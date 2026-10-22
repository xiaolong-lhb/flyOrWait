/**
 * 单条订阅的操作：取消（DELETE）与修改（PATCH）
 *
 * ── 为什么单独一个零件 ──
 * 这两件事原本挂在 `api/subscriptions/[id].js` 上（URL 形如 /api/subscriptions/:id）。
 * 2026-10-22 线上实测：那个文件在部署里，但 Vercel **没给它生成动态路由**——
 * 请求 `/api/subscriptions/<uuid>` 被 `vercel.json` 的 SPA 兜底 `/(.*) → /index.html`
 * 吃掉了（GET 被重定向到首页，DELETE 得到 405 "Method Not Allowed"，响应头还带着
 * `Content-Disposition: inline; filename="index.html"`，是静态文件层的，不是我们的 JSON）。
 * 依据 Vercel 官方路由顺序：**File System Routes 先于 Rewrites** ⇒ 请求既然落到 rewrite，
 * 就说明文件系统里压根没有这条路由，不是方法没写。
 * 社区里同类案例的结论是「路径不合规时，方括号会被当成**字面量**路径」，
 * 也就是真实 uuid 永远匹配不上 /api/subscriptions/[id]。
 *
 * 所以改走「同一个函数 + query 传 id」：
 *   DELETE /api/subscriptions?id=<uuid>
 *   PATCH  /api/subscriptions?id=<uuid>
 * 两条都落在 `api/subscriptions/index.js` 里（那个路由线上已验证可用）。
 * 这也不是权宜之计——Vercel 文档明确建议「不要把每个接口拆成单独的函数，
 * 把相关路由放进同一个函数里」。
 *
 * ⚠️ 本文件以 `_` 开头 = 不是路由，只被 import。
 *
 * 响应体遵循全局约定 { code, message, data }（完整规则见 src/api/index.js 顶部）：
 *   200 + code 0      成功，data = 改动后的那一行（形状与列表接口完全一致）
 *   400 + code 4000   参数错：id 不是合法 uuid / 没有可改字段 / 字段值非法
 *   404 + code 4040   该订阅不存在（或不属于你）
 *   500 + code 5000   服务端异常（连不上库、少环境变量…）
 */
import { getSupabase } from './_supabase.js';
import { toClient } from './_translate.js';

/**
 * id 必须是 uuid —— 数据库主键就是 uuid。
 * 不先拦的话，一个胡乱拼的 id 会让 PostgREST 抛 PG 错误 22P02（invalid input syntax for uuid），
 * 被我们兜成 500 —— 明明是「调用方传错了」，却报成「服务器坏了」，不准确。
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH 允许改的字段（白名单）。其余键一律丢弃，不进数据库 */
export const PATCHABLE = ['threshold', 'email', 'deadline', 'status'];

/**
 * 取消订阅
 *
 * ⭐ 这里必须 .select()：让数据库把「真的被删掉的行」回给我们。
 *   因为「删了 0 行」和「删成功了」在 PostgREST 里都不是错误 ——
 *   不加 select 就没法区分，会把「这条根本不存在」也报成 200，
 *   前端于是以为删掉了，其实什么都没发生。
 */
export async function removeSubscription(ownerId, id, res) {
  const { data, error } = await getSupabase()
    .from('subscriptions')
    .delete()
    .eq('id', id)
    .eq('owner_id', ownerId)
    .select();

  if (error) {
    res.status(500).json({ code: 5000, message: `取消订阅失败：${error.message}`, data: null });
    return;
  }

  if (!data.length) {
    res.status(404).json({ code: 4040, message: '该订阅不存在', data: null });
    return;
  }

  res.status(200).json({ code: 0, message: 'ok', data: { id } });
}

/** 取出要改的字段（白名单过滤），并校验取值 */
function pickPatch(payload) {
  const patch = {};
  for (const k of PATCHABLE) {
    if (payload[k] !== undefined) patch[k] = payload[k];
  }
  return patch;
}

/** 校验要写入的值：返回错误文案，通过则返回空串 */
function patchError(patch) {
  if (patch.threshold !== undefined) {
    const t = Number(patch.threshold);
    if (!Number.isInteger(t) || t <= 0) return '提醒阈值必须是不小于 1 的整数';
  }
  if (patch.email !== undefined) {
    if (typeof patch.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
      return '通知邮箱格式不正确';
    }
  }
  if (patch.deadline !== undefined) {
    // 数据库列是 date，格式不对会抛 PG 错误 22007 → 兜成 500；先在门口拦掉
    if (typeof patch.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(patch.deadline)) {
      return '决策截止日格式应为 YYYY-MM-DD';
    }
  }
  if (patch.status !== undefined) {
    // 只放行用户在界面上真能切的两个值。
    // 'expired' **不在**白名单里：它由系统按出发日判定并写回（读列表时标记，Cron 兜底），
    // 不能由调用方写进来（否则「已过期」可以被伪造）。
    if (!['active', 'paused'].includes(patch.status)) return 'status 只能是 active 或 paused';
  }
  return '';
}

/** 改配置 / 暂停恢复 */
export async function updateSubscription(ownerId, id, req, res) {
  const patch = pickPatch(req.body ?? {});

  if (!Object.keys(patch).length) {
    res.status(400).json({
      code: 4000,
      message: `没有可修改的字段（可改：${PATCHABLE.join(' / ')}）`,
      data: null,
    });
    return;
  }

  const invalid = patchError(patch);
  if (invalid) {
    res.status(400).json({ code: 4000, message: invalid, data: null });
    return;
  }

  // ★ 先读当前状态。过期的订阅是既成事实（航班已经飞了），不允许再改任何字段 ——
  //   尤其不许把 status「复活」成 active，否则「已过期」这个状态就是可以伪造的，
  //   Cron 靠它筛「该比价的」也就失去意义。
  //   为什么不靠前端隐藏按钮：后端是唯一防线，前端藏起来不等于别人调不到。
  //   顺带把 404 也在这里判掉 —— 读不到就是不存在（或不属于你）。
  const { data: cur, error: curErr } = await getSupabase()
    .from('subscriptions')
    .select('status')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (curErr) {
    res.status(500).json({ code: 5000, message: `读取订阅失败：${curErr.message}`, data: null });
    return;
  }

  if (!cur) {
    res.status(404).json({ code: 4040, message: '该订阅不存在', data: null });
    return;
  }

  if (cur.status === 'expired') {
    res.status(400).json({
      code: 4000,
      message: '该订阅已过期（出发日已过），不能再修改',
      data: null,
    });
    return;
  }

  // updated_at 得自己写：Supabase 不会自动维护它（没有触发器），
  // 不写的话这一列会一直停在创建时间，失去意义。
  const row = { ...patch, updated_at: new Date().toISOString() };

  const { data, error } = await getSupabase()
    .from('subscriptions')
    .update(row)
    .eq('id', id)
    .eq('owner_id', ownerId)
    .select();

  if (error) {
    res.status(500).json({ code: 5000, message: `修改订阅失败：${error.message}`, data: null });
    return;
  }

  // 正常走不到这里（上面已经读过一次确认它存在）。留着是防竞态：
  // 查完之后、update 之前被别人删掉，那时匹配 0 行，仍然该报 404 而不是假装成功。
  if (!data.length) {
    res.status(404).json({ code: 4040, message: '该订阅不存在', data: null });
    return;
  }

  // 返回改完的那一行（形状与列表接口一致）→ 前端拿到可直接原地替换
  res.status(200).json({ code: 0, message: 'ok', data: toClient(data[0]) });
}
