<template>
  <div class="ask">
    <header class="chat-head">
      <div class="head-left">
        <button class="ghost icon" type="button" title="历史对话" @click="openDrawer">☰</button>
        <div class="who">
          <span class="name">机票助手</span>
          <span class="sub">回答依据实时票价参考价</span>
        </div>
      </div>
      <button
        class="ghost"
        type="button"
        :disabled="sending || !messages.length"
        @click="handleNew"
      >
        新对话
      </button>
    </header>

    <div ref="scroller" class="chat-body">
      <p v-if="loadingConv" class="conv-loading">正在打开这段对话…</p>

      <!-- 空状态：给几个能直接点的问题，比一句「请输入」有用 -->
      <div v-if="!messages.length && !loadingConv" class="empty">
        <div class="big-avatar" aria-hidden="true">✈</div>
        <h1 class="title">想先问什么？</h1>
        <p class="tip">我能查实时票价、挑出最便宜的那几天，也能告诉某一天到底贵不贵。</p>
        <div class="samples">
          <button
            v-for="s in SAMPLES"
            :key="s"
            class="sample"
            type="button"
            :disabled="sending"
            @click="pickSample(s)"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <MessageBubble
        v-for="m in messages"
        :key="m.id"
        :role="m.role"
        :text="m.text"
        :blocks="m.blocks"
        :state="m.state"
        :stage="m.stage"
        :error="m.error"
        :elapsed="m.elapsed"
        :retryable="m.retryable"
        @retry="store.retry(m.id)"
      />
    </div>

    <ChatComposer :disabled="sending" @submit="handleSubmit" />

    <ConversationDrawer
      v-model="drawerOpen"
      :conversations="conversations"
      :active-id="activeId"
      :disabled="sending || loadingConv"
      :loading="listLoading"
      @create="handleNew"
      @select="handleSelect"
      @remove="handleRemove"
    />
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import ChatComposer from '../../components/chat/ChatComposer.vue';
import ConversationDrawer from '../../components/chat/ConversationDrawer.vue';
import MessageBubble from '../../components/chat/MessageBubble.vue';
import { useAgentStore } from '../../stores/agent.js';

const store = useAgentStore();
const { messages, sending, conversations, activeId, loadingConv } = storeToRefs(store);

const route = useRoute();
const router = useRouter();

/**
 * 示例问题。全部落在日历可查窗口内（约 11-14 ~ 12-13），
 * 否则会走到「超出去查范围」分支，用户第一眼就看到一句拒绝。
 */
const SAMPLES = [
  '11月下旬从深圳去北京哪天便宜',
  '11月26号深圳飞北京贵不贵',
  '11月20号和11月25号哪个更划算',
  '12月初深圳到香港票价怎么样',
];

const scroller = ref(null);
const drawerOpen = ref(false);
const listLoading = ref(false);

/** 滚到底：新增消息、回答落地、切会话时，都该把视线带过去 */
function scrollToBottom() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

watch(
  () => messages.value.length,
  () => nextTick(scrollToBottom),
);

/**
 * 打字时正文一块块长出来，消息条数不变 —— 上面那个 length watcher 不会触发。
 * blocks 每次重解析都是**整体替换成新数组**，所以盯引用就够，不用 deep。
 *
 * 只有「本来就贴着底部」才跟：用户往上翻看之前的回答时，不该被强行拽回来。
 * 判断用的是更新前的 DOM（用户此刻看到的），这正是我们要的。
 */
watch(
  () => messages.value[messages.value.length - 1]?.blocks,
  () => {
    const el = scroller.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) nextTick(scrollToBottom);
  },
);
watch(sending, (v) => {
  if (!v) nextTick(scrollToBottom);
});
// 切会话时消息条数可能一样多（比如都是 4 条），length 不变化就不会触发上面那个
watch(activeId, () => nextTick(scrollToBottom));

/* ── URL 同步 ────────────────────────────────────────────────────────
 * 会话 id 写进 ?c=<id>，刷新才能回到同一段对话。
 * 用 replace 不用 push：切会话不该往浏览器历史里堆记录 ——
 * 用户按返回键应该是「回上一个页面」，不是「回上一个会话」。
 *
 * 两个 watch 互相触发，靠「值相同就返回」刹住：
 *   activeId 变 → 写 URL → 触发第二个 watch → 发现 want === activeId → 跳过
 */
watch(activeId, (id) => {
  const cur = route.query.c || null;
  if (cur === (id || null)) return;
  router.replace({ name: 'ask', query: id ? { c: id } : {} });
});

