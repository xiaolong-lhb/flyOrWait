/**
 * 诊断第五步：异步 run，给 actor 充裕时间（300s），回答唯一还没确定的根本问题：
 *   「XMN 这类航线是**只是慢**，还是 Google 那边**根本没有日历数据**？」
 *
 * 用异步 run（POST /runs + 轮询）绕开 HTTP 等待上限。计费按成功行数，
 * 抓不到 = 0 元，抓到 90 天 ≈ $0.018。
 */
const ACTOR = 'lergassy~flight-price-calendar';
const API = 'https://api.apify.com/v2';
const token = process.env.APIFY_TOKEN;
if (!token) {
  console.error('缺少 APIFY_TOKEN');
  process.exit(1);
}
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const [origin, destination, daysArg] = [process.argv[2] || 'SZX', process.argv[3] || 'XMN', Number(process.argv[4] || 90)];
const RUN_TIMEOUT_S = 300;

function todayShanghai() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

const body = {
  origin,
  destination,
  departureDate: todayShanghai(),
  calendarDays: daysArg,
  calendarOnly: true,
  adults: 1,
  cabinClass: 'economy',
  currency: 'CNY',
  market: 'CN',
  language: 'zh-CN',
  proxyConfiguration: { useApifyProxy: true },
  dataSource: 'page',
};

console.log(`=== ${origin}→${destination} days=${daysArg} → 异步 run（上限 ${RUN_TIMEOUT_S}s）===`);

const startRes = await fetch(`${API}/acts/${ACTOR}/runs?timeout=${RUN_TIMEOUT_S}`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify(body),
});
const startText = await startRes.text();
if (!startRes.ok) {
  console.log(`✗ 启动 run 失败 ${startRes.status}: ${startText.slice(0, 400)}`);
  process.exit(1);
}
const run = JSON.parse(startText).data;
console.log(`runId=${run.id}  datasetId=${run.defaultDatasetId}  起始状态=${run.status}`);

const t0 = Date.now();
let last = '';
for (;;) {
  await new Promise((r) => setTimeout(r, 4000));
  const r = await fetch(`${API}/actor-runs/${run.id}`, { headers: h });
  const d = JSON.parse(await r.text()).data;
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  if (d.status !== last) {
    console.log(`+${el}s  status=${d.status}`);
    last = d.status;
  }
  if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(d.status)) {
    console.log(`\n最终：${d.status}  总耗时 ${el}s  usage=${d.usageTotalUsd ?? '?'} USD`);
    console.log(`stats=${JSON.stringify(d.stats ?? {})}`);

    // 取 dataset
    const items = JSON.parse(
      await (await fetch(`${API}/datasets/${run.defaultDatasetId}/items?clean=false`, { headers: h })).text(),
    );
    const arr = Array.isArray(items) ? items : [];
    const byType = {};
    for (const it of arr) byType[it?.type ?? '(无)'] = (byType[it?.type ?? '(无)'] || 0) + 1;
    console.log(`items ${arr.length} 条，type 分布 ${JSON.stringify(byType)}`);
    for (const it of arr) {
      if (it?.type === 'notice') console.log(`[notice] ${String(it.error ?? it.message ?? '').slice(0, 300)}`);
    }
    const daysOut = arr.filter((it) => it?.type === 'calendar_day' && it.price > 0);
    console.log(`calendar_day 有效 ${daysOut.length} 条`);
    if (daysOut.length) {
      const ds = daysOut.map((d) => d.date).sort();
      console.log(`日期范围 ${ds[0]} ~ ${ds[ds.length - 1]}`);
    }

    // 日志：看抓了多久才出第一天
    console.log('\n--- run 日志 ---');
    const log = await (await fetch(`${API}/actor-runs/${run.id}/log`, { headers: h })).text();
    for (const l of log.split('\n').filter((x) => x.trim())) {
      if (/Searching|price calendar|WARN|ERROR|Done\.|Status message/i.test(l)) {
        console.log(l.slice(0, 220));
      }
    }
    break;
  }
  if (Date.now() - t0 > (RUN_TIMEOUT_S + 60) * 1000) {
    console.log('本地等待超上限，放弃轮询（run 仍在服务端跑）');
    break;
  }
}
