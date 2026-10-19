/**
 * 用户配置   /api/settings
 *
 *   GET  读取配置 + 本月查询次数
 *   PUT  保存配置（邮箱 / 邮件开关）
 *
 * ── 它解决什么问题 ──
 * 这两项配置原来存在浏览器 localStorage：
 *   ① 换浏览器 / 清缓存就没了；
 *   ② 更要命的是**将来 Cron 在服务端跑，读的是数据库**，读不到 localStorage ——
 *      于是「订阅时带的邮箱」只在设置它的那台机器上有效，等于半个摆设。
 * 落库之后，配置才真正跟着用户走。
 *
 * ── 为什么返回「查询次数」而不是「API 额度」 ──
 * 额度是开发者自己账号的（Apify $5/月），拿它去吓用户没道理；
 * 用户真正关心的是「我查了多少次」。所以这里只数次数，不暴露额度。
 * 次数从 query_log 表按 queried_at 过滤当前月算出（见 api/_queryLog.js），
 * 不需要任何跨月归零的定时任务。
 *
 * ── 身份 ──
 * 请求头 X-Owner-Id，由前端拦截器自动带上（见 src/api/index.js）。
 * 项目暂无登录，值固定 'owner'，对应数据库的 owner_id 列。
 *
 * ── 为什么用 upsert 而不是「先查再插 / 再更新」──
 * owner_id 是主键、一人一行。upsert 一条语句就能表达
 * 「有就改、没有就建」，不用两次往返、也不会有并发下的竞态。
 *
 * 响应体遵循全局约定 { code, message, data }，完整规则见 src/api/index.js 顶部。
 */
import { getSupabase } from './_supabase.js';
import { monthRange, countQueries } from './_queryLog.js';

/** GET 时若还没有配置记录，返回这套默认值（而不是 404 —— 没配置过是正常状态） */
const DEFAULTS = { email: '', notifyEnabled: true };

export default async function handler(req, res) {
  // 动态接口，显式声明任何一层都别缓存
  res.setHeader('Cache-Control', 'no-store');

  try {
    const ownerId = req.headers['x-owner-id'];
    if (!ownerId) {
      res.status(400).json({ code: 4000, message: '缺少身份标识（X-Owner-Id）', data: null });
      return;
    }

    if (req.method === 'GET') {
      await readSettings(ownerId, res);
      return;
    }

    if (req.method === 'PUT') {
      await saveSettings(ownerId, req, res);
      return;
    }

    res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
  } catch (e) {
    // 走到这说明是我们自己的问题（环境变量缺失、网络异常、代码抛错…）
    res.status(500).json({ code: 5000, message: e.message, data: null });
  }
}

async function readSettings(ownerId, res) {
  const { data, error } = await getSupabase()
    .from('user_settings')
    .select('email, notify_enabled, updated_at')
    .eq('owner_id', ownerId)
    .maybeSingle(); // 没有记录时返回 null（不是错误）—— .single() 会在 0 行时报错，这里必须用 maybeSingle

  if (error) {
    res.status(500).json({ code: 5000, message: `读取配置失败：${error.message}`, data: null });
    return;
  }

  // 没有记录 = 还没设置过，用默认值顶上（页面照样能渲染）
  const saved = data
    ? { email: data.email ?? '', notifyEnabled: data.notify_enabled }
    : { ...DEFAULTS };

  const { from, to, label } = monthRange();
  const queryCount = await countQueries(ownerId, from, to);

  res.status(200).json({
    code: 0,
    message: 'ok',
    // ⚠️ label 是**本地月份**（'2026-10'），不能从 from 那串 UTC 里切（切出来会是上个月）
    data: { ...saved, queryCount, month: label },
  });
}

async function saveSettings(ownerId, req, res) {
  const payload = req.body ?? {};

  // ── 白名单 + **部分更新**：只认「显式传了」的字段 ──
  //   ⚠️ 这里踩过一个坑：原来写成「不传就当作空」，于是 PUT {"notifyEnabled":true}
  //      会把邮箱**静默清空**（实测中招）。前端恰好每次都补全两个字段所以没暴露，
  //      但接口本身不该有这种「漏传一个就删数据」的语义 —— 将来 Cron / curl 一定会踩。
  //   ⇒ 未传 = 不改（交给数据库里已有的值）；显式传 email:"" = 清空。
  const patch = {};
  const hasEmail = Object.prototype.hasOwnProperty.call(payload, 'email');
  const hasNotify = Object.prototype.hasOwnProperty.call(payload, 'notifyEnabled');

  if (hasEmail) {
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ code: 4000, message: '邮箱格式不正确', data: null });
      return;
    }
    patch.email = email || null; // 空串存成 null，语义更干净（「没设置」）
  }

  if (hasNotify) {
    patch.notify_enabled = payload.notifyEnabled !== false; // 只把「显式的 false」当作关闭
  }

  if (!Object.keys(patch).length) {
    res
      .status(400)
      .json({ code: 4000, message: '没有可保存的字段（email / notifyEnabled）', data: null });
    return;
  }

  // ★ upsert 一条语句表达「有就改、没有就建」——但**没传的列不能出现在 values 里**，
  //   否则会被覆盖成 null。Supabase 对 upsert 的合并语义正是「按传入的列覆盖」。
  const { data, error } = await getSupabase()
    .from('user_settings')
    .upsert(
      { owner_id: ownerId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'owner_id' }, // 主键冲突时改这一行，而不是报错
    )
    .select('email, notify_enabled')
    .single();

  if (error) {
    res.status(500).json({ code: 5000, message: `保存配置失败：${error.message}`, data: null });
    return;
  }

  // 回传落库后的形状，前端直接拿来覆盖本地 —— 与订阅那套「写指令 → 以后端为准」一致
  res.status(200).json({
    code: 0,
    message: 'ok',
    data: { email: data.email ?? '', notifyEnabled: data.notify_enabled },
  });
}
