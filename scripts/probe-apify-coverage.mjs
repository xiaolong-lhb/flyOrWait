/**
 * 覆盖面探针：Apify 那家源，到底「支持多少条航线」？
 *
 * ── 为什么要有这个脚本 ──
 * 「哪天最便宜 / 该不该买」这两件事已经确定用 Apify 的 Google Flights 链路。
 * 但前面只实测过 2 条航线（SZX→PEK、SZX→HKG），于是留下一个必须回答的问题：
 *   前端下拉里的 21 个机场，是不是「有的能出数据、有的根本出不来」？
 * 如果只能出几条，那就是致命的产品局限，必须现在就知道、而不是上线后才发现。
 *
 * ── 怎么做到「便宜」──
 * actor 支持 `routes` 数组（一次 run 搜多条航线），而且 `calendarDays` 最小可以是 1。
 * 两者一组合 ⇒ **每条航线只出 1 行**（当天价），一行 $0.0002。
 * 全量矩阵 46 条航线 ≈ **$0.0092**（不到免费额度的 0.2%）。
 * 另外官方写明「空结果不计费」⇒ 真正拿不到数据的航线是 **$0**。
 *
 * ── 用法 ──
 *   APIFY_TOKEN=apify_api_xxx node scripts/probe-apify-coverage.mjs
 *   APIFY_TOKEN=... node scripts/probe-apify-coverage.mjs --limit=8      # 先小额试跑 8 条
 *   APIFY_TOKEN=... node scripts/probe-apify-coverage.mjs --days=3       # 每条出 3 天（更贵一点）
 *
 * ── 读结果 ──
 *   表格里每条航线显示「出了几天价」。某条 0 行 ⇒ 该航线 Apify 拿不到数据。
 *   末尾会汇总「哪些机场从头到尾没出过数据」—— 那些机场要从前端下拉里砍掉。
 */
import { AIRPORTS } from '../src/data/airports.js';

const ACTOR = 'lergassy~flight-price-calendar';
const API = 'https://api.apify.com/v2';
/** run-sync 是阻塞式的，Apify 这个端点硬上限 300 秒；留 20 秒余量 */
const SYNC_TIMEOUT_MS = 280_000;
/** 每一行数据 $0.0002（FREE 档） */
const USD_PER_ROW = 0.0002;

const token = process.env.APIFY_TOKEN;
if (!token) {
  console.error(
    '缺少 APIFY_TOKEN。用法：APIFY_TOKEN=apify_api_xxx node scripts/probe-apify-coverage.mjs [--limit=N] [--days=N]',
  );
  process.exit(1);
}

// ── 参数 ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const numArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const LIMIT = numArg('limit', Number.POSITIVE_INFINITY);
const DAYS = numArg('days', 1);
/** 一批跑几条航线：太多会让单次 run 超时，太少则多花往返时间。12 条稳住 */
const BATCH = numArg('batch', 12);

/** 出发日取「今天 + 30 天」，避开太近的日期与窗口边界 */
function plusDays(n) {
  const d = new Date(Date.now() + n * 86400_000);
  return d.toISOString().slice(0, 10);
}
const departureDate = plusDays(30);

// ── 造航线清单 ────────────────────────────────────────────────────────────────
const codes = AIRPORTS.map((a) => a.code);
const HUB = 'SZX';
/** 非深圳的几条内地干线，用来验证「跟深圳无关的航线」也通 */
const TRUNK = [
  ['PVG', 'CTU'],
  ['PEK', 'KMG'],
  ['CAN', 'HGH'],
  ['CTU', 'PVG'],
  ['XIY', 'XMN'],
  ['CKG', 'NKG'],
];

const allRoutes = [];
for (const c of codes) if (c !== HUB) allRoutes.push({ origin: HUB, destination: c });
for (const c of codes) if (c !== HUB) allRoutes.push({ origin: c, destination: HUB });
for (const [o, d] of TRUNK) allRoutes.push({ origin: o, destination: d });

const routes = allRoutes.slice(0, LIMIT).map((r) => ({ ...r, departureDate }));

/** 公共参数：每条航线都套这套（actor 约定：这些字段对 routes 里每条都生效） */
const COMMON = {
  calendarDays: DAYS,
  calendarOnly: true,
  adults: 1,
  cabinClass: 'economy',
  maxStops: 'any',
  currency: 'CNY',
  market: 'CN',
  language: 'zh-CN',
  // 免费档没有住宅代理 → 直接点明走结果页兜底，省得第一次必然失败再降级
  proxyConfiguration: { useApifyProxy: true },
  dataSource: 'page',
};

