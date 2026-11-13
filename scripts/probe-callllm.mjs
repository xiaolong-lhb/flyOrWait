/**
 * 流式解析层的离线回归测试（零成本、不联网、不调模型）
 *
 * 为什么要单独一个文件：
 *   `callLLM` 里真正的风险不是「能不能收到流」，而是**把流拼回 message 的那几段**——
 *   分片 arguments 拼错、name 被厂商重发成两遍、CRLF 没吃掉、非 SSE 的兜底走不到。
 *   这些分支在正常请求里几乎不会出，出了问题却表现为「工具参数解析失败」，
 *   最难查。用假服务器把每条分支都摆出来，跑一次 1 秒。
 *
 * 跑法：node scripts/probe-callllm.mjs
 */
import http from 'node:http';
import { callLLM } from '../api/_agentRun.js';

let failed = 0;
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function bad(name, detail) {
  failed += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
}
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name);
  else bad(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ── 假服务器：每个用例自己写 handler ─────────────────────────────── */
let handler = null;
const srv = http.createServer((req, res) => handler(req, res));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const llm = { baseUrl: BASE, model: 'fake', apiKey: 'x', timeoutMs: 5000 };
const messages = [{ role: 'user', content: 'hi' }];

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** 把若干段文本按顺序写出去，段之间留一点间隔，模拟 TCP 分片 */
function streamOut(res, pieces, gap = 5) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  let i = 0;
  const tick = () => {
    if (i >= pieces.length) return res.end();
    res.write(pieces[i++]);
    setTimeout(tick, gap);
  };
  tick();
}

/* ══ 1. content 被从中间劈开，且用 CRLF 结尾 ══════════════════════ */
handler = (req, res) => {
  streamOut(res, [
    'data: {"choices":[{"delta":{"content":"你"',
    '}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n',
    chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  ]);
};
{
  const deltas = [];
  const r = await callLLM(messages, llm, (t) => deltas.push(t));
  eq('分片 + CRLF：content 拼回原文', r.message.content, '你好');
  eq('分片 + CRLF：onDelta 逐段回调', deltas, ['你', '好']);
  eq('分片 + CRLF：usage 从末尾空 choices 块取到', r.usage, {
    prompt_tokens: 3,
    completion_tokens: 2,
  });
  eq('分片 + CRLF：没有工具时 message 里不带 tool_calls 字段', 'tool_calls' in r.message, false);
}

/* ══ 2. tool_calls 的 arguments 被切成三段 ════════════════════════ */
handler = (req, res) => {
  streamOut(res, [
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_abc',
                type: 'function',
                function: { name: 'judge_one_day', arguments: '{"day":"2026-' },
              },
            ],
          },
        },
      ],
    }),
    chunk({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: '11-20","origin":"SZX"' } }] } },
      ],
    }),
    chunk({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: ',"destination":"PEK"}' } }] } },
      ],
    }),
    chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
};
{
  const r = await callLLM(messages, llm);
  const call = r.message.tool_calls?.[0];
  eq('分片 arguments：只有一个调用', r.message.tool_calls?.length, 1);
  eq('分片 arguments：id 完整', call?.id, 'call_abc');
  eq('分片 arguments：name 完整', call?.function?.name, 'judge_one_day');
  let parsed = null;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch {
    /* 下面会判失败 */
  }
  eq('分片 arguments：拼起来是合法 JSON', parsed, {
    day: '2026-11-20',
    origin: 'SZX',
    destination: 'PEK',
  });
}

/* ══ 3. 两个工具并行调用 + 厂商重发 name ══════════════════════════ */
handler = (req, res) => {
  streamOut(res, [
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'c0', function: { name: 'search_flights', arguments: '{"a":1}' } },
              { index: 1, id: 'c1', function: { name: 'judge_one_day', arguments: '{"b":2}' } },
            ],
          },
        },
      ],
    }),
    // 有些厂商每一块都重发 name/id，无脑 += 会变成 search_flightsearch_flights
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: 'search_flights', arguments: '' } },
              { index: 1, function: { name: 'judge_one_day', arguments: '' } },
            ],
          },
        },
      ],
    }),
  ]);
};
{
  const r = await callLLM(messages, llm);
  eq(
    '并行调用 + 重发 name：名字不被拼两遍',
    r.message.tool_calls?.map((c) => c.function.name),
    ['search_flights', 'judge_one_day'],
  );
  eq(
    '并行调用：id 与参数各自独立',
    r.message.tool_calls?.map((c) => [c.id, c.function.arguments]),
    [
      ['c0', '{"a":1}'],
      ['c1', '{"b":2}'],
    ],
  );
}

/* ══ 4. 心跳注释行与 [DONE] 不能当成事件 ═════════════════════════ */
handler = (req, res) => {
  streamOut(res, [
    ': ping\n\n',
    chunk({ choices: [{ delta: { content: 'A' } }] }),
    ': ping\n\n',
    'data: [DONE]\n\n',
  ]);
};
{
  const r = await callLLM(messages, llm);
  eq('注释行 [DONE]：只拿到正文', r.message.content, 'A');
  eq('注释行 [DONE]：usage 缺省为 null', r.usage, null);
}

