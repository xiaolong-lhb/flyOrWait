/**
 * 结果页组装层（纯函数，零网络）
 *
 * 文件名以 _ 开头是刻意的：本地运行器与 Vercel 都会跳过 _ 开头的文件，它不会变成路由。
 *
 * ── 为什么单独一个文件 ──
 *   「把两份原始数据（日历 + 航班列表）拼成结果页要的那一坨」这件事有 200 行，
 *   而且**全是纯计算**。抽出来有三个好处：
 *     ① 零网络 ⇒ 可以用 samples/ 里的真实响应离线跑，改一句话就能看结果；
 *     ② 口径只有一处 ⇒ 结果页的「档位」「典型区间」「阈值」不会出现第二套算法；
 *     ③ api/result.js 只剩「校参 → 打两个源 → 交给它 → 回包」，一眼看得完。
 *
 * ── 与 api/_judge.js 的分工 ──
 *   _judge 只管「一串价格 → 某个/每天的档位」；本文件管「档位 + 航班 + 参数 → 页面字段」。
 *
 * ── 两条不许破的纪律（都是从踩过的坑里来的）──
 *   ① 分位必须喂**整段窗口**：日历切片只用于展示，判据一律吃全窗口（否则同一天
 *      在 11 月和 12 月会得到两个不同的结论）。
 *   ② 拿不到数据就**不出结论**：judgement 不可用时 timingAnswer 返回 null，
 *      由页面如实说「这天暂时判断不了」，绝不硬算一个档位顶上。
 */

import { judgePrices, annotateDays } from './_judge.js';

const LEVEL_LABEL = { low: '偏低', typical: '正常', high: '偏高' };
const LEVEL_TEXT = { low: '属于偏便宜区间', typical: '属正常区间', high: '仍偏高' };
const VERDICT = {
  low: { verdict: 'buy', label: '建议现在买' },
  typical: { verdict: 'typical', label: '价格正常，可以买' },
  high: { verdict: 'wait', label: '建议再等等' },
};

