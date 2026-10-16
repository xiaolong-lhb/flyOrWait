/**
 * 探针脚本：Apify「Flight Price Calendar」actor 到底能不能出**内地航线**的价格日历？
 *
 * ── 为什么要有这个脚本 ──
 * Sky Scrapper 免费档实测只有 20 次/月，对「订阅 + Cron 每日比价」根本不够。
 * 调研后找到的平替首选是 Apify 的 lergassy/flight-price-calendar：
 * 按行计费 $0.0002/行（一航线一年 365 行 = $0.07），免费档每月 $5 额度。
 * 但**唯一靠查资料确认不了的一点**是：它走的 Google Flights 链路，到底出不出内地航线数据？
 * → 这个脚本就是拿来回答这一个问题的。跑一条 SZX→PEK 只要约 $0.006（走免费额度，不花钱）。
 *
 * ── 用法 ──
 *   APIFY_TOKEN=apify_api_xxxx node scripts/probe-apify-calendar.mjs
 *   APIFY_TOKEN=... node scripts/probe-apify-calendar.mjs SZX PEK 30
 *   APIFY_TOKEN=... node scripts/probe-apify-calendar.mjs SZX HKG 30
 *
 *   参数：[origin] [destination] [calendarDays]，默认 SZX PEK 30。
 *
 * ── 特殊玩法：交叉验真 ──
 *   如果跑的是 SZX→HKG，脚本会自动和 samples/sky-priceCalendar-szx-hkg.json
 *   （Sky/天巡的真实响应）**逐日对比**。两家数据源对同一天的报价差多少，一眼就能看出来。
 *   这比「有没有数据」有价值得多 —— 能直接验证新源的口径和量级对不对。
 *
 * ── 注意事项 ──
 *   ① token 不要写进任何文件（尤其 .env.local，那是主人装密钥的文件，不要动）→ 只走命令行环境变量。
 *   ② 这个 actor 默认钉死用 Apify 的**住宅代理**，而免费档**不含住宅代理** →
 *      脚本会自动降级成机房代理重试一次（对应 actor 的 dataSource 会退到「结果页」兜底）。
 *   ③ 跑一次要十几秒到几分钟（run-sync 是阻塞式），Bash 里给足超时。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** actor 标识（Apify 用 ~ 分隔用户名/actor 名） */
const ACTOR = 'lergassy~flight-price-calendar';
const API = 'https://api.apify.com/v2';
/** run-sync 阻塞式等结果，最长给 5 分钟（Apify 这个端点本身的硬上限就是 300 秒） */
const SYNC_TIMEOUT_MS = 300_000;

const token = process.env.APIFY_TOKEN;
if (!token) {
  console.error(
    '缺少 APIFY_TOKEN。用法：APIFY_TOKEN=apify_api_xxx node scripts/probe-apify-calendar.mjs [origin] [destination] [days]',
  );
  process.exit(1);
}

const origin = (process.argv[2] || 'SZX').toUpperCase();
const destination = (process.argv[3] || 'PEK').toUpperCase();
const calendarDays = Number(process.argv[4] || 30);

/** 出发日取「今天 + 30 天」：太近的日期价格没有参考意义，也避开窗口边界 */
function plusDays(n) {
  const d = new Date(Date.now() + n * 86400_000);
  return d.toISOString().slice(0, 10);
}

const BASE_INPUT = {
  origin,
  destination,
  departureDate: plusDays(30),
  calendarDays,
  // 只要日历，不要航班列表 —— 最省（这是本脚本关心的唯一产出）
  calendarOnly: true,
  // 顺手把 Google 的 low/typical/high 判据也带上（免费额度内，一并看掉）
  includePriceInsights: true,
  adults: 1,
  cabinClass: 'economy',
  maxStops: 'any',
  // 默认是 USD / 无 market，显式指定成「人民币 + 中国销售地」才对得上我们的口径
  currency: 'CNY',
  market: 'CN',
  language: 'zh-CN',
};

/**
 * 跑一次 actor，返回 dataset items（数组）。
 * 失败时抛 Error，message 里带上 Apify 的原始报错，便于判断是不是代理问题。
 */
