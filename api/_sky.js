/**
 * Sky Scrapper 客户端（内部共享工具，不是接口）
 *
 * 文件名以 _ 开头是刻意的：本地运行器（scripts/dev-api.mjs）与 Vercel 都会跳过 _ 开头的文件，
 * 它不会变成一个可访问的路由。好处是「第三方接口的调用细节只写一处」。
 *
 * 它负责什么：把「怎么跟 Sky Scrapper 说话」收在文件里 ——
 *   拼 URL、带两个必填请求头、设超时、失败重试、把五花八门的失败归一成一句能展示的话。
 * 上层（api/calendar.js）只管传航线、拿数组，不用关心这些。
 *
 * ⚠️ 用的是 RapidAPI 的 key（账号级：一把 key 通用于所有**已订阅**的 API）。
 *    它只能待在服务端 —— 绝不加 VITE_ 前缀、绝不进前端代码，否则等于把额度送给所有人。
 *
 * ── 实测得来的三条「怪脾气」（下面看着多余的代码全是为了它们）──
 *   ① getPriceCalendar 的 fromDate / toDate **必填，但值会被忽略**：
 *      不传报 {"status":false,"message":[{"fromDate":"Invalid value"}]}，
 *      传 2030 年也照样返回同一份数据 → 所以固定填今天，只为满足它的校验。
 *   ② 会偶发 {"status":false,"message":"Something went wrong..."}，重试一次通常就好
 *      → 所以带重试，把它当「暂时性失败」而不是致命错误。
 *   ③ HTTP 200 也可能是业务失败（官方把结果塞在 body.status 里）
 *      → 判成败必须看 body.status，不能只看 HTTP 状态码。
 *
 * ── 两个接口的成功返回（data 部分）──
 *   searchAirport     → [{ presentation:{suggestionTitle}, navigation:{ entityType,
 *                         relevantFlightParams:{ skyId, entityId } } }]
 *   getPriceCalendar  → { flights: { groups[], days: [{ day:'YYYY-MM-DD',
 *                         group:'low|medium|high', price }] }, priceForReturnFlight }
 *
 * ── 样例回放开关（SKY_REPLAY=1）──
 *   免费档实测只有 20 次/月，打满后整整一个月都没法再打真接口 —— 那段时间要开发/联调怎么办？
 *   答案：`samples/` 里存着当时**真实响应**的原文（脱敏），把它当「录像」放一遍即可。
 *   于是「接口 → 判据 → 响应」整条链路照样能端到端跑通，**一次额度都不烧**。
 *   ⚠️ 这不是假数据 —— 是之前真接口返回过的原文；找不到样本时**直接报错，绝不静默返回空**。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOST = 'sky-scrapper.p.rapidapi.com';
/** 官方说明：live 查询耗时 3~8 秒 → 超时给不够会误杀正常请求，这里留一倍余量 */
const TIMEOUT_MS = 15000;
/** 重试次数（1 = 最多发 2 次请求）。只对付「偶发抽风」，不是无限重试 */
const MAX_RETRIES = 1;
/** 样例目录（项目根 samples/）—— 只在本机开发期用到，线上不会进包 */
const SAMPLES_DIR = join(import.meta.dirname, '..', 'samples');

/** 取 key（缺失就抛错，让上层统一兜成 5xx，不去猜） */
function apiKey() {
  // 兼容两个键名：health.js 里登记的是 SKYSCRAPPER_KEY；万一 .env.local 写成 RAPIDAPI_KEY 也能读到，
  // 省得因为一个名字排查半天。（两个都没有才是真的没配）
  const key = process.env.SKYSCRAPPER_KEY || process.env.RAPIDAPI_KEY;
  if (!key) {
    throw new Error('缺少环境变量 SKYSCRAPPER_KEY（RapidAPI 的 key）');
  }
  return key;
}

/** 本地时区的今天，YYYY-MM-DD（只用于填那个被忽略的必填参数） */
function localToday() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 是否走样例回放。
 * ⚠️ 刻意在**函数里**读环境变量（而不是模块顶层读一次）：
 *    这样开关的状态永远跟当前进程一致，不会因为模块被缓存而读到旧值。
 */
function replayEnabled() {
  return process.env.SKY_REPLAY === '1';
}

