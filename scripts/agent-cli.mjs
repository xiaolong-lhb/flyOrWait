/**
 * Agent 命令行入口
 *
 * ══════════════════════════════════════════════════════════════════════
 *  这个文件只做三件事
 * ══════════════════════════════════════════════════════════════════════
 *  ① 读命令行参数（问题、--replay）
 *  ② 把 api/_agentRun.js 抛出的进度事件打成给人看的样子
 *  ③ 把最终账单打出来，失败时置 exitCode=1
 *
 *  循环、提示词、落库全在 api/_agentRun.js —— 那份代码线上接口也跑，
 *  这样「命令行跑通了」才等于「接口也能跑通」。
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
 */
import { join } from 'node:path';
import { resolveLLM, runAgent } from '../api/_agentRun.js';

const ROOT = join(import.meta.dirname, '..');

// 读 .env.local 的顺序与 scripts/dev-api.mjs 一致；命令行里的变量优先级更高
// （loadEnvFile 不会覆盖已存在的 process.env）。
try {
  process.loadEnvFile(join(ROOT, '.env.local'));
} catch {
  console.log('[env] 没有 .env.local，环境变量只能从命令行传');
}

/* ── 命令行参数 ─────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);

// 这里要拦一下不认识的开关：否则「--mock」会被下面的过滤器当成普通参数丢掉，
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

const LLM = resolveLLM();
if (!LLM.apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY（写进 .env.local 即可，脚本会自动加载）。');
  process.exit(1);
}

/**
 * CLI 的时间预算比线上宽松：线上被 vercel.json 的 maxDuration:60 卡死，
 * 这里没有那个枷锁，但仍要有个上限 —— 免得模型绕圈时你干等十分钟。
 */
const MAX_DURATION_MS = 120_000;

/* ── 事件 → 人看的文字 ──────────────────────────────────────────────── */
function onEvent(e) {
  if (e.type === 'run-created') {
    console.log(`[db] agent_run 已创建：${e.runId}`);
  } else if (e.type === 'round') {
    console.log(`── 第 ${e.round} 轮 ── 模型${e.wantsTools ? `要求调 ${e.wantsTools} 个工具` : '给出回答'}`);
  } else if (e.type === 'tool') {
    console.log(`   → ${e.name}（${e.durationMs}ms）${e.ok ? '' : ` ✗ ${e.code}`}`);
    if (!e.ok) console.log(`     ${e.message}`);
  } else if (e.type === 'llm-error') {
    console.log(`   ✗ 第 ${e.round} 轮模型调用失败：${e.message}`);
  } else if (e.type === 'db-warn') {
    console.warn(`[db] ⚠️ ${e.message}`);
  }
}

/* ── 跑 ─────────────────────────────────────────────────────────────── */
console.log(`\n[run] 模型 = ${LLM.model}${REPLAY ? '｜数据 = 回放' : '｜数据 = 真机'}`);
console.log(`[run] 问题 = ${question}\n`);

let r;
try {
  r = await runAgent({
    question,
    surface: 'cli',
    llm: LLM,
    maxDurationMs: MAX_DURATION_MS,
    onEvent,
  });
} catch (err) {
  console.error('\n[致命] 编排层崩了：', err);
  process.exit(1);
}

console.log('\n══════════ 结果 ══════════');
console.log(r.answer ?? `（没有给出回答：${r.failure}）`);

console.log('\n── 本次账单 ──');
console.log(
  `轮数 ${r.rounds}｜工具调用 ${r.toolCalls} 次｜日历抓取 ${r.stats.calendarFetches} 次｜缓存命中 ${r.stats.cacheHits}`,
);
console.log(
  `token 输入 ${r.usage.prompt_tokens} / 输出 ${r.usage.completion_tokens}｜耗时 ${Math.round(r.elapsedMs / 1000)}s`,
);
console.log(`状态 ${r.status}${r.runId ? `｜run_id ${r.runId}` : '｜未落库'}`);

if (r.status !== 'ok') process.exitCode = 1;
