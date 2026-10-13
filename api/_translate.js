/**
 * 字段翻译（内部共享工具，不是接口）
 *
 * 数据库列名（origin / depart_date / base_price …）与前端 store 字段名
 * （from / departDate / basePrice …）是刻意不一致的：
 *   · from 是 SQL 保留字，列名不能用，只能叫 origin；
 *   · 列名是「存储视角」，store 字段是「页面视角」，各自取最顺的名字。
 *
 * 翻译只做在这一层 —— 页面和 store 拿到的一直是它们原本就在用的形状，
 * 完全不用因为数据库改了列名而跟着改。
 *
 * ★ 列表接口（subscriptions/index.js）与单条接口（subscriptions/[id].js）共用这一份：
 *   翻译散成两处最容易「改了一边忘了另一边」，最后两边形状对不上。
 *
 * 文件名以 _ 开头是刻意的：本地运行器与 Vercel 都会跳过它，不会变成一个路由。
 */

/** 数据库一行 → 前端 store 的形状（只改字段名，值原样透传） */
export function toClient(row) {
  return {
    id: row.id,
    from: row.origin,
    to: row.destination,
    departDate: row.depart_date,
    returnDate: row.return_date,
    flight: row.flight,
    basePrice: row.base_price,
    currentPrice: row.current_price,
    threshold: row.threshold,
    deadline: row.deadline,
    email: row.email,
    status: row.status,
    cabin: row.cabin,
    passengers: row.passengers,
    createdAt: row.created_at,
    lastNotified: row.last_notified_at,
  };
}

/** 前端提交的形状 → 数据库一行（反方向翻译：from→origin、departDate→depart_date…） */
export function toRow(payload, ownerId) {
  return {
    owner_id: ownerId,
    origin: payload.from,
    destination: payload.to,
    depart_date: payload.departDate,
    return_date: payload.returnDate ?? null, // 单程没有返程日
    flight: payload.flight ?? null, // 盯价航班；不指定就按整条航线的最低价
    base_price: payload.basePrice,
    // 刚订阅时「当前最低」就等于订阅价；之后由 Cron 每天比价回写
    current_price: payload.basePrice,
    threshold: payload.threshold,
    deadline: payload.deadline,
    email: payload.email,
    cabin: payload.cabin ?? null,
    passengers: payload.passengers ?? 1,
    // status / created_at / updated_at / last_notified_at 一律不传，交给数据库默认值：
    //   status 默认 'active'、created_at/updated_at 默认 now()、last_notified_at 默认 null
  };
}
