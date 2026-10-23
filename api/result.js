/**
 * 结果页聚合   GET /api/result
 *
 *   ?from=SZX&to=PEK&departDate=2026-11-20&cabin=economy&passengers=1&flexibility=fixed
 *   （整月最优时省略 departDate，由后端取窗口里最便宜那天）
 *
 * ── 为什么要「一个接口出全部」，而不是前端并发打两个 ──
 *   ① 体验：一次请求 = 一个 loading。分成两个的话，日历先回来、航班后回来，
 *      页面会出现「一半有数据一半转圈」的撕裂感；而 Apify 那一枪要 20~60 秒，很难看。
 *   ② 口径：答案①（哪天最便宜）和答案②（该不该买）必须基于**同一份窗口数据**。
 *      交给前端拼，等于把「分位往哪个数组上算」这种要命的口径交给两个异步回调的先后顺序。
 *   ③ 成本：日历那一枪是按行计费的，多打一次就是双份钱。
 *
 * ── 时间预算（这是本接口最脆弱的地方，必须说清）──
 *   Apify 现场爬 Google 航班日历 **实测 20~60 秒**；SerpApi 3~8 秒。
 *   三层超时由内到外逐层放大：Apify 客户端 55s → 本函数 60s（vercel.json maxDuration）→ 浏览器 65s。
 *   ⇒ 「固定日期」时两个源**并行**，总耗时 ≈ Apify。
 *   ⚠️ 「整月最优」（没给 departDate）拿不到航班该查哪天，只能**先等日历回来**再查航班
 *      ⇒ 串行，总耗时 ≈ Apify + SerpApi，靠近甚至可能超过 60 秒。这是已知的临界点，
 *      真机跑下来若频繁超时，第一优先的调整是缩短日历窗口（api/_apify.js 的 DEFAULT_CALENDAR_DAYS）。
 *
 * ── 降级策略 ──
 *   日历挂了  → 硬失败（它是地基，没有它整个页面没意义）
 *   航班挂了  → 降级：日历 + 判据照常出，只是列表空着，并在 notices 里如实说明
 *               （不然用户等了一分钟只换来一句「查询失败」，而钱其实已经花了）
 *
 * 响应体遵循全局约定 { code, message, data }，完整规则见 src/api/index.js 顶部。
 * 组装逻辑（纯计算）在 api/_compose.js，这里只负责校参、并发、回包。
 */
import { getPriceCalendar } from './_apify.js';
import { searchFlights } from './_serp.js';
import { buildCalendarSection, composeResult } from './_compose.js';
import { logQuery } from './_queryLog.js';

const CODE_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * 当前**唯一支持**的舱位（2026-10-23 决定砍掉商务 / 头等）。
 *
 * 为什么砍：Apify 日历的 `cabinClass` 在 api/_apify.js 里是硬编码 economy，
 * 而判据（P25/P75 分位）也是按经济舱那一串价格算的。actor 本身**支持**舱位
 * （枚举是 economy / premium_economy / business / first，注意是下划线），
 * 但「商务舱日历能不能凑够 14 天样本」没实测过 —— 判据的地基就是样本数。
 * 与其提供一个可能算错的选项，不如只做经济舱。
 * 将来要做：改这里 + api/_apify.js + 前端表单，三处一起动。
 */
const SUPPORTED_CABINS = ['economy'];
const FLEX = ['fixed', 'plus3', 'plus7', 'month'];

