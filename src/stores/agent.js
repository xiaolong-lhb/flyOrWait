import { defineStore } from 'pinia';
import { ref } from 'vue';

import { http } from '../api/index.js';
import { toBlocks } from '../utils/markdown.js';

/**
 * 对话 · 状态全部住在这里，不放在 ask.vue 里
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么必须在 store（跟 result store 正好相反）
 * ══════════════════════════════════════════════════════════════════════
 *  index.vue 的内容区是 <RouterView />，**切 tab 会把 ask.vue 整个卸载**。
 *  历史要是放在组件里的 ref([])，用户点一下「我的订阅」再回来，刚才聊的全没了。
 *  放在 store 里，组件销毁了数据还在，请求也还在跑 —— 切走 40 秒再回来，
 *  答案正好接上。
 *
 *  这也是为什么这里**不用** AbortController：用户离开页面不代表不要这条回答了。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  消息形状：块数组，不是 answer 字符串
 * ══════════════════════════════════════════════════════════════════════
 *  { id, role, blocks: [{type:'text', ...}], ... }
 *  现在只有纯文本块。将来卡片是往 blocks 里再加一种 {type:'card'}，
 *  **不用改数据结构、不用改渲染入口**。详见 src/utils/markdown.js。
 *
 *  ⚠️ 接口下发的是 answer 原文，转块只在这一层做一次。
 *    后端再解析一份就必然漂（改一处忘一处，两边静默不一致）。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  会话：activeId 是「当前在聊哪个」，null 表示还没建
 * ══════════════════════════════════════════════════════════════════════
 *  懒创建：点「新对话」只是清屏（activeId = null），不发任何请求。
 *  用户真问出第一句，后端才建会话并把 id 回给我们 —— 否则每次点一下
 *  「新对话」就在库里留一个空壳，会话列表很快就不能看了。
 *
 *  ● 失败时后端也会回 conversationId（data 不是 null），这里必须接住：
 *    否则第一句就失败的话，用户点重试会再建一个会话，同一个问题裂成两条。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  并发：同一时刻只跑一条
 * ══════════════════════════════════════════════════════════════════════
 *  后端每问一次都要现爬日历（20~40s）并按次计费，并发两条既不省钱也不省时，
 *  还会让用户不知道该看哪个。所以 sending 为真时：
 *    · 忽略新的提问
 *    · 禁止切换会话 / 新建 / 删除 —— 否则答案回来时会掉进另一个会话里
 */

/** 重试可能有意义的错误码。5000（服务异常）/ 5030（已停服）重试一百次也一样 */
const RETRYABLE = new Set([5020, 5040, -1]);

