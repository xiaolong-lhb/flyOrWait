/**
 * Agent 编排层（命令行版）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这个文件是干什么的
 * ══════════════════════════════════════════════════════════════════════
 *  _agentTools.js 提供「工具」（执行器，一次一个）。
 *  这里提供「循环」——谁来决定调哪个工具、调几次、什么时候停。
 *
 *     用户原话
 *        ↓
 *     [模型] ←──── 系统提示 + 工具说明书(TOOLS) + 历史
 *        ↓ 说要调 xxx
 *     [runTool] 执行 → 结果塞回历史
 *        ↓ 再来一轮（最多 maxRounds 轮）
 *     [模型] 不再要工具 → 它说的就是答案
 *
 *  ⚠️ 为什么先做命令行、不直接做 /api 接口：
 *     ① 接口有 55s/60s 的硬上限（见 _agentTools.js 头部的已知约束），
 *        而这里要反复试模型、看它到底怎么选工具 —— CLI 没有这个枷锁；
 *     ② 先在 CLI 把「模型会不会乱来」看明白，再谈接前端，
 *        否则等于同时调两头，出了问题不知道是哪头的。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════════════
 *   ① 数据走回放（不烧 Apify/SerpApi 额度，最适合调 prompt）：
 *        node scripts/agent-cli.mjs --replay "11月下旬从深圳去北京哪天便宜"
 *
 *   ② 真机全链路（真抓数据源，一次 20~60 秒）：
 *        node scripts/agent-cli.mjs "11月下旬从深圳去北京哪天便宜"
 *
 *   环境变量（写进 .env.local，脚本自动加载）：
 *     DEEPSEEK_API_KEY   必填
 *     DEEPSEEK_BASE_URL  选填，默认 https://api.deepseek.com
 *     DEEPSEEK_MODEL     选填，默认 deepseek-chat
 *
 * ══════════════════════════════════════════════════════════════════════
 *  几条刻意的选择
 * ══════════════════════════════════════════════════════════════════════
 *  · 裸 fetch，不装 SDK。Node 24 自带 fetch，DeepSeek 是 OpenAI 兼容格式，
 *    多一层 SDK 只会把「消息怎么拼、tool_calls 怎么回填」藏起来 —— 而这正是要学的地方。
 *  · 每一步都写 agent_run / agent_step。不是可选装饰：
 *    模型乱来的时候，唯一的证据就是「它第几轮调了什么、参数是什么、拿到了什么」。
 *  · 预算闸门（轮数 / 工具次数 / 总时长）写死在 AGENT_LIMITS 里。
 *    不加闸门的 agent 迟早会给你一张超时的账单。
 */
import { join } from 'node:path';
import { AGENT_LIMITS, TOOLS, runTool, createToolContext, todayForAgent } from '../api/_agentTools.js';
import { getSupabase } from '../api/_supabase.js';

const ROOT = join(import.meta.dirname, '..');

/* ── 环境变量 ─────────────────────────────────────────────────────────
 * 读 .env.local 的顺序与 scripts/dev-api.mjs 一致；命令行里的变量优先级更高
 * （loadEnvFile 不会覆盖已存在的 process.env）。 */
try {
  process.loadEnvFile(join(ROOT, '.env.local'));
} catch {
  console.log('[env] 没有 .env.local，环境变量只能从命令行传');
}

/* ── 命令行参数 ─────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);

// mock 模式已删除。这里仍要拦一下：否则「--mock」会被下面的过滤器当成普通参数丢掉，
// 结果是悄无声息地真跑一次花钱的模型 —— 宁可报错。
if (argv.includes('--mock')) {
  console.error('--mock 已移除，现在直连真模型。想省数据源额度请加 --replay（token 照样消耗）。');
  process.exit(1);
}

const REPLAY = argv.includes('--replay');
if (REPLAY) {
  // 回放开关只在这里设，不许写进 api/（线上误判会去读被 .vercelignore 排除的 samples/）
  process.env.APIFY_REPLAY = '1';
  process.env.SERP_REPLAY = '1';
}

const question = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
if (!question) {
  console.error('用法：node scripts/agent-cli.mjs [--replay] "你的问题"');
  process.exit(1);
}

const LLM = {
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
};

/**
 * CLI 的时间预算比线上宽松：线上被 vercel.json 的 maxDuration:60 卡死，
 * 这里没有那个枷锁，但仍要有个上限 —— 免得模型绕圈时你干等十分钟。
 */
const MAX_DURATION_MS = 120_000;

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
 *  系统提示
 * ══════════════════════════════════════════════════════════════════════
 *  这里只写「模型该遵守什么」，不写任何判据算法。
 *  「贵不贵」只能引用工具算好的字段，模型的任务是把结论讲成人话。 */