console.log('\n▶ Apify 覆盖率探针');
console.log(`  actor    : ${ACTOR}`);
console.log(`  航线数   : ${routes.length} 条（每条 ${DAYS} 天）`);
console.log(`  出发日   : ${departureDate}`);
console.log(`  预估花费 : ≤ $${(routes.length * DAYS * USD_PER_ROW).toFixed(4)}（空结果不计费）\n`);

/**
 * 跑一次 actor，返回 dataset items。
 * 顶层放第一条航线、其余走 routes —— 两种输入写法里较稳的一种（顶层必填字段也被满足）。
 */
async function runActor(chunk) {
  const [first, ...rest] = chunk;
  const payload = { ...COMMON, origin: first.origin, destination: first.destination, routes: rest };

  const res = await fetch(`${API}/acts/${ACTOR}/run-sync-get-dataset-items?timeout=270`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}｜${body?.error?.message || JSON.stringify(body).slice(0, 300)}`,
    );
  }
  if (!Array.isArray(body)) {
    throw new Error(`预期 dataset 行数组，实际：${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/** 把 items 归到「航线 → 有价天数」 */
function tally(items) {
  const byRoute = new Map(); // 'SZX>PEK' → { origin, destination, prices:Set, days:number }
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it.origin;
    const d = it.destination;
    if (!o || !d) continue;
    const key = `${o}>${d}`;
    const rec = byRoute.get(key) || { origin: o, destination: d, days: 0, prices: [] };
    if (it.type === 'calendar_day' && typeof it.price === 'number') {
      rec.days += 1;
      rec.prices.push(it.price);
    }
    byRoute.set(key, rec);
  }
  return byRoute;
}

// ── 分批跑 ────────────────────────────────────────────────────────────────────
const tallyAll = new Map();
let spent = 0;

for (let i = 0; i < routes.length; i += BATCH) {
  const chunk = routes.slice(i, i + BATCH);
  const labels = chunk.map((r) => `${r.origin}→${r.destination}`).join(' ');
  process.stdout.write(`  [${i + 1}-${i + chunk.length}/${routes.length}] ${labels}\n`);

  let items;
  try {
    items = await runActor(chunk);
  } catch (e) {
    console.error(`  ✖ 这一批失败：${e.message}`);
    for (const r of chunk)
      tallyAll.set(`${r.origin}>${r.destination}`, { ...r, days: 0, prices: [], error: true });
    continue;
  }

  const t = tally(items);
  for (const r of chunk) {
    const rec = t.get(`${r.origin}>${r.destination}`) || { ...r, days: 0, prices: [] };
    tallyAll.set(`${r.origin}>${r.destination}`, rec);
  }
  console.log(`      → 返回 ${items.length} 行`);

  // 顺手取这次 run 的真实花费
  try {
    const j = await (
      await fetch(`${API}/acts/${ACTOR}/runs?desc=true&limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    spent += j?.data?.items?.[0]?.usageTotalUsd || 0;
  } catch {
    /* 拿不到就算了 */
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
console.log('\n══ 结果 ══════════════════════════════════════════════');
const rows = routes.map(
  (r) => tallyAll.get(`${r.origin}>${r.destination}`) || { ...r, days: 0, prices: [] },
);

const ok = rows.filter((r) => r.days > 0);
const bad = rows.filter((r) => r.days === 0);

console.log(`有数据：${ok.length} / ${rows.length} 条`);
console.log(
  `没数据：${bad.length} 条${bad.length ? ' → ' + bad.map((r) => r.origin + '→' + r.destination).join(', ') : ''}`,
);

// 哪些机场「从头到尾没出过数据」
const airportOk = new Set();
for (const r of ok) {
  airportOk.add(r.origin);
  airportOk.add(r.destination);
}
const neverOk = codes.filter((c) => !airportOk.has(c));

console.log('\n── 机场级可用性（21 个）──────────────────────────────');
console.log(`  出过数据的机场：${airportOk.size} / ${codes.length}`);
if (neverOk.length) {
  console.log(`  ⚠️ 从未出过数据：${neverOk.join(', ')}  ← 建议从前端下拉砍掉`);
} else {
  console.log('  ✅ 全部机场都至少出过一次数据');
}

const priceList = ok.flatMap((r) => r.prices);
if (priceList.length) {
  priceList.sort((a, b) => a - b);
  console.log(
    `\n  单日价区间：¥${Math.round(priceList[0])} ~ ¥${Math.round(priceList[priceList.length - 1])}`,
  );
}

console.log(
  `\n── 本次花费 ──────────────────────────────────────────\n  ≈ $${spent.toFixed(4)}（免费额度 $5/月）\n`,
);
