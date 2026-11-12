/**
 * Agent 流式接口（SSE）—— 前端唯一读流的地方
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么不放在 api/index.js
 * ══════════════════════════════════════════════════════════════════════
 *  index.js 是 axios 实例，它的便利全靠拦截器：自动带 X-Owner-Id、自动把
 *  `{code,message,data}` 解包成 data、自动把 4xx 归一化成可展示的中文。
 *
 *  这些**没有一条能用在流上**：
 *    · axios 会把整个响应体读完了才 resolve —— 流到它手里就已经是一整块了
 *    · 拦截器那套「看 res.status 判成败」在流式接口上等于作废（见下）
 *    · SSE 是一行一行来的，没有「解包」这个动作
 *
 *  所以这里是 fetch + ReadableStream，独立成文件。两套范式各自写清楚，
 *  好过在一个文件里判断「这次该走哪套」。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ⚠️ 判成败的唯一依据：有没有收到 done 事件
 * ══════════════════════════════════════════════════════════════════════
 *  后端一旦写出第一个字节，HTTP 状态码就永久锁死 200（SSE 的物理限制）。
 *  所以：
 *
 *    写头之前的失败（参数错 / 缺 Key / 关停）→ 仍是真实状态码，这里按状态码抛
 *    写头之后的失败（模型挂了 / 超时）        → 200 + 一条 error 事件，这里按事件抛
 *
 *  **调用方不要读 e.status 判断严不严重，要看 e.code**（全局约定不变）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  抛出的错误形状：与 axios 拦截器归一化的结果字段一致
 * ══════════════════════════════════════════════════════════════════════
 *  { code, message, status, data }  —— 是带附加字段的 Error，不是裸对象，
 *  这样 DevTools 里能看到堆栈。
 *
 *  message 永远是**可以直接展示给用户的中文**（后端原话，这里一个字不翻译）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  断线相关的三件事（这是流式接口与普通请求最大的差别）
 * ══════════════════════════════════════════════════════════════════════
 *  ① 「丢包」不存在。SSE 走 TCP，丢包由内核重传，应用层要么收到完整字节、
 *     要么连接断了。所以这里处理的是「连接没了」，不是「中间少了一段」。
 *
 *  ② 静默 ≠ 断线，要靠心跳区分。后端每 15s 发一行 `: ping`（SSE 注释行，
 *     读得到字节但不产生事件）。这里任何字节——包括心跳——都会重置空闲计时。
 *     45s 内一个字节都没有，才认定连接死了。
 *       为什么是 45s：后端单次最长静默是日历工具（35s），再加两次心跳的余量；
 *       正好等于后端整轮预算 BUDGET.totalMs，两个数语义统一，不用记第三个。
 *
 *  ③ 不自动重连。EventSource 原生带重连，但它只能发 GET、带不了 body 和
 *     X-Owner-Id，用不了。而 fetch 没有自动重连**恰好是对的**：服务端无状态，
 *     「重连」并不能接着上次的位置发，只会把整个 run 重跑一遍（花钱、可能
 *     重复写库）。所以断线的正确语义是「重试整个请求」，与 store 里 retry()
 *     的行为天然一致。
 */

import { getIdentityId } from './identity.js';

/** 空闲超时：这么多毫秒一个字节都没来，判定连接已死（理由见文件头 ②） */
const IDLE_MS = 45_000;

/** 网络层错误用的伪 code：负数，永远撞不上业务码（与 index.js 取值一致） */
const NETWORK_ERROR_CODE = -1;

/**
 * 造一个形状与 axios 拦截器一致的错误。
 * 用真正的 Error 而不是裸对象：堆栈能定位到抛出的那一行。
 */
function streamError(message, { code = NETWORK_ERROR_CODE, status = 0, data = null } = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.data = data;
  // 显式标记「这是我造好的、shape 已经对了」。
  // 不能靠「有没有 code 字段」来判：浏览器的 AbortError 是 DOMException，
  // 它的 legacy code 是 20，在部分引擎里还继承自 Error —— 会把自己的超时
  // 误判成「外部抛的上层错误」再原样抛一次，错误文案就丢了。
  err.normalized = true;
  return err;
}

/**
 * 发一条问题并逐条吐出后端事件。
 *
 * 用法（调用方只需认 type，其余字段原样透传）：
 *
 *     for await (const ev of streamAgent({ question, conversationId })) {
 *       if (ev.type === 'meta')  ...   // 一定是最先到的
 *       if (ev.type === 'stage') ...   // 可以到很多条
 *       if (ev.type === 'done')  ...   // 成功时一定以它结尾
 *     }
 *
 * 失败不靠返回值表达，一律**抛出**（本函数内部会把 error 事件翻译成异常，
 * 这样调用方只需要一个 try/catch，不用在循环里判断两种收尾）。
 *
 * @param {{question:string, conversationId?:string}} body
 * @returns {AsyncGenerator<{type:string}>}
 */
