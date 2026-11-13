/**
 * Agent 请求的前置处理 —— 方法 / 开关 / 身份 / 字数 / Key / 会话 / 历史
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么要有这个文件
 * ══════════════════════════════════════════════════════════════════════
 *  api/agent.js（一次性返回）和 api/agent-stream.js（SSE 流式）要做的
 *  前置步骤**一模一样**：七个检查，一个都不能少。
 *
 *  不抽出来就得把同一段复制到两个文件里，那么「字数上限从 300 改成 500」
 *  这种改动以后必然只改到一处 —— 两份逻辑一定会漂。
 *  这是抽它的唯一理由，不是为了好看。
 *
 *  ══ 本文件不碰 res ══
 *  错误统一用 { ok:false, code, message } 往外传，由各自接口决定
 *  是回一个 HTTP 状态码（agent.js），还是回一条 SSE error 事件（流式）。
 *  一旦这里开始写 res.status()，抽出来的东西就只能给一种返回方式用了。
 *
 *  ══ code 的口径 ══
 *  沿用全局约定：**前三位就是 HTTP 码**。所以调用方写 `Math.floor(code/10)`
 *  就能拿到 status，不必再维护一张会漂的映射表：
 *    4000→400  4040→404  4050→405  5000→500  5030→503
 */

import { resolveLLM } from './_agentRun.js';
import { loadHistory, resolveConversation } from './_conversation.js';

/** 用户原话上限。不是性能考虑：超长输入意味着这不是一句提问，别让模型替我们读文章。 */
const MAX_QUESTION = 300;

/* ══════════════════════════════════════════════════════════════════════
 *  时间预算：整个 Agent 链路唯一需要动脑的地方
 * ══════════════════════════════════════════════════════════════════════
 *  超时由内到外逐层放大（每一层都必须比外层小，否则外层的收尾永远轮不到）：
 *      模型首块 10s  <  单轮模型 15s  <  整轮预算 45s  <  Vercel 60s  <  浏览器 65s
 *
 *  首块和单轮为什么要分成两个数：流式之后「慢」有两种含义，一个数表达不了 ——
 *    ① 一个字节都不回（上游挂住 / 连接卡死）→ 这是故障，10s 就该断，别让用户干等
 *    ② 已经在慢慢吐，只是还没吐完        → 这是正常，到点砍掉就是误伤
 *  只设 15s 的话，① 要白等 15s；只设 3s 的话，② 会被砍。两个数各管一件事。
 *  首块 10s 的依据是实测 556~1284ms（10 次，带工具的 deepseek），留了近 10 倍余量。
 *
 *  为什么整轮预算定在 45s 而不是 58s：
 *    Vercel 掐断是**硬断连接**，前端只会看到「网络异常」—— 我们自己准备好的
 *    那句中文报错永远没机会发出去。所以必须在平台上限之内**主动收尾**，
 *    哪怕收尾的结论是「这次没答完」。
 *
 *  为什么单轮定 15s：对 flash 这种模型足够；设大了会把日历的时间挤掉
 *  （一次日历最长 35s，两轮模型 30s + 日历 35s 已经顶到 45s 边缘）。
 *
 *  正常一问的耗时拼起来（实测过的量级）：
 *    模型第 1 轮 2~5s（决定调哪个工具）+ 日历 0~35s + 末轮 2~5s ≈ 40s 以内。
 *
 *  ⚠️ 已知残余风险，写在明处，不假装没有：
 *    预算是**轮间**检查的，不是每次 I/O 之前检查的。若模型在拿到日历之后
 *    又要查一条**不同航线**（同航线有缓存救得了、不同航线救不了），
 *    那一轮可能在 45s 之后再加一次 35s 的日历 ⇒ 越过 60s 被平台掐断。
 *    概率低但存在。彻底解决要把 deadline 穿透到工具层（每次调用只取剩余预算），
 *    那要改 _agentRun + _agentTools 两个文件，不在当前改动范围。
 *
 *  ⚠️ 这两个数是**两个接口共用**的：流式接口的预算若单独写一份，
 *     调的时候必然只调到一处，变成「一次性接口 45s、流式 60s」这种说不清的口径。
 */
export const BUDGET = {
  /** 整轮预算，必须明显小于 vercel.json 的 maxDuration(60s) */
  totalMs: 45_000,
  /** 单次模型调用（从发出请求到读完流）的总上限 */
  llmMs: 15_000,
  /**
   * 单次模型调用的首块上限：字节都不回就是故障，比 llmMs 更早断。
   * ⚠️ 必须 < llmMs。配大了不会报错，但会被 callLLM 里的 Math.min 静默压成 llmMs，
   *    拆分就白做了 —— 改这两个数时必须一起看。
   */
  llmFirstTokenMs: 10_000,
};

