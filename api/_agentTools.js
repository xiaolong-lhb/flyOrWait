/**
 * Agent 工具层：把「已经算好的能力」暴露成 LLM 能调的窄接口
 *
 * 文件名以 _ 开头是刻意的：本地运行器与 Vercel 都跳过 _ 开头的文件，它不会变成路由。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么不是「把 api/*.js 包一层」
 * ══════════════════════════════════════════════════════════════════════
 *  现成的接口是**页面视角的聚合**，直接当工具会给 agent 挖三个坑：
 *   ① /api/result 一次 20~60 秒 —— 塞进 tool calling 循环，模型等一轮就崩；
 *   ② 返回体里有 notices、judgement、完整航班列表 —— 塞进上下文纯烧 token；
 *   ③ 粒度太粗 —— 问「11 月哪天最便宜」不需要航班列表，打一次就是双份钱。
 *  ⇒ 页面继续用聚合接口，agent 用这里的原子工具，**内部复用同一批零件**，
 *    判据口径一份不新增（全部经由 _judge.js，这里连一个分位数都不自己算）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  三条纪律
 * ══════════════════════════════════════════════════════════════════════
 *  ① 工具按「用户会问的问题」切，不按「现有函数」1:1 映射。
 *     反例：直接暴露 getPriceCalendar，让模型拿 30 个价格自己回答「哪天便宜」——
 *     那是让模型做比较和排序，正好踩红线「LLM 只决定查什么，代码决定算出什么」。
 *     所以有 find_cheapest_days：排序取最小由代码做完，模型只负责挑和解释。
 *
 *  ② 参数校验不信模型。每个参数进执行体之前都过一遍格式校验（见 assert*）。
 *     但注意校验的**层级区别**：
 *       工具层校验 = 体验层（早点告诉模型「这个参数不对，去问用户」）
 *       POST /api/subscriptions 校验 = 唯一防线（真正挡写库）
 *     两层不可互替，但也不重复：这里**不判断**「出发日是否早于今天」「是否重复订阅」
 *     这类业务规则 —— 那是 POST 的事，在这里写第二份就又多一个口径。
 *
 *  ③ 返回一律裁薄，且**如实**。数据不足就返回 available:false + reason，
 *     绝不替数据源圆场（跟 _judge.js 的「不编造」是同一条红线）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  已知约束（写在这里，别等出事才发现）
 * ══════════════════════════════════════════════════════════════════════
 *  · 日历抓取超时是**按场景传的**（_apify.getPriceCalendar 的 timeoutMs）：
 *    页面那条路 55s 刚好，agent 这条留给日历的只有 35s（AGENT_LIMITS.calendarTimeoutMs），
 *    因为一次 run 还要跑三四轮模型。⇒ 一次 agent run 里最好只抓一次日历，
 *    下面 ctx.getCalendar 做了 run 内缓存就是为了这件事。
 *  · 一次 run 的工具调用次数与轮数上限在 AGENT_LIMITS，由编排层强制执行（本文件不强制）。
 */

import { getPriceCalendar } from './_apify.js';
import { searchFlights } from './_serp.js';
import { judgePrices, annotateDays } from './_judge.js';
import { todayShanghai } from './_expire.js';

/* ── 参数格式（与 api/result.js 的 CODE_RE / DATE_RE 同源）────────────────
 * ⚠️ 已知重复：这两个正则在 api/result.js 里各有一份。
 *    故意没有立刻抽公共模块 —— 它们是由外部数据源规格定死的（三字码 / ISO 日期），
 *    不会各自演化。若将来要改，**两处必须一起改**，或抽成 api/_codes.js 再统一 import。 */
const CODE_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** 航班列表最多回几条（按价格升序取前 N，剩下的只报数量不报内容） */
const MAX_FLIGHTS = 8;
/** 「最便宜的几天」最多回几条 */
const MAX_CHEAP_DAYS = 5;

/**
 * 编排层要强制执行的预算。放在这里是因为它属于「工具层的规格」，
 * 不该散落在每个调用方里各写一遍。
 */