/** 服务器本地「今天」：一个给日期比较用，一个给页面展示快照时间用 */
function localNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { iso, stamp: `${iso} ${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** 外部源失败 → 502；我们自己的配置缺失 → 500（分开，别让运维看不出是谁的锅） */
function fail(res, e, what) {
  const configError = String(e?.message || '').includes('缺少环境变量');
  console.error(`[result] ${what}失败：`, e);
  res.status(configError ? 500 : 502).json({
    code: configError ? 5000 : 5020,
    message: `${what}失败：${e?.message || '未知错误'}`,
    data: null,
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
    return;
  }

  const from = String(req.query.from || '').toUpperCase();
  const to = String(req.query.to || '').toUpperCase();
  const departDate = req.query.departDate ? String(req.query.departDate) : '';
  const returnDate = req.query.returnDate ? String(req.query.returnDate) : '';
  const cabin = req.query.cabin ? String(req.query.cabin) : 'economy';
  const passengers = Number(req.query.passengers) || 1;
  const flexibility = req.query.flexibility ? String(req.query.flexibility) : 'fixed';

  // ── 入参校验：后端这份是唯一防线（挡 curl / Cron，不挡用户）──
  if (!CODE_RE.test(from) || !CODE_RE.test(to)) {
    res
      .status(400)
      .json({ code: 4000, message: 'from / to 需为三位机场代码（如 SZX）', data: null });
    return;
  }
  if (from === to) {
    res.status(400).json({ code: 4000, message: '出发地与目的地不能相同', data: null });
    return;
  }
  if (!FLEX.includes(flexibility)) {
    res
      .status(400)
      .json({ code: 4000, message: `flexibility 只能是 ${FLEX.join(' / ')}`, data: null });
    return;
  }
  if (departDate && !DATE_RE.test(departDate)) {
    res.status(400).json({ code: 4000, message: 'departDate 格式应为 YYYY-MM-DD', data: null });
    return;
  }
  if (!departDate && flexibility !== 'month') {
    // 只有「整月最优」允许不给日期 —— 其余模式不给日期，后端根本不知道要判哪一天
    res.status(400).json({
      code: 4000,
      message: '请提供 departDate（或把 flexibility 设为 month）',
      data: null,
    });
    return;
  }
  if (returnDate) {
    if (!DATE_RE.test(returnDate)) {
      res.status(400).json({ code: 4000, message: 'returnDate 格式应为 YYYY-MM-DD', data: null });
      return;
    }
    if (departDate && returnDate < departDate) {
      res.status(400).json({ code: 4000, message: '返回日期不能早于出发日期', data: null });
      return;
    }
  }
  // ★ 明确拒绝，不「忽略掉按经济舱算」。
  //   静默降级是最坏的：调用方（现在是页面，将来是 Agent）会以为拿到的是商务舱数据，
  //   实际日历和判据全是经济舱口径，而两边都没有线索能发现这件事。
  if (!SUPPORTED_CABINS.includes(cabin)) {
    res.status(400).json({
      code: 4000,
      message: `当前仅支持经济舱（cabin=economy）—— 日历与判据都按经济舱口径计算，不做静默降级`,
      data: null,
    });
    return;
  }
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 9) {
    res.status(400).json({ code: 4000, message: 'passengers 需为 1~9 的整数', data: null });
    return;
  }

  const now = localNow();
  if (departDate && departDate < now.iso) {
    res.status(400).json({ code: 4000, message: '出发日期不能早于今天', data: null });
    return;
  }

  // ── 并发起两路（固定日期时；「整月最优」的航班只能等日历回来再查）──
  const flightArgs = {
    origin: from,
    destination: to,
    returnDate: returnDate || null,
    cabin,
    passengers,
  };

  const [calR, flyR] = await Promise.allSettled([
    getPriceCalendar({ origin: from, destination: to }),
    departDate ? searchFlights({ ...flightArgs, date: departDate }) : Promise.resolve(null),
  ]);

  if (calR.status === 'rejected') {
    fail(res, calR.reason, '价格日历');
    return;
  }
  const all = calR.value;

  if (!all.length) {
    res.status(404).json({
      code: 4040,
      message: `暂无 ${from} → ${to} 的价格数据，换个机场试试`,
      data: null,
    });
    return;
  }

  // 目标出发日：用户指定就用它；没指定（整月最优）就取整段窗口里最便宜那天
  const targetDate = departDate || all.reduce((a, b) => (b.price < a.price ? b : a), all[0]).day;

  // ⚠️ 目标日期必须落在窗口内。窗口是「今天起 N 天」（api/_apify.js 的 DEFAULT_CALENDAR_DAYS），
  //    用户挑一个半年后的日期是**真的查不到** —— 这时要当场说清楚，
  //    绝不能拿窗口里别的月份的数据顶上（那就是编造）。all 已按日期升序。
  const windowStart = all[0].day;
  const windowEnd = all[all.length - 1].day;
  if (targetDate < windowStart || targetDate > windowEnd) {
    res.status(404).json({
      code: 4040,
      message: `所选日期 ${targetDate} 不在当前可查范围内（可查 ${windowStart} ~ ${windowEnd}），请改选日期`,
      data: null,
    });
    return;
  }

  let flightsResult = flyR.status === 'fulfilled' ? flyR.value : null;
  if (flyR.status === 'rejected') {
    console.error('[result] 航班列表失败（降级为只出日历）：', flyR.reason);
  }

  // 「整月最优」：日历回来了才知道该查哪天 → 这里补一次串行调用
  if (!departDate) {
    try {
      flightsResult = await searchFlights({ ...flightArgs, date: targetDate });
    } catch (e) {
      console.error('[result] 航班列表失败（降级为只出日历）：', e);
      flightsResult = null;
    }
  }

  // ── 组装 ──
  // ★ 判据与日历上色都喂**整段窗口** all；切片只发生在 buildCalendarSection 内部（展示用）
  try {
    const section = buildCalendarSection({
      days: all,
      month: targetDate.slice(0, 7), // 页面直接展示「所选日期所在的那个月」，不用用户自己翻
      date: targetDate,
    });

    const data = composeResult({
      section,
      flightsResult,
      params: { from, to, departDate, returnDate, cabin, passengers, flexibility },
      targetDate,
      snapshotAt: now.stamp,
      todayISO: now.iso,
    });

    res.status(200).json({ code: 0, message: 'ok', data });

    // ── 记一次查询（给设置页的「本月查询次数」用）──
    // ★ 刻意**不 await**、且吞掉错误：这只是附带记一笔账，
    //   记账失败绝不能让用户的查询失败 —— 用户要的是票价，不是我们的统计。
    //   放在响应之后，也就不会给用户增加任何等待时间。
    logQuery(req.headers['x-owner-id']).catch((e) =>
      console.error('[result] 记录查询次数失败（不影响结果）：', e),
    );
  } catch (e) {
    // 走到这里说明是**我们自己的组装逻辑**出了问题（不是外部源），回 500 才对
    fail(res, e, '结果组装');
  }
}
