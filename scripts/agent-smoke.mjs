/**
 * Agent 工具层自检脚本（不联网、不烧额度）
 *
 *   APIFY_REPLAY=1 SERP_REPLAY=1 node scripts/agent-smoke.mjs
 *
 * 校验五件事：
 *   ① schema 与执行体一一对应（漏一个工具会被这一步抓到）
 *   ② 正常调用能跑通，且返回是**裁薄**的
 *   ③ 坏参数 / 不存在的工具 / 数据不足，都回结构化错误，不抛异常
 *   ④ run 内日历只抓一次 —— 后面几次全命中缓存
 *   ⑤ 关键结论有断言，失败会 exit 1
 *
 * ★ 关于 ⑤：早先这里只 line() 打印、不做判断，于是「工具静默返回错结论」
 *   （比如缺数据时报 cheaper:'same'）看起来跟正常一样，退出码永远是 0。
 *   打印不是自检，断言才是。新增工具时，顺手加一条 check()。
 */
import {
  TOOLS,
  runTool,
  createToolContext,
  assertToolsConsistent,
  todayForAgent,
} from '../api/_agentTools.js';

const line = (t = '') => console.log(t);
const head = (t) => {
  line();
  line('─'.repeat(64));
  line(t);
  line('─'.repeat(64));
};

/** 断言：失败只记账、不中断，最后统一结算 —— 一次跑完看全貌，比第一个错就停更有用 */
let failures = 0;
const check = (cond, msg) => {
  if (cond) {
    line(`  ✓ ${msg}`);
  } else {
    failures += 1;
    line(`  ✗ ${msg}`);
  }
};

const ctx = createToolContext();

head('0. schema 与执行体一致性');
line(JSON.stringify(assertToolsConsistent(), null, 2));
line(`工具数：${TOOLS.length}｜今天（东八区）：${todayForAgent()}`);

head('1. schema 自查：每个工具都有 name / description / parameters');
for (const t of TOOLS) {
  const f = t.function;
  const okShape = Boolean(f.name && f.description && f.parameters?.properties);
  line(
    `${okShape ? '✓' : '✗'} ${f.name}（必填：${(f.parameters.required || []).join(', ') || '无'}）`,
  );
}

head('2. find_cheapest_days —— 排序取最小由代码完成');
const cheap = await runTool(
  'find_cheapest_days',
  { from: 'szx', to: 'PEK', dateFrom: '2026-11-14', dateTo: '2026-12-15', limit: 3 },
  ctx,
);
line(JSON.stringify(cheap, null, 2));
check(cheap.ok === true, 'find_cheapest_days 应成功');
check(Array.isArray(cheap.data?.cheapest) && cheap.data.cheapest.length > 0, '应返回非空的最便宜清单');

head('3. judge_one_day —— 拿上面最便宜那天去判档（应命中缓存）');
const firstDay = cheap.data?.cheapest?.[0]?.day;
if (firstDay) {
  const judge = await runTool('judge_one_day', { from: 'SZX', to: 'PEK', date: firstDay }, ctx);
  line(JSON.stringify(judge, null, 2));
  check(judge.data?.available === true, `judge_one_day 对 ${firstDay} 应有结论`);
} else {
  line('⚠️ 没拿到最便宜的一天，跳过');
  check(false, '没拿到最便宜的一天 —— 上一步应已失败');
}

head('4. compare_two_dates —— 四场景');
const cmpBase = { from: 'SZX', to: 'PEK' };

const cmpNormal = await runTool(
  'compare_two_dates',
  { ...cmpBase, dateA: '2026-11-20', dateB: '2026-11-25' },
  ctx,
);
check(cmpNormal.ok === true, '两天都有价时 ok=true');
check(
  typeof cmpNormal.data?.cheaper === 'string' && cmpNormal.data.cheaper !== 'same',
  `两天价位不同时 cheaper 应是日期字符串（实际 ${JSON.stringify(cmpNormal.data?.cheaper)}）`,
);
// 样本里 11-20 = 2550、11-25 = 1842 ⇒ 差 708，占较贵那天的 27.8%
check(cmpNormal.data?.diff === 708, `diff 应为 708（实际 ${JSON.stringify(cmpNormal.data?.diff)}）`);
check(
  cmpNormal.data?.diffPercent === 27.8,
  `diffPercent 应为 27.8（实际 ${JSON.stringify(cmpNormal.data?.diffPercent)}）`,
);

const cmpSame = await runTool(
  'compare_two_dates',
  { ...cmpBase, dateA: '2026-11-27', dateB: '2026-11-28' },
  ctx,
);
check(cmpSame.data?.cheaper === 'same', `两天同价时 cheaper 应为 'same'（实际 ${JSON.stringify(cmpSame.data?.cheaper)}）`);
check(
  cmpSame.data?.diff === 0 && cmpSame.data?.diffPercent === 0,
  `两天同价时 diff / diffPercent 都应为 0（实际 ${JSON.stringify([cmpSame.data?.diff, cmpSame.data?.diffPercent])}）`,
);

