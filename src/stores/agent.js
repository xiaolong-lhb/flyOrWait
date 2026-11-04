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
 * ══════════════════════════════════════════════════════════════════════
 *  并发：同一时刻只跑一条
 * ══════════════════════════════════════════════════════════════════════
 *  后端每问一次都要现爬日历（20~40s）并按次计费，并发两条既不省钱也不省时，
 *  还会让用户不知道该看哪个。所以 sending 为真时直接忽略新的提交。
 */

/** 重试可能有意义的错误码。5000（服务异常）/ 5030（已停服）重试一百次也一样 */
const RETRYABLE = new Set([5020, 5040, -1]);

export const useAgentStore = defineStore('agent', () => {
  /** 消息列表：用户与助手交替 */
  const messages = ref([]);

  /** 是否有请求在飞 */
  const sending = ref(false);

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
      const data = await http.post('/agent', { question });
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
    } catch (e) {
      // 已被拦截器归一化成 { code, message, status }，message 可以直接展示
      reply.state = 'error';
      reply.error = e?.message || '没能拿到回答，请稍后重试';
      reply.retryable = RETRYABLE.has(e?.code);
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

  /** 清空当前对话（期 1 只是清屏；期 2 会同时开一个新会话） */
  function reset() {
    stopTimer();
    messages.value = [];
    sending.value = false;
  }

  return { messages, sending, ask, retry, reset };
});
