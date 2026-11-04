<template>
  <!-- 用户：右对齐，纯文本，不解析 markdown（用户输什么就显示什么） -->
  <div v-if="role === 'user'" class="row user">
    <div class="bubble user-bubble">{{ text }}</div>
  </div>

  <!-- 助手：左对齐，带头像 -->
  <div v-else class="row bot">
    <div class="avatar" aria-hidden="true">✈</div>

    <div class="bubble bot-bubble">
      <!-- ① 等待中：3 个点 + 真实秒数。不编造「正在调用日历」——前端不知道后端在干什么 -->
      <div v-if="state === 'loading'" class="waiting">
        <span class="dots"><i></i><i></i><i></i></span>
        <span class="wait-text">正在查实时票价，已等 {{ elapsed }} 秒</span>
      </div>

      <!-- ② 失败：文案来自后端，前端一个字不翻译；能不能重试由父组件判断 -->
      <div v-else-if="state === 'error'" class="failed">
        <p class="failed-msg">{{ error || '这次没能拿到回答' }}</p>
        <button v-if="retryable" class="retry" type="button" @click="emit('retry')">重试</button>
      </div>

      <!-- ③ 成功：按块渲染。见 src/utils/markdown.js 为什么不用 v-html -->
      <template v-else>
        <template v-for="(blk, i) in blocks" :key="i">
          <p v-if="blk.type === 'p'" class="blk-p">
            <span v-for="(r, j) in blk.runs" :key="j" :class="{ b: r.bold }">{{ r.text }}</span>
          </p>

          <ul v-else-if="blk.type === 'ul'" class="blk-list">
            <li v-for="(item, j) in blk.items" :key="j">
              <span v-for="(r, k) in item" :key="k" :class="{ b: r.bold }">{{ r.text }}</span>
            </li>
          </ul>

          <ol v-else-if="blk.type === 'ol'" class="blk-list">
            <li v-for="(item, j) in blk.items" :key="j">
              <span v-for="(r, k) in item" :key="k" :class="{ b: r.bold }">{{ r.text }}</span>
            </li>
          </ol>

          <pre v-else-if="blk.type === 'code'" class="blk-code">{{ blk.text }}</pre>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
defineProps({
  /** user | assistant */
  role: { type: String, default: 'assistant' },
  /** 用户消息的纯文本 */
  text: { type: String, default: '' },
  /** 助手消息的块数组（toBlocks 的产物） */
  blocks: { type: Array, default: () => [] },
  /** loading | ok | error */
  state: { type: String, default: 'ok' },
  /** 失败文案，后端原话 */
  error: { type: String, default: '' },
  /** 已等待秒数，仅 loading 态用 */
  elapsed: { type: Number, default: 0 },
  /** 是否给重试按钮：5000/5030 这类重试无意义的错误应为 false */
  retryable: { type: Boolean, default: false },
});

const emit = defineEmits(['retry']);
</script>

<style scoped>
.row {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}
.row.user {
  justify-content: flex-end;
}
.row.bot {
  align-items: flex-start;
}

.avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 15px;
  color: #fff;
  background: #2f6bff;
  border-radius: 50%;
}

.bubble {
  max-width: 78%;
  padding: 11px 15px;
  font-size: 14.5px;
  line-height: 1.68;
  border-radius: 14px;
}
.user-bubble {
  color: #fff;
  background: #2f6bff;
  border-top-right-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bot-bubble {
  color: #1f2937;
  background: #fff;
  border: 1px solid #e8ecf2;
  border-top-left-radius: 4px;
}

/* ---------- 块 ---------- */
.blk-p {
  margin: 0 0 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.blk-p:last-child {
  margin-bottom: 0;
}
.b {
  font-weight: 700;
}

.blk-list {
  margin: 0 0 10px;
  padding-left: 20px;
}
.blk-list:last-child {
  margin-bottom: 0;
}
.blk-list li {
  margin: 3px 0;
  word-break: break-word;
}

.blk-code {
  margin: 0 0 10px;
  padding: 10px 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  background: #f5f7fa;
  border-radius: 8px;
  overflow-x: auto;
}

/* ---------- 等待 ---------- */
.waiting {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dots {
  display: inline-flex;
  gap: 4px;
}
.dots i {
  width: 6px;
  height: 6px;
  background: #9aa5b5;
  border-radius: 50%;
  animation: fade 1.3s infinite;
}
.dots i:nth-child(2) {
  animation-delay: 0.18s;
}
.dots i:nth-child(3) {
  animation-delay: 0.36s;
}
@keyframes fade {
  0%,
  60%,
  100% {
    opacity: 0.25;
  }
  30% {
    opacity: 1;
  }
}
.wait-text {
  font-size: 13px;
  color: #9aa5b5;
}

/* ---------- 失败 ---------- */
.failed-msg {
  margin: 0;
  color: #b42318;
}
.retry {
  margin-top: 8px;
  padding: 5px 14px;
  font-size: 13px;
  color: #2f6bff;
  background: #eef3ff;
  border: 1px solid #c9d6ff;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.retry:hover {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
}

@media (prefers-reduced-motion: reduce) {
  .dots i {
    animation: none;
    opacity: 0.6;
  }
}

@media (max-width: 640px) {
  .bubble {
    max-width: 84%;
  }
  .avatar {
    width: 28px;
    height: 28px;
    font-size: 13px;
  }
}
</style>