/**
 * 读一份样例，返回它的 data（与真实调用 callSky 的返回口径对齐）。
 * 找不到 / 不是成功响应 → 抛错。**绝不返回空数组糊弄过去** —— 那会让「没数据」和「没录像」混为一谈。
 *
 * ⚠️ name 必须与 samples/ 里的文件名**大小写完全一致**：Windows 下大小写不敏感会掩盖问题，
 *    一到 Linux（线上）就找不到文件 —— 所以这里刻意不做任何 toLowerCase 兜底。
 */
async function readSample(name) {
  const fileName = name;
  let raw;
  try {
    raw = await readFile(join(SAMPLES_DIR, fileName), 'utf8');
  } catch {
    throw new Error(
      `回放模式找不到样例 samples/${fileName}（SKY_REPLAY=1 时只能查已存过样本的航线）`,
    );
  }
  const body = JSON.parse(raw);
  // samples/ 里也可能存着失败响应（历史原因），一并挡掉
  if (body?.status !== true) {
    throw new Error(`回放样例 samples/${fileName} 不是成功响应（status !== true）`);
  }
  return body.data;
}

/**
 * 调一次 Sky Scrapper。成功返回 body.data；失败抛 Error（message 可直接展示给用户）。
 *
 * @param {string} path   形如 '/api/v1/flights/getPriceCalendar'
 * @param {Record<string, string|number>} params  查询参数（空值会被丢掉）
 */
async function callSky(path, params) {
  const key = apiKey(); // 提前取：缺 key 是配置问题，没必要重试（也不该进下面的循环）

  const url = new URL(`https://${HOST}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          // 这两个头缺一不可：Key 证明你是谁，Host 告诉 RapidAPI 你要打哪个 API
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': HOST,
        },
        // fetch 自己没有超时，靠这个「到点自动中断」，否则请求会一直挂着
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(
          `Sky Scrapper 返回 ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`,
        );
        // 5xx / 429 = 对方暂时不行，值得重试；4xx（Key 错、没订阅）= 再试也一样，直接放弃
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }

      const body = await res.json();

      // ⚠️ 坑 ③：HTTP 200 也可能是业务失败，成败在 body.status 里
      if (body?.status !== true) {
        const detail =
          typeof body?.message === 'string' ? body.message : JSON.stringify(body?.message ?? '');
        const err = new Error(`Sky Scrapper 业务失败：${detail || '未知原因'}`);
        err.retryable = true; // 坑 ②：实测这类错重试常能过
        throw err;
      }

      return body.data;
    } catch (e) {
      lastError = e;
      // 默认当作可重试（fetch 抛的 TypeError = 断网/DNS；超时是 TimeoutError，都没有 retryable 字段）
      const retryable = e.retryable !== false;
      if (!retryable || attempt === MAX_RETRIES) break;
    }
  }

  throw lastError;
}

/**
 * 地名 → skyId。返回 data 数组（含 presentation / navigation）。
 *
 * 注意：**我们平时用不到它**。前端机场表只放「具体机场」，而实测「机场级 skyId == IATA 码」，
 * 所以 from/to 能直接当 skyId 用。留在这儿是给「城市级码」兜底（如 TYO → TYOA）。
 */
export function searchAirport(query) {
  if (replayEnabled()) {
    return readSample(`sky-searchAirport-${String(query).toLowerCase()}.json`);
  }
  return callSky('/api/v1/flights/searchAirport', { query, locale: 'en-US' });
}

/**
 * 价格日历：一次拿到「今天起整段窗口」的每日最低价。
 * ⚠️ 窗口长度随航线变（实测 87~215 天），且中间可能有缺日 —— 上层要容忍。
 *
 * @param {{ origin: string, destination: string, currency?: string }} p
 * @returns {Promise<Array<{ day: string, group: string, price: number }>>} 按日期升序
 */
export async function getPriceCalendar({ origin, destination, currency = 'CNY' }) {
  // 回放模式：不碰网络，直接读存下来的真实响应（样本名 = samples/sky-priceCalendar-{小写航线码}.json）
  if (replayEnabled()) {
    const name = `sky-priceCalendar-${origin.toLowerCase()}-${destination.toLowerCase()}.json`;
    const data = await readSample(name);
    return data?.flights?.days ?? [];
  }

  const today = localToday();
  const data = await callSky('/api/v1/flights/getPriceCalendar', {
    originSkyId: origin,
    destinationSkyId: destination,
    fromDate: today, // ← 坑 ①：必填但值被忽略，填今天只为过校验
    toDate: today, //  ← 同上
    currency,
  });

  // 只取「每天价格」这一层。groups（£/££/£££ 图例）是硬编码的、我们不用；noPriceLabel 实测没触发过。
  return data?.flights?.days ?? [];
}
