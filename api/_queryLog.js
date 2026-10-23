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
import { todayShanghai } from './_expire.js';

/**
 * 当前月的起止。
 *
 * ★ 时区：「本月」指的是**用户的月**（东八区），不是运行环境的月。
 *   `queried_at` 是 timestamptz（UTC 绝对时刻），而 Vercel 的 Node 跑在 UTC：
 *   北京时间每月 1 号 00:00~08:00，UTC 还停在上个月最后一天 ⇒
 *   跟着 `getFullYear()` 走会把「本月」算成上个月，标签和边界一起错。
 *
 *   所以先取东八区的年月（`todayShanghai()` 是全项目唯一「今天」来源），
 *   再把「东八区某月 1 号 00:00」换算成绝对时刻。
 *   中国不实行夏令时、常年 UTC+8 ⇒ 固定减 8 小时就是准确的，不需要引入时区库。
 *
 * @returns {{from: string, to: string, label: string}}
 *   from / to —— ISO(UTC)，左闭右开，给数据库比较用
 *   label     —— 'YYYY-MM'，东八区月份，给页面展示用
 */
export function monthRange() {
  const [y, m] = todayShanghai().split('-').map(Number); // m 是 1-based
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
  return {
    from: new Date(Date.UTC(y, m - 1, 1) - SHANGHAI_OFFSET_MS).toISOString(),
    to: new Date(Date.UTC(y, m, 1) - SHANGHAI_OFFSET_MS).toISOString(),
    label: `${y}-${String(m).padStart(2, '0')}`,
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
