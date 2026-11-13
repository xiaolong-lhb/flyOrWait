/**
 * Agent 接口（SSE 流式版）—— 让用户看得见「它在干活」
 *
 * ══════════════════════════════════════════════════════════════════════
 *  和 api/agent.js 的关系
 * ══════════════════════════════════════════════════════════════════════
 *  两个文件跑的是**同一个** runAgent、同一套前置检查（_agentPrepare.js）。
 *  区别只在「怎么把结果送回去」：
 *
 *    agent.js        → 攒完一次性 res.json，用户干等 10~40 秒
 *    agent-stream.js → 边跑边 res.write，用户看到「正在查票价 → 查完了 → 正在整理」
 *
 *  **范围：v1 流「阶段」，v2 起答案正文也流（delta）。**
 *  两条流的方向和来源完全不同 —— 阶段来自我们自己代码的时间点，正文来自模型吐 token。
 *  见文件末尾「v2：答案正文也走流」一节。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ⚠️ 本文件是「HTTP 状态码约定」的显式例外
 * ══════════════════════════════════════════════════════════════════════
 *  全局约定是：code 前三位就是 HTTP 码（4000→400 / 5020→502）。
 *  但**一旦 res.write() 发出第一个字节，响应头就定死了 200**，之后
 *  再怎么错都改不了状态码。这不是偷懒，是 SSE 的物理限制。
 *
 *  所以本文件的口径是：
 *    写头**之前**的错误（七步前置检查）→ 仍然用真实状态码
 *    写头**之后**的错误（runAgent 失败/超时）→ 状态码 200，真码在 error 事件里
 *
 *  前端不要靠 res.status 判断成败，要看有没有收到 done 事件 ——
 *  这跟 axios 那套拦截器的习惯不同，是流式接口必然要付的代价。
 *
 *  ⇒ 也正因为这个代价，写头的位置**必须尽量靠后**（放在 prepare 之后），
 *    让「参数错 / 缺 Key / 关停」这些高频失败仍然走状态码。
 *    实测 prepare 热路径 ~0.8s、冷启动 ~1.7s，这个延迟用户看不到。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  事件协议（前端只需认 type 一个字段）
 * ══════════════════════════════════════════════════════════════════════
 *  统一用 `data: {json}` 而不区分 `event:` 名 —— 只有一种解析形状，
 *  不会出现「前端把 event 名拼错 ⇒ 事件被静默丢弃」这种查不出来的 bug。
 *
 *    { type:'meta',     conversationId, isNew }        连上就有，**必须在第一个**
 *    { type:'stage',    stage:'thinking', label }      模型开始算
 *    { type:'stage',    stage:'calling',  label }      工具开始跑（最长 35s）
 *    { type:'stage',    stage:'tool-done', label, ok, durationMs }
 *    { type:'delta',    round, text }                  答案正文的一个分片，收到就追加
 *    { type:'retract',  round }                        撤回本轮已发的 delta（清空正文）
 *    { type:'done',     data:{...} }                   结构与 api/agent.js 的 data **完全一致**
 *    { type:'error',    code, message, data:{conversationId} }
 *
 *  ★ delta 只是「提前看到」，**done 里的完整答案才是准的**。两者内容一致，
 *    但前端必须以 done 覆盖一次（否则一旦有分片丢失，界面就永远停在残缺版本）。
 *
 *  ★ meta 必须在最前面：客户端中途断线时**可能收不到 done**，而它需要一个
 *    conversationId 才能在重试时接上同一段对话。放 done 里就等于断一次丢一次上下文。
 *
 *  ★ label 由后端给（工具名 → 人话），前端不认识任何工具名。
 *    否则以后加一个工具，就得记得去改前端映射表，漏了就是界面上一个空白。
 */

import {
  BUDGET,
  MODEL_ERROR_MESSAGE,
  SERVER_ERROR_MESSAGE,
  prepareAgentRequest,
} from './_agentPrepare.js';
import { logAgentEvent } from './_agentLog.js';
import { runAgent } from './_agentRun.js';
import { touchConversation } from './_conversation.js';

/**
 * 心跳间隔。
 *
 * 只发 SSE 注释行（`: ping\n\n`），不是业务事件 —— 它存在的唯一目的是让
 * **字节流别断**，从而让前端能区分两种情况：
 *
 *    「服务端在忙，还没产出」  → 心跳还在来
 *    「连接已经死了」          → 一个字节都收不到
 *
 * 没有心跳时这两者在前端看来一模一样，只能靠一个粗暴的总超时误判。
 *
 * 为什么是 15s：日历工具最长 35s，如果只在工具前后发事件，中间就是 35s 静默；
 * 15s 一次心跳能让「连续 3 次没心跳」才判定断线（前端空闲阈值 45s），
 * 同时也能卡在运营商 NAT 回收空闲连接（常见 30~60s）之前。
 */
const HEARTBEAT_MS = 15_000;

/**
 * 工具名 → 给用户看的人话。
 *
 * 前端不认工具名（见文件头）。这里没有的工具一律兜底成「正在处理」——
 * 宁可文案粗一点，也不能因为新加一个工具就让界面空一块。
 */
