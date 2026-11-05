/**
 * 会话历史   /api/conversations
 *
 *   GET             列出会话（最近更新的在前）
 *   GET ?id=<uuid>  单个会话 + 它的全部消息
 *
 * 单条操作用 `?id=` 而不用 `/api/conversations/:id`，跟 /api/subscriptions 同一个理由：
 * Vercel 曾把 api/**.js 的方括号文件名注册成字面量路径，真 uuid 匹配不到
 * （2026-10-22 线上踩过，详见 api/_subscriptionOps.js 顶部）。走 query 才是已验证可用的路由。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么没有「消息表」
 * ══════════════════════════════════════════════════════════════════════
 *  agent_run 一行天然就是**一问一答**：
 *    input_text              = 用户问什么
 *    answer                  = 助手答什么
 *    started_at/finished_at  = 什么时候问的、什么时候答完
 *    rounds / tool_calls     = 过程中调了几轮、用了几个工具
 *  所以「会话」只是一组 run 靠 conversation_id 串起来，不必再造一张 agent_message
 *  把同一份数据抄一遍 —— 抄了就得维护两份，迟早不一致。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ★ error 列绝不能原样下发
 * ══════════════════════════════════════════════════════════════════════
 *  agent_run.error 存的是 runAgent 的 failure 原文，可能带着上游 401 的响应体、
 *  接口 URL 这类实现细节。api/agent.js 已经把这些抹成「服务暂时不可用」；
 *  历史接口若直接吐出来，等于从后门把刚堵上的洞重新打开。
 *  处置：库里照存（排查要用），下发时 status !== 'ok' 一律换成统一文案。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  接口只给原文，不给「块」
 * ══════════════════════════════════════════════════════════════════════
 *  前端渲染用的是块数组（{type:'text'} 现在、{type:'card'} 将来），但那是
 *  **前端的消息模型**，不是接口契约。接口只回 answer 原文，由前端 store 调
 *  toBlocks() 转 —— 否则 markdown 解析逻辑要在前后端各写一份，改一处就静默不一致。
 *
 * 响应体遵循全局约定 { code, message, data }，见 src/api/index.js 顶部。
 */
import { getSupabase } from './_supabase.js';

/**
 * uuid 形状校验。
 * 与 api/_subscriptionOps.js 的 UUID_RE 同形，但本地写一份 ——
 * 不为了一个正则去 import 订阅模块，那会让「会话」和「订阅」无谓耦合。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 历史里「没答完」的统一说法。
 * 不含任何实现细节，但用户看了知道下一步该干什么（重新问一遍）。
 */
const INCOMPLETE_MESSAGE = '这次没能答完，可以重新提问。';

export default async function handler(req, res) {
  // 动态接口，任何一层都别缓存
  res.setHeader('Cache-Control', 'no-store');

  try {
    // 身份（X-Owner-Id，由前端拦截器自动带上）—— 现在固定 'owner'，但接口不认识默认值，
    // 缺了就明确报错，不替调用方猜一个
    const ownerId = req.headers['x-owner-id'];
    if (!ownerId) {
      res.status(400).json({ code: 4000, message: '缺少身份标识（X-Owner-Id）', data: null });
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ code: 4050, message: `不支持的方法：${req.method}`, data: null });
      return;
    }

    // 用 Object.hasOwn 判「参数在不在」，不用真值判断：
    // `?id=` 这种空值也该明确报「无效的会话 ID」，而不是静默掉到列表去 ——
    // 那会让调用方以为参数被忽略了。这跟 subscriptions 的写法保持一致。
    if (Object.hasOwn(req.query ?? {}, 'id')) {
      await getConversation(ownerId, String(req.query.id ?? ''), res);
      return;
    }

    await listConversations(ownerId, res);
  } catch (e) {
    // 走到这里说明是我们自己的锅（缺环境变量、网络异常、代码抛错）。
    // ★ 对外只给统一文案、真因进日志 —— 跟 api/agent.js 的口径一致，
    //   别把 e.message（可能含连接串、表名）递给用户。
    console.error('[conversations] 未预期异常：', e);
    res.status(500).json({ code: 5000, message: '服务暂时不可用，请稍后再试', data: null });
  }
}

