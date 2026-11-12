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
 *    { type: 'llm-start', round }               ← 调用模型**之前**抛，填「正在想」的静默
 *    { type: 'round',  round, wantsTools }      ← 模型返回**之后**抛
 *    { type: 'tool-start', round, name, args }   ← 开始执行前抛，两端之间的等待靠它填
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
 *  「贵不贵」只能引用工具算好的字段，模型的任务是把结论讲成人话。
 *
 *  ⚠️ 第 9 条只在**多轮**时出现（multiTurn）。单轮注入它等于提醒模型
 *     「你有历史可引用」，反而诱导它在没有历史时也去编 —— 而且会让
 *     评测集（单轮）跑在和线上（多轮）不一样的 prompt 上。
 */
export function buildSystemPrompt(today = todayForAgent(), { multiTurn = false } = {}) {
  const rules = [
    '你是「该买机票吗」的助手，帮用户判断机票什么时候买、哪天走划算。',
    `今天是 ${today}（东八区）。所有日期都用 YYYY-MM-DD。`,
    '',
    '铁律（违反任何一条都算回答失败）：',
    '1. 贵不贵不许自己算：不要拿日历里的价格自己比较、求平均、估分位。',
    '   档位和「贵还是便宜」只能引用工具返回的 level 和 vsTypical 字段。',
    '2. 工具返回的档位取值是英文，回答里必须换成中文，一一对应，不许把英文原样写出来',
    '   （机场代码 SZX/PEK 这种除外，那是给用户看的真代码）：',
    '   level  low = 偏低，typical = 正常，high = 偏高。',
    '   vsTypical  below = 已在典型区间下沿或更低，within = 落在典型区间内，',
    '   above = 已在典型区间上沿或更高。',
    '   照抄上面这几种说法，不许自己加程度（「还更低」「比平时便宜很多」都不行）。',
    '   价格正好等于区间下沿或上沿时，用「下沿或更低 / 上沿或更高」的写法，两边都成立。',
    '3. 最便宜的那几天只能来自 find_cheapest_days，不要自己从日历里挑。',
    '4. 工具返回 available:false 时，如实说明原因（数据不足 / 超出可查范围 / 这天没有数据），',
    '   不许编一个档位，也不许用「应该不贵」「大概正常」这类话糊过去。',
    '5. 你没有写库权限。用户想订阅时调 create_subscription_draft，产出的是待确认的草稿，',
    '   缺字段就问用户，不要自己编邮箱、编价格。',
    '6. 机场只能填三位代码（如 SZX、PEK）。用户说城市名时，问他或按常识换算并说明你换成了哪个代码。',
    '7. 回答用中文，简短。先说结论，再说依据（第几天的价是多少、落在哪个档位）。',
    '8. 工具名只给你自己看，回答里一个字都不许出现。',
    '   find_cheapest_days / search_price_calendar / judge_one_day / search_flights /',
    '   compare_two_dates / create_subscription_draft 这些名字用户看不懂，写出来像报错日志。',
    '   要说「我查了 12-01 到 12-10 的票价」，不要说「用 find_cheapest_days 查」。',
  ];

  // ── 只在多轮追加 ──
  // 这一条是多轮里最容易犯的错：上一轮答案里写着「11-27 是 1650」，
  // 用户追问「那 11-28 呢」，模型顺口就说「差不多，也是 1650 左右」—— 但它这轮根本没查。
  // 单轮时没有历史可引用，写进去只是噪音。
  if (multiTurn) {
    rules.push(
      '9. 上面几轮的问答只用来理解「他在问什么」（比如「那 11-28 呢」指哪条航线、哪天），',
      '   里面的价格、档位、最便宜的日子一律不能引用 —— 那是上一轮查的，此刻已经不代表现状。',
      '   多少价格、什么档位、哪天最便宜，都必须本轮重新调工具查一遍。',
      '   哪怕历史里明明写着「11-27 是 1650」，也不许说「差不多，也是 1650」。',
      '   查不出来就直说查不出来，不要拿历史里的数字顶上。',
    );
  }

  return rules.join('\n');
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

function createRecorder({ surface, model, ownerId = 'owner', conversationId = null, onEvent }) {
  let runId = null;
  /** 步号自增。不要用「轮数×2」去算 —— 一次回复带两个工具调用就会撞出两行同 seq。 */
  let seq = 0;

  async function start(input) {
    try {
      const { data, error } = await getSupabase()
        .from('agent_run')
        .insert({
          // ★ 必须和会话的 owner_id 同源：写死 'owner' 的话，将来接登录后
          //   会话按用户分、run 全归 'owner'，历史接口按 owner 一过滤就查不到自己的消息
          owner_id: ownerId,
          surface,
          // null 是合法值（命令行 / 评测集没有会话），列允许空
          conversation_id: conversationId,
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
 *  @param {Array}    [opts.history]       之前几轮的 [{role,content}]，拼在本次提问之前
 *  @param {string}   [opts.conversationId] 所属会话，落库用；命令行/评测集不传
 *  @param {string}   [opts.ownerId]       身份，默认 'owner'（与其它表一致）
 *  @param {Function} [opts.onEvent]       进度回调，不传就静默
 *  @returns {Promise<{runId,status,rounds,toolCalls,answer,failure,usage,elapsedMs,stats,model}>}
 */
export async function runAgent({
  question,
  surface = 'chat',
  llm = resolveLLM(),
  maxDurationMs = 120_000,
  history = [],
  conversationId = null,
  ownerId = 'owner',
  onEvent = () => {},
}) {
  if (!llm.apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY');
  }

  const ctx = createToolContext();
  const messages = [
    // 有历史才注入铁律 9 —— 单轮时它只是噪音，还会让评测集和线上跑在两条 prompt 上
    { role: 'system', content: buildSystemPrompt(todayForAgent(), { multiTurn: history.length > 0 }) },
    // ★ 历史是「对话背景」，不是「数据来源」。它只能帮模型听懂指代，
    //   里面任何价格都不作数 —— 那条约束在提示词里，也在 _conversation.js 的注释里。
    ...history,
    { role: 'user', content: question },
  ];
  const recorder = createRecorder({ surface, model: llm.model, ownerId, conversationId, onEvent });

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

    // ★ 必须在 callLLM **之前**抛。round 事件是模型返回之后才抛的，
    //   所以单靠它表达不了「正在想」—— 中间那 2~5 秒在流式界面上是纯静默，
    //   而纯静默正是这次改造要消灭的东西。跟 tool-start 同一个道理。
    onEvent({ type: 'llm-start', round: rounds });

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

      // ★ 「开始执行」必须在 runTool 之前抛，这是它存在的全部意义。
      //   下面的 tool 事件是**执行完之后**才发的（带上耗时与结果），
      //   两者之间是整段工具耗时 —— 日历最长 35s。只有 tool 事件的话，
      //   前端在「模型决定要查」到「查完了」之间收不到任何字节，用户看到的是干等。
      //   ⚠️ args 会带给前端，但它可能含邮箱等用户输入，展示层只许用 name。
      onEvent({ type: 'tool-start', round: rounds, name, args });

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