const TOOL_LABEL = {
  search_price_calendar: '正在查票价日历',
  find_cheapest_days: '正在找最便宜的几天',
  judge_one_day: '正在判断这一天的价格',
  search_flights: '正在查具体航班',
  compare_two_dates: '正在对比两个日期',
  create_subscription_draft: '正在准备订阅草稿',
};

function labelOf(name) {
  return TOOL_LABEL[name] ?? '正在处理';
}

export default async function handler(req, res) {
  // ── ① 前置七步：失败仍然用真实 HTTP 状态码 ──
  // 这一段是「写头之前」，所以 400 / 405 / 500 / 503 都还在，前端老逻辑照用。
  const prep = await prepareAgentRequest(req);
  if (!prep.ok) {
    res.statusCode = Math.floor(prep.code / 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ code: prep.code, message: prep.message, data: null }));
    return;
  }
  const { ownerId, question, llm, conv, history } = prep;

  // ── ② 从这里开始，状态码永久固定在 200 ──
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // no-transform：明确禁止中间层压缩/改写。压缩层自己会攒缓冲，
  // 会把「边算边到」变成「最后一次性吐」—— 那样这套改造就白做了。
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx 一类反代的专用开关（不认 Cache-Control: no-transform）。
  // Vercel 不用它，但填上不花钱，且本地跑在别的网关后面时能救命。
  res.setHeader('X-Accel-Buffering', 'no');
  // 立刻把响应头刷出去：不刷的话 Node 会等到第一次 write 才发头，
  // 那「连上了」这件事本身就晚了。
  res.flushHeaders?.();

  let finished = false;

  /** 往流里推一条事件。已收尾后静默忽略（避免 end 之后 write 报错）。 */
  const send = (obj) => {
    if (finished) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      // 连接已经断了。不要因此让整个 handler 抛出去 ——
      // runAgent 还要跑完并落库，那是这一轮唯一有长期价值的东西。
      console.warn('[agent-stream] 写入失败（连接可能已断）：', e.message);
    }
  };

  const hb = setInterval(() => {
    if (finished) return;
    try {
      res.write(': ping\n\n');
    } catch {
      /* 断开时忽略，close 事件会处理 */
    }
  }, HEARTBEAT_MS);

  /**
   * 客户端提前断开（关页面、切网、代理断线）。
   *
   * **这里刻意不中止 runAgent。** 中止了库里那行 agent_run 会永远停在
   * running，而跑完至少留下一条可查的记录 —— 用户重试时也能从库里看到
   * 「上一次其实答出来了，只是没送到」。代价是白烧一次模型钱，可以接受。
   */
  res.on('close', () => {
    if (!finished) {
      console.warn('[agent-stream] 客户端提前断开；本轮 run 仍会跑完并落库');
    }
  });

  // ★ 第一个事件就带 conversationId（理由见文件头）
  send({ type: 'meta', conversationId: conv.id, isNew: conv.isNew });

  // ── ③ 跑循环，把内部事件翻译成阶段事件 ──
  let result;
  try {
    result = await runAgent({
      question,
      surface: 'chat',
      llm,
      maxDurationMs: BUDGET.totalMs,
      history: history.messages,
      conversationId: conv.id,
      ownerId,
      onEvent: (ev) => {
        // 日志与流并行：日志给人查，流给用户看，两者都不能省
        logAgentEvent(ev);
        relay(ev, send);
      },
    });
  } catch (e) {
    // 编排层自己抛了（数据库连不上、形态不对之类）。完整堆栈只进日志。
    console.error('[agent-stream] 编排层异常：', e);
    clearInterval(hb);
    send({
      type: 'error',
      code: 5000,
      message: SERVER_ERROR_MESSAGE,
      data: { conversationId: conv.id },
    });
    finished = true;
    res.end();
    return;
  }

  clearInterval(hb);

  // ── ④ 三种收尾，码值与文案跟 api/agent.js 逐条一致 ──
  // 同一个失败在两条链路上必须是同一个码、同一句话，否则用户截图去问的时候
  // 会被当成两个 bug。
  if (result.status === 'failed') {
    // failure 里可能有 URL、状态码、偶尔有 key 片段 —— 给日志，不给用户
    console.error(`[agent-stream] run ${result.runId} 模型侧失败：${result.failure}`);
    send({
      type: 'error',
      code: 5020,
      message: MODEL_ERROR_MESSAGE,
      data: { conversationId: conv.id },
    });
  } else if (result.status === 'aborted') {
    console.warn('[agent-stream] run 未完成：', result.failure);
    send({
      type: 'error',
      code: 5040,
      message: `这次没能答完：${result.failure}`,
      data: { conversationId: conv.id },
    });
  } else if (!String(result.answer ?? '').trim()) {
    // status=ok 但一个字都没有：模型空转了一轮。当成失败，别让前端弹个空气泡。
    console.warn('[agent-stream] 模型返回空回答，runId =', result.runId);
    send({
      type: 'error',
      code: 5020,
      message: '模型返回了空回答，请重试一次',
      data: { conversationId: conv.id },
    });
  } else {
    // ★ done 的 data 结构与 api/agent.js 的 data **逐字段一致**，
    //   这样前端 store 拿到之后几乎不用改（只是从 await 的返回值换成事件参数）。
    send({
      type: 'done',
      data: {
        runId: result.runId,
        conversationId: conv.id,
        answer: result.answer,
        model: result.model,
        status: result.status,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        elapsedMs: result.elapsedMs,
        tokens: {
          prompt: result.usage?.prompt_tokens ?? 0,
          completion: result.usage?.completion_tokens ?? 0,
        },
      },
    });
  }

  finished = true;
  res.end();

  // ── ⑤ 收尾之后才更新会话时间 ──
  // touch 只把会话顶到列表前面，用户看不见。放在 end 之前等于让用户
  // 白等一次跨境往返（实测 ~0.7s），而流式改造的全部意义就是别再白等。
  //
  // ⚠️ 已知残余风险：Vercel 可能在响应结束后冻结函数，这次 update 可能没跑完。
  //    后果只是「会话列表顺序没更新」，不影响消息本身 —— 可以接受。
  try {
    await touchConversation(conv.id);
  } catch (e) {
    console.warn('[agent-stream] 更新会话时间失败（不影响回答）：', e.message);
  }
}