/** 数据库行 → 前端字段（会话列表与详情共用，保证两处形状永远一样） */
function toClient(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listConversations(ownerId, res) {
  const { data, error } = await getSupabase()
    .from('agent_conversation')
    .select('id, title, created_at, updated_at')
    .eq('owner_id', ownerId)
    // 最近说过的排前面：用户找的是「刚才那个对话」，不是「最早那个」
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[conversations] 读会话列表失败：', error.message);
    res.status(500).json({ code: 5000, message: '读取会话列表失败', data: null });
    return;
  }

  res.status(200).json({ code: 0, message: 'ok', data: data.map(toClient) });
}

async function getConversation(ownerId, id, res) {
  if (!UUID_RE.test(id)) {
    res.status(400).json({ code: 4000, message: '无效的会话 ID', data: null });
    return;
  }

  const supa = getSupabase();

  // owner_id 也进条件：现在全项目只有一个 'owner'，但查询里不写，
  // 将来接登录的那天就成了越权读别人会话。约束写进查询，不靠调用方自觉。
  const { data: conv, error: convErr } = await supa
    .from('agent_conversation')
    .select('id, title, created_at, updated_at')
    .eq('owner_id', ownerId)
    .eq('id', id)
    // 0 行是「没有这条」，是正常情况不是错误 ⇒ maybeSingle，不用 single（single 会报错）
    .maybeSingle();

  if (convErr) {
    console.error('[conversations] 读会话失败：', convErr.message);
    res.status(500).json({ code: 5000, message: '读取会话失败', data: null });
    return;
  }
  if (!conv) {
    res.status(404).json({ code: 4040, message: '会话不存在', data: null });
    return;
  }

  const { data: runs, error: runErr } = await supa
    .from('agent_run')
    .select('id, input_text, answer, status, started_at, finished_at, rounds, tool_calls')
    .eq('owner_id', ownerId)
    .eq('conversation_id', id)
    // 排除 status='running'：那是请求还在飞时建的占位行。用户刷新页面后
    // 那条请求已经断了，它不会再有答案 —— 返回它只会在历史里留一条永远转圈的气泡。
    .neq('status', 'running')
    // 升序：先说的问题排前面，跟聊天界面从上往下的时间轴一致
    .order('started_at', { ascending: true });

  if (runErr) {
    console.error('[conversations] 读会话消息失败：', runErr.message);
    res.status(500).json({ code: 5000, message: '读取会话消息失败', data: null });
    return;
  }

  res.status(200).json({
    code: 0,
    message: 'ok',
    // flatMap：一行 run 摊成「问题 + 回答」两条消息，再拼成一维列表
    data: { ...toClient(conv), messages: runs.flatMap(toMessages) },
  });
}

/**
 * 一行 agent_run → 两条消息
 * @returns {Array<object>} 固定两条：user 在前、assistant 在后
 */
function toMessages(run) {
  const messages = [{ id: `${run.id}-q`, role: 'user', text: run.input_text ?? '', at: run.started_at }];

  // ★ 没答完时既不回 answer（可能是 null），也不回 error（可能含上游原文），
  //   只给一句用户能理解、且不泄漏实现细节的话。status 照给，前端要区分可以自己判。
  const answered = run.status === 'ok' && Boolean(run.answer);

  messages.push({
    id: `${run.id}-a`,
    role: 'assistant',
    text: answered ? run.answer : INCOMPLETE_MESSAGE,
    status: run.status,
    at: run.finished_at ?? run.started_at,
    meta: {
      rounds: run.rounds ?? 0,
      toolCalls: run.tool_calls ?? 0,
      elapsedMs: elapsedOf(run),
    },
  });

  return messages;
}

/** 这一轮耗时。库里没存 elapsed（在 meta jsonb 里），用起止时间相减即可 */
function elapsedOf(run) {
  if (!run.started_at || !run.finished_at) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
