/**
 * 订阅「过期」判定与写回（内部共享工具，不是接口）
 *
 * ── 为什么不前端现算 ──
 * 派生字段要在每个读的地方各算一遍（列表页、Cron、将来的导出），
 * 早晚有人写成 `<` / `<=` 不一致，或者忘了时区 —— 判据漂移的坑已经踩过一次。
 * 状态落进数据库后只有一处定义，谁读都一样。
 *
 * ── 为什么放在「读列表」时顺手做 ──
 * Cron 每天标记是最终形态，但它还没上线；而且就算上线了，
 * 用户打开页面那一刻看到的状态也应该是真的 —— 不能等下一次 Cron。
 * 所以查询时顺手对比一次：本次查出来的行里，出发日已过的 active/paused
 * 就地标成 expired 并写回库。
 *
 * ⭐ 没有过期行时**一次写都不会发生**（纯读）——
 *    常规查询不会因为多了这个检查而多付一次写入成本。
 *
 * ⚠️「今天」必须用 Asia/Shanghai：
 *    - 不能用 `new Date().toISOString().slice(0,10)`（UTC，本地 00:00~08:00 差一天）
 *    - 不能用 `getFullYear()/getMonth()`（跟随运行环境：本机东八区 vs Vercel UTC）
 *    - 也不用数据库的 current_date（库在 UTC，同一时刻会算出前一天）
 *    Cron 上线后必须复用这一个函数，别另写一份。
 */
import { getSupabase } from './_supabase.js';

/** 东八区的今天，YYYY-MM-DD（格式恰好可直接与 date 列做字符串比较） */
export function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

/**
 * 这一行该不该过期。
 *
 * 只看两件事：状态还在「需要盯」的集合里（active / paused），且出发日已经过去。
 * · paused 也要标：用户暂停的是一条「还会飞」的监控，航班飞走了这条同样作废；
 *   留着 paused 会永远挂在列表里显示「已暂停」，比「已过期」更误导。
 * · 已经是 expired 的不重复处理；将来的其它状态（若新增）默认不动。
 */
export function isExpired(row, today = todayShanghai()) {
  const watching = row.status === 'active' || row.status === 'paused';
  // depart_date 是 date 列，PostgREST 返回的就是 'YYYY-MM-DD'，字符串比较即日期比较
  return watching && row.depart_date < today;
}

/**
 * 把 rows 里满足过期条件的标成 expired，并**就地**把 rows 的 status 改掉。
 *
 * 为什么要就地改：调用方紧接着要把 rows 返回给前端。若改完库再重新查一遍，
 * 就多一次多余的往返；反正被标记的就是这几行，字段也没变，改内存里那一格就够了。
 *
 * @param {Array<object>} rows 数据库原样行（字段名是库那套：status / depart_date）
 * @returns {Promise<number>} 本次真正标记的条数（0 表示一次写都没发生）
 *
 * ⚠️ 更新只按 id 收口。传入的 rows 必须来自「已经按 owner 过滤」的查询，
 *    否则等于越权改别人的记录。
 */
export async function markExpiredRows(rows) {
  const today = todayShanghai();
  // 先筛出要动的 id，再决定要不要发写请求 —— 没有就一条 SQL 都不发
  const ids = rows.filter((row) => isExpired(row, today)).map((row) => row.id);
  if (!ids.length) return 0;

  const { error } = await getSupabase()
    .from('subscriptions')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .in('id', ids);

  // 失败要抛出去，让调用方决定怎么报 —— 绝不能吞掉：
  // 吞了就会「库说还活着，页面显示监控中」，而这正是要修的问题本身。
  if (error) throw new Error(`标记过期订阅失败：${error.message}`);

  const marked = new Set(ids);
  for (const row of rows) if (marked.has(row.id)) row.status = 'expired';

  console.log(`[expire] 标记 ${ids.length} 条订阅为已过期`);
  return ids.length;
}
