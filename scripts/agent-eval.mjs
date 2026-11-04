/**
 * Agent 评测集（回归裁判）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么需要这个文件
 * ══════════════════════════════════════════════════════════════════════
 *  模型不是确定性的。同一句话今天调 1 个工具、明天调 3 个，两个答案都「看起来对」。
 *  所以改提示词、换模型、加工具之后，必须有一份能判对错的东西 —— 否则每次改动
 *  都只能靠手感，而手感不会告诉你「昨天能用的问题今天挂了」。
 *
 *  它测的是**能观测到的行为**，不是「感觉好不好」：
 *    · 该调的工具调了没有、不该调的调了没有
 *    · 轮数、工具调用次数有没有失控
 *    · 答案里引用的数字是不是工具算出来的
 *    · 该说「查不到」的时候有没有编
 *
 * ══════════════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════════════
 *   ① 先白嫖：只检查用例表本身写对没写对，不调模型、不花钱
 *        node scripts/agent-eval.mjs --check
 *
 *   ② 跑全量（数据走回放，只烧 token）
 *        node scripts/agent-eval.mjs --replay
 *
 *   ③ 只跑一条 / 看模型原话
 *        node scripts/agent-eval.mjs --replay --only compare-two-dates -v
 *
 *   ④ 同一题跑三次，看稳不稳（模型非确定性，单次通过不算数）
 *        node scripts/agent-eval.mjs --replay --repeat 3 --only subscribe-draft
 *
 *  退出码：全部用例 100% 通过才 0，否则 1。
 *
 *  ⚠️ 每条用例都要真调模型，8 条全跑大约 3~4 万输入 token（几分钱）。
 *     数据走 --replay 时不吃 Apify / SerpApi 额度。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../api/_agentTools.js';
import { resolveLLM, runAgent } from '../api/_agentRun.js';

/**
 * 答案里绝对不该出现的名字 —— 从工具表直接取，不手抄：
 * 以后加了新工具，这条检查自动覆盖，不用记得回来改。
 */
const TOOL_NAME_LEAKS = TOOLS.map((t) => t.function.name);

/**
 * 档位取值也必须换成中文（提示词铁律 2）。用词边界匹配是因为
 * 「below」里含「low」——直接 includes 会把合法答案判挂。
 * 机场代码（SZX/PEK）不在此列，那是给用户看的真代码。
 */
const VALUE_LEAKS = [/\blow\b/i, /\btypical\b/i, /\bhigh\b/i, /\bbelow\b/i, /\bwithin\b/i, /\babove\b/i];

const ROOT = join(import.meta.dirname, '..');
const CASES_FILE = join(ROOT, 'scripts', 'eval-cases.json');
const MAX_DURATION_MS = 90_000;

/* ── 环境变量与参数 ─────────────────────────────────────────────────── */
try {
  process.loadEnvFile(join(ROOT, '.env.local'));
} catch {
  // 没有 .env.local 时靠命令行传
}

const argv = process.argv.slice(2);
const REPLAY = argv.includes('--replay');
const CHECK_ONLY = argv.includes('--check');
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const repeatIdx = argv.indexOf('--repeat');
const REPEAT = Math.max(1, Number(repeatIdx >= 0 ? argv[repeatIdx + 1] : 1) || 1);

if (REPLAY) {
  process.env.APIFY_REPLAY = '1';
  process.env.SERP_REPLAY = '1';
}

const doc = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
const allCases = doc.cases ?? [];
const cases = ONLY ? allCases.filter((c) => c.id.includes(ONLY)) : allCases;

if (!cases.length) {
  console.error(ONLY ? `没有 id 含「${ONLY}」的用例` : '用例表是空的');
  process.exit(1);
}

/* ══════════════════════════════════════════════════════════════════════
 *  --check：只验用例表自身，不花钱
 * ══════════════════════════════════════════════════════════════════════ */
if (CHECK_ONLY) {
  const toolNames = new Set(TOOLS.map((t) => t.function.name));
  const ids = new Set();
  let bad = 0;

  const fail = (msg) => {
    bad += 1;
    console.log(`  ✗ ${msg}`);
  };

  for (const c of cases) {
    const name = c.id ?? '(无 id)';
    if (!c.id) fail('用例缺少 id');
    if (ids.has(c.id)) fail(`${name}：id 重复`);
    ids.add(c.id);
    if (!String(c.question ?? '').trim()) fail(`${name}：question 为空`);
    if (!c.expect || typeof c.expect !== 'object') fail(`${name}：缺少 expect`);
    if (!c.note) fail(`${name}：缺少 note（说明这条在防什么，将来才知道能不能删）`);

    const e = c.expect ?? {};
    for (const key of ['toolsAll', 'toolsNone']) {
      for (const t of e[key] ?? []) {
        // 工具名打错是最常见的静默失败：断言永远不触发，看起来永远是绿灯
        if (!toolNames.has(t)) fail(`${name}：${key} 里的「${t}」不是已注册的工具`);
      }
    }
    for (const key of ['answerIncludes', 'answerIncludesAny', 'answerExcludes']) {
      if (e[key] && !Array.isArray(e[key])) fail(`${name}：${key} 应该是数组`);
    }
    if (!e.toolsAll && !e.toolsNone && !e.answerIncludes && !e.answerIncludesAny && !e.answerExcludes) {
      console.log(`  ⚠️ ${name}：只验了预算与状态，没验工具选择 —— 确认这是有意的`);
    }
  }

  console.log(`\n已注册工具：${[...toolNames].join(', ')}`);
  console.log(bad ? `用例表有 ${bad} 处问题` : `用例表 OK：${cases.length} 条`);
  process.exit(bad ? 1 : 0);
}

