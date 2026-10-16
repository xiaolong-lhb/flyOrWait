/**
 * 判据层：把「一串每日价格」判成一个档位结论（low / typical / high）
 *
 * 文件名以 _ 开头是刻意的：本地运行器与 Vercel 都会跳过 _ 开头的文件，它不会变成路由。
 *
 * ── 为什么单独一个文件 ──
 *   ① 它是「该不该买」这个核心结论的算法。将来数据源会换（Sky 日历 / SerpApi 历史 / 自建缓存），
 *      但算法不变 → 抽出来，换源只改「喂进来的数组」，判断逻辑一个字不动。
 *   ② 纯函数、零网络 → 可以直接拿 samples/ 里的真实响应验证，**不烧一次额度**。
 *
 * ── 输入 ──
 *   days       形如 [{ day: '2026-11-12', price: 1839.54 }, ...]
 *              直接喂 Sky Scrapper getPriceCalendar 的 data.flights.days（多余的 group 字段会被忽略）
 *   targetDate 'YYYY-MM-DD'：用户要出发的那一天
 *
 * ── 判据怎么算的 ──
 *   把整个窗口的价格从小到大排，取 P25 / P75 当分界：
 *     目标价 <= P25   → low       （便宜）
 *     目标价 >= P75   → high      （贵）
 *     其余            → typical   （正常）
 *   这个 25 / 50 / 25 的切法不是拍脑袋：实测 Sky 自己返回的 group 分布就是 53 / 108 / 54
 *   （≈25% / 50% / 25%），说明它也是按分位切的 —— 我们用同一套口径，方便交叉校验。
 *
 * ── 和 Google 的 price_level 有什么区别（重要）──
 *   Google 的 price_level 拿「过去 62 天」比 → 回答「这个价，比历史通常的价贵吗」
 *   我们拿「未来整个窗口」比               → 回答「这个价，比接下来别的出发日贵吗」
 *   用户真正要决定的是「现在买 / 再等等」，后者更直接相关。
 *   港澳台与国际航线两边都有，可互为佐证；纯内地航线只有我们这一套（Google 不返回）。
 *
 * ── 不编造（红线）──
 *   样本太少 或 目标日期没有价格 → 返回 available:false，由上层决定怎么展示，
 *   **绝不用残缺数据硬算一个档位出来**。
 *   "没有这天"还要再分两种（10-15 实测：HKG 样本的 11-12 就属于后者）：
 *     date_out_of_window —— 真的超出可查范围（早于窗口首日 / 晚于窗口末日）
 *     date_no_data       —— 在窗口范围内，但这一天**数据源本身缺数据**（窗口不连续，很常见）
 *   两者对用户是两句不同的话：「超出可查范围」vs「这天暂无价格」，不能混成一句。
 *
 * ⚠️ TODO（已知简化，等真实数据跑起来再定）：
 *   目前用「整个窗口」算分位。窗口长达 87~215 天，远处旺季/淡季会拉宽区间。
 *   若实测发现对「近期出发」不够敏感，可改为只看目标日期前后各 N 天（加一个 scope 参数）。
 */

/** 样本少于这个数就不出结论 —— 分位数在样本太少时会剧烈跳动 */
const MIN_SAMPLE = 14;
/** 档位分界：P25 / P75（与 Sky 的 group 分布口径一致） */
const LOW_P = 0.25;
const HIGH_P = 0.75;

/**
 * 线性插值分位数（sorted 必须已升序）
 * ⚠️ 算法与前端 mock（src/data/mockResult.js）里那份**保持完全一致**，
 *    否则「页面上的典型区间」与「后端的档位判断」会出现两套口径。
 */
function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 判档。返回结论对象；数据不足时返回 { available: false, reason }。
 *
 * @param {Array<{day: string, price: number}>} days 每日价格（顺序无所谓，内部会排序）
 * @param {string} targetDate 目标出发日 'YYYY-MM-DD'
 */
