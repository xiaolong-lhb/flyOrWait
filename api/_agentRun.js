/**
 * Agent 编排层（循环本体）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这个文件是干什么的
 * ══════════════════════════════════════════════════════════════════════
 *  _agentTools.js 提供「工具」（执行器，一次一个）。
 *  这里提供「循环」—— 谁来决定调哪个工具、调几次、什么时候停。
 *
 *     用户原话
 *        ↓
 *     [模型] ←──── 系统提示 + 工具说明书(TOOLS) + 历史
 *        ↓ 说要调 xxx
 *     [runTool] 执行 → 结果塞回历史
 *        ↓ 再来一轮（最多 maxRounds 轮）
 *     [模型] 不再要工具 → 它说的就是答案
 *
 *  ⚠️ 为什么单独成文件、而不是写在某个入口里：
 *     现在有三个入口要跑同一份循环 —— 命令行(scripts/agent-cli.mjs)、
 *     评测集(scripts/agent-eval.mjs)、线上接口(api/agent.js)。
 *     循环要是各写一份，评测集测的就不是上线的代码了。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  进度怎么对外说
 * ══════════════════════════════════════════════════════════════════════
 *  本文件**不打印任何东西**，只通过 onEvent 回调往外抛事件：
 *    { type: 'run-created', runId }
 *    { type: 'round',  round, wantsTools }
 *    { type: 'tool',   round, name, ok, code, message, durationMs, args }
 *    { type: 'llm-error', round, message }
 *    { type: 'db-warn', message }
 *
 *  为什么不让它自己 console.log：命令行要打给人看，接口要吞掉，
 *  评测集要收成数据。三种消费者，一个回调就够，不必分叉逻辑。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  几条刻意的选择
 * ══════════════════════════════════════════════════════════════════════
 *  · 裸 fetch，不装 SDK。Node 自带 fetch，DeepSeek 是 OpenAI 兼容格式，
 *    多一层 SDK 只会把「消息怎么拼、tool_calls 怎么回填」藏起来。
 *  · 每一步都写 agent_run / agent_step。不是可选装饰：
 *    模型乱来的时候，唯一的证据就是「它第几轮调了什么、参数是什么、拿到了什么」。
 *  · 预算闸门（轮数 / 工具次数 / 总时长）三道，缺一道就可能收到一张超时账单。
 */
import { AGENT_LIMITS, TOOLS, runTool, createToolContext, todayForAgent } from './_agentTools.js';
import { getSupabase } from './_supabase.js';

/* ══════════════════════════════════════════════════════════════════════
 *  模型配置：厂商中立
 * ══════════════════════════════════════════════════════════════════════
 *  DeepSeek / Qwen / 智谱 都是 OpenAI 兼容格式，换厂商只改环境变量，
 *  这个文件一个字不用动。 */
