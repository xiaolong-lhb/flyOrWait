/**
 * Agent 对话接口   POST /api/agent
 *
 *   请求：{ "question": "11月下旬从深圳去北京哪天便宜", "conversationId": "<可选 uuid>" }
 *   响应：{ code: 0, message: "ok",
 *           data: { runId, conversationId, answer, model, status,
 *                   rounds, toolCalls, elapsedMs, tokens } }
 *
 *   不传 conversationId ⇒ 后端新建一个会话，把 id 一起返回；前端存下来，下一句带回来。
 *   带了但不存在（或不属于当前身份）⇒ 404 / 4040，前端应当清掉本地 id、当成开新对话。
 *   ★ 失败时**也回** conversationId（data 不是 null，是 { conversationId }）：
 *     否则第一句就失败的话，用户重试会再建一个会话，同一个问题在列表里裂成两条。
 *     body 形状没变（还是 {code,message,data}），只是失败时 data 有了内容。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这个文件只做两件事
 * ══════════════════════════════════════════════════════════════════════
 *   ① 让 _agentPrepare 把请求整理干净 → ② 调 runAgent → ③ 按全局约定回包
 *
 * 循环本体在 api/_agentRun.js，工具在 api/_agentTools.js。
 * 前置七步（方法/开关/身份/字数/Key/会话/历史）在 api/_agentPrepare.js，
 * 和流式接口 api/agent-stream.js 共用同一份。
 * 这里**刻意不写任何业务逻辑**：命令行（scripts/agent-cli.mjs）和评测集
 * （scripts/agent-eval.mjs）跑的是同一份 runAgent，接口里再长一份逻辑，
 * 就又多了一个和上线代码不一致的真源。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  时间预算：45s / 15s 两个数在 _agentPrepare.js 的 BUDGET 里
 * ══════════════════════════════════════════════════════════════════════
 *  三层超时由内到外逐层放大：
 *      单轮模型 15s  <  整轮预算 45s  <  Vercel maxDuration 60s  <  浏览器 65s
 *
 *  ⚠️ 为什么整轮必须是 45s 而不是贴着 58s、以及「轮间检查」这个已知残余风险，
 *     完整推导写在 _agentPrepare.js 的 BUDGET 上方。不在这里重复，
 *     是因为流式接口用的是同一组数 —— 说明写两遍，改的时候就只会改到一遍。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  没有鉴权 —— 这一点必须说清，不能装作有
 * ══════════════════════════════════════════════════════════════════════
 *  跟其它接口一样只靠 X-Owner-Id 区分身份，而它是明文、可伪造的。
 *  也就是说域名公开后**任何人都能打这个接口，每次都在烧 token**。
 *  前端再加任何 token 都没用 —— 浏览器里看得见。
 *
 *  所以这里给一个真正有用的东西：环境变量 AGENT_DISABLED=1 立刻停服
 *  （改完 Redeploy 即生效）。账单不对劲时这比什么都快。
 *  真正的防护要靠登录 / 按人限额，那是 v2 的事。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么不记 query_log
 * ══════════════════════════════════════════════════════════════════════
 *  设置页那个「本月查询次数」统计的是 `result` 接口（页面查询）。
 *  agent 的每次 run 已经完整落在 agent_run / agent_step 里，
 *  再插一行 query_log 只会让那个数字的口径变得说不清 —— 宁可分开看。
 */