watch(
  () => route.query.c,
  (c) => {
    const want = c ? String(c) : null;
    if (want === activeId.value) return;

    if (!want) {
      // 地址栏里的 c 没了（浏览器后退 / 手动改）⇒ 回到新对话。
      // 注意：在 /ask 页内点顶部「问一问」也会走到这里，效果等同于开新对话。
      store.newChat();
      return;
    }

    store.openConversation(want).catch((e) => {
      ElMessage.error(e?.message || '打开会话失败');
    });
  },
);

onMounted(() => {
  const c = route.query.c ? String(route.query.c) : null;

  if (c) {
    if (c !== activeId.value) {
      store.openConversation(c).catch((e) => {
        ElMessage.error(e?.message || '打开会话失败');
      });
    }
    return;
  }

  // URL 没带，但 store 里还留着上次的会话（切走再切回来就是这种情况）——
  // 把 id 补进地址栏，否则一刷新就丢
  if (activeId.value) {
    router.replace({ name: 'ask', query: { c: activeId.value } });
  }
});

/* ── 交互 ─────────────────────────────────────────────────────────── */

async function openDrawer() {
  drawerOpen.value = true;
  listLoading.value = true;
  try {
    await store.loadConversations();
  } catch (e) {
    ElMessage.error(e?.message || '会话列表读取失败');
  } finally {
    listLoading.value = false;
  }
}

function handleSubmit(text) {
  store.ask(text);
}

function pickSample(text) {
  store.ask(text);
}

function handleNew() {
  store.newChat();
  drawerOpen.value = false;
}

async function handleSelect(id) {
  // 点的就是当前这段：只是关抽屉，别重新拉一遍
  if (id === activeId.value) {
    drawerOpen.value = false;
    return;
  }
  try {
    await store.openConversation(id);
    drawerOpen.value = false;
  } catch (e) {
    ElMessage.error(e?.message || '打开会话失败');
  }
}

async function handleRemove(id) {
  try {
    await ElMessageBox.confirm('删除后这段对话就找不回来了。', '删除对话', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return; // 用户点了取消 —— 不是错误，什么都别做
  }

  try {
    await store.removeConversation(id);
  } catch (e) {
    ElMessage.error(e?.message || '删除失败，请稍后重试');
  }
}
</script>

<style scoped>
/* 整页限高：消息区自己滚，输入区永远在底部 —— 这是对话页与其它页最大的区别 */
.ask {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  max-width: 820px;
  min-height: 0;
  margin: 0 auto;
  padding: 0 20px;
}

/* ---------- 顶部 ---------- */
.chat-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 14px 2px 12px;
  border-bottom: 1px solid #eef1f5;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.who {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.name {
  font-size: 15px;
  font-weight: 700;
  color: #1a2233;
}
.sub {
  font-size: 12px;
  color: #9aa5b5;
}
.ghost {
  padding: 6px 14px;
  font-family: inherit;
  font-size: 13px;
  color: #4a5568;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 9px;
  cursor: pointer;
  transition: all 0.2s;
}
.ghost:hover:not(:disabled) {
  color: #2f6bff;
  border-color: #c9d6ff;
}
.ghost:disabled {
  color: #c4c8d0;
  cursor: not-allowed;
}
/* 图标按钮：正方的，不要被文字按钮的 padding 撑长 */
.ghost.icon {
  padding: 6px 9px;
  font-size: 14px;
  line-height: 1;
}

/* ---------- 消息区 ---------- */
.chat-body {
  flex: 1;
  min-height: 0;
  padding: 20px 0 4px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.conv-loading {
  margin: 0 0 16px;
  font-size: 12px;
  color: #9aa5b5;
  text-align: center;
}

/* ---------- 空状态 ---------- */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding-bottom: 40px;
  text-align: center;
}
.big-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin-bottom: 18px;
  font-size: 28px;
  color: #fff;
  background: #2f6bff;
  border-radius: 50%;
  box-shadow: 0 8px 24px rgba(47, 107, 255, 0.25);
}
.title {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 800;
  color: #1f2937;
}
.tip {
  max-width: 460px;
  margin: 0 0 22px;
  font-size: 14px;
  line-height: 1.7;
  color: #6b7280;
}
.samples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  max-width: 600px;
}
.sample {
  padding: 9px 16px;
  font-family: inherit;
  font-size: 13px;
  color: #1f2937;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.2s;
}
.sample:hover:not(:disabled) {
  color: #1e50d8;
  background: #eef3ff;
  border-color: #2f6bff;
}
.sample:disabled {
  color: #c4c8d0;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .ask {
    padding: 0 12px;
  }
  .title {
    font-size: 19px;
  }
  .sub {
    display: none;
  }
}
</style>