/* ══════════════════════════════════════════════════════════════════════
 *  错误文案：对外说人话，对内留细节
 * ══════════════════════════════════════════════════════════════════════
 *  项目约定是「message 可以直接展示给用户」，所以它**不能**夹带实现细节。
 *  判断标准只有一条：**用户看到这句话，能不能做点什么**。
 *
 *    能改的（question 为空 / 超长）        → 原话直出，还要说清怎么改
 *    改不了但重试有用（模型 429、超时）    → 说「稍后再试」，给重试按钮
 *    改不了且重试也没用（缺 key、代码崩了）→ 一句统一话，细节全进日志
 *
 *  「后端缺少环境变量 DEEPSEEK_API_KEY」这种话，用户没有那个变量，告诉他
 *  变量名除了漏实现细节之外毫无用处。真正的原因写在 console.error 里 ——
 *  线上出这种事，`vercel logs` 搜 DEEPSEEK_API_KEY 就能定位。
 *
 *  两个接口共用这两句：同一种失败在两条链路上必须是同一句话，
 *  否则用户截图去问客服时，两句话会被当成两个 bug。
 */
export const SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后再试';
export const MODEL_ERROR_MESSAGE = '模型服务暂时不可用，请稍后再试';

/**
 * 把一次请求整理成可以直接喂给 runAgent 的东西。
 *
 * @param {import('http').IncomingMessage & { body?: any }} req
 * @returns {Promise<
 *   { ok: true, ownerId: string, question: string, llm: object,
 *     conv: {id:string,isNew:boolean},
 *     history: {messages: Array, warning: string|null} } |
 *   { ok: false, code: number, message: string }
 * >}
 *
 * ⚠️ 顺序是刻意的，每一步都在替后面省事：
 *    ① 方法和开关最先 —— 关停时要**一个数据库请求都不打**就退出去；
 *    ② Key 检查在建会话之前 —— 没配 Key 时不该在库里留下一个永远没有消息的空会话；
 *    ③ 历史放在会话之后 —— 刚建的会话必然没历史，能省一次跨境查询。
 */
export async function prepareAgentRequest(req) {
  // ── ① 方法 ──
  // 两个接口都是 POST：上行带 body，所以不用 GET（GET 的 body 会被各种中间层吃掉）
  if (req.method !== 'POST') {
    return { ok: false, code: 4050, message: `不支持的方法：${req.method}` };
  }

  // ── ② 紧急刹车 ──
  // 账单或模型出问题时，改环境变量比重发一版代码快。
  // 放在最前面：关停就该是「一个字都不多花」，连会话都不建。
  if (process.env.AGENT_DISABLED === '1') {
    return { ok: false, code: 5030, message: 'Agent 功能已临时关闭' };
  }

  // ── ③ 身份（拦截器自动带，现在固定 'owner'）──
  // 会话是按 owner_id 归属的，没有它就不知道该往哪个会话里写 run。
  // 跟 api/conversations.js 同一个口径：接口不认识默认值，缺了就明确报错。
  const ownerId = req.headers['x-owner-id'];
  if (!ownerId) {
    return { ok: false, code: 4000, message: '缺少身份标识（X-Owner-Id）' };
  }

  // ── ④ 入参校验：后端这份是唯一防线（前端那份只管体验）──
  const payload = req.body ?? {};
  const question = String(payload.question ?? '').trim();

  if (!question) {
    return { ok: false, code: 4000, message: 'question 不能为空' };
  }
  if (question.length > MAX_QUESTION) {
    return {
      ok: false,
      code: 4000,
      message: `question 最多 ${MAX_QUESTION} 字，收到 ${question.length} 字`,
    };
  }

  // ── ⑤ 模型 Key ──
  const llm = { ...resolveLLM(), timeoutMs: BUDGET.llmMs, firstTokenMs: BUDGET.llmFirstTokenMs };
  if (!llm.apiKey) {
    // 配置缺失算我们自己的锅（500），不是外部源的问题（502）—— 跟 api/result.js 同口径。
    // 这条日志不是可选的：对外已经被抹成一句通用提示，这里是**唯一**知道真因的地方。
    console.error('[agent] 配置缺失：未设置 DEEPSEEK_API_KEY，无法调用模型');
    return { ok: false, code: 5000, message: SERVER_ERROR_MESSAGE };
  }

  // ── ⑥ 会话：带了 id 就认领，没带就新建一个 ──
  const conv = await resolveConversation({
    ownerId,
    conversationId: payload.conversationId,
    firstQuestion: question,
  });
  if (!conv.ok) {
    // code 前三位就是 HTTP 码 —— 不在这里换算，交给调用方（见文件头）
    return { ok: false, code: conv.code, message: conv.message };
  }

  // ── ⑦ 历史 ──
  // 刚建的会话必然没有历史，省一次跨境查询（Vercel 到 Supabase 一来一回不便宜）
  const history = conv.isNew
    ? { messages: [], warning: null }
    : await loadHistory({ ownerId, conversationId: conv.id });
  if (history.warning) {
    // 历史读不到就降级成单轮，不能让整轮挂掉：用户问的是新问题，历史只是帮他理解指代
    console.warn('[agent] 历史读取失败，本轮按单轮处理：', history.warning);
  }

  return {
    ok: true,
    // ownerId 必须一起返回：runAgent 要用它写 agent_run.owner_id。
    // 调用方重新从 req.headers 里再取一次也能拿到，但那等于让两个地方
    // 各自解释「身份是什么」—— 以后加登录时必漏一处。
    ownerId,
    question,
    llm,
    conv: { id: conv.id, isNew: conv.isNew },
    history,
  };
}