import { runAgent } from './_agentRun.js';
import { touchConversation } from './_conversation.js';
// 事件的日志格式与 api/agent-stream.js 共用同一份（_agentLog.js）。
// 别名成 logEvent 是为了让 onEvent 那行和以前一模一样 —— 这次改动的目的
// 只是把实现搬走，不是改调用方式。
import { logAgentEvent as logEvent } from './_agentLog.js';
// 方法 / 开关 / 身份 / 字数 / Key / 会话 / 历史 这七步全部在 _agentPrepare.js。
// 流式接口 api/agent-stream.js 用的是同一份 —— 两处各写一遍就一定会漂。
// 时间预算（45s / 15s）和两句对外错误文案也从那里取，不再在本文件维护。
import {
  BUDGET,
  MODEL_ERROR_MESSAGE,
  SERVER_ERROR_MESSAGE,
  prepareAgentRequest,
} from './_agentPrepare.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── 前置七步：方法 / 开关 / 身份 / 字数 / Key / 会话 / 历史 ──
  // 全部交给 _agentPrepare.js。本文件只负责「拿到干净的 question 之后怎么跑」。
  const prep = await prepareAgentRequest(req);
  if (!prep.ok) {
    // code 前三位就是 HTTP 码（4000→400 / 4040→404 / 4050→405 / 5000→500 / 5030→503）——
    // 全局约定本来就这么定的，所以这里不必再维护一张会漂的映射表。
    res
      .status(Math.floor(prep.code / 10))
      .json({ code: prep.code, message: prep.message, data: null });
    return;
  }
  const { ownerId, question, llm, conv, history } = prep;

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
      onEvent: logEvent,
    });
  } catch (e) {
    // 走到这里说明是**编排层自己**抛了（数据库连不上、形态不对之类）
    // 完整堆栈只进日志：e.message 里可能有连接串、表名，对用户全是噪音
    console.error('[agent] 编排层异常：', e);
    res.status(500).json({
      code: 5000,
      message: SERVER_ERROR_MESSAGE,
      data: { conversationId: conv.id },
    });
    return;
  }

  // 答得好不好都更新会话时间：用户确实在这里说了话，列表该把它顶到前面。
  // touch 自己吞异常（失败只打日志），到这儿不会有 throw。
  await touchConversation(conv.id);

  // ── 三种收尾，分别对应三种「用户该知道的事」──
  // 注意：run 已经完整落库了，即便这里回 5xx，runId 也能在库里查到。
  if (result.status === 'failed') {
    // status=failed 只有一条来路：模型调用抛了。failure 形如
    // 「第 2 轮模型调用失败：模型接口 401：{...}」，后半段是上游原文，
    // 里面有 URL、状态码、偶尔还有 key 片段 —— 给日志，不给用户。
    console.error(`[agent] run ${result.runId} 模型侧失败：${result.failure}`);
    res.status(502).json({
      code: 5020,
      message: MODEL_ERROR_MESSAGE,
      data: { conversationId: conv.id },
    });
    return;
  }
  if (result.status === 'aborted') {
    // 预算用尽 / 轮数或工具次数到顶。504 的语义是「服务端没能及时完成」，
    // 原因写进 message —— 不给用户一句含糊的「稍后重试」。
    console.warn('[agent] run 未完成：', result.failure);
    res.status(504).json({
      code: 5040,
      message: `这次没能答完：${result.failure}`,
      data: { conversationId: conv.id },
    });
    return;
  }
  if (!String(result.answer ?? '').trim()) {
    // status=ok 但一个字都没有：模型空转了一轮。当成失败，别让前端弹个空气泡。
    console.warn('[agent] 模型返回空回答，runId =', result.runId);
    res.status(502).json({
      code: 5020,
      message: '模型返回了空回答，请重试一次',
      data: { conversationId: conv.id },
    });
    return;
  }

  res.status(200).json({
    code: 0,
    message: 'ok',
    data: {
      runId: result.runId,
      conversationId: conv.id,
      answer: result.answer,
      model: result.model,
      status: result.status,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      elapsedMs: result.elapsedMs,
      // 字段名转成前端习惯的 camelCase。逐字透传 usage 的 snake_case
      // 等于把厂商字段名漏进前端，换模型时那边就得跟着改。
      tokens: {
        prompt: result.usage?.prompt_tokens ?? 0,
        completion: result.usage?.completion_tokens ?? 0,
      },
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════
 *  进度事件的日志实现搬到了 api/_agentLog.js
 * ══════════════════════════════════════════════════════════════════════
 *  本文件与 api/agent-stream.js 跑的是同一个 runAgent，事件序列完全一样。
 *  日志格式如果各留一份，同一次 run 在两种接口下打出来的行会长得不一样，
 *  排查时得先分清用户用的是哪个接口才能读懂日志。
 *
 *  那里还留着原来那段「为什么值得留 / 为什么不打 args」的理由，不在这里重复 ——
 *  同一份理由写两遍，改的时候必然只改到一处。
 */