export const AGENT_LIMITS = {
  maxRounds: 6, // 最多几轮「模型想 → 我们执行 → 回给模型」
  maxToolCalls: 8, // 一次 run 内最多执行几次工具
  /**
   * 日历那一枪的时间预算，直接传给 _apify.getPriceCalendar 的 timeoutMs。
   *
   * 55s（页面视角）在这里不能照抄：一次 run 还要跑三四轮模型，每轮几秒。
   * 35 + 20(单轮模型上限) + 组装 ≈ 55s，压在 Vercel 的 60s 之内。
   * 代价是比页面那条路更容易撞超时 —— 但撞了也只是这个工具回 ok:false，
   * 模型会如实说「查不到」，而不是整轮被平台掐断、前端看到网络异常。
   */
  calendarTimeoutMs: 35_000,
};

/* ══════════════════════════════════════════════════════════════════════
 *  统一的返回信封
 * ══════════════════════════════════════════════════════════════════════
 *  执行体**不抛异常给模型看**。参数错、数据缺、外部源挂 —— 全部翻成
 *  { ok:false, error:{ code, message } } 回给模型，让它自己决定：改参数重试 / 换工具 / 直接说做不到。
 *  抛异常等于整轮崩掉，而模型其实有能力自己纠错。
 *  真正该崩的（代码 bug、环境变量缺失）才让它往上冒。 */

function ok(data) {
  return { ok: true, data };
}

function bad(code, message) {
  return { ok: false, error: { code, message } };
}

/* ── 参数校验 ───────────────────────────────────────────────────────── */

function readCode(args, key) {
  const v = String(args?.[key] ?? '')
    .trim()
    .toUpperCase();
  if (!CODE_RE.test(v)) {
    return { error: `${key} 需为三位机场代码（如 SZX），收到「${args?.[key] ?? ''}」` };
  }
  return { value: v };
}

function readDate(args, key) {
  const v = String(args?.[key] ?? '').trim();
  if (!DATE_RE.test(v)) {
    return { error: `${key} 格式应为 YYYY-MM-DD，收到「${args?.[key] ?? ''}」` };
  }
  return { value: v };
}

function readMonth(args, key) {
  const v = String(args?.[key] ?? '').trim();
  if (!MONTH_RE.test(v)) {
    return { error: `${key} 格式应为 YYYY-MM，收到「${args?.[key] ?? ''}」` };
  }
  return { value: v };
}

/** 把一组 read* 的返回一次性收成「要么全有值，要么一条错误信息」 */
function collect(reads) {
  for (const r of reads) if (r.error) return { error: r.error };
  return { values: reads.map((r) => r.value) };
}

/* ══════════════════════════════════════════════════════════════════════
 *  Run 上下文：一个 run 一份，负责缓存与计数
 * ══════════════════════════════════════════════════════════════════════
 *  ★ 为什么缓存必须在 run 内做（不能靠模块级变量）：
 *    ① 日历一枪 20~60 秒、按行计费。模型很可能先 find_cheapest_days 再 judge_one_day，
 *       两次都命中同一个窗口 —— 不缓存就是双倍钱 + 双倍时间；
 *    ② 模块级缓存会被 serverless 复用实例带到下一个用户的 run 里（串轮次）。
 *       跟 user_settings 那个开关的缓存是同一个坑（见 check-prices.js 的注释）。 */

