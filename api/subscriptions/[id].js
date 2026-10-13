/**
 * 单条订阅   /api/subscriptions/:id
 *
 *   DELETE  取消订阅（删掉这条；它的通知流水由外键 on delete cascade 一起清）
 *   PATCH   改配置：提醒阈值 / 通知邮箱 / 决策截止日（「我的订阅」编辑态点保存走这里）
 *           以及 暂停 / 恢复（status 在 active ↔ paused 之间切）
 *
 * ── 身份 ──
 * 请求头 X-Owner-Id（前端拦截器自动带，见 src/api/index.js），对应数据库 owner_id。
 * ★ 每次读写都带 owner_id 一起过滤 —— 光凭 id 就能改/删的话，
 *    「猜到别人的 id」等于能改别人的订阅。
 *
 * ── 为什么 PATCH 不用 _translate.js 的 toRow ──
 * 这里能改的四个字段（threshold / email / deadline / status）在数据库里恰好同名，
 * 不需要翻译；而且它们天然构成一份「白名单」—— 只放行这几个键，
 * 免得有人顺手把 owner_id、created_at 也塞进来改了。
 *
 * 响应体遵循全局约定 { code, message, data }（完整规则见 src/api/index.js 顶部）：
 *   200 + code 0      成功，data = 改动后的那一行（形状与列表接口完全一致）
 *   400 + code 4000   参数错：id 不是合法 uuid / 没有可改字段 / 字段值非法
 *   404 + code 4040   该订阅不存在（或不属于你）
 *   405 + code 4050   方法不支持
 *   500 + code 5000   服务端异常（连不上库、少环境变量…）
 */
import { getSupabase } from '../_supabase.js';
import { toClient } from '../_translate.js';

/**
 * id 必须是 uuid —— 数据库主键就是 uuid。
 * 不先拦的话，一个胡乱拼的 id 会让 PostgREST 抛 PG 错误 22P02（invalid input syntax for uuid），
 * 被我们兜成 500 —— 明明是「调用方传错了」，却报成「服务器坏了」，不准确。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH 允许改的字段（白名单）。其余键一律丢弃，不进数据库 */
const PATCHABLE = ['threshold', 'email', 'deadline', 'status'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const ownerId = req.headers['x-owner-id'];
    if (!ownerId) {
      res.status(400).json({ code: 4000, message: '缺少身份标识（X-Owner-Id）', data: null });
      return;
    }

    const id = String(req.query.id ?? '');
    if (!UUID_RE.test(id)) {
      res.status(400).json({ code: 4000, message: '无效的订阅 ID', data: null });
      return;
    }

    if (req.method === 'DELETE') {
      await removeSubscription(ownerId, id, res);
      return;
    }

    if (req.method === 'PATCH') {
      await updateSubscription(ownerId, id, req, res);
      return;
    }

    res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
  } catch (e) {
    res.status(500).json({ code: 5000, message: e.message, data: null });
  }
}

/**
 * 取消订阅
 *
 * ⭐ 这里必须 .select()：让数据库把「真的被删掉的行」回给我们。
 *   因为「删了 0 行」和「删成功了」在 PostgREST 里都不是错误 ——
 *   不加 select 就没法区分，会把「这条根本不存在」也报成 200，
 *   前端于是以为删掉了，其实什么都没发生。
 */
async function removeSubscription(ownerId, id, res) {
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
    if (!['active', 'paused'].includes(patch.status)) return 'status 只能是 active 或 paused';
  }
  return '';
}

/** 改配置 / 暂停恢复 */
async function updateSubscription(ownerId, id, req, res) {
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

  // 同上：没匹配到行不是错误，得自己判 404
  if (!data.length) {
    res.status(404).json({ code: 4040, message: '该订阅不存在', data: null });
    return;
  }

  // 返回改完的那一行（形状与列表接口一致）→ 前端拿到可直接原地替换
  res.status(200).json({ code: 0, message: 'ok', data: toClient(data[0]) });
}