function buildSystemPrompt() {
  return [
    '你是「该买机票吗」的助手，帮用户判断机票什么时候买、哪天走划算。',
    `今天是 ${todayForAgent()}（东八区）。所有日期都用 YYYY-MM-DD。`,
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
async function callLLM(messages) {
  const res = await fetch(`${LLM.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM.apiKey}`,
    },
    body: JSON.stringify({
      model: LLM.model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.2, // 判断类任务要稳，不要发挥
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`模型接口 ${res.status}：${text.slice(0, 300)}`);
  }

  const body = JSON.parse(text);
  const message = body?.choices?.[0]?.message;
  if (!message) throw new Error(`模型返回里没有 message：${text.slice(0, 300)}`);

  // ★ deepseek-reasoner 会带 reasoning_content。把它塞回下一次请求会被接口拒绝，
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

/* ══════════════════════════════════════════════════════════════════════
 *  落库：agent_run / agent_step
 * ══════════════════════════════════════════════════════════════════════
 *  ★ 写日志失败**不能让整个 run 挂掉**：用户要的是答案，不是我们的记账。
 *    但也不能静默 —— 打一行警告，让你知道「这次没留下证据」。 */

let runId = null;
/** 步号自增。不要用「轮数×2」去算 —— 一次回复带两个工具调用就会撞出两行同 seq。 */
let stepSeq = 0;

async function startRun(input) {
  try {
    const { data, error } = await getSupabase()
      .from('agent_run')
      .insert({
        owner_id: 'owner', // 项目暂不做登录，跟其它表一致
        surface: 'chat',
        input_text: input,
        status: 'running',
        model: LLM.model,
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    runId = data.id;
    console.log(`[db] agent_run 已创建：${runId}`);
  } catch (err) {
    console.warn(`[db] ⚠️ 建 agent_run 失败，本次不落库：${err.message}`);
    runId = null;
  }
}

async function logStep(step) {
  if (!runId) return;
  try {
    stepSeq += 1;
    const { error } = await getSupabase()
      .from('agent_step')
      .insert({ run_id: runId, seq: stepSeq, ...step });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(`[db] ⚠️ 写 agent_step 失败：${err.message}`);
  }
}

async function finishRun(patch) {
  if (!runId) return;
  try {
    const { error } = await getSupabase()
      .from('agent_run')
      .update({ finished_at: new Date().toISOString(), ...patch })
      .eq('id', runId);
    if (error) throw new Error(error.message);
    console.log(`[db] agent_run 已收尾：status=${patch.status}`);
  } catch (err) {
    console.warn(`[db] ⚠️ 收尾 agent_run 失败：${err.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 *  主循环
 * ══════════════════════════════════════════════════════════════════════ */

async function main() {
  if (!LLM.apiKey) {
    console.error('缺少 DEEPSEEK_API_KEY（写进 .env.local 即可，脚本会自动加载）。');
    process.exit(1);
  }

  const ctx = createToolContext();
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: question },
  ];

  console.log(`\n[run] 模型 = ${LLM.model}${REPLAY ? '｜数据 = 回放' : '｜数据 = 真机'}`);
  console.log(`[run] 问题 = ${question}\n`);

  await startRun(question);

  const startedAt = Date.now();
  let rounds = 0;
  let answer = null;
  let failure = null;
  let aborted = false;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  while (rounds < AGENT_LIMITS.maxRounds) {
    // 预算闸门：模型绕圈时，这里先兜住
    if (Date.now() - startedAt > MAX_DURATION_MS) {
      aborted = true;
      failure = `超过总时长预算 ${MAX_DURATION_MS / 1000}s`;
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
      res = await callLLM(messages);
    } catch (err) {
      failure = `第 ${rounds} 轮模型调用失败：${err.message}`;
      break;
    }

    const { message } = res;
    if (res.usage) {
      usage.prompt_tokens += res.usage.prompt_tokens ?? 0;
      usage.completion_tokens += res.usage.completion_tokens ?? 0;
    }
    messages.push(message);

    const wantsTools = message.tool_calls?.length ?? 0;
    console.log(`── 第 ${rounds} 轮 ── 模型${wantsTools ? `要求调 ${wantsTools} 个工具` : '给出回答'}`);

    await logStep({
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
        // 模型给了坏 JSON：当成参数错误回给它，让它自己重写，不要整轮崩掉
        console.log(`   ⚠️ ${name} 参数不是合法 JSON，已回退`);
      }

      const tt = Date.now();
      // 关键：同一个 ctx 传进去，缓存才活得下来（一次 run 只抓一次日历）
      const out = await runTool(name, args, ctx);
      const cost = Date.now() - tt;

      console.log(`   → ${name}（${cost}ms）${out.ok ? '' : ` ✗ ${out.error.code}`}`);
      if (!out.ok) console.log(`     ${out.error.message}`);

      await logStep({
        kind: 'tool',
        tool_name: name,
        args: summarize(args),
        result: summarize(out),
        ok: out.ok,
        error: out.ok ? null : out.error.message,
        duration_ms: cost,
      });

      // 无论成功失败都回给模型：失败也是一条事实，它有权据此改参数重试
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(out),
      });
    }
  }

  if (!answer && !failure) {
    if (rounds >= AGENT_LIMITS.maxRounds) {
      aborted = true;
      failure = `达到最大轮数 ${AGENT_LIMITS.maxRounds}，模型仍未给出回答`;
    }
  }

  const status = failure ? (aborted ? 'aborted' : 'failed') : 'ok';

  await finishRun({
    status,
    rounds,
    tool_calls: ctx.stats.toolCalls,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    answer: answer ?? null,
    error: failure,
    meta: {
      replay: REPLAY,
      elapsed_ms: Date.now() - startedAt,
      calendar_fetches: ctx.stats.calendarFetches,
      cache_hits: ctx.stats.cacheHits,
    },
  });

  console.log('\n══════════ 结果 ══════════');
  if (answer) console.log(answer);
  else console.log(`（没有给出回答：${failure}）`);

  console.log('\n── 本次账单 ──');
  console.log(`轮数 ${rounds}｜工具调用 ${ctx.stats.toolCalls} 次｜日历抓取 ${ctx.stats.calendarFetches} 次｜缓存命中 ${ctx.stats.cacheHits}`);
  console.log(`token 输入 ${usage.prompt_tokens} / 输出 ${usage.completion_tokens}｜耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log(`状态 ${status}${runId ? `｜run_id ${runId}` : '｜未落库'}`);

  if (status !== 'ok') process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n[致命] 编排层崩了：', err);
  process.exitCode = 1;
});
