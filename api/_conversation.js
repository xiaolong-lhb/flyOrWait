/**
 * 会话零件（建会话 / 取历史 / 更新活跃时间）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独成文件
 * ══════════════════════════════════════════════════════════════════════
 *  这三件事既不归 api/agent.js（它只校参、只回包，不写业务逻辑），
 *  也不归 api/_agentRun.js（那是循环本体，命令行和评测集也在用，
 *  它们不需要会话）。所以按项目「_ 开头 = 共享零件」的约定放这里。
 *
 *  目前只有 api/agent.js 调用；将来 DELETE 会话、会话重命名也会用它。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ★ 历史只用于理解指代，不能当数据来源
 * ══════════════════════════════════════════════════════════════════════
 *  这里把上一轮的问答取出来交给模型，是为了让它听懂「那 11-28 呢」
 *  指的是哪条航线、哪天。**不是**让它复用上一轮的价格 —— 那个价早就过期了。
 *
 *  这层约束靠两处一起兜：
 *    本文件：只取最近 HISTORY_ROUNDS 轮，且答案截断（省 token、也断了整段复读的念头）
 *    prompt：_agentRun.js 铁律 9 明说「历史里的价格不能再引用」
 *  少任何一处，多轮一上线就会开始编价格。
 */

import { getSupabase } from './_supabase.js';

/** uuid 形状。会话与订阅共用同一套形状，但各留一份 —— 不为一个正则去跨模块耦合。 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 最近几轮带进上下文。
 * 2 轮（= 4 条消息）是权衡：再多，prompt token 和首轮耗时一起涨，
 * 而接口总预算只有 45s，日历一项就要吃掉最多 35s。
 */
const HISTORY_ROUNDS = 2;

/**
 * 历史里的答案截到多少字。
 * 真实答案是 200~400 字，截 400 基本等于不截；真要超了说明模型那天话多，
 * 而历史只需要「他在说什么」，不需要逐字复读。
 */
const HISTORY_ANSWER_MAX = 400;

/** 标题取第一问的前几个字。这不是模型起的标题 —— 多一次调用多一分钱，不值。 */
const TITLE_MAX = 12;
const DEFAULT_TITLE = '新对话';

/* ══════════════════════════════════════════════════════════════════════
 *  建 / 认会话
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 有 id 就认领，没有就新建。
 *
 * 懒创建是有意的：前端点「新对话」只是清屏，不发请求；
 * 用户真问出第一句，才在这里建一行 —— 否则会话列表里会出现一堆空壳。
 *
 * @param {object} opts
 * @param {string} opts.ownerId        身份（现在固定 'owner'，接登录后才有意义）
 * @param {string} [opts.conversationId] 前端带来的会话 id，可为空
 * @param {string} opts.firstQuestion  新建时用来起标题
 * @returns {Promise<{ok:true,id:string,isNew:boolean}|{ok:false,code:number,message:string}>}
 *          code 沿用全局约定（前三位是 HTTP 码），调用方用 code/10 就能拿到 status
 */
export async function resolveConversation({ ownerId, conversationId, firstQuestion }) {
  const supa = getSupabase();
  const wanted = String(conversationId ?? '').trim();

  // ── 没带 id：新建 ──
  if (!wanted) {
    const { data, error } = await supa
      .from('agent_conversation')
      .insert({ owner_id: ownerId, title: makeTitle(firstQuestion) })
      .select('id')
      .single();

    if (error) {
      console.error('[conversation] 新建会话失败：', error.message);
      return { ok: false, code: 5000, message: '服务暂时不可用，请稍后再试' };
    }
    return { ok: true, id: data.id, isNew: true };
  }

  // ── 带了 id：先验形状，再验归属 ──
  // 形状不对直接 400，不要去查库（查了也是白跑一趟跨境请求）
  if (!UUID_RE.test(wanted)) {
    return { ok: false, code: 4000, message: '无效的会话 ID' };
  }

  // ★ owner_id 也进条件：现在全项目只有一个 'owner'，但查询里不写，
  //   将来接登录的那天就成了「往别人的会话里插话」。约束写进查询，不靠调用方自觉。
  const { data, error } = await supa
    .from('agent_conversation')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('id', wanted)
    .maybeSingle();

  if (error) {
    console.error('[conversation] 读会话失败：', error.message);
    return { ok: false, code: 5000, message: '服务暂时不可用，请稍后再试' };
  }
  if (!data) {
    // 404 而不是 400：id 是合法的，只是这条不存在（或不属于你）。
    // 前端收到这个码应该清掉本地会话 id、当成开新对话 —— 而不是让用户卡死在这里。
    return { ok: false, code: 4040, message: '会话不存在，已为你开一个新对话' };
  }

  return { ok: true, id: data.id, isNew: false };
}

/* ══════════════════════════════════════════════════════════════════════
 *  取历史
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 最近几轮的问答，按对话顺序排好，直接可以拼进 messages。
 *
 * @returns {Promise<{messages: Array<{role:string,content:string}>, warning: string|null}>}
 *          ⚠️ 读历史失败**不能让整轮挂掉**：用户问的是新问题，历史只是辅助。
 *          所以这里不抛错，返回空历史 + warning，由调用方决定记哪条日志。
 */
export async function loadHistory({ ownerId, conversationId }) {
  if (!conversationId) return { messages: [], warning: null };

  const { data, error } = await getSupabase()
    .from('agent_run')
    .select('input_text, answer')
    .eq('owner_id', ownerId)
    .eq('conversation_id', conversationId)
    // 只取完整往返：failed / aborted 那几条只有问题没有答案，
    // 塞进上下文会让消息变成「连着两个 user」，模型会以为自己在被催
    .eq('status', 'ok')
    .not('answer', 'is', null)
    // 倒序取最近 N 条，再翻正 —— 正序 + limit 拿到的是最早那几轮，正好搞反
    .order('started_at', { ascending: false })
    .limit(HISTORY_ROUNDS);

  if (error) {
    return { messages: [], warning: error.message };
  }

  return { messages: data.slice().reverse().flatMap(toMessagePair), warning: null };
}

/** 一行 agent_run → 一问一答两条消息 */
function toMessagePair(run) {
  const question = String(run.input_text ?? '').trim();
  const answer = String(run.answer ?? '').trim();
  if (!question || !answer) return [];

  return [
    { role: 'user', content: question },
    { role: 'assistant', content: clip(answer, HISTORY_ANSWER_MAX) },
  ];
}

/**
 * 按**码点**截断，不用 slice —— 中文是 BMP 内的（slice 安全），
 * 但 emoji 是代理对，slice 会把它劈成两个乱码字符。
 */
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

/* ══════════════════════════════════════════════════════════════════════
 *  更新活跃时间
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把会话顶到列表前面。
 *
 * 为什么不用触发器：这张表只有这一个写点，加触发器反而多一层看不见的逻辑。
 * 失败只打日志 —— 排序不更新是小事，为它把一次已经答完的对话变成报错不值得。
 */
export async function touchConversation(conversationId) {
  if (!conversationId) return;

  const { error } = await getSupabase()
    .from('agent_conversation')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  if (error) console.warn('[conversation] 更新会话时间失败：', error.message);
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function makeTitle(question) {
  // 换行压成空格：标题是一行文本，留着 \n 会让列表里的一行变成两行
  const flat = String(question ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return DEFAULT_TITLE;

  const chars = Array.from(flat);
  return chars.length <= TITLE_MAX ? flat : `${chars.slice(0, TITLE_MAX).join('')}…`;
}