export function createToolContext() {
  /** key = `${origin}-${destination}` → 整段窗口的每日价格（未裁切） */
  const calendars = new Map();
  const stats = { toolCalls: 0, calendarFetches: 0, cacheHits: 0 };

  async function getCalendar(origin, destination) {
    const key = `${origin}-${destination}`;
    if (calendars.has(key)) {
      stats.cacheHits += 1;
      return calendars.get(key);
    }
    const days = await getPriceCalendar({
      origin,
      destination,
      timeoutMs: AGENT_LIMITS.calendarTimeoutMs,
    });
    stats.calendarFetches += 1;
    calendars.set(key, days);
    return days;
  }

  /**
   * 只看缓存，**绝不发起抓取**。
   *
   * ★ 为什么需要它：create_subscription_draft 想拿 basePrice 时会去日历里找当天价。
   *   如果那里调用 getCalendar，缓存没命中就会现场抓 20~60 秒 ——
   *   用户只是想「盯这条」，却为此等一分钟，还可能把整个 run 顶到 60s 平台上限。
   *   ⇒ 草稿只吃缓存；没缓存就让模型去调 judge_one_day（那是它本来就该走的路）。
   */
  function peekCalendar(origin, destination) {
    const key = `${origin}-${destination}`;
    const hit = calendars.get(key);
    if (hit) stats.cacheHits += 1;
    return hit ?? null;
  }

  return { getCalendar, peekCalendar, stats };
}

/* ══════════════════════════════════════════════════════════════════════
 *  执行体
 * ══════════════════════════════════════════════════════════════════════
 *  ok 的真假不是「结果好/坏」，而是分这两件事：
 *    ok:false → 这次调用**没能给出事实**：参数不合规、超出可查范围、外部源挂了。
 *               模型该做的是改参数重试 / 换工具 / 如实说做不到。
 *    ok:true  → 调用成功，data 就是事实 —— **包括「数据不足」这个事实**。
 *               典型是 judge_one_day 返回 available:false，它带着
 *               insufficient_data / date_out_of_window / date_no_data 三种 reason，
 *               这是判据层的业务结论，工具层不许把它改写成错误、也不许圆成一句话。
 *  这条分界要是搞混，模型会把「这天没有价格」当成「工具坏了」反复重试，白烧钱。 */

/**
 * 查一个月里每天的参考价 + 档位。
 * 档位来自 annotateDays(整段窗口)，不是只拿这个月排分位 ——
 * 否则同一天在 11 月和 12 月会得到两种颜色（_judge.js 里写过的纪律）。
 */
async function searchPriceCalendar(args, ctx) {
  const r = collect([readCode(args, 'from'), readCode(args, 'to'), readMonth(args, 'month')]);
  if (r.error) return bad('bad_args', r.error);
  const [from, to, month] = r.values;
  if (from === to) return bad('bad_args', '出发地与目的地不能相同');

  const all = await ctx.getCalendar(from, to);
  if (!all.length) {
    return bad('no_data', `${from}→${to} 没有拿到任何日历数据`);
  }

  const annotated = annotateDays(all); // 整段窗口算档位
  const days = annotated
    .filter((d) => d.day.startsWith(month))
    .map((d) => ({ day: d.day, price: d.price, level: d.level }));

  return ok({
    month,
    days,
    // 如实告诉模型样本范围：样本不足时 level 全是 null，它得说「数据不够」而不是硬编一个结论
    window: { start: annotated[0]?.day, end: annotated[annotated.length - 1]?.day },
    sampleDays: annotated.length,
    note: days.length ? undefined : `窗口内没有 ${month} 的数据，可查范围见 window`,
  });
}

/**
 * 区间内最便宜的 N 天。
 * 排序取最小在这里做完（代码的事），模型拿到的已经是结论。
 */
