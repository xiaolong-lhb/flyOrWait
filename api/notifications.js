/**
 * 通知记录   /api/notifications
 *
 *   GET  列出「我」的通知流水 —— 按时间倒序，最新的排前面
 *
 * ── 为什么现在就要这个接口 ──
 * 「我的订阅」页那张「通知记录」表早就有完整的界面（时间 / 航线 / 触发价 / 状态），
 * 但前端 `logs` 一直是个写死的空数组 ⇒ 表格永远走「暂无通知记录」。
 * 这一版先把**读**打通：接口按真实形状返回，页面上看到的就是库里那几行。
 * 至于谁来写这张表 —— 将来 Cron 比价跌破阈值时写，本轮先塞两条测试数据。
 *
 * ── 航线从哪来：快照优先，join 兜底 ──
 * 通知记录要显示「哪条航线跌了」，但航线本身不属于这条记录，它属于订阅。
 * 早先的做法是只存 subscription_id、查询时 join 订阅表拿航线，看起来省事，有两个硬伤：
 *   ① 外键是 on delete cascade → 取消订阅会把历史提醒一起删掉。可那封邮件是真的发过了，
 *      删订阅只表示「别再盯了」，不等于这件事没发生；而且这是**不可恢复**的丢失 ——
 *      将来做「历史提醒一共帮我省了多少」或排查发信失败，全靠这张表。
 *   ② 航线是 join 出来的、不是记下来的 → 一旦将来允许改订阅的航线，历史记录会跟着变，
 *      变成「收到的是 A 航线的邮件，记录里却写着 B 航线」。
 * 现在的做法：写入时把 origin / destination 快照落库（将来是 Cron 负责填），
 * 读取时**优先用快照**；只有老数据没快照、且订阅还活着时，才用 join 兜一下 ——
 * 纯兼容，新写入的行不依赖订阅表。外键已改为 on delete set null：
 * 取消订阅只把 subscription_id 置空，记录本身留下。
 *
 * ⚠️ 因此**别再把外键改回 cascade**。那会让取消订阅静默抹掉历史。
 *
 * ── 响应形状 ──
 * data: [{ id, from, to, price, status, notifiedAt }]
 *   · from / to        业务字段名（数据库里叫 origin / destination，翻译在这一层做）
 *   · status           保持枚举 'sent' / 'failed'，**不翻成中文** —— 与订阅的
 *                      status('active'/'paused') 同一套做法，人话由页面决定
 *   · notifiedAt       原样给 ISO 串（UTC），**不在服务端格式化成「几点几分」**：
 *                      本机是东八区、Vercel 是 UTC，服务端格式化一定有一边是错的；
 *                      交给浏览器按访客的本地时区显示才准（见 mySubscribtion.vue）
 */
import { getSupabase } from './_supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const ownerId = req.headers['x-owner-id'];
    if (!ownerId) {
      res.status(400).json({ code: 4000, message: '缺少身份标识（X-Owner-Id）', data: null });
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
      return;
    }

    const { data, error } = await getSupabase()
      .from('notify_log')
      // 嵌套写法：`subscriptions (...)` 是「顺着外键把订阅那一行也带出来」。
      // 它现在只作**兜底**（老数据没有快照列时用），新数据靠自己的 origin/destination 快照。
      .select(
        'id, origin, destination, price, kind, send_status, notified_at, subscriptions ( origin, destination )',
      )
      .eq('owner_id', ownerId)
      .order('notified_at', { ascending: false })
      .limit(50); // 通知记录只用来「回看最近发生了什么」，不做全量翻页

    if (error) {
      res
        .status(500)
        .json({ code: 5000, message: `读取通知记录失败：${error.message}`, data: null });
      return;
    }

    res.status(200).json({ code: 0, message: 'ok', data: data.map(toClient) });
  } catch (e) {
    res.status(500).json({ code: 5000, message: e.message, data: null });
  }
}

/** 数据库一行（含 join 出来的订阅）→ 前端要的形状 */
function toClient(row) {
  // 订阅被删过、或外键没配上时，join 结果可能是 null
  const flight = row.subscriptions ?? {};
  return {
    id: row.id,
    // 快照优先。行里自带航线 → 与订阅是否还在无关；
    // 没有快照的老数据才退回 join 结果，两边都没有就给空串，别让页面渲染出 undefined
    from: row.origin ?? flight.origin ?? '',
    to: row.destination ?? flight.destination ?? '',
    price: row.price,
    // 两类通知：hit = 到了目标价；deadline = 到了决策截止日。
    // 页面上要分开说 —— 两者都是「已提醒」，但含义完全不同。
    kind: row.kind,
    status: row.send_status,
    notifiedAt: row.notified_at,
  };
}