export function resolveLLM(env = process.env) {
  return {
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_MODEL || 'deepseek-chat',
    apiKey: env.DEEPSEEK_API_KEY || '',
    /**
     * 单次模型调用超时。默认 60s 是 CLI 的宽松值；
     * 线上接口必须传更小的值（见 api/agent.js），否则一轮就把总预算吃光。
     */
    timeoutMs: Number(env.AGENT_LLM_TIMEOUT_MS) || 60_000,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 *  系统提示
 * ══════════════════════════════════════════════════════════════════════
 *  这里只写「模型该遵守什么」，不写任何判据算法。
 *  「贵不贵」只能引用工具算好的字段，模型的任务是把结论讲成人话。 */
export function buildSystemPrompt(today = todayForAgent()) {
  return [
    '你是「该买机票吗」的助手，帮用户判断机票什么时候买、哪天走划算。',
    `今天是 ${today}（东八区）。所有日期都用 YYYY-MM-DD。`,
    '',
    '铁律（违反任何一条都算回答失败）：',
    '1. 贵不贵不许自己算：不要拿日历里的价格自己比较、求平均、估分位。',
    '   档位和「贵还是便宜」只能引用工具返回的 level 和 vsTypical 字段。',
    '2. 引用 vsTypical 必须照抄它的取值，不许自己形容：',
    '   below = 低于典型区间，within = 落在典型区间内，above = 高于典型区间。',
    '   价格正好等于区间下沿或上沿时就是 within，不许说成「还更低」或「还更高」。',
    '3. 最便宜的那几天只能来自 find_cheapest_days，不要自己从日历里挑。',
    '4. 工具返回 available:false 时，如实说明原因（数据不足 / 超出可查范围 / 这天没有数据），',
    '   不许编一个档位，也不许说「大概是正常价」。',
    '5. 你没有写库权限。用户想订阅时调 create_subscription_draft，产出的是待确认的草稿，',
    '   缺字段就问用户，不要自己编邮箱、编价格。',
    '6. 机场只能填三位代码（如 SZX、PEK）。用户说城市名时，问他或按常识换算并说明你换成了哪个代码。',
    '7. 回答用中文，简短。先说结论，再说依据（第几天的价是多少、落在哪个档位）。',
  ].join('\n');
}

/* ══════════════════════════════════════════════════════════════════════
 *  模型调用
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 真模型（DeepSeek / OpenAI 兼容格式）。
 * @returns {Promise<{message: object, usage: object|null}>}
 */
async function callLLM(messages, llm) {
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.2, // 判断类任务要稳，不要发挥
    }),
    signal: AbortSignal.timeout(llm.timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`模型接口 ${res.status}：${text.slice(0, 300)}`);
  }

  const body = JSON.parse(text);
  const message = body?.choices?.[0]?.message;
  if (!message) throw new Error(`模型返回里没有 message：${text.slice(0, 300)}`);

  // ★ deepseek-reasoner / flash 会带 reasoning_content。把它塞回下一次请求会被接口拒绝，
  //   所以这里只挑需要的字段，未来换模型也不会带进脏字段。
  return {
    message: {
      role: 'assistant',
      content: message.content ?? '',
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    },
    usage: body.usage ?? null,
  };
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

/**
 * 落库前把结果裁一刀。
 * 一张日历一个月是几十行 JSON，全存进去表会很快变大，而排查只看摘要。
 */