async function findCheapestDays(args, ctx) {
  const r = collect([
    readCode(args, 'from'),
    readCode(args, 'to'),
    readDate(args, 'dateFrom'),
    readDate(args, 'dateTo'),
  ]);
  if (r.error) return bad('bad_args', r.error);
  const [from, to, dateFrom, dateTo] = r.values;
  if (from === to) return bad('bad_args', '出发地与目的地不能相同');
  if (dateFrom > dateTo) return bad('bad_args', 'dateFrom 不能晚于 dateTo');

  const limit = Math.min(Math.max(Number(args.limit) || MAX_CHEAP_DAYS, 1), MAX_CHEAP_DAYS);

  const all = await ctx.getCalendar(from, to);
  const annotated = annotateDays(all); // 整段窗口算档位
  const inRange = annotated.filter((d) => d.day >= dateFrom && d.day <= dateTo);

  if (!inRange.length) {
    return bad(
      'out_of_window',
      `可查范围是 ${annotated[0]?.day ?? '?'} ~ ${annotated[annotated.length - 1]?.day ?? '?'}，` +
        `与 ${dateFrom} ~ ${dateTo} 没有交集`,
    );
  }

  // 稳定排序：价格相同时按日期先后，避免同一天在不同次调用里排到不同位置
  const sorted = [...inRange].sort((a, b) => a.price - b.price || a.day.localeCompare(b.day));

  return ok({
    range: { from: dateFrom, to: dateTo },
    scannedDays: inRange.length,
    cheapest: sorted.slice(0, limit),
    // 供模型解释「这个月的行情大概什么样」，都是整段窗口的分位，不是切片
    sameLevelDays: {
      low: inRange.filter((d) => d.level === 'low').length,
      typical: inRange.filter((d) => d.level === 'typical').length,
      high: inRange.filter((d) => d.level === 'high').length,
    },
  });
}

/**
 * 单日判档。**唯一**能回答「这天贵不贵」的工具。
 * 直接转给 judgePrices，一个数字都不加工 —— 它是项目里唯一被真实数据验证过的计算。
 */
async function judgeOneDay(args, ctx) {
  const r = collect([readCode(args, 'from'), readCode(args, 'to'), readDate(args, 'date')]);
  if (r.error) return bad('bad_args', r.error);
  const [from, to, date] = r.values;
  if (from === to) return bad('bad_args', '出发地与目的地不能相同');

  const all = await ctx.getCalendar(from, to);
  const verdict = judgePrices(all, date);

  // available:false 时把 reason 原样带出去（insufficient_data / date_out_of_window / date_no_data），
  // 这三种对用户是三句不同的话，不能让模型编成一句「暂时没有数据」
  return ok(verdict);
}

/** 单日航班列表（裁薄）。只有用户明确问「哪班」时才该调它。 */
// 第二个参数是 ctx，但这里用不到日历缓存 —— 执行体签名统一为 (args, ctx)，故留着占位
async function searchFlightsTool(args) {
  const r = collect([readCode(args, 'from'), readCode(args, 'to'), readDate(args, 'date')]);
  if (r.error) return bad('bad_args', r.error);
  const [from, to, date] = r.values;
  if (from === to) return bad('bad_args', '出发地与目的地不能相同');

  const { flights, meta } = await searchFlights({ origin: from, destination: to, date });
  if (!flights.length) {
    return bad('no_data', '这一天没有查到航班报价');
  }

  return ok({
    date,
    flights: flights.slice(0, MAX_FLIGHTS).map((f) => ({
      id: f.id,
      airline: f.airline,
      departTime: f.departTime,
      arriveTime: f.arriveTime,
      // 给数字不给「2 小时 15 分」：模型对数字的比较比解析字符串可靠
      durationMin: f.durationMin,
      stops: f.stops,
      price: f.price,
    })),
    totalPriced: meta.priced,
    // 回放模式下 meta.date 与请求的 date 可能不一致（录像那天），如实带上，别让模型以为查的就是这天
    dataDate: meta.date || undefined,
  });
}

/**
 * 组装订阅草稿。**不写库**（红线：agent 第一版无写权限）。
 *
 * 输出的字段名与 POST /api/subscriptions 的入参**完全一致**（from / to / departDate…），
 * 这样前端拿到就能直接填表，不用再翻译一层 —— 少一层映射就少一处漂移。
 */
