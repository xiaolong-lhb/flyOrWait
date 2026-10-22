/**
 * 订阅集合   /api/subscriptions
 *
 *   GET   列出「我的订阅」—— 按 owner 过滤，最新的排前面
 *   POST  新建一条订阅 —— 同一航线 + 同一出发日 + 同一邮箱已存在时，返回 409 / 4090
 *   DELETE ?id=<uuid>   取消订阅（删掉这条；历史通知流水保留，外键 on delete set null）
 *   PATCH  ?id=<uuid>   改配置：提醒阈值 / 通知邮箱 / 决策截止日，以及 暂停/恢复
 *
 * ⚠️ 单条操作为什么用 `?id=` 而不用 `/api/subscriptions/:id`：
 *   原来单条操作挂在同目录的 `[id].js` 上。2026-10-22 线上实测那条路由**根本没生成**——
 *   GET 被 SPA 兜底 rewrite 到首页、DELETE 得到 405（响应头是 index.html 的静态头）。
 *   按 Vercel 的路由顺序（File System Routes 先于 Rewrites），落到 rewrite 就说明
 *   文件系统里没有这条路由；社区案例的结论是方括号被当成**字面量**路径，真实 uuid 匹配不上。
 *   详见 api/_subscriptionOps.js 顶部。改成 query 传 id 后，走的是这条已验证可用的路由；
 *   Vercel 官方文档也建议「相关路由放进同一个函数，别为每个接口拆一个函数」。
 *
 * ── 身份从哪来 ──
 * 请求头 X-Owner-Id，由前端拦截器自动带上（见 src/api/index.js），
 * 对应数据库里的 owner_id 列。项目暂无登录，值固定为 'owner'。
 *
 * ── 字段翻译（toClient / toRow）──
 * 数据库列名与前端 store 字段名刻意不一致（from 是 SQL 保留字，列名只能叫 origin…）。
 * 翻译统一放在 api/_translate.js，本文件与 api/_subscriptionOps.js 共用同一份，
 * 保证「进」「出」两边的形状永远对得上。
 *
 * 响应体遵循全局约定 { code, message, data }，完整规则见 src/api/index.js 顶部。
 */
import { getSupabase } from '../_supabase.js';
import { toClient, toRow } from '../_translate.js';
import { markExpiredRows, todayShanghai } from '../_expire.js';
import { UUID_RE, removeSubscription, updateSubscription } from '../_subscriptionOps.js';

/**
 * 列表展示顺序：还在盯的在前，已结束的沉底。
 *
 *   active（监控中）→ paused（已暂停）→ expired（已提醒 / 已过期）
 *
 * 同组内保持原有先后：数据库按 created_at 倒序取回，排序用的是
 * Array.prototype.sort，而它在 ES2019 起规范保证**稳定**（相等元素不换位），
 * 所以不必再比一次时间，写了反而多一处可能出错的比较。
 *
 * ── 为什么在后端排，不交给前端 ──
 * store 的约定是「位置、顺序、条数全由后端说了算」，前端只负责画。
 * 前端再排一次，等于把「状态优先级」这条规则抄了两份，改一处就静默不一致。
 *
 * ── 为什么不在 SQL 里排 ──
 * PostgREST 只能按列的值排。按字符排恰好得到 active < expired < paused，
 * 不是我们要的顺序；要自定义顺序就得加派生列（改表），不值得。
 * 所以取回后在本进程里排一次，仍然只有一条查询、不多一次往返。
 *
 * ⚠️ 将来加分页时必须改成库侧排序（或先按状态分组取），
 *    否则内存排序只看得到当前这一页，跨页顺序会乱。
 */
const STATUS_RANK = { active: 0, paused: 1, expired: 2 };

function sortForDisplay(rows) {
  // 未知状态排最后，不塞到中间假装认识它
  return rows.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));
}

export default async function handler(req, res) {
  // 动态接口，显式声明任何一层都别缓存
  res.setHeader('Cache-Control', 'no-store');

  try {
    // 身份检查上提到这里统一做：GET 和 POST 都需要，就不在每个方法里各写一遍
    const ownerId = req.headers['x-owner-id'];
    if (!ownerId) {
      res.status(400).json({ code: 4000, message: '缺少身份标识（X-Owner-Id）', data: null });
      return;
    }

    // ── 单条操作：?id=<uuid>（取消 / 修改，逻辑在 api/_subscriptionOps.js）──
    // 用 Object.hasOwn 判「参数在不在」，不用真值判断：`?id=` 这种空值也该明确报
    // 「无效的订阅 ID」，而不是静默掉到 GET 列表去 —— 那会让调用方以为参数被忽略了。
    if (Object.hasOwn(req.query ?? {}, 'id')) {
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

      // 带 id 却没有对应动词：说清楚这里支持什么，别让人误以为是集合接口
      res.status(405).json({
        code: 4050,
        message: `带 id 时只支持 DELETE / PATCH，收到：${req.method}`,
        data: null,
      });
      return;
    }

    if (req.method === 'GET') {
      await listSubscriptions(ownerId, res);
      return;
    }

    if (req.method === 'POST') {
      await createSubscription(ownerId, req, res);
      return;
    }

    res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
  } catch (e) {
    // 走到这说明是我们自己的问题（环境变量缺失、网络异常、代码抛错…）
    res.status(500).json({ code: 5000, message: e.message, data: null });
  }
}

