<template>
  <div class="ask">
    <header class="chat-head">
      <div class="who">
        <span class="name">机票助手</span>
        <span class="sub">回答依据实时票价参考价</span>
      </div>
      <button class="ghost" type="button" :disabled="sending || !messages.length" @click="handleReset">
        新对话
      </button>
    </header>

    <div ref="scroller" class="chat-body">
      <!-- 空状态：给三四个能直接点的问题，比一句「请输入」有用 -->
      <div v-if="!messages.length" class="empty">
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
        :error="m.error"
        :elapsed="m.elapsed"
        :retryable="m.retryable"
        @retry="store.retry(m.id)"
      />
    </div>

    <ChatComposer :disabled="sending" @submit="handleSubmit" />
  </div>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import ChatComposer from '../../components/chat/ChatComposer.vue';
import MessageBubble from '../../components/chat/MessageBubble.vue';
import { useAgentStore } from '../../stores/agent.js';

const store = useAgentStore();
const { messages, sending } = storeToRefs(store);

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

/** 滚到底：新增消息、以及回答落地时都该把视线带过去 */
function scrollToBottom() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

watch(
  () => messages.value.length,
  () => nextTick(scrollToBottom),
);
watch(sending, (v) => {
  if (!v) nextTick(scrollToBottom);
});

function handleSubmit(text) {
  store.ask(text);
}

function pickSample(text) {
  store.ask(text);
}

function handleReset() {
  store.reset();
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

/* ---------- 消息区 ---------- */
.chat-body {
  flex: 1;
  min-height: 0;
  padding: 20px 0 4px;
  overflow-y: auto;
  scrollbar-gutter: stable;
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
