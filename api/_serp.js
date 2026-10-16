/**
 * SerpApi 客户端（内部共享工具，不是接口）
 *
 * 文件名以 _ 开头是刻意的：本地运行器（scripts/dev-api.mjs）与 Vercel 都会跳过 _ 开头的文件，
 * 它不会变成一个可访问的路由。好处是「第三方接口的调用细节只写一处」。
 *
 * ── 它负责哪一半 ──
 *   结果页要两块数据，来自两个**完全不同的源**，各存各的样本：
 *     ① 日历（哪天最便宜 / 该不该买）→ Apify，见 api/_apify.js
 *     ② 航班列表（有哪些班次）      → SerpApi，就是本文件
 *   两边不是同一个接口的两种用法，是两条独立的链路，不要把一处的坑搬到另一处。
 *
 * ── 为什么航班列表留在 SerpApi（而不是也交给 Apify）──
 *   实测：Apify 那个 actor 传 `calendarOnly:false` 也能给列表，但那会走 Google 的
 *   「results API」通道（需要住宅 IP，免费档没有）→ 稳定性反而更差。
 *   SerpApi 这边内地线实测有数据（SZX→PEK 一次返回 34 个方案），且额度独立（250 次/月）。
 *
 * ── 输入口径 ──
 *   searchFlights({ origin, destination, date, returnDate, cabin, passengers })
 *     → { flights, meta }（flights 已按价格升序）
 *
 * ── 三个必须知道的坑 ──
 *   ① `type`：**1 = 往返，2 = 单程**（不是直觉的 1/0）。传错会拿到完全不同的东西。
 *   ② 往返（type=1）返回的 `best_flights` 是**去程候选**，条目里带 `departure_token`，
 *      真正的回程要拿这个 token **再打一次**。我们这一轮只列去程候选，
 *      **不对它的价格语义下结论**（见 result.js 里那条 notice）——没实测过的事不写死。
 *   ③ Google 会给个别方案**不带价格**（官方原文：部分航司把票价留在 Google Flights 之外）。
 *      这些条目故意**不丢弃统计**：meta 里如实报出「共 N 个方案、其中 M 个没给价」，
 *      页面才有机会解释「为什么列表看起来比别处贵/少」，而不是静默造假。
 *
 * ── 样例回放开关（SERP_REPLAY=1）──
 *   与 _apify.js / _sky.js 同一套纪律：
 *     不发任何网络请求，读 `samples/serp-{出发}-{到达}-{oneway|roundtrip}.json`
 *     （那是真接口返回过的**原文**，不是假数据）；
 *     **找不到样本 → 直接抛错，绝不静默返回空数组**；
 *     开关在**函数内**读环境变量（避免模块缓存读到旧值）；
 *     样本名大小写必须与文件名完全一致。
 *   ⚠️ 已有的样本是 2026-11-12 那一次录的 —— 回放时航班日期固定为 11-12，
 *      与「你要查的日期」无关。那是录像的日期，不是 bug。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENDPOINT = 'https://serpapi.com/search.json';
/** 实测 live 查询 3~8 秒；给一倍余量，超时说明对方挂了，早点失败更好 */
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;
/** 样例目录（项目根 samples/）—— 只在本机开发期用到，线上由 .vercelignore 挡在外面 */
const SAMPLES_DIR = join(import.meta.dirname, '..', 'samples');

/** 我方舱位 → SerpApi `travel_class`（1 经济 / 2 超级经济 / 3 商务 / 4 头等） */
const CABIN_TO_TRAVEL_CLASS = { economy: 1, premium: 2, business: 3, first: 4 };

/**
 * Google 的国家/语言。`hl=zh-CN` 决定返回中文航司名；
 * `gl` 决定走哪国的 Google 站点 —— 产品面向国内用户，取 `cn`。
 * ⚠️ 已存的样本是早前用 gl=us / gl=cn 各录过一份的（当时在探路），
 *    下一次真调时要留意结果是否有差异（额度够，不差这一枪）。
 */
const HL = 'zh-CN';
const GL = 'cn';

/** 取 key（缺失就抛错，让上层统一兜成 5xx，不去猜） */
function apiKey() {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    throw new Error('缺少环境变量 SERPAPI_KEY（SerpApi 的 key）');
  }
  return key;
}

/**
 * 是否走样例回放。
 * ⚠️ 刻意在**函数里**读环境变量（而不是模块顶层读一次）：开关永远跟当前进程一致。
 */
function replayEnabled() {
  return process.env.SERP_REPLAY === '1';
}

/** 读一份样例原文。找不到 → 抛错（绝不返回空数组糊弄过去） */
async function readSample(name) {
  let raw;
  try {
    raw = await readFile(join(SAMPLES_DIR, name), 'utf8');
  } catch {
    throw new Error(`回放模式找不到样例 samples/${name}（SERP_REPLAY=1 时只能查已存过样本的航线）`);
  }
  return JSON.parse(raw);
}

/** 分 → '8h45m'（前端「时长」那一列直接用这个字符串） */
function fmtDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** '2026-11-12 07:00' → '07:00'（取不到就给空串，不编一个时间出来） */
function timeOf(dateTime) {
  const m = /(\d{2}:\d{2})/.exec(String(dateTime || ''));
  return m ? m[1] : '';
}

/**
 * 把一个 SerpApi 方案（best_flights / other_flights 里的元素）压成前端要的形状。
 *
 * ⚠️ 这里只做**翻译**，不做取舍：没有价格的方案由调用方统计，不在这里偷偷丢掉业务信息。
 *
 * @param {object} group   SerpApi 的一个行程方案
 * @param {number} index   供兜底 id 用
 */