/* ══════════════════════════════════════════════════════════════════════
 *  跑评测
 * ══════════════════════════════════════════════════════════════════════ */
const LLM = resolveLLM();
if (!LLM.apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY（写进 .env.local 即可）。想先白嫖请加 --check。');
  process.exit(1);
}

console.log(`\n══ 评测 ${cases.length} 条 · 每条跑 ${REPEAT} 次 · 数据${REPLAY ? '回放' : '真机'} · 模型 ${LLM.model} ══`);

/** 单次 run 的断言结果 */
function evaluate(expect, result, toolNames) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });

  if (expect.status) {
    add(result.status === expect.status, `status=${result.status}${result.failure ? `（${result.failure}）` : ''}`);
  }

  for (const t of expect.toolsAll ?? []) {
    add(toolNames.includes(t), `调用了 ${t}${toolNames.includes(t) ? '' : `（实际：${toolNames.join('/') || '无'}）`}`);
  }
  for (const t of expect.toolsNone ?? []) {
    add(!toolNames.includes(t), `没有调用 ${t}`);
  }
  if (expect.maxRounds != null) {
    add(result.rounds <= expect.maxRounds, `轮数 ${result.rounds} ≤ ${expect.maxRounds}`);
  }
  if (expect.maxToolCalls != null) {
    add(result.toolCalls <= expect.maxToolCalls, `工具调用 ${result.toolCalls} 次 ≤ ${expect.maxToolCalls}`);
  }

  const answer = result.answer ?? '';
  for (const s of expect.answerIncludes ?? []) {
    add(answer.includes(s), `答案含「${s}」`);
  }
  // 「至少出现一个」必须整体判一次 —— 逐个 add 会变成「全都要有」，语义正好相反
  if (expect.answerIncludesAny?.length) {
    const hit = expect.answerIncludesAny.find((s) => answer.includes(s));
    add(Boolean(hit), `答案含 ${expect.answerIncludesAny.map((s) => `「${s}」`).join(' 或 ')}（命中：${hit ?? '无'}）`);
  }
  for (const s of expect.answerExcludes ?? []) {
    add(!answer.includes(s), `答案不含「${s}」`);
  }

  // 全局规则（提示词铁律 8）：工具名只给模型自己看，任何用例的答案里都不许出现。
  // 不写进每条用例 —— 写进用例就得逐条维护，漏一条就漏一个口子。
  for (const s of TOOL_NAME_LEAKS) {
    add(!answer.includes(s), `答案不泄漏工具名「${s}」`);
  }
  for (const re of VALUE_LEAKS) {
    add(!re.test(answer), `答案不泄漏英文档位「${re.source.replaceAll('\\b', '')}」`);
  }

  return checks;
}

let totalPrompt = 0;
let totalCompletion = 0;
let failedCases = 0;
let flakyCases = 0;

for (const [i, c] of cases.entries()) {
  const runs = [];
  for (let n = 0; n < REPEAT; n += 1) {
    const toolNames = [];
    let result;
    try {
      result = await runAgent({
        question: c.question,
        surface: 'eval',
        llm: LLM,
        maxDurationMs: MAX_DURATION_MS,
        onEvent: (e) => {
          if (e.type === 'tool') toolNames.push(e.name);
        },
      });
    } catch (err) {
      result = {
        status: 'crashed',
        rounds: 0,
        toolCalls: 0,
        answer: null,
        failure: err.message,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      };
    }
    totalPrompt += result.usage?.prompt_tokens ?? 0;
    totalCompletion += result.usage?.completion_tokens ?? 0;
    runs.push({ result, checks: evaluate(c.expect ?? {}, result, toolNames), toolNames });
  }

  const passed = runs.filter((r) => r.checks.every((x) => x.ok)).length;
  const mark = passed === runs.length ? '✓' : passed === 0 ? '✗' : '~';
  if (passed === 0) failedCases += 1;
  else if (passed < runs.length) flakyCases += 1;

  console.log(`\n${i + 1}. ${mark} ${c.id}  ${passed}/${runs.length}`);
  console.log(`   ${c.note ?? ''}`);

  for (const [n, run] of runs.entries()) {
    const bad = run.checks.filter((x) => !x.ok);
    if (!bad.length && !VERBOSE) continue;

    // 只跑一次时不用标「第 N 次」
    const prefix = runs.length > 1 ? `第 ${n + 1} 次：` : '';
    if (bad.length) {
      for (const b of bad) console.log(`     ✗ ${prefix}${b.text}`);
      if (VERBOSE) {
        console.log(`     工具：${run.toolNames.join(' → ') || '无'}`);
        console.log(`     答：${run.result.answer ?? '（无）'}`);
      }
    } else {
      console.log(`     ✓ ${prefix}全部 ${run.checks.length} 条断言通过`);
      console.log(`     工具：${run.toolNames.join(' → ') || '无'}`);
      console.log(`     答：${run.result.answer ?? '（无）'}`);
    }
  }
}

/* ── 汇总 ───────────────────────────────────────────────────────────── */
const okCount = cases.length - failedCases - flakyCases;
console.log('\n══════════ 汇总 ══════════');
console.log(`通过 ${okCount}/${cases.length}｜不稳定 ${flakyCases}｜失败 ${failedCases}`);
console.log(`token 输入 ${totalPrompt} / 输出 ${totalCompletion}`);

if (flakyCases) {
  console.log('\n「不稳定」= 同一条用例多次跑结果不一致。模型本身有随机性，');
  console.log('但如果某条反复不稳定，说明提示词在那条上存在歧义，需要写得更死。');
}

if (failedCases || flakyCases) process.exitCode = 1;