async function listSubscriptions(ownerId, res) {
  const { data, error } = await getSupabase()
    .from('subscriptions')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ code: 5000, message: `读取订阅失败：${error.message}`, data: null });
    return;
  }

  // ★ 顺手把「出发日已过、还挂着 active/paused」的订阅标成 expired，并**写回数据库**。
  //   不是只在返回时改个字段 —— 那样库里的 status 永远是错的，Cron / 导出 / 将来接的
  //   任何读取方都得自己再算一遍，状态就没有唯一出处了。
  //   没有过期行时这一步一次写都不发（markExpiredRows 里先筛 id，空就不请求）。
  //   标记失败**不降级**：宁可报错，也不能让页面继续把过期订阅显示成「监控中」。
  try {
    const marked = await markExpiredRows(data);
    if (marked) console.log(`[subscriptions] 已标记 ${marked} 条过期（owner=${ownerId}）`);
  } catch (e) {
    res.status(500).json({ code: 5000, message: e.message, data: null });
    return;
  }

  // 展示顺序：还在盯的在前、已结束的沉底（详见文件顶部 STATUS_RANK 的说明）。
  // 放在过期标记之后 —— 先让 status 变成最终值，再按最终状态排，
  // 否则刚被标成 expired 的那几条会排错位置。
  sortForDisplay(data);

  // 这行把查到的记录「逐条翻译」后再返回。注意左右两个 data 是两回事，别看混：
  //   右边的 data ← 上面 await 拿到的「行数组」，字段名是数据库那套（origin、base_price…）
  //   左边的 data ← 响应体三件套里的字段名，表示「这里装要返回给前端的东西」
  //
  // data.map(toClient)：map 会遍历数组每一项，把每次的返回值收集成一个新数组。
  // 整行意思 = 每一行都过一遍 toClient，翻译成前端字段名，拼成新数组，放进响应的 data 里。
  // 写成 .map(toClient) 等价于 .map((row) => toClient(row))，只是更简洁：
  //   map 会把「当前这一行」作为第一个参数传进去；后面两个（下标、原数组）toClient 没声明，
  //   用不上、自动忽略。
  // ⚠️ 所以 toClient 只能有一个参数 —— 将来若真要给它加第二个参数，这行必须改回箭头函数写法，
  //    否则会把「下标」当成第二个参数收进去，出隐蔽的 bug。
  // 此处 data 一定是数组：查库失败上面已 return，成功时哪怕没数据也是 []，不会是 null。
  res.status(200).json({ code: 0, message: 'ok', data: data.map(toClient) });
}

/** 新建时必须有值的字段（对应数据库里 not null 的列），缺一个就整条不收 */
const REQUIRED_FIELDS = ['from', 'to', 'departDate', 'basePrice', 'threshold', 'deadline', 'email'];

// 「今天」的算法（东八区）与过期标记逻辑统一放在 api/_expire.js ——
// 全项目只有那一份，别在这里另写一遍（两处时区口径不一致正是踩过的坑）。

async function createSubscription(ownerId, req, res) {
  const payload = req.body ?? {};

  const missing = REQUIRED_FIELDS.filter(
    (k) => payload[k] === undefined || payload[k] === null || payload[k] === '',
  );
  if (missing.length) {
    res.status(400).json({ code: 4000, message: `缺少必填项：${missing.join('、')}`, data: null });
    return;
  }

  // ★ 出发日必须在未来。
  //   不挡的话，一条「出发日已过」的订阅可以照样建出来 —— 它一出生就是过期的，
  //   Cron 不会给它比价，列表里却会一直挂着。与其事后标记，不如在入口就不收。
  //   先校格式再比大小：字符串比较只对 YYYY-MM-DD 成立，格式错会让比较得出错误结论。
  const departDate = String(payload.departDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate)) {
    res.status(400).json({ code: 4000, message: '出发日格式应为 YYYY-MM-DD', data: null });
    return;
  }
  if (departDate < todayShanghai()) {
    res.status(400).json({ code: 4000, message: '出发日不能早于今天', data: null });
    return;
  }

  const { data, error } = await getSupabase()
    .from('subscriptions')
    .insert(toRow(payload, ownerId))
    .select() // 让数据库把「真正插进去的那一行」回给我们（含 id、created_at 这些由库生成的列）
    .single(); // 只插一条，所以直接取单个对象，不是数组

  if (error) {
    // ⭐ 「去重靠数据库」的落点就在这儿。
    // 23505 = PostgreSQL 的唯一约束冲突。我们在 subscriptions 上建了唯一索引
    // (owner_id, origin, destination, depart_date, email) —— 同航线 + 同出发日 + 同邮箱只能有一条。
    // 这是「业务冲突」，不是服务器坏了 → 翻成约定的 409 / 4090，前端才好识别、好提示。
    // 靠数据库挡的好处：两个人（或两个标签页）同时提交同一条，也不会有漏网之鱼。
    if (error.code === '23505') {
      res.status(409).json({ code: 4090, message: '这条航线你已经订阅过了', data: null });
      return;
    }

    res.status(500).json({ code: 5000, message: `新建订阅失败：${error.message}`, data: null });
    return;
  }

  // 返回的形状与列表接口完全一致 —— 前端拿到就能直接塞进列表，不用再转一次
  res.status(200).json({ code: 0, message: 'ok', data: toClient(data) });
}