export function judgePrices(days, targetDate) {
  // 1 清洗：丢掉没有价格的日子（数据源本来就有缺日），按日期升序
  const clean = (days || [])
    .filter((d) => d && typeof d.price === 'number' && d.price > 0)
    .map((d) => ({ day: d.day, price: d.price }))
    .sort((a, b) => a.day.localeCompare(b.day));

  if (clean.length < MIN_SAMPLE) {
    return { available: false, reason: 'insufficient_data', totalDays: clean.length };
  }

  // 2 目标日期必须在这批数据里 —— 不在就分两种：真的超范围，还是窗口内缺这天
  //   （'YYYY-MM-DD' 是定长字符串，直接比大小等价于比日期，不用转 Date）
  const window = { start: clean[0].day, end: clean[clean.length - 1].day };
  const target = clean.find((d) => d.day === targetDate);
  if (!target) {
    const outOfRange = targetDate < window.start || targetDate > window.end;
    return {
      available: false,
      reason: outOfRange ? 'date_out_of_window' : 'date_no_data',
      totalDays: clean.length,
      window,
    };
  }

  // 3 算分位与统计
  const sorted = clean.map((d) => d.price).sort((a, b) => a - b);
  const typicalLow = percentile(sorted, LOW_P);
  const typicalHigh = percentile(sorted, HIGH_P);
  const median = percentile(sorted, 0.5);

  // 4 判档（用 <= / >= 与前端 mock 口径一致）
  const level =
    target.price <= typicalLow ? 'low' : target.price >= typicalHigh ? 'high' : 'typical';
  const vsTypical =
    target.price < typicalLow ? 'below' : target.price > typicalHigh ? 'above' : 'within';

  // 5 百分位：窗口内有多少天比它更便宜（越低越便宜）
  const cheaperCount = sorted.filter((p) => p < target.price).length;
  const percentileRank = Math.round((cheaperCount / sorted.length) * 100);

  const cheapest = clean.reduce((a, b) => (b.price < a.price ? b : a), clean[0]);

  return {
    available: true,
    level, // low | typical | high
    vsTypical, // below | within | above
    price: target.price,
    percentile: percentileRank, // 0~100，越小越便宜
    cheaperCount, // 比目标日更便宜的天数
    totalDays: sorted.length, // 参与判断的总天数（样本量，用于页面上如实标注）
    typicalLow,
    typicalHigh,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    // ⚠️ max 可能含远期异常值（实测出现过 21513）—— 展示时优先用 typicalHigh / median
    cheapest: { date: cheapest.day, price: cheapest.price },
    window: { start: clean[0].day, end: clean[clean.length - 1].day },
  };
}

/**
 * 给整段窗口的**每一天**标档位（low / typical / high），供「价格日历」上色用。
 *
 * ── 为什么需要它（换数据源引出来的）──
 *   以前日历的颜色是 Sky 自己在响应里给的 `group`（low / medium / high），我们照抄。
 *   换成 Apify 之后它**不返回这个字段** —— 于是要么自己拍一个阈值，要么
 *   用跟「该不该买」**完全相同**的分位口径。选后者：同一次请求里，
 *   日历的颜色和结论的档位出自同一个函数，天然不会互相打架。
 *
 * ── 与 judgePrices 的关系 ──
 *   共用同一套 LOW_P / HIGH_P / percentile。区别只是：judgePrices 回答「某一天贵不贵」，
 *   这个回答「每一天贵不贵」。样本不足（< MIN_SAMPLE）时每天的 level 给 null ——
 *   **不编造档位**，由前端决定是灰度显示还是不染色。
 *
 * ⚠️ 必须喂**整段窗口**、再切片去展示（跟 judgePrices 同一条纪律）：
 *    拿「切完月的 19 天」去排分位，同一天在 11 月和 12 月会得到不同颜色。
 *
 * @param {Array<{day: string, price: number}>} days
 * @returns {Array<{day: string, price: number, level: 'low'|'typical'|'high'|null}>} 按日期升序
 */
export function annotateDays(days) {
  const clean = (days || [])
    .filter((d) => d && typeof d.price === 'number' && d.price > 0)
    .map((d) => ({ day: d.day, price: d.price }))
    .sort((a, b) => a.day.localeCompare(b.day));

  if (clean.length < MIN_SAMPLE) {
    return clean.map((d) => ({ ...d, level: null }));
  }

  const sorted = clean.map((d) => d.price).sort((a, b) => a - b);
  const typicalLow = percentile(sorted, LOW_P);
  const typicalHigh = percentile(sorted, HIGH_P);

  return clean.map((d) => ({
    ...d,
    level: d.price <= typicalLow ? 'low' : d.price >= typicalHigh ? 'high' : 'typical',
  }));
}