/**
 * 把 runAgent 的内部事件翻译成给用户看的阶段事件。
 *
 * 三个事件的语义差别（这是整条链路的时间轴）：
 *      llm-start  → 模型开始算（这段之前没有任何事件，所以必须有它）
 *      round      → 模型算完了，要么要工具、要么给答案
 *      tool-start → 工具开始执行（日历最长 35s，这段靠它 + 心跳撑住）
 *      tool       → 工具执行完，带耗时和成败
 *
 * @param {{type:string}} ev
 * @param {(obj:object)=>void} send
 */
function relay(ev, send) {
  switch (ev.type) {
    case 'llm-start':
      send({
        type: 'stage',
        stage: 'thinking',
        // 第一轮在想「要不要查、查什么」，之后在想「怎么把结果说清楚」——
        // 同一句「正在思考」连说两次，用户会觉得卡住了
        label: ev.round === 1 ? '正在理解你的问题' : '正在整理答案',
      });
      break;

    // 答案正文的一个分片。前端只做一件事：追加到当前气泡末尾。
    // 不带 round 也能用（撤回时清空即可），但留着方便排查「这段字是哪一轮吐的」。
    case 'delta':
      send({ type: 'delta', round: ev.round, text: ev.text });
      break;

    // 这一轮其实要工具：把刚显示的那点字撤回。
    // 实测几乎不会触发（工具轮 content 为空），但模型升级会改行为 —— 留着。
    case 'retract':
      console.warn(`[agent-stream] 第 ${ev.round} 轮先吐正文后改要工具，已通知前端撤回`);
      send({ type: 'retract', round: ev.round });
      break;

    case 'tool-start':
      // 只传 label，不传 args：args 里可能有用户填的邮箱
      send({ type: 'stage', stage: 'calling', label: labelOf(ev.name) });
      break;

    case 'tool':
      send({
        type: 'stage',
        stage: 'tool-done',
        label: labelOf(ev.name),
        ok: ev.ok,
        durationMs: ev.durationMs,
      });
      break;

    // round 不单独翻译成阶段：它和 llm-start / tool-start 紧邻，
    // 多发一条只会让界面上闪一下同名文字。
    //
    // llm-error / db-warn 也不发：前者后面紧跟一条 error 或 done，
    // 后者是内部记账问题，用户看了也做不了什么。

    default:
      break;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  v2：答案正文也走流（delta / retract）
 * ══════════════════════════════════════════════════════════════════════
 *  v1 只流「过程」（stage），答案等 done 一把给。v2 把正文也拆成分片：
 *
 *      模型吐一个 token → callLLM 的 onDelta → delta 事件 → 前端追加
 *
 *  ★ 唯一的设计难点：**这一轮是在「要工具」还是在「写答案」，只有等它吐完才知道**
 *    （判决依据是有没有 tool_calls）。所以只有两种做法：
 *      A. 先攒在内存，确认是答案轮再放出去 —— 绝不撤回，但首字一点没提前，
 *         等于没做流式。**否决。**
 *      B. 先照传，发现要工具就撤回 —— 延迟最低。**采用。**
 *
 *    选 B 的数据依据（scripts/probe-delta.mjs，连打 10 次）：
 *      工具轮 content 非空 0/10，答案轮首字 556~1284ms（均值 924ms）。
 *    也就是说 B 那条撤回分支几乎不会触发，而 B' 那种「先攒 200ms」会吃掉
 *    924ms 里 22% 的首字延迟去防一个不会发生的事 —— 不划算。
 *
 *  ⚠️ 边界：0/10 是「同一问句 + 同一工具 + deepseek-flash」的结果。
 *     换模型、换提示词、换工具都得用同一个探针重测，不能拿它当普遍规律。
 *
 *  ⇒ retract 分支仍然保留：概率是 0 也要留安全阀，因为模型升级会改行为。
 */
