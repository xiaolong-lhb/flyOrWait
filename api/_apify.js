/**
 * Apify 客户端（内部共享工具，不是接口）
 *
 * 文件名以 _ 开头是刻意的：本地运行器（scripts/dev-api.mjs）与 Vercel 都会跳过 _ 开头的文件，
 * 它不会变成一个可访问的路由。好处是「第三方接口的调用细节只写一处」。
 *
 * ── 它是谁 ──
 *   Apify 上的 actor `lergassy/flight-price-calendar`：抓 Google Flights 的「价格日历」，
 *   一次返回「某个出发日起连续 N 天」的每日最低价。
 *   2026-10-15 实测：内地线（SZX→PEK）**30/30 天连续有价**、一天不缺（Sky 那边中间有缺日）。
 *
 * ── 为什么换掉 Sky（这是本文件的由来）──
 *   Sky Scrapper（见 api/_sky.js）免费档**实测只有 20 次/月**（响应头 X-RateLimit-Requests-Limit: 20），
 *   而本应用的核心是「订阅 + 定时比价」——5 条订阅每天刷一次就要 150 次/月，根本不够。
 *   Apify 这边：**$0.0002/行、免费档 $5/月** ⇒ 一条航线刷 90 天日历 = $0.018，
 *   约合「27 条航线每天刷一次」，量级完全不同。Sky 降级为备选（_sky.js 保留）。
 *
 * ── 输入口径（与 _sky.js::getPriceCalendar 对齐，上层无感）──
 *   getPriceCalendar({ origin, destination, currency, days })
 *     → Array<{ day: 'YYYY-MM-DD', price: number, isCheapest: boolean }>（按日期升序）
 *   ⚠️ 关键：Apify 的字段叫 `date`，我们统一翻译成 `day` —— 这样 api/_judge.js
 *      一行都不用改（它认的就是 `day`）。翻译只发生在这里。
 *
 * ── 三个必须知道的坑（下面看着多余的代码全是为了它们）──
 *   ① `currency` 默认 **USD**、`market` 默认**空** ⇒ 必须显式传 CNY + CN，
 *      否则拿到的是美元价、且销售地不明（票价会跟国内看到的不一样）。
 *   ② `proxyConfiguration` 默认**钉死住宅代理**（RESIDENTIAL），而**免费档该组可用数为 0**
 *      ⇒ 默认配置必然失败。官方说明里写了：住宅 IP 走「results API」（100~150 条），
 *      普通 IP 走「results page」（约 15~40 条）——而**日历只需要「每天一个最低价」，
 *      page 通道完全够用**，且任何 IP 都能跑。所以这里显式 `dataSource: 'page'`。
 *   ③ 它**按行计费**（一行 $0.0002），所以 `days` 直接等于成本：90 天 = $0.018。
 *      官方原文：`Error rows and empty results are always free.` ⇒ 拿不到数据的航线不花钱。
 *
 * ── 已知硬伤（不是我们的 bug，是源的脾气，页面措辞要兜住）──
 *   官方文档自己写着：`Some airlines keep fares off Google Flights …, so those flights come with no price.`
 *   ⇒ Google 链路会**系统性缺掉部分航司的票价**，报出来的「最低价」偏低。
 *   实测 SZX→HKG 与 Sky 逐日对比：Apify 便宜 13/18 天、中位 −30.6% ——很可能就是这个原因。
 *   对策：页面上把价格标成「参考价」；且**只认这一个源**，不要两源混用（同一天两个数更糟）。
 *
 * ── 样例回放开关（APIFY_REPLAY=1）──
 *   走真接口时，一次调用要 20~60 秒、且要烧 $0.018；开发联调不必每次都付这个代价。
 *   开关打开后**不发任何网络请求**，直接读 `samples/apify-calendar-{出发}-{到达}.json`
 *   （那是真接口返回过的**原文**，不是假数据）。
 *   ⚠️ 找不到样本 → **直接抛错**，绝不静默返回空数组 —— 那会让「这条航线没数据」
 *      和「这条航线没存样本」混成一件事。
 *   ⚠️ 样本名必须与文件名**大小写完全一致**（Windows 不敏感会掩盖问题、Linux 会挂）。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ACTOR = 'lergassy~flight-price-calendar';
const API = 'https://api.apify.com/v2';
/**
 * ── 超时：必须比平台的掐断时间**更早**，这一点是刻意的 ──
 *   run-sync 是阻塞式的（Apify 服务端自己最多等 300 秒），但**我们的部署上限只有 60 秒**
 *   （根目录 vercel.json 的 functions.maxDuration）。
 *
 *   如果这里放任它跑 230 秒，超时那一刻是**平台**把我们掐掉 —— 握手直接断，
 *   前端只会看到一句「网络异常」，我们自己写的「Apify 抓取超时」永远没机会回给用户。
 *   所以把内部超时收到 50 秒（服务端参数）/ 55 秒（本地 fetch 等待），
 *   留 5 秒给上层组装响应 —— 超时也超得**有话说**。
 *
 *   三层超时由内到外逐层放大：Apify 55s → 后端函数 60s → 浏览器 65s。
 */
const ACTOR_TIMEOUT_S = 50;
/** 本地 fetch 侧的超时，比上面再宽一点，避免「服务端刚算完、我们这边先断了」 */
const FETCH_TIMEOUT_MS = 55_000;
/** 默认抓「今天起多少天」的日历。90 天 ≈ $0.018；改大改小直接改成本，别乱调 */
const DEFAULT_CALENDAR_DAYS = 90;
/** 样例目录（项目根 samples/）—— 只在本机开发期用到，线上由 .vercelignore 挡在外面 */
const SAMPLES_DIR = join(import.meta.dirname, '..', 'samples');