function summarize(value, max = 1500) {
  try {
    const s = JSON.stringify(value);
    return s.length <= max ? value : { truncated: true, preview: `${s.slice(0, max)}…` };
  } catch {
    return { unserializable: true };
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  落库：agent_run / agent_step
 * ══════════════════════════════════════════════════════════════════════
 *  ★ 写日志失败**不能让整个 run 挂掉**：用户要的是答案，不是我们的记账。
 *    但也不能静默 —— 抛一条 db-warn 事件，让调用方决定怎么报。 */

function createRecorder({ surface, model, onEvent }) {
  let runId = null;
  /** 步号自增。不要用「轮数×2」去算 —— 一次回复带两个工具调用就会撞出两行同 seq。 */
  let seq = 0;

  async function start(input) {
    try {
      const { data, error } = await getSupabase()
        .from('agent_run')
        .insert({
          owner_id: 'owner', // 项目暂不做登录，跟其它表一致
          surface,
          input_text: input,
          status: 'running',
          model,
        })
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      runId = data.id;
      onEvent({ type: 'run-created', runId });
    } catch (err) {
      onEvent({ type: 'db-warn', message: `建 agent_run 失败，本次不落库：${err.message}` });
      runId = null;
    }
  }

  async function step(row) {
    if (!runId) return;
    try {
      seq += 1;
      const { error } = await getSupabase()
        .from('agent_step')
        .insert({ run_id: runId, seq, ...row });
      if (error) throw new Error(error.message);
    } catch (err) {
      onEvent({ type: 'db-warn', message: `写 agent_step 失败：${err.message}` });
    }
  }

  async function finish(patch) {
    if (!runId) return;
    try {
      const { error } = await getSupabase()
        .from('agent_run')
        .update({ finished_at: new Date().toISOString(), ...patch })
        .eq('id', runId);
      if (error) throw new Error(error.message);
    } catch (err) {
      onEvent({ type: 'db-warn', message: `收尾 agent_run 失败：${err.message}` });
    }
  }

  return { start, step, finish, get runId() { return runId; } };
}

/* ══════════════════════════════════════════════════════════════════════
 *  主循环
 * ══════════════════════════════════════════════════════════════════════
 *  @param {object}   opts
 *  @param {string}   opts.question        用户原话
 *  @param {string}   [opts.surface]       这次 run 从哪来（chat / eval / cli），落进 agent_run.surface
 *  @param {object}   [opts.llm]           不传就按环境变量解析
 *  @param {number}   [opts.maxDurationMs]  总时长预算，线上要传小于平台的 60s
 *  @param {Function} [opts.onEvent]       进度回调，不传就静默
 *  @returns {Promise<{runId,status,rounds,toolCalls,answer,failure,usage,elapsedMs,stats,model}>}
 */
export async function runAgent({
  question,
  surface = 'chat',
  llm = resolveLLM(),
  maxDurationMs = 120_000,
  onEvent = () => {},
}) {
  if (!llm.apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY');
  }

  const ctx = createToolContext();
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: question },
  ];
  const recorder = createRecorder({ surface, model: llm.model, onEvent });

  await recorder.start(question);

  const startedAt = Date.now();
  let rounds = 0;
  let answer = null;
  let failure = null;
  let aborted = false;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  while (rounds < AGENT_LIMITS.maxRounds) {
    // 预算闸门：模型绕圈时，这里先兜住
    if (Date.now() - startedAt > maxDurationMs) {
      aborted = true;
      failure = `超过总时长预算 ${Math.round(maxDurationMs / 1000)}s`;
      break;
    }
    if (ctx.stats.toolCalls >= AGENT_LIMITS.maxToolCalls) {
      aborted = true;
      failure = `工具调用已达上限 ${AGENT_LIMITS.maxToolCalls} 次`;
      break;
    }

    rounds += 1;
    const t0 = Date.now();
    let res;
    try {
      res = await callLLM(messages, llm);
    } catch (err) {
      failure = `第 ${rounds} 轮模型调用失败：${err.message}`;
      onEvent({ type: 'llm-error', round: rounds, message: err.message });
      break;
    }

    const { message } = res;
    if (res.usage) {
      usage.prompt_tokens += res.usage.prompt_tokens ?? 0;
      usage.completion_tokens += res.usage.completion_tokens ?? 0;
    }
    messages.push(message);

    const wantsTools = message.tool_calls?.length ?? 0;
    onEvent({ type: 'round', round: rounds, wantsTools });

    await recorder.step({
      kind: 'llm',
      result: summarize({ content: message.content, tool_calls: message.tool_calls }),
      ok: true,
      duration_ms: Date.now() - t0,
    });

    // 模型不再要工具 → 它说的就是答案
    if (!wantsTools) {
      answer = message.content;
      break;
    }

    // ★ 一次回复可能带多个工具调用：逐个执行，再把这批结果一起回给模型。
    //   绝不能弹出对话框问用户 —— 这个循环里没有人类。
    for (const call of message.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        // 模型给了坏 JSON：当成参数错误回给它，让它自己重写，不要整轮崩掉。
        // args 保持 {}，工具的参数校验会把问题说清楚。
      }

      const tt = Date.now();
      // 关键：同一个 ctx 传进去，缓存才活得下来（一次 run 只抓一次日历）
      const out = await runTool(name, args, ctx);
      const durationMs = Date.now() - tt;

      onEvent({
        type: 'tool',
        round: rounds,
        name,
        ok: out.ok,
        code: out.ok ? null : out.error.code,
        message: out.ok ? null : out.error.message,
        durationMs,
        args,
      });

      await recorder.step({
        kind: 'tool',
        tool_name: name,
        args: summarize(args),
        result: summarize(out),
        ok: out.ok,
        error: out.ok ? null : out.error.message,
        duration_ms: durationMs,
      });

      // 无论成功失败都回给模型：失败也是一条事实，它有权据此改参数重试
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(out),
      });
    }
  }

  if (!answer && !failure && rounds >= AGENT_LIMITS.maxRounds) {
    aborted = true;
    failure = `达到最大轮数 ${AGENT_LIMITS.maxRounds}，模型仍未给出回答`;
  }

  const status = failure ? (aborted ? 'aborted' : 'failed') : 'ok';
  const elapsedMs = Date.now() - startedAt;

  await recorder.finish({
    status,
    rounds,
    tool_calls: ctx.stats.toolCalls,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    answer: answer ?? null,
    error: failure,
    meta: {
      surface,
      elapsed_ms: elapsedMs,
      calendar_fetches: ctx.stats.calendarFetches,
      cache_hits: ctx.stats.cacheHits,
    },
  });

  return {
    runId: recorder.runId,
    status,
    rounds,
    toolCalls: ctx.stats.toolCalls,
    answer,
    failure,
    usage,
    elapsedMs,
    stats: ctx.stats,
    model: llm.model,
  };
}
