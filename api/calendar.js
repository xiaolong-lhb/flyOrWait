/**
 * 价格日历   GET /api/calendar?from=SZX&to=LJG&month=2026-11[&date=2026-11-12]
 *
 * 回答页面上的「① 哪天出发最便宜」—— 给出**某一个月**每天的最低票价，
 * 让前端把日历格子染成「便宜绿 / 适中橙 / 偏贵红」。
 *
 * 可选参数 `date`（目标出发日）会让响应**多挂一个 `judgement` 字段**，
 * 回答「② 现在这个价该不该买」—— 由 api/_judge.js 判出 low / typical / high。
 * 为什么不新开一个 /api/judge？因为判据要吃的那份数据**这个请求已经拿到了**，
 * 另开接口就得再打一次数据源（多烧一次钱）。同一份窗口数据、两个视角，放一个响应里天然合理。
 *
 * ── 数据源：Apify（2026-10-15 换源，细节见 api/_apify.js）──
 * 原来用 Sky Scrapper，免费档**实测只有 20 次/月**，扛不住「订阅 + 定时比价」
 * （5 条订阅每天刷一次 = 150 次/月）。换 Apify `lergassy/flight-price-calendar`：
 * **$0.0002/行、免费档 $5/月** ⇒ 一条航线抓 90 天日历只花 $0.018，量级完全不同。
 * Sky 降级为备选（api/_sky.js 保留，含 SKY_REPLAY 回放）。
 *
 * ── 它不做「按天遍历」 ──
 * Apify 那个 actor **一次就把整段窗口（今天起 N 天）全部返回**了，所以我们只发 **1 次**请求，
 * 然后在内存里 filter 出目标月 —— 不存在「循环 30 天打 30 次」。
 * （真正需要按天循环的是备用方案 SerpApi —— 它没有原生日历接口。）
 *
 * ⚠️ 判据与日历上色**都必须喂整段窗口 `all`**，不能喂切片后的月份。
 *    分位是相对「喂进去的样本」算的：样本范围一变，同一天的结论就会变。
 *    若拿切片去判，11-12 在「看 11 月」时是 low、「看 12 月」时可能变成 typical —— 口径漂移。
 *
 * ── 日历的颜色谁来算 ──
 *   以前是 Sky 在响应里给 `group`（low/medium/high），我们照抄；**Apify 不返回这个字段**
 *   ⇒ 改用**自家的分位**（api/_judge.js::annotateDays，与判据同一个函数、同一套 P25/P75）。
 *   好处：颜色和结论永不自相矛盾，也不再依赖源方施舍。
 *
 * ── 为什么不用先查 skyId ──
 * 前端机场表只放「具体机场」，而实测「机场级 skyId == IATA 码」，
 * 所以 from / to 直接当码传下去，省掉一次查询（也省一次钱）。
 *
 * ── 成本提醒（重要）──
 * Apify **按行计费**（$0.0002/行），本接口每被调用一次就按返回天数烧一次
 * （默认 90 天 ≈ $0.018；官方说明「空结果不计费」，所以没数据的航线不花钱）。
 * ⚠️ 前端绝不要「翻月份就发一次」—— 翻月份只是切内存里的数据，不该再发请求。
 * 📼 开发联调（不想花钱 / 不想等 20~60 秒）：在 .env.local 里加 `APIFY_REPLAY=1`，
 *   走 samples/ 的真实响应回放，**零成本、零等待**跑通整条链路（细节见 api/_apify.js 顶部）。
 *
 * 响应体遵循全局约定 { code, message, data }，完整规则见 src/api/index.js 顶部。
 */
import { getPriceCalendar } from './_apify.js';
import { buildCalendarSection } from './_compose.js';

export default async function handler(req, res) {
  // 动态接口，显式声明任何一层都别缓存
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
    return;
  }

  const from = String(req.query.from || '').toUpperCase();
  const to = String(req.query.to || '').toUpperCase();
  const month = req.query.month ? String(req.query.month) : '';
  /** 可选：目标出发日。给了它，响应里才会多一个 judgement（该不该买） */
  const date = req.query.date ? String(req.query.date) : '';

  // ── 入参校验（后端这份是唯一防线：前端能拦体验，但挡不住直接打接口的）──
  const CODE_RE = /^[A-Z]{3}$/;
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
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ code: 4000, message: 'month 格式应为 YYYY-MM', data: null });
    return;
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ code: 4000, message: 'date 格式应为 YYYY-MM-DD', data: null });
    return;
  }

  try {
    // 1 次请求 → 拿到整段窗口的每日最低价（可能上百天）
    const all = await getPriceCalendar({ origin: from, destination: to });

    if (!all.length) {
      res.status(404).json({
        code: 4040,
        message: `暂无 ${from} → ${to} 的价格数据，换个机场试试`,
        data: null,
      });
      return;
    }

    // 日历切片 + 判据的组装**与 /api/result 共用同一份**（api/_compose.js）——
    // 这段逻辑以前在本文件里写了一遍，结果页要一模一样地再写一遍，两处口径迟早漂移。
    // 注意：判据仍然吃的是 all（整段窗口），切片只发生在 section 内部。
    const section = buildCalendarSection({ days: all, month, date });

    if (!section.dayCount) {
      // 常见于：请求的月份落在数据窗口之外（窗口不是整整一年，各航线不同）
      const { start, end } = section.window;
      res.status(404).json({
        code: 4040,
        message: `${section.monthLabel} 暂无价格数据，当前可查范围 ${start} ~ ${end}`,
        data: null,
      });
      return;
    }

    res.status(200).json({
      code: 0,
      message: 'ok',
      data: {
        from,
        to,
        currency: 'CNY',
        monthLabel: section.monthLabel,
        // ⚠️ 字段名叫 days 是本接口的历史契约（前端按它对接），组装层里叫 calendar，别改回去
        days: section.calendar,
        monthMin: section.monthMin,
        monthMax: section.monthMax,
        // 该月「有价的天数」可能少于当月天数（数据源有缺日）→ 前端据此提示，别把空格子当 0 元
        dayCount: section.dayCount,
        window: section.window,
        // 没传 date 就是 null。传了但判不了（超窗口 / 样本不足）时**仍是 HTTP 200** ——
        // 请求本身成功了，只是「这天判不了」，前端看 judgement.available 决定怎么显示（不编造）。
        judgement: section.judgement,
      },
    });
  } catch (e) {
    // 环境变量没配 = 我们自己的问题（500）；外部源不给数据 = 502。
    const configError = e.message.includes('缺少环境变量');
    res.status(configError ? 500 : 502).json({
      code: configError ? 5000 : 5020,
      message: `价格日历查询失败：${e.message}`,
      data: null,
    });
  }
}