/** 取 token（缺失就抛错，让上层统一兜成 5xx，不去猜） */
function apiToken() {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('缺少环境变量 APIFY_TOKEN（Apify 的 Personal API token）');
  }
  return token;
}

/** 本地时区的今天，YYYY-MM-DD —— 作为日历窗口的起点 */
function localToday() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 是否走样例回放。
 * ⚠️ 刻意在**函数里**读环境变量（而不是模块顶层读一次）：
 *    这样开关永远跟当前进程一致，不会因为模块被缓存而读到旧值。
 */
function replayEnabled() {
  return process.env.APIFY_REPLAY === '1';
}

/** 读一份样例的 items。找不到 / 结构不对 → 抛错（绝不返回空数组糊弄过去） */
async function readSample(name) {
  let raw;
  try {
    raw = await readFile(join(SAMPLES_DIR, name), 'utf8');
  } catch {
    throw new Error(
      `回放模式找不到样例 samples/${name}（APIFY_REPLAY=1 时只能查已存过样本的航线）`,
    );
  }
  const body = JSON.parse(raw);
  const items = body?.items;
  if (!Array.isArray(items) || !items.length) {
    throw new Error(`回放样例 samples/${name} 里没有 items 数据`);
  }
  return items;
}

/**
 * 把 Apify 的行统一成我们的内部口径：`date` → `day`，丢掉汇总行，按日期升序。
 * @param {Array<object>} items actor 的 dataset 行
 * @returns {Array<{ day: string, price: number, isCheapest: boolean }>}
 */
function normalize(items) {
  return items
    .filter(
      (it) => it && it.type === 'calendar_day' && typeof it.price === 'number' && it.price > 0,
    )
    .map((it) => ({ day: it.date, price: it.price, isCheapest: it.isCheapest === true }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * 真调一次 actor（阻塞式，20~60 秒），返回 dataset 行。
 * @param {{ origin: string, destination: string, currency: string, days: number }} p
 */
async function runActor({ origin, destination, currency, days }) {
  const token = apiToken();

  const body = {
    origin,
    destination,
    // 坑 ① 的延伸：Apify 的日历是「从 departureDate 起连续 days 天」，所以起点给今天
    departureDate: localToday(),
    calendarDays: days,
    // 只要日历，不要航班列表 —— 列表那一半走 SerpApi（另一条链路）
    calendarOnly: true,
    adults: 1,
    // ★ 固定经济舱（2026-10-23 决定，见 api/result.js 的 SUPPORTED_CABINS）
    //   actor 其实支持 cabinClass，枚举是 economy / premium_economy / business / first
    //   （**下划线**，不是空格 —— 这点容易记错）。没开放的原因不是不支持，
    //   而是「商务舱日历能不能凑够 api/_judge.js 的 14 天样本」没实测过：
    //   样本不够时判据会直接返回 available:false，等于卖了商务舱却回答不了「该不该买」。
    //   ⇒ 要做的话：这里改成入参 + api/result.js 放开 SUPPORTED_CABINS + 前端加回选项，
    //     三处一起改，并真跑一次看 dayCount 是否 ≥ 14。
    cabinClass: 'economy',
    currency, // ← 坑 ①：必须显式 CNY，默认是 USD
    market: 'CN', // ← 坑 ①：默认空，销售地不明会导致票价口径漂
    language: 'zh-CN',
    // 坑 ②：免费档没有住宅代理，直接点明走「结果页」通道（任何 IP 都能跑，日历够用）
    proxyConfiguration: { useApifyProxy: true },
    dataSource: 'page',
  };

  let res;
  try {
    res = await fetch(
      `${API}/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${ACTOR_TIMEOUT_S}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 官方两种传法都支持（?token= 与 Bearer 头），用头更干净、不会漏进日志
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
  } catch (e) {
    if (e.name === 'TimeoutError') {
      throw new Error(`Apify 抓取超时（超过 ${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒）`, {
        cause: e,
      });
    }
    throw new Error(`Apify 请求失败：${e.message}`, { cause: e });
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Apify 返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
  }

  if (!res.ok) {
    const detail = payload?.error?.message || JSON.stringify(payload).slice(0, 200);
    throw new Error(`Apify 返回 ${res.status}：${detail}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error(`Apify 返回格式异常（预期数组）：${JSON.stringify(payload).slice(0, 160)}`);
  }

  return payload;
}

/**
 * 价格日历：一次拿到「今天起 days 天」的每日最低价。
 *
 * @param {{ origin: string, destination: string, currency?: string, days?: number }} p
 * @returns {Promise<Array<{ day: string, price: number, isCheapest: boolean }>>} 按日期升序
 */
export async function getPriceCalendar({
  origin,
  destination,
  currency = 'CNY',
  days = DEFAULT_CALENDAR_DAYS,
}) {
  if (replayEnabled()) {
    const name = `apify-calendar-${origin.toLowerCase()}-${destination.toLowerCase()}.json`;
    console.log(`[apify][REPLAY] 读本地样例 samples/${name} —— 未发网络请求`);
    return normalize(await readSample(name));
  }

  console.log(`[apify][LIVE] 真调 actor：${origin}→${destination}，${days} 天，走网络`);
  return normalize(await runActor({ origin, destination, currency, days }));
}