/* ══ 5. 厂商不认 stream，回了整段 JSON → 走老路兜底 ═══════════════ */
handler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '整段答案' } }],
      usage: { prompt_tokens: 7, completion_tokens: 9 },
    }),
  );
};
{
  const r = await callLLM(messages, llm);
  eq('非 SSE 兜底：拿到整段 content', r.message.content, '整段答案');
  eq('非 SSE 兜底：usage 也在', r.usage, { prompt_tokens: 7, completion_tokens: 9 });
}

/* ══ 6. 上游 500 ═════════════════════════════════════════════════ */
handler = (req, res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: '上游炸了' } }));
};
{
  let msg = '';
  try {
    await callLLM(messages, llm);
  } catch (e) {
    msg = e.message;
  }
  if (msg.includes('模型接口 500') && msg.includes('上游炸了')) ok('上游 500：抛出且带原文');
  else bad('上游 500：抛出且带原文', `实际 message=${msg}`);
}

/* ══ 7. 流里一个数据块都没有 ═════════════════════════════════════ */
handler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end();
};
{
  let msg = '';
  try {
    await callLLM(messages, llm);
  } catch (e) {
    msg = e.message;
  }
  if (msg.includes('没有收到任何数据块')) ok('空流：明确报错而不是当空答案');
  else bad('空流：明确报错而不是当空答案', `实际 message=${msg}`);
}

/* ══ 8. 流内报错块 ═══════════════════════════════════════════════ */
handler = (req, res) => {
  streamOut(res, [chunk({ error: { message: '余额不足' } })]);
};
{
  let msg = '';
  try {
    await callLLM(messages, llm);
  } catch (e) {
    msg = e.message;
  }
  if (msg.includes('流内报错') && msg.includes('余额不足')) ok('流内 error 块：抛出');
  else bad('流内 error 块：抛出', `实际 message=${msg}`);
}

/* ══ 9. 首块之后挂住 → 超时要翻成中文 ═══════════════════════════ */
handler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(chunk({ choices: [{ delta: { content: '半' } }] }));
  // 之后什么都不发，等客户端超时
};
{
  const t0 = Date.now();
  let msg = '';
  try {
    await callLLM(messages, { ...llm, timeoutMs: 300 });
  } catch (e) {
    msg = e.message;
  }
  const ms = Date.now() - t0;
  if (msg.includes('模型接口超时') && ms < 2000) ok(`卡流超时：${ms}ms 抛中文错误`);
  else bad('卡流超时：抛中文错误', `用时 ${ms}ms，message=${msg}`);
  // 首块已经到过 ⇒ 不能说成「没有返回任何数据」，否则查日志的人会跑去查网络
  eq('卡流超时：不误报成「首块未返回」', msg.includes('没有返回任何数据'), false);
}

/* ══ 10. 一个字节都不回 → 首块超时，比分总时长更早断 ═════════════ */
handler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders(); // 头回了、数据一个字没有：最像「上游挂住」
};
{
  const t0 = Date.now();
  let msg = '';
  try {
    await callLLM(messages, { ...llm, timeoutMs: 5000, firstTokenMs: 300 });
  } catch (e) {
    msg = e.message;
  }
  const ms = Date.now() - t0;
  // 关键不是「有报错」，而是**远早于 timeoutMs 就断**：这正是不拆两个数的价值
  const fast = ms >= 250 && ms < 1500;
  if (msg.includes('没有返回任何数据') && fast) ok(`首块超时：${ms}ms 就断（没等满 5000ms）`);
  else bad('首块超时：尽早断', `用时 ${ms}ms，message=${msg}`);
}

/* ══ 11. ★ 慢但健康的流，不能被首块超时误伤 ═══════════════════════ */
handler = (req, res) => {
  // 头也慢（100ms 才回），首块到了之后整条流还要 450ms ——
  // 总耗时（~550ms）已超过 firstTokenMs(300)，但没超过 timeoutMs(4000)，必须读完。
  // 这条就是在守「拆完之后不能把健康的慢流砍掉」。
  setTimeout(() => {
    streamOut(
      res,
      ['A', 'B', 'C', 'D'].map((t) => chunk({ choices: [{ delta: { content: t } }] })),
      150,
    );
  }, 100);
};
{
  let r = null;
  let msg = '';
  try {
    r = await callLLM(messages, { ...llm, timeoutMs: 4000, firstTokenMs: 300 });
  } catch (e) {
    msg = e.message;
  }
  eq('慢流不误伤：整条流长于首块上限也能读完', r?.message?.content, 'ABCD');
  if (msg) bad('慢流不误伤：不该抛错', `抛了：${msg}`);
}

srv.close();

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
