/**
 * ============================================================================
 * ⚠️ 本文件全部是 MOCK 假数据 —— 仅用于在「未接入真实数据」前跑通结果页。
 *    接入真实数据时，请按下方的标记逐个替换来源。
 *
 * 【API】= 需要调真实接口        【AI】= 需要大模型产出
 *
 *  ① calendar      每日最低价      →【API】价格日历 API（Sky Scrapper getPriceCalendar / 聚合数据）
 *                                     ⚠️ 只给「每天一个最低价」，没有航班明细；必须走 Serverless 代理
 *  ② flights       航班列表        →【API】实时价 API（Sky Scrapper searchFlights / SerpApi google_flights）
 *                                     ⚠️ 这是**另一次独立调用**，不要指望从日历里拆出航班
 *  ③ priceHistory  62 天历史曲线   →【API】SerpApi google_flights 的 price_insights.price_history
 *                                     ⚠️ 随「单日航班查询」一起返回，不额外调用；约 61~62 天，每天 1 个点
 *                                     ⚠️ 该曲线是「同一出发日」的价格走势，换出发日要重新查
 *                                     ⚠️ 带航司/经停过滤时 Google 可能不返回该字段 → 判断层查询禁止带过滤
 *  ④ timingAnswer  购买时机（答案②）→【AI】DeepSeek 解释层
 *                                     输入 = 当前最低价 + 62 天历史 + 典型区间 + 档位
 *                                     ⚠️ 红线：AI 只翻译归纳，不得编造任何数字
 *  ⑤ dateAnswer    出发日建议（答案①）→【AI + API】Agent 扫日历求最优出发日，再查该日的历史档位
 *  ⑥ 数据依据      替代原「把握 %」  → 不再编造置信度百分比，改为如实标注数据来源与样本量；
 *                                     无历史数据时必须显式说明，不允许硬给结论
 *
 * 【调用次数】固定日期 = 1 次日历 + 1 次单日航班（含 price_insights）= 2 次
 *             整月最优 = 1 次日历 + 1 次单日（选中日即最优日）= 2 次
 *             ±3 / ±7  = 1 次日历 + 1 次选中日 + 1 次最优日 = 3 次（多出的一次用于答案①的历史档位）
 * ============================================================================
 */

/** 当月每日最低价序列（MOCK 固定值，从当月 1 号起依次映射）→【API】① */
const DAILY_PRICE_SEQ = [
  2550, 2300, 2200, 2450, 2280, 2320, 2400, 2600, 2350, 2350, 2430, 2180, 2400, 2800, 2300, 2200,
  2050, 1990, 2300, 2700, 2900, 2400, 2260, 2380, 2450, 2350, 2500, 2650, 2420, 2280,
];

/**
 * 航班模板（MOCK）→【API】②
 * 真实价格 = 该日期最低价 × factor，取整到十位。
 * factor 拉开「直飞贵 / 中转便宜」的价差，方便演示「组合延展」提示。
 */
const FLIGHT_TEMPLATES = [
  {
    id: 'ZH0820',
    airline: '深航 ZH',
    departTime: '08:20',
    duration: '4h10m',
    stops: 0,
    stopText: '直飞',
    factor: 1.096,
  },
  {
    id: 'CZ1340',
    airline: '南航 CZ',
    departTime: '13:40',
    duration: '4h25m',
    stops: 0,
    stopText: '直飞',
    factor: 1.136,
  },
  {
    id: 'JL0900',
    airline: '日航 JL',
    departTime: '09:00',
    duration: '4h05m',
    stops: 0,
    stopText: '直飞',
    factor: 1.196,
  },
  {
    id: 'MU2105',
    airline: '东航 MU',
    departTime: '21:05',
    duration: '7h（中转）',
    stops: 1,
    stopText: '1 停',
    factor: 1.0,
  },
];

const pad2 = (n) => String(n).padStart(2, '0');
/** 2026-11-12 → 11-12（界面展示用短格式） */
const fmtMD = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** 价格取整到十位，避免出现 ¥2183.2 这种不像机票价的数字 */
const roundPrice = (n) => Math.round(n / 10) * 10;
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 线性插值分位数（sorted 需为升序数组） */
function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 生成某个出发日的「近 62 天价格曲线」（MOCK）→【API】③
 * 真实来源：SerpApi google_flights → price_insights.price_history（约 61~62 天，每天 1 个点）
 *
 * 形态用 day 取模决定，只为让 MOCK 演示出三种不同状态：
 *   0 = 早期高、近期下探（当前价＝历史低位）→ 建议买
 *   1 = 平稳波动（当前价≈中位）           → 价格正常
 *   2 = 早期低、一路走高（当前价＝历史高位）→ 建议等
 * 末点强制等于当前价，保证曲线上「今天」与实时价一致。
 */