async function createSubscriptionDraft(args, ctx) {
  const r = collect([readCode(args, 'from'), readCode(args, 'to'), readDate(args, 'departDate')]);
  if (r.error) return bad('bad_args', r.error);
  const [from, to, departDate] = r.values;
  if (from === to) return bad('bad_args', '出发地与目的地不能相同');

  const problems = [];

  const threshold = Number(args.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    problems.push('threshold 需要一个大于 0 的数字（用户愿意接受的价格上限）');
  }

  const email = String(args.email ?? '').trim();
  if (!email) {
    problems.push('email 缺失，需要问用户要收信邮箱');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push(`email 格式不对：「${email}」`);
  }

  // basePrice 是订阅时的基准价。优先用模型给的（它多半刚从 judge_one_day 拿到），
  // 退一步从 run 缓存里找当天价 —— 注意这里用 peekCalendar（只看缓存，不抓取），
  // 草稿工具不该为了补一个字段去花 20~60 秒。
  let basePrice = Number(args.basePrice);
  let basePriceSource = 'model';
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    const cached = ctx.peekCalendar(from, to) || [];
    const hit = cached.find((d) => d.day === departDate);
    basePrice = hit?.price ?? NaN;
    basePriceSource = hit ? 'calendar_cache' : 'missing';
  }
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    problems.push('basePrice 缺失，先调 judge_one_day 拿到这天参考价');
  }

  // deadline = 提醒截止日。没给就默认「盯到出发日为止」，并如实标注来源，
  // 不假装这是模型推荐出来的日期（页面上的「推荐」标记靠 deadline === recommendedDeadline）。
  const deadlineRaw = String(args.deadline ?? '').trim();
  let deadline = deadlineRaw;
  let deadlineSource = 'model';
  if (!deadlineRaw) {
    deadline = departDate;
    deadlineSource = 'defaulted_to_departure';
  } else if (!DATE_RE.test(deadlineRaw)) {
    problems.push(`deadline 格式应为 YYYY-MM-DD，收到「${deadlineRaw}」`);
  }

  return ok({
    draft: {
      from,
      to,
      departDate,
      basePrice: Number.isFinite(basePrice) ? basePrice : undefined,
      threshold: Number.isFinite(threshold) ? threshold : undefined,
      deadline: DATE_RE.test(deadline) ? deadline : undefined,
      email: email || undefined,
      flight: args.flightId ? String(args.flightId) : undefined,
      cabin: 'economy', // 全项目唯一支持的舱位，写死，别让模型挑
      passengers: 1,
    },
    deadlineSource,
    // basePrice 是模型给的还是从缓存推的 —— 用户看到的价格必须有出处，不能糊成「基准价」
    basePriceSource,
    problems,
    // ready=false 时模型应该去问用户，而不是硬凑一个草稿让表单报错
    ready: problems.length === 0,
    note: '这是草稿，没有写库。用户确认后由前端 POST /api/subscriptions 落库。',
  });
}

/**
 * 比较同航线两天谁便宜
 */
async function compareTwoDates(args, ctx) {
  const r = collect([
    readCode(args, 'from'),
    readCode(args, 'to'),
    readDate(args, 'dateA'),
    readDate(args, 'dateB'),
  ]);
  if (r.error) return bad('bad_args', r.error);
  const [from, to, dateA, dateB] = r.values;
  if (from === to) return bad('bad_args', '出发地与目的地不能相同');
  if (dateA === dateB) return bad('bad_args', 'dateA 与 dateB 不能相同');

  const all = await ctx.getCalendar(from, to);
  const verdictA = judgePrices(all, dateA);
  const verdictB = judgePrices(all, dateB);

  // 只有两边都拿到价，"谁更便宜"才成立。
  // 任一边 available:false（超窗口 / 这天没报价 / 样本不足）⇒ cheaper 必须是 null，
  // 让模型去看对应 verdict 的 reason，而不是被它读成"两天一样便宜"。
  const bothPriced = verdictA.available && verdictB.available;
  const cheaper = !bothPriced
    ? null
    : verdictA.price < verdictB.price
      ? dateA
      : verdictB.price < verdictA.price
        ? dateB
        : 'same';

  // 差价与百分比由代码算，不给模型自己减的机会。
  // 口径（两个都刻意做成非负，模型就不可能把方向说反）：
  //   diff        = 较贵 − 较便宜，单位元
  //   diffPercent = diff ÷ 较贵那天 × 100，含义固定为「便宜了百分之几」，
  //                 基数取较贵那天 ⇒ 永远落在 0~100，不会出现负号或 >100%
  // 任一天没价时两者都是 null —— 与 cheaper 保持同一开关，不留半个结论。
  let diff = null;
  let diffPercent = null;
  if (bothPriced) {
    diff = Math.abs(verdictA.price - verdictB.price);
    const higher = Math.max(verdictA.price, verdictB.price);
    diffPercent = higher > 0 ? Math.round((diff / higher) * 1000) / 10 : 0;
  }

  // available:false 时把 reason 原样带出去（insufficient_data / date_out_of_window / date_no_data），
  // 这三种对用户是三句不同的话，不能让模型编成一句「暂时没有数据」
  return ok({
    cheaper,
    diff,
    diffPercent,
    verdictA,
    verdictB,
  });
}