function toFlight(group, index) {
  const legs = Array.isArray(group?.flights) ? group.flights : [];
  const first = legs[0] || {};
  const last = legs[legs.length - 1] || {};
  const firstNo = String(first.flight_number || '').replace(/\s+/g, '');
  const airlineCode = firstNo.replace(/[0-9].*$/, '');

  // 经停数：优先用 layovers（Google 明确给的），没有就按「段数 − 1」推
  const stops = Array.isArray(group?.layovers)
    ? group.layovers.length
    : Math.max(0, legs.length - 1);

  const durationMin = Number(group?.total_duration) || 0;

  return {
    // id 用于前端「盯价」与订阅里匹配这一班：拼上每一段的航班号，避免中转方案撞车
    id:
      legs
        .map((l) => String(l?.flight_number || '').replace(/\s+/g, ''))
        .filter(Boolean)
        .join('-') || `FLIGHT-${index + 1}`,
    airline: first.airline ? `${first.airline} ${airlineCode}`.trim() : '未知航司',
    departTime: timeOf(first?.departure_airport?.time),
    arriveTime: timeOf(last?.arrival_airport?.time),
    duration: fmtDuration(durationMin),
    durationMin, // 数字版留着算「中转比直飞多花多久」，不要在字符串上做解析
    stops,
    stopText: stops === 0 ? '直飞' : `${stops} 停`,
    price: typeof group?.price === 'number' ? group.price : null,
  };
}

/**
 * 归一化：两个数组拼起来 → 翻译 → 按价格升序。
 * @returns {{ flights: Array<object>, meta: object }}
 */
function normalize(body) {
  const groups = [...(body?.best_flights || []), ...(body?.other_flights || [])];

  // 先把有价的挑出来排序；没价的不进列表，但**要计数**（见文件头坑 ③）
  const priced = [];
  let missing = 0;
  const seen = new Map(); // id → 出现次数，用于给重复航班号补后缀

  groups.forEach((g, i) => {
    const f = toFlight(g, i);
    if (f.price === null || f.price <= 0) {
      missing += 1;
      return;
    }
    const n = (seen.get(f.id) || 0) + 1;
    seen.set(f.id, n);
    if (n > 1) f.id = `${f.id}#${n}`; // 同一天同一班号出现两次（不同舱位/代理）时别让 id 撞
    priced.push(f);
  });

  priced.sort((a, b) => a.price - b.price);

  return {
    flights: priced,
    meta: {
      total: groups.length,
      priced: priced.length,
      missing,
      // 这批航班实际是哪一天的（回放时与你要查的日期无关，是录像那天的）
      date: body?.search_parameters?.outbound_date || '',
      returnDate: body?.search_parameters?.return_date || '',
      tripType: String(body?.search_parameters?.type) === '1' ? 'roundtrip' : 'oneway',
    },
  };
}

/**
 * 真调一次 SerpApi。失败抛 Error（message 可直接展示给用户）。
 * @param {Record<string, string|number>} params
 */
async function callSerp(params) {
  const key = apiKey(); // 提前取：缺 key 是配置问题，没必要重试
  const url = new URL(ENDPOINT);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('api_key', key);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`SerpApi 返回 ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`);
        // 5xx / 429 = 对方暂时不行，值得重试；4xx（key 错 / 参数错）= 再试也一样
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }

      const body = await res.json();

      // ⚠️ SerpApi 的失败**不是**靠 HTTP 状态码表达的：200 里也可能带 error 字段
      if (body?.error) {
        const err = new Error(`SerpApi 业务失败：${body.error}`);
        // 额度用完 / 参数不对这类问题重试无意义，交给上层直接展示
        err.retryable = false;
        throw err;
      }
      if (body?.search_metadata?.status !== 'Success') {
        const err = new Error(
          `SerpApi 未返回成功结果（status=${body?.search_metadata?.status ?? '未知'}）`,
        );
        err.retryable = true;
        throw err;
      }

      return body;
    } catch (e) {
      lastError = e;
      const retryable = e.retryable !== false;
      if (!retryable || attempt === MAX_RETRIES) break;
    }
  }

  throw lastError;
}

/**
 * 航班列表（实时价）。
 *
 * @param {{ origin: string, destination: string, date: string, returnDate?: string|null,
 *           cabin?: string, passengers?: number }} p
 * @returns {Promise<{ flights: Array<object>, meta: object }>} flights 按价格升序
 */
export async function searchFlights({
  origin,
  destination,
  date,
  returnDate = null,
  cabin = 'economy',
  passengers = 1,
}) {
  // 回放模式：不碰网络，直接读存下来的真实响应
  if (replayEnabled()) {
    const suffix = returnDate ? 'roundtrip' : 'oneway';
    const name = `serp-${origin.toLowerCase()}-${destination.toLowerCase()}-${suffix}.json`;
    console.log(`[serp][REPLAY] 读本地样例 samples/${name} —— 未发网络请求`);
    return normalize(await readSample(name));
  }

  console.log(`[serp][LIVE] 真调 SerpApi：${origin}→${destination} ${date}，走网络`);
  const body = await callSerp({
    engine: 'google_flights',
    hl: HL,
    gl: GL,
    // 坑 ①：1 = 往返、2 = 单程
    type: returnDate ? 1 : 2,
    departure_id: origin,
    arrival_id: destination,
    outbound_date: date,
    return_date: returnDate || undefined,
    travel_class: CABIN_TO_TRAVEL_CLASS[cabin] ?? 1,
    adults: passengers,
    // 价格一律人民币（日历那边也是 CNY，两个源的口径要对齐）
    currency: 'CNY',
  });

  return normalize(body);
}
