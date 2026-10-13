/**
 * 订阅集合   /api/subscriptions
 *
 *   GET   列出「我的订阅」—— 按 owner 过滤，最新的排前面
 *   POST  新建一条订阅 —— 同一航线 + 同一出发日 + 同一邮箱已存在时，返回 409 / 4090
 *
 * ── 身份从哪来 ──
 * 请求头 X-Owner-Id，由前端拦截器自动带上（见 src/api/index.js），
 * 对应数据库里的 owner_id 列。项目暂无登录，值固定为 'owner'。
 *
 * ── 字段翻译（toClient / toRow）──
 * 数据库列名与前端 store 字段名刻意不一致（from 是 SQL 保留字，列名只能叫 origin…）。
 * 翻译统一放在 api/_translate.js，本文件与同目录的 [id].js 共用同一份，
 * 保证「进」「出」两边的形状永远对得上。
 *
 * 响应体遵循全局约定 { code, message, data }，完整规则见 src/api/index.js 顶部。
 */
import { getSupabase } from '../_supabase.js';
import { toClient, toRow } from '../_translate.js';

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

async function createSubscription(ownerId, req, res) {
  const payload = req.body ?? {};

  const missing = REQUIRED_FIELDS.filter(
    (k) => payload[k] === undefined || payload[k] === null || payload[k] === '',
  );
  if (missing.length) {
    res.status(400).json({ code: 4000, message: `缺少必填项：${missing.join('、')}`, data: null });
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