function buildHistory(anchorPrice, day) {
  const shape = day % 3;
  const pts = [];
  for (let i = 0; i < 62; i++) {
    const t = i / 61; // 0 = 62 天前，1 = 今天
    const noise = Math.sin(i * 1.7 + day) * 70 + Math.sin(i * 0.55 + day * 0.3) * 50;
    let base = anchorPrice;
    if (shape === 0) base = anchorPrice * (1 + 0.18 * (1 - t) ** 2);
    else if (shape === 2) base = anchorPrice * (1 - 0.16 * (1 - t));
    pts.push(roundPrice(base + noise));
  }
  pts[pts.length - 1] = anchorPrice;
  return pts;
}

/**
 * 组装一份完整的结果页数据（全部是 MOCK）。
 * ⚠️ 往返暂按单程算：returnDate 收下了但不参与计算 —— 往返价与单程价是两套口径，
 *    要等联调时用真实 API（SerpApi 往返需 departure_token 二次调用）才能落实。
 * @param {{from:string,to:string,departDate:string|null,returnDate?:string|null,cabin:string,passengers:number,flexibility:string}} params
 */
export function buildMockResult(params) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  /** 快照时间：任何基于「此刻」的判断都必须带上它（快照会过期）→ 展示用 */
  const snapshotAt = `${toISO(today)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  /* ---------------- ① 价格日历 →【API】 ------------------------------ */
  const base = params.departDate
    ? new Date(`${params.departDate}T00:00:00`)
    : new Date(today.getTime() + 30 * 86400000);

  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const monthLabel = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}`;

  let calendar = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const date = new Date(base.getFullYear(), base.getMonth(), day);
    return {
      day,
      date: `${monthLabel}-${pad2(day)}`,
      shortDate: fmtMD(date),
      price: DAILY_PRICE_SEQ[i % DAILY_PRICE_SEQ.length],
      isSelected: params.departDate === `${monthLabel}-${pad2(day)}`,
    };
  });

  // 整月最优 / ±N 天：由 Agent 扫全月，挑最便宜的一天作为推荐出发日
  const cheapest = calendar.reduce((a, b) => (b.price < a.price ? b : a), calendar[0]);
  if (!params.departDate) {
    calendar = calendar.map((c) => ({ ...c, isSelected: c.day === cheapest.day }));
  }

  const selected = calendar.find((c) => c.isSelected) ?? cheapest;
  const prices = calendar.map((c) => c.price);
  const monthMin = Math.min(...prices);
  const monthMax = Math.max(...prices);
  const sortedAsc = [...calendar].sort((a, b) => a.price - b.price);
  const rank = sortedAsc.findIndex((c) => c.day === selected.day) + 1;

  /* ---------------- ② 航班列表 →【API】 ------------------------------ */
  const flights = FLIGHT_TEMPLATES.map((t) => ({
    ...t,
    price: roundPrice(selected.price * t.factor),
  })).sort((a, b) => a.price - b.price);
  // 标记当天最便宜的一班 → 用于「选班」提示（lowest_price 的正确用途）
  const lowestPrice = flights[0].price;
  const flightsMarked = flights.map((f) => ({ ...f, isLowest: f.price === lowestPrice }));

  const directMin = Math.min(...flights.filter((f) => f.stops === 0).map((f) => f.price));
  const transferCheapest = flights.filter((f) => f.stops > 0).sort((a, b) => a.price - b.price)[0];

  /* ---------------- ③ 62 天历史曲线 →【API】SerpApi price_history ------- */
  const currentPrice = selected.price;
  const historySeq = buildHistory(currentPrice, selected.day);
  const sortedHistory = [...historySeq].sort((a, b) => a - b);
  const typicalLow = roundPrice(percentile(sortedHistory, 0.25)); // 典型区间下沿
  const typicalHigh = roundPrice(percentile(sortedHistory, 0.75)); // 典型区间上沿
  const historyStats = {
    min: sortedHistory[0],
    max: sortedHistory[sortedHistory.length - 1],
    avg: roundPrice(sortedHistory.reduce((a, b) => a + b, 0) / sortedHistory.length),
    typicalLow,
    typicalHigh,
    points: historySeq.length,
  };
  // 当前价在历史里的位置：低于它的历史点越多 → 百分位越低 → 越便宜
  const cheaperCount = historySeq.filter((p) => p < currentPrice).length;
  const positionPct = Math.round((cheaperCount / historySeq.length) * 100);
  const level =
    currentPrice <= typicalLow ? 'low' : currentPrice >= typicalHigh ? 'high' : 'typical';

  // 曲线要带日期，供图表画 x 轴
  const priceHistory = historySeq.map((price, i) => {
    const d = new Date(today.getTime());
    d.setDate(d.getDate() - (historySeq.length - 1 - i));
    return { date: fmtMD(d), price };
  });

  /* ---------------- ④ 答案②：购买时机（纵向）→【AI】 ------------------ */
  const departISO = params.departDate || cheapest.date;
  const departDay = new Date(`${departISO}T00:00:00`);
  const daysToDepart = Math.max(0, Math.round((departDay - today) / 86400000));

  const deadlineDate = new Date(departDay.getTime());
  deadlineDate.setDate(deadlineDate.getDate() - 21); // 起飞前 21 天
  const deadlineISO = toISO(deadlineDate);
  const deadlinePassed = deadlineDate < today;

  const vsTypical =
    currentPrice < typicalLow ? 'below' : currentPrice > typicalHigh ? 'above' : 'within';
  const vsTypicalText =
    vsTypical === 'below'
      ? '低于典型区间下沿'
      : vsTypical === 'above'
        ? '高于典型区间上沿'
        : '落在典型区间内';

  const VERDICT = {
    low: { verdict: 'buy', label: '建议现在买' },
    typical: { verdict: 'typical', label: '价格正常，可以买' },
    high: { verdict: 'wait', label: '建议再等等' },
  }[level];

  // 阈值默认值：取「典型区间下沿」与「当前价 × 0.95」中更低者（宁可多等一点，也不漏掉回调）
  const suggestedThreshold = Math.min(typicalLow, roundPrice(currentPrice * 0.95));

  const timingAnswer = {
    verdict: VERDICT.verdict, // buy | typical | wait
    verdictLabel: VERDICT.label,
    currentPrice,
    level, // low | typical | high
    levelLabel: { low: '偏低', typical: '正常', high: '偏高' }[level],
    positionPct,
    typicalLow,
    typicalHigh,
    vsTypical,
    vsTypicalText,
    historyMin: historyStats.min,
    historyMax: historyStats.max,
    // 推理链：每条都必须能在下面「62 天走势图 / 航班列表」里找到出处
    reasoning: [
      `当前最低价 ¥${currentPrice.toLocaleString()}（实时查询，共 ${flights.length} 班可选）`,
      `近 62 天同一出发日的价格区间 ¥${historyStats.min.toLocaleString()}~¥${historyStats.max.toLocaleString()}，当前价处于第 ${positionPct} 百分位（越低越便宜）`,
      `典型价区间 ¥${typicalLow.toLocaleString()}~¥${typicalHigh.toLocaleString()}，当前价${vsTypicalText}`,
      // ⚠️ 下面这句是行业规律文案占位，真实情况应由 AI 结合节假日/展会/淡旺季判断
      level === 'high'
        ? `距出发还有 ${daysToDepart} 天，历史上这个阶段仍出现过回调，值得设个阈值等一次`
        : `距出发还有 ${daysToDepart} 天，当前价已在${
            level === 'low' ? '近期低位' : '正常水位'
          }，继续等的空间有限`,
    ],
    // 「再等等」的三件套：触发条件 + 决策期限 + 数据依据（缺一条就不许出「再等等」）
    action: {
      condition:
        level === 'low'
          ? `跌到 ¥${roundPrice(currentPrice * 0.95).toLocaleString()} 或更低，我立刻邮件通知你`
          : `跌到 ¥${suggestedThreshold.toLocaleString()} 或更低，我立刻邮件通知你`,
      deadline: deadlineISO,
      deadlineText: deadlinePassed
        ? '已进入决策期，建议尽快决定'
        : `最晚 ${deadlineISO}（起飞前 21 天）前做决定`,
      basisText: `基于近 62 天历史 · ${historySeq.length} 个价格点`,
    },
  };

  /* ---------------- ⑤ 答案①：出发日建议（横向）→【AI + API】 ---------- */
  // 扫描范围随「日期灵活度」变化：±3 / ±7 只扫所选日附近，整月最优扫全月
  const scanPool = (() => {
    if (params.flexibility === 'fixed') return [];
    if (params.flexibility === 'month' || !params.departDate) return calendar;
    const span = params.flexibility === 'plus3' ? 3 : 7;
    return calendar.filter((c) => Math.abs(c.day - selected.day) <= span);
  })();

  const scanCheapest = scanPool.length
    ? scanPool.reduce((a, b) => (b.price < a.price ? b : a), scanPool[0])
    : null;

  let dateAnswer = null;
  if (scanCheapest) {
    // 再查一次该最优日的历史档位（真实实现＝第 3 次调用，见文件头「调用次数」）
    const bestHistory = buildHistory(scanCheapest.price, scanCheapest.day);
    const bestSorted = [...bestHistory].sort((a, b) => a - b);
    const bestPct = Math.round(
      (bestHistory.filter((p) => p < scanCheapest.price).length / bestHistory.length) * 100,
    );
    const bestLow = roundPrice(percentile(bestSorted, 0.25));
    const bestHigh = roundPrice(percentile(bestSorted, 0.75));
    const bestLevel =
      scanCheapest.price <= bestLow ? 'low' : scanCheapest.price >= bestHigh ? 'high' : 'typical';
    const bestLevelText = { low: '属于偏便宜区间', typical: '属正常区间', high: '仍偏高' }[
      bestLevel
    ];

    dateAnswer = {
      scopeText: `${scanPool[0].date} ~ ${scanPool[scanPool.length - 1].date}`,
      scannedDays: scanPool.length,
      bestDate: scanCheapest.shortDate,
      bestDateISO: scanCheapest.date,
      bestPrice: scanCheapest.price,
      savedText: !params.departDate
        ? '已为你锁定全月最低价'
        : selected.day === scanCheapest.day
          ? '你选的就是最优日，暂无更省的选择'
          : `比所选 ${selected.shortDate} 省 ¥${(selected.price - scanCheapest.price).toLocaleString()}`,
      historyLevel: bestLevel,
      historyPct: bestPct,
      historyText: `该日价格处于近 62 天第 ${bestPct} 百分位，${bestLevelText}`,
      // ⚠️ 注意：答案① 的价格来自日历源、答案② 的价格来自 Google，两者可能差 5~15%，判断时须知道来源不同
      // 该字段仅作内部溯源（数据来源差异的证据），**不展示给用户**（供应商名属于后端实现细节）
      priceSource: '日历源（Sky Scrapper）',
    };
  }

  /* ---------------- ⑥ 延展建议（hints）------------------------------- */
  const hints = [];
  if (transferCheapest) {
    hints.push({
      type: 'transfer',
      text: `中转可省：${transferCheapest.airline} ${transferCheapest.stopText} ¥${transferCheapest.price.toLocaleString()}，比直飞最低省 ¥${(directMin - transferCheapest.price).toLocaleString()}、多约 2h45m`,
    });
  }
  if (params.flexibility === 'fixed' && cheapest.day !== selected.day) {
    hints.push({
      type: 'flexible',
      text: `灵活出发：若日期可挪，${cheapest.shortDate} 更便宜 ¥${(selected.price - cheapest.price).toLocaleString()} —— 在查询页选「±3 天 / 整月最优」我直接帮你锁定。`,
    });
  }
  if (level === 'high') {
    hints.push({
      type: 'seat',
      text: '价格偏高，常见原因是低价舱位已售完（只剩高价舱）。若行程已定，建议尽早在下方设好阈值，把「等」交给监控。',
    });
  }

  return {
    params,
    snapshotAt, // 快照时间（展示用；也提醒用户这份判断会过期）
    monthLabel,
    calendar,
    monthMin,
    monthMax,
    selected,
    rank,
    flights: flightsMarked,
    lowestPrice,
    directMin,
    transferCheapest,
    // 答案②：购买时机（永远有）
    timingAnswer,
    // 答案①：出发日建议（仅日期不固定时出现）
    dateAnswer,
    // 62 天历史 →【API】③
    // 说明：timingAnswer 的档位 / 百分位就是由这两个字段算出来的，属于结论的计算依据；
    //       当前 UI 不再直接展示走势图，字段保留供未来「查看依据」等场景使用。
    priceHistory,
    historyStats,
    // 订阅卡片阈值默认值
    suggestedThreshold,
    // 延展建议
    hints,
  };
}
