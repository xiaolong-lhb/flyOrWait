/**
 * 查询计数（内部共享工具，不是接口）
 *
 * 文件名以 _ 开头是刻意的：本地运行器与 Vercel 都会跳过它，不会变成一个路由。
 *
 * ── 它干什么 ──
 *   logQuery(ownerId)            每次「查一次票」后追加一行
 *   countQueries(ownerId, from, to)  数某个时间段查了多少次
 *
 * ── 为什么是「日志行」而不是「一个计数列」──
 * 页面要显示的是「**本月**查询次数」。若在 user_settings 上放一个 used 计数列，
 * 就得额外写一个「每月 1 号把它归零」的定时任务 —— 多一个环节、多一个会忘记维护的地方。
 * 换成日志表：跨月不过是时间过滤的范围变了，**零维护**。
 * 代价是行数会涨，但一天几十行，可忽略。
 *
 * ── 为什么记日志要「不 await」──
 * 见 api/result.js 的调用点：这是「附带记一笔」，失败绝不能让用户的查询失败 ——
 * 用户要的是票价，不是我们的记账。所以调用方吞掉错误，这里也只负责抛。
 */

import { getSupabase } from './_supabase.js';

/**
 * 当前月的起止。
 *
 * ★ 这里有个必须说清的时区问题（已实测踩到）：
 *   `queried_at` 是 timestamptz，存的是 **UTC 绝对时刻**；而用户说的「本月」是**本地月份**。
 *   本地本月 1 号 00:00（东八区）转成 UTC 其实是 **上个月最后一天 16:00**。
 *   如果直接拿 UTC 的月份去切，会有两处错：
 *     ① 标签错：`from.toISOString().slice(0,7)` 在东八区取出来是**上个月**（实测 10-16 返回 "2026-09"）；
 *     ② 边界错：本地 11-01 08:00 之前查的，UTC 还停在 10-31 ⇒ 会被算进上个月。
 *   ⇒ 做法：**用本地时间构造边界，再 toISOString 成 UTC 去比**（比较的是同一根时间轴，正确），
 *      而**给人看的月份标签单独用本地字段拼**，不从 UTC 串里切。
 *
 * @returns {{from: string, to: string, label: string}}
 *   from / to —— ISO(UTC)，左闭右开，给数据库比较用
 *   label     —— 'YYYY-MM'，本地月份，给页面展示用
 */
export function monthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  // new Date(y, m, 1) 就是**本地**该月 1 号 00:00；toISOString 只是换个表示法，绝对时刻不变
  const from = new Date(y, m, 1);
  const to = new Date(y, m + 1, 1);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    label: `${y}-${String(m + 1).padStart(2, '0')}`,
  };
}

/** 记一次查询。失败抛错，由调用方决定「要不要因为记账失败而影响主流程」（答案是不影响） */
export async function logQuery(ownerId) {
  const { error } = await getSupabase().from('query_log').insert({ owner_id: ownerId });
  if (error) throw new Error(`记录查询次数失败：${error.message}`);
}

/**
 * 数某个时间段内查了多少次。
 * @param {string} ownerId
 * @param {string} from ISO 时间（含）
 * @param {string} to   ISO 时间（不含）
 * @returns {Promise<number>}
 *
 * ⚠️ 用 count + head:true：只要一个数字，**不把行传回来**。
 *    行数以后会越来越多，传回来纯属浪费带宽。
 */
export async function countQueries(ownerId, from, to) {
  const { count, error } = await getSupabase()
    .from('query_log')
    .select('*', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .gte('queried_at', from)
    .lt('queried_at', to);

  if (error) throw new Error(`统计查询次数失败：${error.message}`);
  return count ?? 0;
}
