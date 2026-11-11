/**
 * 流式探针（临时接口，验完就删）  GET /api/stream-probe
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这个文件唯一要回答的问题
 * ══════════════════════════════════════════════════════════════════════
 *  「Vercel 会不会把 res.write() 攒到函数结束才一次性发出去？」
 *
 *  这个答案决定期 3（Agent 回答改成流式）能不能做：
 *    能边算边到  ⇒ 按原计划做，用户能看见「正在查机票」
 *    被平台缓冲  ⇒ 这条路在 Node Runtime 上不通，得换写法或换运行时
 *
 *  ⚠️ 为什么不能在本机 dev:api 验：
 *     本地是 express，express 对 res.write 是直通的，一定能流。
 *     「本地能流」提供的信息量是 0 —— 要验的从来不是代码，是平台。
 *
 *  ⚠️ 为什么官方文档也没法当依据：
 *     Vercel 的流式文档只给了 Next.js 的写法（return ReadableStream）。
 *     本项目用的是 export default function handler(req, res) 这种纯 Node 写法，
 *     官方没有对应示例。所以只能实测。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  怎么读结果
 * ══════════════════════════════════════════════════════════════════════
 *  验证命令（-N 关掉 curl 自己的缓冲，不加这个参数什么都看不出来）：
 *
 *      curl -N https://fly-or-wait.vercel.app/api/stream-probe
 *
 *  三种结果：
 *    ① 每行出现的时间戳依次是 0 / 1000 / 2000 / 3000 / 4000
 *       ⇒ 通。平台没有缓冲，按原计划做。
 *    ② 五行一起在第 5 秒出现
 *       ⇒ 被缓冲。去掉 X-Accel-Buffering 再试一次；仍然不行就说明
 *         Node Runtime 这条路不通，需要换'edge'运行时重新验。
 *    ③ 直接 504 / 超时
 *       ⇒ 函数没能正常收尾，问题出在别处（比如 maxDuration），另查。
 *
 *  顺带还验了一件事：响应头设成 text/event-stream 之后，
 *  Vercel 会不会给它套上 gzip —— 一旦套了 gzip，压缩流自己就会攒缓冲区。
 */

/** 吐几次。5 次 × 1 秒，足够区分「陆续到」和「一次性到」 */
const PINGS = 5;
const INTERVAL_MS = 1000;

export default async function handler(req, res) {
  // ── 响应头三件套 + 一个防压缩的 ──
  // "no-transform" 很关键：它明确告诉任何中间层「不许改我的响应体」，
  // 压缩属于「改」，所以这一条能顺手把 gzip 缓冲挡掉。
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 给 Nginx 一类反向代理看的（Vercel 前面是不是这套不确定，写了不亏）
  res.setHeader('X-Accel-Buffering', 'no');

  const t0 = Date.now();

  for (let i = 0; i < PINGS; i++) {
    // 用 SSE 的注释行（以冒号开头）：客户端解析时会忽略它，
    // 但字节是真的发出去了 —— 我们要的就是「字节什么时候到」，不需要它成为事件。
    res.write(`: ping ${i} t=${Date.now() - t0}ms\n\n`);

    // res.flush 是 compression 中间件挂上去的，原生 ServerResponse 没有。
    // 存在就调一下（有压缩层时必须靠它把缓冲挤出去），不存在说明没有这层。
    if (typeof res.flush === 'function') res.flush();

    if (i < PINGS - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  // 最后一条真正的事件，方便用 EventSource 或 fetch 读流的客户端也能用
  res.write(`data: ${JSON.stringify({ done: true, elapsedMs: Date.now() - t0 })}\n\n`);
  res.end();
}