/* ══════════════════════════════════════════════════════════════════════
 *  Schema（OpenAI / DeepSeek / Qwen 通用的 function calling 格式）
 * ══════════════════════════════════════════════════════════════════════
 *  description 不是注释，是**提示词**。它决定模型选不选对这个工具、
 *  以及会不会在该调 A 的时候错调 B。写的时候按「什么情况下该用我」来写。 */

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_price_calendar',
      description:
        '查某条航线某个月里**每一天**的参考价，以及每天相对整段可查窗口的档位（low/typical/high）。' +
        '适合回答「这个月整体什么行情」。如果用户问的是「哪天最便宜」，改用 find_cheapest_days —— ' +
        '本工具返回的是一整个月，你不需要也不应该自己从里面挑最便宜的那天。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '出发机场三字码，如 SZX' },
          to: { type: 'string', description: '到达机场三字码，如 PEK' },
          month: { type: 'string', description: '要看的月份，格式 YYYY-MM，如 2026-11' },
        },
        required: ['from', 'to', 'month'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_cheapest_days',
      description:
        '在指定日期区间内，按价格从低到高给出最便宜的几天（含每天的档位）。' +
        '用户问「这几天哪天走最便宜」「下个月哪几天划算」时用这个。排序由服务端完成，' +
        '拿到结果直接采用即可，不要自己再比较价格。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '出发机场三字码，如 SZX' },
          to: { type: 'string', description: '到达机场三字码，如 PEK' },
          dateFrom: { type: 'string', description: '区间开始日 YYYY-MM-DD' },
          dateTo: { type: 'string', description: '区间结束日 YYYY-MM-DD' },
          limit: {
            type: 'integer',
            description: `回几条，默认 ${MAX_CHEAP_DAYS}，最多 ${MAX_CHEAP_DAYS}`,
          },
        },
        required: ['from', 'to', 'dateFrom', 'dateTo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'judge_one_day',
      description:
        '判断某一天出发的参考价是便宜、正常还是贵 —— 这是**唯一**能给出「贵不贵」结论的工具。' +
        '返回 P25/P75、百分位、更便宜的天数等依据。不要用 search_price_calendar 的原始价格自己下结论。' +
        '用户问「这天贵吗」「值不值得等」时用这个。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '出发机场三字码，如 SZX' },
          to: { type: 'string', description: '到达机场三字码，如 PEK' },
          date: { type: 'string', description: '出发日 YYYY-MM-DD' },
        },
        required: ['from', 'to', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_flights',
      description:
        '查某一天有哪些具体航班、各多少钱。只在用户问「哪班」「几点起飞」「直飞还是中转」时调用。' +
        '只想知道贵不贵请不要用它 —— 那个用 judge_one_day。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '出发机场三字码，如 SZX' },
          to: { type: 'string', description: '到达机场三字码，如 PEK' },
          date: { type: 'string', description: '出发日 YYYY-MM-DD' },
        },
        required: ['from', 'to', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_subscription_draft',
      description:
        '把「盯这条航线、低于某个价格就通知我」组装成一张**订阅草稿**。不会写库 —— ' +
        '返回的是待用户确认的表单内容。缺必填项时 ready=false 且 problems 会说明缺什么，' +
        '这时你应该去问用户，而不是自己编一个值填上。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '出发机场三字码，如 SZX' },
          to: { type: 'string', description: '到达机场三字码，如 PEK' },
          departDate: { type: 'string', description: '出发日 YYYY-MM-DD' },
          threshold: { type: 'number', description: '价格上限（元），低于它才通知' },
          email: { type: 'string', description: '收信邮箱' },
          deadline: {
            type: 'string',
            description: '提醒截止日 YYYY-MM-DD，不填默认盯到出发日',
          },
          basePrice: {
            type: 'number',
            description: '订阅时的基准价，通常就是 judge_one_day 返回的 price',
          },
          flightId: {
            type: 'string',
            description:
              '可选。只盯某一个航班时传 search_flights 返回的 id，不传则盯整条航线最低价',
          },
        },
        required: ['from', 'to', 'departDate', 'threshold', 'email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_two_dates',
      description:
        '比较同一条航线上两个具体日期谁更便宜。问「A 和 B 哪天便宜」时用我，' +
        '不要分别调两次 judge_one_day。' +
        'cheaper 是更便宜那天的日期；两天同价返回 "same"；任一天查不到价返回 null。' +
        'diff / diffPercent 是差价（元）与「便宜了百分之几」，已由工具算好且恒为非负，' +
        '直接引用，不要自己再减一遍。' +
        'cheaper 为 null 时去看 verdictA / verdictB 的 available 与 reason：' +
        '缺数据就问用户或如实说明可查窗口，不要编日期、不要编价格。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '出发机场三字码，如 SZX' },
          to: { type: 'string', description: '到达机场三字码，如 PEK' },
          dateA: { type: 'string', description: '第一个日期 YYYY-MM-DD' },
          dateB: { type: 'string', description: '第二个日期 YYYY-MM-DD' },
        },
        required: ['from', 'to', 'dateA', 'dateB'],
      },
    },
  },
];