async function runActor(input) {
  // timeout=280：run-sync 是阻塞式的，显式给上限（免得跑超时后 Apify 改返回 run 对象而不是数据行）
  const res = await fetch(`${API}/acts/${ACTOR}/run-sync-get-dataset-items?timeout=280`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
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
    const detail = body?.error?.message || JSON.stringify(body).slice(0, 400);
    throw new Error(`HTTP ${res.status}｜${detail}`);
  }
  if (!Array.isArray(body)) {
    throw new Error(`预期是 dataset 行数组，实际拿到：${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/** 从一堆行里挑出「一天一行」的日历项。字段名有 date / day、price 也有可能是对象，都兜一下。 */
function collectDays(items) {
  const days = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const date = it.date || it.day;
    const price = typeof it.price === 'number' ? it.price : it.price?.amount;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof price === 'number') {
      days.push({ date, price });
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** 和本地 Sky 样本逐日对比（只有航线能对上样本时才有意义） */
async function crossCheckWithSky(days) {
  const name = `sky-priceCalendar-${origin.toLowerCase()}-${destination.toLowerCase()}.json`;
  let sample;
  try {
    sample = JSON.parse(await readFile(join(import.meta.dirname, '..', 'samples', name), 'utf8'));
  } catch {
    return null; // 没样本就算了，不是错误
  }
  const skyDays = sample?.data?.flights?.days || [];
  const skyByDate = new Map(skyDays.map((d) => [d.day, d.price]));
  const rows = [];
  for (const d of days) {
    if (!skyByDate.has(d.date)) continue;
    const skyPrice = skyByDate.get(d.date);
    rows.push({
      date: d.date,
      apify: Math.round(d.price),
      sky: Math.round(skyPrice),
      diffPct: Math.round(((d.price - skyPrice) / skyPrice) * 1000) / 10,
    });
  }
  return { sampleName: name, total: rows.length, rows };
}

// ── 开跑 ──────────────────────────────────────────────────────────────────────
console.log(
  `\n▶ ${origin} → ${destination}｜窗口 ${calendarDays} 天｜出发日 ${BASE_INPUT.departureDate}`,
);
console.log(`  actor: ${ACTOR}\n`);

let items;
let note = '';
try {
  items = await runActor(BASE_INPUT);
} catch (e) {
  // 免费档不带住宅代理 → actor 默认配置可能直接失败，降级成机房代理再来一次
  if (/proxy/i.test(e.message)) {
    console.log(`⚠️ 第一次失败（疑似代理）：${e.message}`);
    console.log('   降级为机房代理重试…\n');
    try {
      items = await runActor({
        ...BASE_INPUT,
        proxyConfiguration: { useApifyProxy: true }, // 不指定 RESIDENTIAL = 用机房代理
        dataSource: 'page', // 结果 API 只给住宅 IP，退到结果页
      });
      note = '（本次走的是「机房代理 + 结果页」降级路径）';
    } catch (e2) {
      console.error(`✖ 降级后仍失败：${e2.message}`);
      process.exit(1);
    }
  } else {
    console.error(`✖ 失败：${e.message}`);
    process.exit(1);
  }
}

console.log(`✅ 返回 ${items.length} 行${note}\n`);

const days = collectDays(items);

if (!days.length) {
  console.log('⚠️ 没有任何一天的价格 —— 可能就是「这家源不出这条航线」。');
  console.log('   原始前 3 行（看真实字段长什么样）：');
  console.log(JSON.stringify(items.slice(0, 3), null, 2));
  process.exit(0);
}

const prices = days.map((d) => d.price).sort((a, b) => a - b);
const sum = prices.reduce((a, b) => a + b, 0);
const mid = (arr) => arr[(arr.length - 1) >> 1];
const cheapest = [...days].sort((a, b) => a.price - b.price).slice(0, 5);

console.log('── 有价天数 ──────────────────────────');
console.log(`  有价 ${days.length} 天 / 请求窗口 ${calendarDays} 天`);
console.log(`  区间 ${days[0].date} ~ ${days[days.length - 1].date}`);
console.log(
  `  最低 ¥${Math.round(prices[0])}｜中位 ¥${Math.round(mid(prices))}｜最高 ¥${Math.round(prices[prices.length - 1])}｜均值 ¥${Math.round(sum / prices.length)}`,
);
console.log('\n── 最便宜 5 天 ───────────────────────');
for (const d of cheapest) console.log(`  ${d.date}  ¥${Math.round(d.price)}`);

// 顺手报一下这次 run 实际花了多少（best-effort，失败不影响结论）
try {
  const r = await fetch(`${API}/acts/${ACTOR}/runs?desc=true&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  const u = j?.data?.items?.[0]?.usageTotalUsd;
  if (typeof u === 'number')
    console.log(`\n── 本次花费 ─────────────────────────\n  $${u.toFixed(4)}（免费额度 $5/月）`);
} catch {
  /* 拿不到就算了 */
}

console.log('\n── 第一行原始数据（字段名以它为准）──');
console.log(JSON.stringify(items[0], null, 2));

const cross = await crossCheckWithSky(days);
if (cross) {
  console.log(`\n── 与本地 Sky 样本交叉对比（${cross.sampleName}）──`);
  if (!cross.total) {
    console.log('  两边没有重叠的日期，比不了。');
  } else {
    console.log(`  重叠 ${cross.total} 天｜日期          Apify      Sky      差`);
    for (const r of cross.rows.slice(0, 15)) {
      const diff = (r.diffPct > 0 ? '+' : '') + r.diffPct;
      console.log(
        `  ${r.date}   ¥${String(r.apify).padStart(6)}  ¥${String(r.sky).padStart(6)}  ${diff.padStart(6)}%`,
      );
    }
    if (cross.rows.length > 15) console.log(`  …（共 ${cross.rows.length} 天，只列前 15）`);
  }
}
console.log('');