/** 'YYYY-MM-DD' ± n 天 */
function shiftISO(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 两个 'YYYY-MM-DD' 相差几天 */
function daysBetween(fromISO, toISO) {
  const a = new Date(`${fromISO}T00:00:00`);
  const b = new Date(`${toISO}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

/** 分 → '2h45m' */
function fmtDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

const short = (iso) => String(iso).slice(5); // '2026-11-12' → '11-12'
const yuan = (n) => `¥${Math.round(n).toLocaleString()}`;
const cheapestOf = (arr) => arr.reduce((a, b) => (b.price < a.price ? b : a), arr[0]);

/* ══════════════════════════════════════════════════════════════════════
 * 一、日历 + 判据（api/calendar.js 与 api/result.js 共用这一段）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 一天 → 页面日历格。
 * price 取整到元：整个应用都按「元」展示（订阅阈值、卡片都是整数），留小数反而难看。
 * level 原样带上：**日历的颜色就用它**，不要再用 min~max 分档 ——
 * 那会把「颜色」和「结论」变成两套口径，而且远期异常值一进来就全被压成同一个色。
 */
function toCell(d) {
  const [, mm, dd] = d.day.split('-');
  return {
    day: Number(dd),
    date: d.day,
    shortDate: `${mm}-${dd}`,
    price: Math.round(d.price),
    level: d.level,
  };
}

/** 该月共几天（用于把日历补齐成整月） */
function daysInMonth(monthLabel) {
  const [y, m] = monthLabel.split('-').map(Number);
  return new Date(y, m, 0).getDate(); // 下个月的第 0 天 = 本月最后一天
}

/**
 * 一天 → 「这天没有报价」的占位格。
 * price / level 都是 null ⇒ 前端 priceColor(null) 落到中性灰、不染色，
 * 正好复用现成的「样本不足就不编造档位」语义（见 result.vue 的 priceColor 注释）。
 */
function toPlaceholderCell(iso) {
  const [, mm, dd] = iso.split('-');
  return { day: Number(dd), date: iso, shortDate: `${mm}-${dd}`, price: null, level: null };
}

/**
 * 从「整段窗口的每日价格」算出日历 + 判据。
 *
 * ⚠️ 本函数**不做 HTTP 判断**：数据为空 / 该月没数据，交给调用方决定回什么状态码。
 *
 * @param {{ days: Array<{day:string, price:number}>, month?: string, date?: string }} p
 *        days  —— 整段窗口（不是切片！）
 *        month —— 要看哪个月 'YYYY-MM'；不传取窗口首日所在月
 *        date  —— 目标出发日；给了才会算 judgement
 */

export function buildCalendarSection({ days, month, date }) {
  const annotated = annotateDays(days);
  const window = annotated.length
    ? { start: annotated[0].day, end: annotated[annotated.length - 1].day }
    : null;

  const monthLabel = month || (window ? window.start.slice(0, 7) : '');
  const byDate = new Map(annotated.map((d) => [d.day, d]));

  // ⚠️ 这里必须**补齐该月的每一天**，而不是只把「有数据的天」塞进数组。
  //    前端（result.vue）的做法是「先按 1 号的星期位补空格，再**顺序**渲染本数组、
  //    每格显示数组里的日号」—— 两者都必须从 1 号开始排才不会错位。
  //    若数组第一格是 14 号，整月的日期就会整体往前串若干格。
  //    真机下这**必然发生**：日历窗口是「今天起 90 天」，用户查「本月」时窗口起点就在月中。
  //    （以前没发现，是因为日历在 <details> 里默认折叠，得点开才看得见。）
  //    占位格 price/level = null ⇒ 灰色、不染色、不参与任何计算（见下面的 priced）。
  //
  // ⚠️ 但该月与窗口**完全没有交集**时不给占位（保持空数组）：
  //    否则「这个月根本没有数据」会被伪装成「一整月的灰格子」，
  //    调用方那句「无数据 → 报错」的判断（api/calendar.js 的 !dayCount）就失效了。
  const monthStart = `${monthLabel}-01`;
  const monthEnd = `${monthLabel}-${String(daysInMonth(monthLabel || '2000-01')).padStart(2, '0')}`;
  const overlaps = !!window && !!monthLabel && monthStart <= window.end && monthEnd >= window.start;

  const calendar = [];
  if (overlaps) {
    for (let i = 1; i <= daysInMonth(monthLabel); i++) {
      const iso = `${monthLabel}-${String(i).padStart(2, '0')}`;
      const hit = byDate.get(iso);
      calendar.push(hit ? toCell(hit) : toPlaceholderCell(iso));
    }
  }

  // ⚠️ 一切数值只看**有报价的格子**：占位格的 price 是 null，混进去会让
  //    Math.min(...prices) 变成 0、cheapestOf 选中一个空格子（页面就会显示 ¥0）。
  const prices = calendar.filter((c) => c.price !== null).map((c) => c.price);

  return {
    monthLabel,
    window,
    /** 整段窗口（已标档位）—— 判据、答案①的扫描池、最便宜一天都从它来 */
    annotated,
    calendar,
    monthMin: prices.length ? Math.min(...prices) : null,
    monthMax: prices.length ? Math.max(...prices) : null,
    /** 「该月有报价的天数」—— 注意不是数组长度（数组含占位格，等于当月天数） */
    dayCount: prices.length,
    judgement: date ? judgePrices(days, date) : null,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、答案②：购买时机（永远有）—— 【不再依赖 AI 写文案】
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把 judgement 翻译成页面上的「答案②」。
 *
 * ⚠️ 文案里的每个数字都必须能在下方「日历 / 航班列表」里找到出处。
 *    以前 mock 里有一句「历史上这个阶段仍出现过回调」——那是**行业规律占位**，
 *    我们拿不到历史数据去证明它 ⇒ 已删掉，不编造（红线）。
 *
 * @returns {object|null} judgement 不可用时返回 null（页面据此如实说明，不硬给结论）
 */
function buildTimingAnswer({ judgement, selected, flightsCount, todayISO }) {
  if (!judgement || !judgement.available) return null;

  const currentPrice = selected.price; // 与日历格子上那个数字保持一致
  const v = VERDICT[judgement.level] ?? VERDICT.typical;
  // ⚠️ 档位（level）与「跟典型区间的关系」必须**同源**，否则同一屏里会出现自相矛盾的话。
  //    实测撞到过：价格正好等于 P25 时，_judge 里 level 用 `<=` 判成 low、
  //    而 vsTypical 用 `<` 判成 within ⇒ 页面显示「偏低」紧跟着「落在典型区间内」。
  //    这里统一从 level 推，措辞取「…或更低 / 更高」，等号两侧都成立。
  const vsTypicalText =
    judgement.level === 'low'
      ? '已在典型区间下沿或更低'
      : judgement.level === 'high'
        ? '已在典型区间上沿或更高'
        : '落在典型区间内';

  const typicalLow = Math.round(judgement.typicalLow);
  const typicalHigh = Math.round(judgement.typicalHigh);
  const daysToDepart = Math.max(0, daysBetween(todayISO, selected.date));

  // 决策截止日 = 起飞前 21 天（产品规则，不是数据结论）。
  // 若这个日期已经过去 → 说明已进入决策期，文案换一句。
  const deadline = shiftISO(selected.date, -21);
  const deadlinePassed = deadline < todayISO;

  // 阈值默认值：取「典型区间下沿」与「当前价 × 0.95」中更低者 —— 宁可多等一点，也别漏掉回调
  const fallbackTo = Math.round(currentPrice * 0.95);
  const suggestedThreshold = Math.min(typicalLow, fallbackTo);

  const days = judgement.totalDays;
  const cheapest = judgement.cheapest;

  return {
    verdict: v.verdict, // buy | typical | wait
    verdictLabel: v.label,
    currentPrice,
    level: judgement.level,
    levelLabel: LEVEL_LABEL[judgement.level],
    positionPct: judgement.percentile,
    typicalLow,
    typicalHigh,
    // vsTypical 与 level 同源（见上面那段说明），保证页面上的两句话不会打架
    vsTypical:
      judgement.level === 'low' ? 'below' : judgement.level === 'high' ? 'above' : 'within',
    vsTypicalText,
    // 页面文案里的「接下来 N 天」，以及内部的样本量
    basisLabel: `接下来 ${days} 天`,
    basisDays: days,
    suggestedThreshold,

    // 推理链：每条都能在下面的日历 / 航班列表里对上
    reasoning: [
      `当前最低价 ${yuan(currentPrice)}（${selected.date}${
        flightsCount ? `，实时查询共 ${flightsCount} 班可选` : '，来自价格日历'
      }）`,
      `接下来 ${days} 天里最便宜的是 ${cheapest.date} 的 ${yuan(
        cheapest.price,
      )}；当前价处于第 ${judgement.percentile} 百分位（越低越便宜）`,
      `典型价区间 ${yuan(typicalLow)}~${yuan(typicalHigh)}，当前价${vsTypicalText}`,
      judgement.level === 'high'
        ? `距出发还有 ${daysToDepart} 天，价格高于典型区间，值得设个阈值等一次回调`
        : judgement.level === 'low'
          ? `距出发还有 ${daysToDepart} 天，当前价已在低位，继续等的空间有限`
          : `距出发还有 ${daysToDepart} 天，当前价处于正常水位，可按需决定`,
    ],

    // 「再等等」的三件套：触发条件 + 决策期限 + 数据依据（缺一条就不许出「再等等」）
    action: {
      // ⚠️ 说「提醒」而不是「发邮件」：通知渠道（Resend 之类）这一轮还没接，别在文案里许愿
      condition: `跌到 ${yuan(
        judgement.level === 'low' ? fallbackTo : suggestedThreshold,
      )} 或更低，我立刻提醒你`,
      deadline,
      deadlineText: deadlinePassed
        ? '已进入决策期，建议尽快决定'
        : `最晚 ${deadline}（起飞前 21 天）前做决定`,
      basisText: `基于接下来 ${days} 天的实时报价（共 ${days} 个价格点）`,
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、答案①：出发日建议（仅「日期不固定」时出现）
 * ══════════════════════════════════════════════════════════════════════ */

/** 该扫哪些天：整月最优 → 目标日期所在整月；±3 / ±7 → 前后 N 天 */
function scanPool(allDays, params) {
  if (params.flexibility === 'month') {
    const month = (params.departDate || allDays[0].day).slice(0, 7);
    return allDays.filter((d) => d.day.startsWith(month));
  }
  const span = params.flexibility === 'plus3' ? 3 : 7;
  if (!params.departDate) return allDays.slice(0, span * 2 + 1);
  const lo = shiftISO(params.departDate, -span);
  const hi = shiftISO(params.departDate, span);
  return allDays.filter((d) => d.day >= lo && d.day <= hi);
}

function buildDateAnswer({ annotated, params, targetDate, selectedPrice }) {
  if (params.flexibility === 'fixed' || !annotated.length) return null;

  const pool = scanPool(annotated, params);
  if (!pool.length) return null;

  const best = cheapestOf(pool);
  // 这一天放在**整段窗口**里排第几（口径与答案②完全一致）
  const j = judgePrices(annotated, best.day);

  const savedText = !params.departDate
    ? '已为你锁定最便宜的出发日'
    : best.day === targetDate
      ? '你选的就是最优日，暂无更省的选择'
      : `比所选 ${short(targetDate)} 省 ${yuan(selectedPrice - best.price)}`;

  return {
    scopeText: pool.length > 1 ? `${pool[0].day} ~ ${pool[pool.length - 1].day}` : pool[0].day,
    scannedDays: pool.length,
    bestDate: short(best.day),
    bestDateISO: best.day,
    bestPrice: Math.round(best.price),
    savedText,
    historyLevel: best.level,
    historyPct: j.available ? j.percentile : null,
    historyText: j.available
      ? `该日价格处于接下来 ${j.totalDays} 天的第 ${j.percentile} 百分位，${LEVEL_TEXT[best.level]}`
      : `该日价格${LEVEL_TEXT[best.level] ?? ''}`,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、延展建议（hints）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 这三条判空是**刻意**的 —— 原 mock 里有三个已知缺陷，移植到后端时一并修掉了：
 *   ① 不判「中转真的更便宜」→ 中转 ¥3200 / 直飞 ¥2800 时会输出「省 ¥-400」
 *   ② 不防「该航线全是中转」→ Math.min(...[]) = Infinity → 输出「省 ¥Infinity」
 *   ③ 「多约 2h45m」是硬编码 → 现在按实际的 durationMin 差值算
 */
function buildHints({
  annotated,
  flights,
  directMin,
  transferMin,
  params,
  targetDate,
  selectedPrice,
}) {
  const hints = [];

  const transfers = flights.filter((f) => f.stops > 0);
  if (directMin !== null && transferMin !== null && transferMin < directMin && transfers.length) {
    const cheapestTransfer = cheapestOf(transfers);
    const directs = flights.filter((f) => f.stops === 0);
    const fastestDirect = directs.reduce(
      (a, b) => (b.durationMin < a.durationMin ? b : a),
      directs[0],
    );
    const extra = cheapestTransfer.durationMin - fastestDirect.durationMin;
    hints.push({
      type: 'transfer',
      text: `中转可省：${cheapestTransfer.airline} ${cheapestTransfer.stopText} ${yuan(
        cheapestTransfer.price,
      )}，比直飞最低省 ${yuan(directMin - transferMin)}${extra > 0 ? `、多约 ${fmtDuration(extra)}` : ''}`,
    });
  }

  if (params.flexibility === 'fixed' && annotated.length) {
    const cheapest = cheapestOf(annotated);
    // ⚠️ 差价必须为正才出这条 —— 否则会写出「更便宜 ¥-300」这种反话
    if (cheapest.day !== targetDate && cheapest.price < selectedPrice) {
      hints.push({
        type: 'flexible',
        text: `灵活出发：若日期可挪，${short(cheapest.day)} 更便宜 ${yuan(
          selectedPrice - cheapest.price,
        )} —— 在查询页选「±3 天 / 整月最优」我直接帮你锁定。`,
      });
    }
  }

  return hints;
}

/* ══════════════════════════════════════════════════════════════════════
 * 五、提示语（notices）：把「缺什么」如实说出来，而不是留个空白让人猜
 * ══════════════════════════════════════════════════════════════════════ */

function judgementReason(j, window) {
  if (!j) return '没有可判断的出发日，暂不做「该不该买」的判断';
  if (j.reason === 'insufficient_data') {
    return `报价样本只有 ${j.totalDays} 天，不足以判断贵贱，这次不给结论`;
  }
  if (j.reason === 'date_out_of_window') {
    const range = window ? `${window.start} ~ ${window.end}` : '当前窗口';
    return `所选日期不在可查范围内（当前可查 ${range}）`;
  }
  if (j.reason === 'date_no_data') return '所选日期这天数据源没有报价，暂不做判断';
  return '数据不足，暂不做判断';
}

/* ══════════════════════════════════════════════════════════════════════
 * 六、总装
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 组装结果页的全部数据。
 *
 * @param {object} p
 * @param {object} p.section       buildCalendarSection 的返回值
 * @param {object|null} p.flightsResult  _serp.searchFlights 的返回值；null = 航班那一路挂了
 * @param {object} p.params        查询参数（原样回显给页面）
 * @param {string} p.targetDate    这次要判断的出发日 'YYYY-MM-DD'
 * @param {string} p.snapshotAt    快照时间（展示用；提醒用户这份判断会过期）
 * @param {string} p.todayISO      服务器本地今天（算「距出发几天」用；传进来便于离线测）
 */
export function composeResult({
  section,
  flightsResult,
  params,
  targetDate,
  snapshotAt,
  todayISO,
}) {
  const { calendar, window, judgement } = section;
  const flights = flightsResult ? flightsResult.flights : [];
  const meta = flightsResult ? flightsResult.meta : null;

  // 日历里一格报价都没有时**不给兜底**：说明目标日期落在了可查范围之外（调用方本该先拦下来）。
  // 这里若硬凑一个「最便宜的格子」，页面就会拿别的月份的数据冒充所选日期 —— 那是编造。
  // 不静默兜底，也不让下面的 selected.price 抛一个看不懂的 TypeError。
  // ⚠️ 判据是「有没有**报价**」，不是「数组长不长」—— 补齐占位格后，数组几乎总是非空的。
  // 这是「该月根本没有数据」的**唯一**出口：占位格全是 null，会被这里挡下。
  const pricedCells = calendar.filter((c) => c.price !== null);
  if (!pricedCells.length) {
    const range = window ? `${window.start} ~ ${window.end}` : '当前窗口';
    throw new Error(`${section.monthLabel} 没有报价数据（可查范围 ${range}），无法组装结果页`);
  }

  // ── 选中格 ──
  // 优先精确命中目标日期；命不中（这天没报价）就退到当月最便宜那天 ——
  // 页面总得有个「被选中」的格子，但 judgement 那边会如实说「这天判断不了」，两者不冲突。
  // ⚠️ 必须从 pricedCells 里选：占位格的 price 是 null，一旦被 cheapestOf 选中，
  //    页面就会拿到 null 当价格渲染（曾出过「¥0.00k」这种凭空冒出来的数字）。
  const selected = pricedCells.find((c) => c.date === targetDate) ?? cheapestOf(pricedCells);
  const sortedCells = [...pricedCells].sort((a, b) => a.price - b.price);
  const rank = sortedCells.findIndex((c) => c.date === selected.date) + 1;
  // 回给页面的 calendar 含占位格（要用来占位对齐），但只有有价的格子会被标成 selected
  const calendarMarked = calendar.map((c) => ({ ...c, isSelected: c.date === selected.date }));
  // selected 也取「标过 isSelected 的那个对象」，免得它和 calendar 里的同一格形状不一致
  // （少一个字段的坑很小，但踩到时是「前端某处莫名 undefined」，不值得省这一行）
  const selectedCell = calendarMarked.find((c) => c.date === selected.date) ?? selected;

  // ── 航班：标出「当天最低」那一班（这是 lowest_price 的正确用途：选哪一班，不是该不该买）──
  const lowestPrice = flights.length ? flights[0].price : selected.price;
  const markedFlights = flights.map((f) => ({ ...f, isLowest: f.price === lowestPrice }));

  const directs = flights.filter((f) => f.stops === 0);
  const transfers = flights.filter((f) => f.stops > 0);
  const directMin = directs.length ? Math.min(...directs.map((f) => f.price)) : null;
  const transferMin = transfers.length ? Math.min(...transfers.map((f) => f.price)) : null;

  const timingAnswer = buildTimingAnswer({
    judgement,
    selected,
    flightsCount: flights.length,
    todayISO,
  });

  const dateAnswer = buildDateAnswer({
    annotated: section.annotated,
    params,
    targetDate,
    selectedPrice: selected.price,
  });

  const hints = buildHints({
    annotated: section.annotated,
    flights,
    directMin,
    transferMin,
    params,
    targetDate,
    selectedPrice: selected.price,
  });

  // ── 提示语：缺什么就说什么 ──
  const notices = {};
  if (!flightsResult) {
    notices.flights = '航班列表这次没取到，先看价格日历';
  } else if (meta.missing > 0) {
    notices.flights = `${meta.total} 个方案里有 ${meta.missing} 个数据源没给价，已跳过（这是数据源的常态，不是丢数据）`;
  }
  if (meta && meta.tripType === 'roundtrip') {
    notices.tripType = '往返行程当前只列出去程候选，完整往返比价待接入';
  }
  // 航班源实际返回的是哪一天。正常情况下就等于所选日期；一旦不等（回放样本是几天前录的、
  // 或源给错了日期），页面必须说出来 —— 否则用户会看到「所选 11-20」配着 11-12 的航班时刻表。
  if (meta && meta.date && meta.date !== targetDate) {
    notices.flightsDate = `航班列表是 ${meta.date} 的报价（与所选 ${targetDate} 不同），日期请以价格日历为准`;
  }
  if (!timingAnswer) {
    notices.judgement = judgementReason(judgement, window);
  }

  return {
    params,
    snapshotAt,
    currency: 'CNY',

    monthLabel: section.monthLabel,
    calendar: calendarMarked,
    monthMin: section.monthMin,
    monthMax: section.monthMax,
    dayCount: section.dayCount,
    window,
    selected: selectedCell,
    rank,

    flights: markedFlights,
    lowestPrice,
    directMin,
    transferMin,

    timingAnswer, // null = 这次判断不了，页面如实说明
    dateAnswer, // null = 「固定日期」或没有可扫的天
    hints,

    suggestedThreshold: timingAnswer
      ? timingAnswer.suggestedThreshold
      : Math.round(selected.price * 0.95),
    notices,
  };
}
