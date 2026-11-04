/**
 * Agent 对话接口   POST /api/agent
 *
 *   请求：{ "question": "11月下旬从深圳去北京哪天便宜" }
 *   响应：{ code: 0, message: "ok",
 *           data: { runId, answer, model, status, rounds, toolCalls, elapsedMs, tokens } }
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这个文件只做三件事
 * ══════════════════════════════════════════════════════════════════════
 *   ① 校参（question 非空、别超长）→ ② 调 runAgent → ③ 按全局约定回包
 *
 * 循环本体在 api/_agentRun.js，工具在 api/_agentTools.js。
 * 这里**刻意不写任何业务逻辑**：命令行（scripts/agent-cli.mjs）和评测集
 * （scripts/agent-eval.mjs）跑的是同一份 runAgent，接口里再长一份逻辑，
 * 就又多了一个和上线代码不一致的真源。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  时间预算：本接口唯一需要动脑的地方
 * ══════════════════════════════════════════════════════════════════════
 *  三层超时由内到外逐层放大，中间这层就是本函数：
 *      单轮模型 15s  <  本函数预算 45s  <  Vercel maxDuration 60s  <  浏览器 65s
 *
 *  为什么预算要定在 45s 而不是 58s：
 *    Vercel 掐断是**硬断连接**，前端只会看到「网络异常」——我们自己准备好的
 *    那句中文报错永远没机会发出去。所以必须在平台上限之内**主动收尾**，
 *    哪怕收尾的结论是「这次没答完」。
 *
 *  正常一问的耗时拼起来（实测过的量级）：
 *    模型第 1 轮 2~5s（决定调哪个工具）+ 日历 0~35s + 末轮 2~5s ≈ 40s 以内。
 *
 *  ⚠️ 已知残余风险，写在明处，不假装没有：
 *    预算是**轮间**检查的，不是每次 I/O 之前检查的。若模型在拿到日历之后
 *    又要查一条**不同航线**（同航线有缓存救得了、不同航线救不了），
 *    那一轮可能在 45s 之后再加一次 35s 的日历 ⇒ 越过 60s 被平台掐断。
 *    概率低但存在。彻底解决要把 deadline 穿透到工具层（每次调用只取剩余预算），
 *    那要改 _agentRun + _agentTools 两个文件，不在本次改动范围。
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
import { resolveLLM, runAgent } from './_agentRun.js';

/** 用户原话上限。不是性能考虑：超长输入意味着这不是一句提问，别让模型替我们读文章。 */
const MAX_QUESTION = 300;