/** name → 执行体。TOOLS 里有的，这里必须有；漏了 runTool 会明确报错，不会静默返回空 */
const EXECUTORS = {
  search_price_calendar: searchPriceCalendar,
  find_cheapest_days: findCheapestDays,
  judge_one_day: judgeOneDay,
  search_flights: searchFlightsTool,
  create_subscription_draft: createSubscriptionDraft,
  compare_two_dates: compareTwoDates,
};

/**
 * 执行一次工具调用。
 *
 * @param {string} name 模型给的工具名
 * @param {object} args 模型给的参数（**不可信**，逐个校验）
 * @param {object} ctx  createToolContext() 的产物，一次 run 一个
 * @returns {Promise<{ok:boolean, data?:any, error?:{code:string,message:string}}>}
 */
export async function runTool(name, args, ctx) {
  const executor = EXECUTORS[name];
  if (!executor) {
    // 模型编了一个不存在的工具名 —— 回给它可用列表，让它自己改
    return bad(
      'unknown_tool',
      `没有这个工具：${name}。可用：${Object.keys(EXECUTORS).join(' / ')}`,
    );
  }
  if (!ctx) throw new Error('runTool 需要 ctx（createToolContext() 的产物）');

  ctx.stats.toolCalls += 1;

  try {
    return await executor(args ?? {}, ctx);
  } catch (err) {
    // 外部源挂了（Apify 超时 / SerpApi 报错）：如实回给模型，让它决定换路还是告诉用户，
    // 不要在这里吞掉，也不要假装成功
    return bad('tool_failed', err?.message || '工具执行失败');
  }
}

/** 仅供调试/自检：确认 schema 与执行体一一对应 */
export function assertToolsConsistent() {
  const declared = TOOLS.map((t) => t.function.name).sort();
  const implemented = Object.keys(EXECUTORS).sort();
  const same =
    declared.length === implemented.length && declared.every((n, i) => n === implemented[i]);
  return { ok: same, declared, implemented };
}

/** 今天的东八区日期，给编排层拼 prompt 用（别在别处再写一份） */
export function todayForAgent() {
  return todayShanghai();
}