export const useAgentStore = defineStore('agent', () => {
  /** 当前会话的消息：用户与助手交替 */
  const messages = ref([]);

  /** 是否有请求在飞 */
  const sending = ref(false);

  /** 会话列表（最近更新的在前）。只在打开抽屉时主动加载，不在进页面就拉 */
  const conversations = ref([]);

  /** 当前会话 id。null = 新对话还没落库 */
  const activeId = ref(null);

  /** 正在加载某个会话的历史 */
  const loadingConv = ref(false);

  /** 计时器句柄。不放进 ref，它不需要被渲染 */
  let timer = null;

  function newId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `m-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /* ══════════════════════════════════════════════════════════════════
   *  会话
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * 拉会话列表。
   * @param {object} [opts]
   * @param {boolean} [opts.silent] true = 失败不抛（后台刷新用），
   *        false = 抛给调用方（用户主动打开抽屉时要能看见「没读到」）
   */
  async function loadConversations({ silent = false } = {}) {
    try {
      conversations.value = await http.get('/conversations');
    } catch (e) {
      if (!silent) throw e;
      // 静默失败：列表没刷出来不影响正在进行的对话，下次打开抽屉会重试
    }
  }

  /**
   * 切到一个已有会话：拉历史并整体覆盖当前消息。
   *
   * 不做增量合并（不像订阅页那样 writeAndSync 之后手动 patch）——
   * 历史就是服务端那份数据，本地任何「保留几条」都是自找不一致。
   */
  async function openConversation(id) {
    if (sending.value || !id) return;
    if (id === activeId.value && messages.value.length) return;

    loadingConv.value = true;
    try {
      const data = await http.get('/conversations', { params: { id } });
      activeId.value = data.id;
      messages.value = data.messages.map(fromServer);
    } catch (e) {
      // 4040：这条会话在别处被删了，或者 URL 里的 id 是旧的。
      // 不能把用户卡在一个空白页上 —— 清成本地新对话，错误照样往上抛给组件提示。
      if (e?.code === 4040) newChat();
      throw e;
    } finally {
      loadingConv.value = false;
    }
  }

  /** 删会话。删完整体重拉列表，不在本地 filter —— 前端不维护数据 */
  async function removeConversation(id) {
    if (sending.value || !id) return;

    await http.delete('/conversations', { params: { id } });
    if (activeId.value === id) newChat();
    await loadConversations({ silent: true });
  }

  /** 开新对话：只清屏，不建会话 */
  function newChat() {
    if (sending.value) return;
    stopTimer();
    messages.value = [];
    activeId.value = null;
  }

  /**
   * 后端回了会话 id 就认下来。
   * 无论成功失败都要刷一次列表：success 时 updated_at 变了，顺序要跟着变。
   */
  function adoptConversation(id) {
    if (!id) return;
    activeId.value = id;
    loadConversations({ silent: true });
  }

  /* ══════════════════════════════════════════════════════════════════
   *  提问
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * 发一条问题。
   * @param {string} question 用户原话（已 trim）
   * @returns {Promise<void>}
   */
  async function ask(question) {
    if (sending.value || !question) return;
    sending.value = true;

    messages.value.push({ id: newId(), role: 'user', text: question, state: 'ok' });

    // 助手占位：先亮出 3 个点，别让用户对着空白怀疑页面死了
    messages.value.push({
      id: newId(),
      role: 'assistant',
      blocks: [],
      state: 'loading',
      error: '',
      elapsed: 0,
      retryable: false,
    });

    /**
     * ⚠️ 必须把「代理对象」取回来再改，不能留着上面那个对象字面量。
     *    ref([]) 只在**读取元素时**才把它包成 reactive proxy，
     *    直接改 push 进去的裸对象 ⇒ set 陷阱没走到 ⇒ 不触发任何更新。
     *    症状：定时器每秒都写成功了，页面却一直显示「已等 0 秒」；
     *    答案看起来正常只是因为 finally 里 sending 翻转顺带重渲了一次。
     *    （11-04 真踩，探针验证：改裸对象触发 0 次，改 proxy 触发 1 次）
     */
    const reply = messages.value[messages.value.length - 1];

    const startedAt = Date.now();
    stopTimer();
    timer = setInterval(() => {
      // 直接改 store 里的对象：这条消息本来就是响应式的
      reply.elapsed = Math.round((Date.now() - startedAt) / 1000);
    }, 1000);

    try {
      const body = { question };
      // 有会话就带上，让后端把这一轮接到同一段对话里；没有就让它建一个
      if (activeId.value) body.conversationId = activeId.value;

      const data = await http.post('/agent', body);
      // 真正的块交给解析器，气泡只负责渲染块
      reply.blocks = toBlocks(data?.answer ?? '');
      reply.state = 'ok';
      // 留个账，排查时不用去翻数据库
      reply.meta = {
        runId: data?.runId,
        rounds: data?.rounds,
        toolCalls: data?.toolCalls,
        elapsedMs: data?.elapsedMs,
      };
      adoptConversation(data?.conversationId);
    } catch (e) {
      // 已被拦截器归一化成 { code, message, status, data }，message 可以直接展示
      reply.state = 'error';
      reply.error = e?.message || '没能拿到回答，请稍后重试';
      reply.retryable = RETRYABLE.has(e?.code);
      // ★ 失败时后端也给了 conversationId（见 api/agent.js），接住它，
      //   重试才不会再建一个会话
      adoptConversation(e?.data?.conversationId);
    } finally {
      stopTimer();
      sending.value = false;
    }
  }

  /** 重试：把失败那条连同它上面的问题一起去掉，再问一遍 */
  async function retry(messageId) {
    const idx = messages.value.findIndex((m) => m.id === messageId);
    if (idx < 0) return;

    // 往上找最近的一条用户消息
    let q = '';
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (messages.value[i].role === 'user') {
        q = messages.value[i].text;
        break;
      }
    }
    if (!q) return;

    messages.value.splice(idx - 1, 2);
    await ask(q);
  }

  return {
    messages,
    sending,
    conversations,
    activeId,
    loadingConv,
    ask,
    retry,
    newChat,
    loadConversations,
    openConversation,
    removeConversation,
  };
});

/**
 * 接口消息 → 前端消息。
 *
 * 接口只给 text 原文（后端不做 markdown 解析），所以这里统一转一次块。
 * 历史里可能混着「这次没能答完」的失败消息 —— 对前端就是一坨普通文本，
 * 不需要特殊渲染，`status` 留着以后要用再取。
 */
function fromServer(m) {
  return {
    id: m.id,
    role: m.role,
    ...(m.role === 'user'
      ? { text: m.text }
      : { blocks: toBlocks(m.text ?? ''), meta: m.meta ?? null }),
    state: 'ok',
    error: '',
    elapsed: 0,
    retryable: false,
  };
}