const cmpOut = await runTool(
  'compare_two_dates',
  { ...cmpBase, dateA: '2026-11-20', dateB: '2026-12-25' },
  ctx,
);
// ★ 这条是核心回归：缺数据时若退化成 'same'，就是在编造「两天一样便宜」
check(cmpOut.ok === true, 'B 超窗口仍是 ok=true —— 这是事实，不是工具坏了');
check(
  cmpOut.data?.cheaper === null,
  `B 超窗口时 cheaper 必须是 null（实际 ${JSON.stringify(cmpOut.data?.cheaper)}）`,
);
check(
  cmpOut.data?.verdictB?.reason === 'date_out_of_window',
  `B 的 reason 应为 date_out_of_window（实际 ${JSON.stringify(cmpOut.data?.verdictB?.reason)}）`,
);
// ★ 差值也必须跟着变 null。否则会出现「比不了，但差价是 0」这种自相矛盾的返回
check(
  cmpOut.data?.diff === null && cmpOut.data?.diffPercent === null,
  `任一天缺价时 diff / diffPercent 都应为 null（实际 ${JSON.stringify([cmpOut.data?.diff, cmpOut.data?.diffPercent])}）`,
);

const cmpSameDay = await runTool(
  'compare_two_dates',
  { ...cmpBase, dateA: '2026-11-20', dateB: '2026-11-20' },
  ctx,
);
check(cmpSameDay.ok === false && cmpSameDay.error?.code === 'bad_args', '同一天应回 bad_args');

head('5. search_price_calendar —— 只看其中一个月');
const cal = await runTool('search_price_calendar', { from: 'SZX', to: 'PEK', month: '2026-11' }, ctx);
line(
  `days=${cal.data?.days?.length}｜window=${JSON.stringify(cal.data?.window)}｜sample=${cal.data?.sampleDays}`,
);
line(`前三天：${JSON.stringify(cal.data?.days?.slice(0, 3))}`);
check(cal.ok === true, 'search_price_calendar 应成功');
check(Array.isArray(cal.data?.days) && cal.data.days.length > 0, '应返回非空日价列表');

head('6. search_flights —— 裁薄成 8 条');
const fl = await runTool('search_flights', { from: 'SZX', to: 'PEK', date: firstDay }, ctx);
line(`ok=${fl.ok}｜条数=${fl.data?.flights?.length}｜totalPriced=${fl.data?.totalPriced}`);
line(`第一条：${JSON.stringify(fl.data?.flights?.[0])}`);
check(fl.ok === true, 'search_flights 应成功');
check((fl.data?.flights?.length ?? 0) <= 8, '航班列表应被裁到 8 条以内');

head('7. create_subscription_draft —— 缺邮箱应 ready=false，且不写库');
const draft1 = await runTool(
  'create_subscription_draft',
  { from: 'SZX', to: 'PEK', departDate: firstDay, threshold: 1800, basePrice: 1700 },
  ctx,
);
line(JSON.stringify(draft1, null, 2));
check(draft1.ok === true, '草稿缺邮箱仍应 ok=true（返回的是「还差什么」这个事实）');
check(draft1.data?.ready === false, '缺邮箱时 ready 应为 false');
check(Array.isArray(draft1.data?.problems) && draft1.data.problems.length > 0, '应列出缺什么');

head('8. create_subscription_draft —— 字段齐了，basePrice 走缓存');
const draft2 = await runTool(
  'create_subscription_draft',
  { from: 'SZX', to: 'PEK', departDate: firstDay, threshold: 1800, email: 'a@b.com' },
  ctx,
);
line(JSON.stringify(draft2, null, 2));
check(draft2.ok === true, '字段齐了应 ok=true');
check(draft2.data?.ready === true, '字段齐了 ready 应为 true');

head('9. 坏参数 / 不存在工具 —— 必须是结构化错误，不能抛');
for (const [name, args] of [
  ['judge_one_day', { from: 'sz', to: 'PEK', date: '2026-11-20' }],
  ['judge_one_day', { from: 'SZX', to: 'PEK', date: '2026/11/20' }],
  ['find_cheapest_days', { from: 'SZX', to: 'PEK', dateFrom: '2026-12-15', dateTo: '2026-11-14' }],
  ['no_such_tool', {}],
  ['list_my_subscriptions', {}],
]) {
  const r = await runTool(name, args, ctx);
  // 用 → 而不是 ✓/✗：这里是「工具拒绝的日志」，✓/✗ 留给断言，
  // 否则一眼看过去分不清「预期内的拒绝」和「断言的失败」。
  line(`  → ${r.ok ? '!! 未拒绝' : r.error.code}  ${name}  ${r.ok ? '' : r.error.message}`);
  check(r.ok === false && Boolean(r.error?.code), `${name} 应回结构化错误（不能抛、不能装作成功）`);
}

head('10. 超窗口 —— 这是「事实」不是「错误」：ok=true + available=false');
const outRange = await runTool(
  'judge_one_day',
  { from: 'SZX', to: 'PEK', date: '2030-01-01' },
  ctx,
);
line(JSON.stringify(outRange, null, 2));
// ★ 与第 9 段的分界：ok=false 只留给「参数给错了」。查不到数据是正常结果，
//   若在这里回 ok=false，模型会以为工具坏了、反复改参数重试，白烧 token。
check(outRange.ok === true, '超窗口仍应 ok=true（工具正常工作了，只是这天没数据）');
check(outRange.data?.available === false, 'available 应为 false');
check(
  outRange.data?.reason === 'date_out_of_window',
  `reason 应为 date_out_of_window（实际 ${JSON.stringify(outRange.data?.reason)}）`,
);

head('11. 缓存账：日历只该抓 1 次');
line(JSON.stringify(ctx.stats, null, 2));
check(ctx.stats.calendarFetches === 1, '整个自检只抓了 1 次日历（同航线复用缓存）');

line();
if (failures > 0) {
  line(`✗ ${failures} 条断言失败`);
  process.exit(1);
}
line('✓ 全部断言通过');