const BUDGET = {
  /** 整轮预算，必须明显小于 vercel.json 的 maxDuration(60s)，见文件头 */
  totalMs: 45_000,
  /** 单轮模型调用。15s 对 flash 这种模型足够；设大了会把日历的时间挤掉 */
  llmMs: 15_000,
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
 */
const SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后再试';
const MODEL_ERROR_MESSAGE = '模型服务暂时不可用，请稍后再试';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
    return;
  }

  // 紧急刹车：账单或模型出问题时，改环境变量比重发一版代码快
  if (process.env.AGENT_DISABLED === '1') {
    res.status(503).json({
      code: 5030,
      message: 'Agent 功能已临时关闭',
      data: null,
    });
    return;
  }

  // ── 入参校验：后端这份是唯一防线（前端那份只管体验）──
  const payload = req.body ?? {};
  const question = String(payload.question ?? '').trim();

  if (!question) {
    res.status(400).json({ code: 4000, message: 'question 不能为空', data: null });
    return;
  }
  if (question.length > MAX_QUESTION) {
    res.status(400).json({
      code: 4000,
      message: `question 最多 ${MAX_QUESTION} 字，收到 ${question.length} 字`,
      data: null,
    });
    return;
  }

  const llm = { ...resolveLLM(), timeoutMs: BUDGET.llmMs };
  if (!llm.apiKey) {
    // 配置缺失回 500（我们自己的锅），不是 502（外部源的锅）—— 跟 api/result.js 同口径
    // 这条日志不是可选的：对外已经被抹成一句通用提示，这里是**唯一**知道真因的地方
    console.error('[agent] 配置缺失：未设置 DEEPSEEK_API_KEY，无法调用模型');
    res.status(500).json({ code: 5000, message: SERVER_ERROR_MESSAGE, data: null });
    return;
  }

  let result;
  try {
    result = await runAgent({
      question,
      surface: 'chat',
      llm,
      maxDurationMs: BUDGET.totalMs,
      onEvent: logEvent,
    });
  } catch (e) {
    // 走到这里说明是**编排层自己**抛了（数据库连不上、形态不对之类）
    // 完整堆栈只进日志：e.message 里可能有连接串、表名，对用户全是噪音
    console.error('[agent] 编排层异常：', e);
    res.status(500).json({ code: 5000, message: SERVER_ERROR_MESSAGE, data: null });
    return;
  }

  // ── 三种收尾，分别对应三种「用户该知道的事」──
  // 注意：run 已经完整落库了，即便这里回 5xx，runId 也能在库里查到。
  if (result.status === 'failed') {
    // status=failed 只有一条来路：模型调用抛了。failure 形如
    // 「第 2 轮模型调用失败：模型接口 401：{...}」，后半段是上游原文，
    // 里面有 URL、状态码、偶尔还有 key 片段 —— 给日志，不给用户。
    console.error(`[agent] run ${result.runId} 模型侧失败：${result.failure}`);
    res.status(502).json({ code: 5020, message: MODEL_ERROR_MESSAGE, data: null });
    return;
  }
  if (result.status === 'aborted') {
    // 预算用尽 / 轮数或工具次数到顶。504 的语义是「服务端没能及时完成」，
    // 原因写进 message —— 不给用户一句含糊的「稍后重试」。
    console.warn('[agent] run 未完成：', result.failure);
    res.status(504).json({
      code: 5040,
      message: `这次没能答完：${result.failure}`,
      data: null,
    });
    return;
  }
  if (!String(result.answer ?? '').trim()) {
    // status=ok 但一个字都没有：模型空转了一轮。当成失败，别让前端弹个空气泡。
    console.warn('[agent] 模型返回空回答，runId =', result.runId);
    res.status(502).json({
      code: 5020,
      message: '模型返回了空回答，请重试一次',
      data: null,
    });
    return;
  }

  res.status(200).json({
    code: 0,
    message: 'ok',
    data: {
      runId: result.runId,
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

/**
 * 进度回调只写日志，不回给前端。
 *
 * 为什么值得留：线上出问题时，`vercel logs` 里这几行是**唯一**能立刻看出
 * 「它第几轮调了哪个工具、花了多久、失败在哪个工具」的东西 ——
 * 库里虽然有 agent_step，但那是要连数据库才能看的。
 *
 * ⚠️ 这里刻意不打 args 全文：里面可能有邮箱，日志是比数据库更容易被翻看的地方。
 */
function logEvent(ev) {
  switch (ev.type) {
    case 'round':
      console.log(`[agent] 第 ${ev.round} 轮：${ev.wantsTools ? `要调 ${ev.wantsTools} 个工具` : '给出回答'}`);
      break;
    case 'tool':
      console.log(
        `[agent]   ${ev.name} ${ev.ok ? 'ok' : `✗ ${ev.code}`} ${ev.durationMs}ms` +
          (ev.ok ? '' : ` — ${ev.message}`),
      );
      break;
    case 'llm-error':
      console.error(`[agent] 第 ${ev.round} 轮模型失败：${ev.message}`);
      break;
    case 'db-warn':
      // 记账失败不影响回答，但必须留痕 —— 否则「为什么库里缺了这次 run」永远查不清
      console.warn(`[agent] 落库异常：${ev.message}`);
      break;
    default:
      break;
  }
}
