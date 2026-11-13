/**
 * 一次性探针：回答「模型的工具调用轮会不会吐 content」。
 *
 * 用途：决定 v2 逐字流用 B（边到边显示 + 可撤回）还是 B'（延迟 200ms 再显示）。
 * 这两条都建立在「工具轮 content 为空」这个假设上，而该假设只见过一两次，
 * 不能当规律 —— 所以要连打多次拿数据。
 *
 * 跑法（必须带 --env-file，否则拿不到 Key）：
 *   node --env-file=.env.local scripts/probe-delta.mjs
 *
 * 每一轮做两次模型调用：
 *   ① 带工具的真问题 → 看这一轮有没有 content（这是核心指标）
 *   ② 拿①的 tool_calls 拼一条假工具结果回给模型 → 看答案轮的 content 是不是分片流出
 *      （②里工具数据是假的，只关心「有没有分片」，不关心内容）
 */

import { TOOLS, todayForAgent } from '../api/_agentTools.js';
import { buildSystemPrompt, resolveLLM } from '../api/_agentRun.js';

const llm = resolveLLM(process.env);
if (!llm.apiKey) {
  console.error('没有 DEEPSEEK_API_KEY —— 要用 node --env-file=.env.local 跑');
  process.exit(1);
}

const QUESTION = '11月20日 深圳到北京 便宜吗';
const TIMES = Number(process.argv[2]) || 10;

const FAKE_TOOL_RESULT = JSON.stringify({
  day: '2026-11-20',
  price: 1650,
  currency: 'CNY',
  level: 'low',
  levelLabel: '偏低',
  typicalLow: 1750,
  typicalHigh: 1942,
  median: 1842,
  cheaperCount: 12,
  window: { start: '2026-11-14', end: '2026-12-13' },
});

async function streamOnce(messages) {
  const t0 = Date.now();
  const res = await fetch(llm.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
    body: JSON.stringify({
      model: llm.model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) throw new Error('模型接口 ' + res.status + '：' + (await res.text()).slice(0, 200));

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let firstContentAt = null;
  let usage = null;
  let chunks = 0;
  let reasoningLen = 0;
  const calls = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(raw);
        } catch {
          continue;
        }
        chunks += 1;
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta;
        if (!d) continue;
        if (d.reasoning_content) reasoningLen += d.reasoning_content.length;
        if (typeof d.content === 'string' && d.content.length) {
          content += d.content;
          if (firstContentAt === null) firstContentAt = Date.now() - t0;
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? 0;
          calls[i] ??= { id: '', name: '', args: '' };
          if (tc.id) calls[i].id += tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
      }
    }
  }

  return { content, firstContentAt, calls, usage, chunks, reasoningLen, ms: Date.now() - t0 };
}

const system = buildSystemPrompt(todayForAgent(), { multiTurn: false });
console.log('model=' + llm.model + '  问句=' + QUESTION + '  次数=' + TIMES + '\n');
console.log('  #  轮1 content  轮1 工具            轮1 块  轮2 首字  轮2 字数  轮2 块  usage');
console.log('  ' + '-'.repeat(92));

let toolRoundsWithContent = 0;
let toolRounds = 0;
const answerFirstAt = [];
let usageOk = 0;

for (let i = 1; i <= TIMES; i++) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: QUESTION },
  ];

  const r1 = await streamOnce(messages);
  const hasTool = r1.calls.length > 0;
  if (hasTool) toolRounds += 1;
  if (r1.content.trim()) toolRoundsWithContent += 1;
  if (r1.usage?.completion_tokens) usageOk += 1;

  let r2 = null;
  if (hasTool) {
    messages.push({
      role: 'assistant',
      content: r1.content,
      tool_calls: r1.calls.map((c) => ({
        id: c.id || 'call_' + Math.random().toString(36).slice(2),
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    });
    messages.push({
      role: 'tool',
      tool_call_id: messages.at(-1).tool_calls[0].id,
      content: FAKE_TOOL_RESULT,
    });
    r2 = await streamOnce(messages);
    if (r2.content.trim() && r2.firstContentAt !== null) answerFirstAt.push(r2.firstContentAt);
    if (r2.usage?.completion_tokens) usageOk += 1;
  }

  console.log(
    '  ' +
      String(i).padStart(2) +
      '  ' +
      String(r1.content.length).padStart(8) +
      '  ' +
      (r1.calls.map((c) => c.name).join(',') || '（无）').padEnd(18) +
      '  ' +
      String(r1.chunks).padStart(5) +
      '  ' +
      String(r2?.firstContentAt ?? '-').padStart(7) +
      '  ' +
      String(r2 ? r2.content.length : '-').padStart(7) +
      '  ' +
      String(r2?.chunks ?? '-').padStart(5) +
      '  ' +
      (r2?.usage ? r2.usage.prompt_tokens + '/' + r2.usage.completion_tokens : '无'),
  );

  if (r1.content.trim()) {
    console.log('        ⚠️ 轮1 有 content：' + JSON.stringify(r1.content.slice(0, 120)));
  }
}

console.log('\n=== 汇总 ===');
console.log('工具轮总数：' + toolRounds + '/' + TIMES);
console.log('工具轮里 content 非空：' + toolRoundsWithContent + '/' + toolRounds + '  ← 决定 B 还是 B\' 的关键');
if (answerFirstAt.length) {
  const avg = Math.round(answerFirstAt.reduce((a, b) => a + b, 0) / answerFirstAt.length);
  console.log('答案轮首字延迟：' + answerFirstAt.join(', ') + ' ms，均值 ' + avg + ' ms');
}
console.log('带 usage 的响应：' + usageOk + ' 次  ← include_usage 是否生效');