export async function* streamAgent(body) {
  const ctrl = new AbortController();
  let timedOut = false;
  let idle = null;

  /** 重新计时。每收到一次字节（含心跳）都调一次。 */
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, IDLE_MS);
  };
  const disarm = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };

  let res;
  try {
    arm();
    res = await fetch('/api/agent-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 与 axios 拦截器同一个出处：漏带这个头，后端就不知道该把这一轮
        // 写进谁的会话里。
        'X-Owner-Id': getIdentityId(),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    disarm();
    // 请求压根没发出去 / 被空闲计时掐断
    throw streamError(timedOut ? '等待超时，请重试' : '网络异常，请稍后重试');
  }

  // ── 写头之前的失败：仍有真实状态码，body 是 {code,message,data} ──
  if (!res.ok) {
    disarm();
    const payload = await res.json().catch(() => null);
    throw streamError(payload?.message ?? `请求失败（${res.status}）`, {
      code: payload?.code ?? 5000,
      status: res.status,
      // 失败时后端也会回 { conversationId }（见 api/agent-stream.js），
      // 接住它，重试才不会裂成两个会话。
      data: payload?.data ?? null,
    });
  }

  // ── 状态码 200 但不是流：说明中间层改写或返回了一个错误页 ──
  const ctype = res.headers.get('content-type') ?? '';
  if (!res.body || !ctype.includes('text/event-stream')) {
    disarm();
    await res.text().catch(() => '');
    throw streamError('响应格式不符合约定', { code: 5000, status: res.status });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;

  // 建连阶段的那个计时器到此作废，后面每个 chunk 自己计时（见 idleRead）
  disarm();

  /**
   * 读一次，最多等 IDLE_MS。
   *
   * ★ 为什么用 Promise.race，而不是只靠 ctrl.abort()：
   *   abort 确实会让真实 fetch 的 body 报错（规范写着会 error the stream），
   *   但那是一条**间接**链路 —— 换成别的传输方式、或者某个环境对 abort 的
   *   处理有差异，超时就会静默失效，表现是界面永远停在最后一个阶段标签上。
   *   实测踩过：只挂 abort 时，计时器到点了，读的那一端却毫无反应。
   *   race 是直接的：到点就一定 reject。
   *   abort 仍然保留，作用是尽早释放底层连接。
   */
  const idleRead = async () => {
    let t = null;
    const guard = new Promise((_, reject) => {
      t = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        reject(streamError('等待超时，请重试'));
      }, IDLE_MS);
    });
    try {
      return await Promise.race([reader.read(), guard]);
    } finally {
      if (t) clearTimeout(t);
    }
  };

  try {
    for (;;) {
      const { done, value } = await idleRead();

      if (done) {
        // 把解码器里最后半个多字节字符吐出来
        buf += decoder.decode();
        break;
      }

      // 任何字节都算「连接还活着」：心跳（`: ping`）也是字节，
      // 所以「有没有在动」不依赖业务事件，只看字节流。
      buf += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件。这里按 '\n\n' 切，不按行切：
      // 一个事件的 data 行可能被 TCP 从中间劈开，按行切会读到半句 JSON。
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);

        for (const line of chunk.split('\n')) {
          // 心跳注释行（': ping'）和空行都在这里被跳过
          if (!line.startsWith('data:')) continue;

          const raw = line.slice(5).trim();
          if (!raw) continue;

          let ev;
          try {
            ev = JSON.parse(raw);
          } catch {
            // 按 '\n\n' 切过之后不该出现半句；真出现了就丢掉这一条，
            // 不要整条流崩掉——丢一条阶段标签远好过丢掉整个回答。
            continue;
          }

          if (ev.type === 'error') {
            // 写头之后的失败：状态码是 200，真码在事件里
            throw streamError(ev.message || '这次没能拿到回答', {
              code: ev.code ?? 5000,
              status: res.status,
              data: ev.data ?? null,
            });
          }

          if (ev.type === 'done') finished = true;
          yield ev;
        }
      }
    }
  } catch (e) {
    if (e?.normalized) throw e;
    // reader.read() 抛了：AbortError（空闲超时）或网络断了
    throw streamError(timedOut ? '等待超时，请重试' : '网络中断，没能拿到回答', {
      code: NETWORK_ERROR_CODE,
    });
  } finally {
    disarm();
    try {
      reader.cancel();
    } catch {
      // 已经断了，取消也会抛，忽略
    }
  }

  // ── 流正常结束，但没等到 done ──
  // 这是最容易被忽略的一种失败：连接是「干净地」断的（比如代理主动收尾、
  // 函数被平台掐断），reader 不报错，只是没有 done。不判这一条，界面就会
  // 永远停在最后一个阶段标签上。
  if (!finished) {
    throw streamError('连接中断，没能收到完整回答，请重试');
  }
}
