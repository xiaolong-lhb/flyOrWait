<template>
  <div class="composer">
    <div class="box" :class="{ dis: disabled }">
      <textarea
        ref="inputRef"
        v-model="text"
        class="area"
        rows="1"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="autoGrow"
        @keydown.enter.exact.prevent="send"
      ></textarea>

      <div class="foot">
        <!--
          字数上限 300 与后端 api/agent.js 的 MAX_QUESTION 对齐。
          这里只是体验：用户写到 285 就提前提醒，而不是等提交后被 400 打回来。
          真正拦得住的是后端那一份 —— 前端这份永远可以被绕过。
        -->
        <span class="count" :class="{ over: text.length > maxLength }">
          {{ text.length }}/{{ maxLength }}
        </span>

        <button class="send" type="button" :disabled="!canSend" @click="send">
          {{ disabled ? '查询中' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({
  /** 等待回答时整体禁用：同一时刻只允许一条在跑，理由见 stores/agent.js */
  disabled: { type: Boolean, default: false },
  maxLength: { type: Number, default: 300 },
  placeholder: { type: String, default: '问点什么，比如：11月下旬从深圳去北京哪天便宜' },
});

const emit = defineEmits(['submit']);

const text = ref('');
const inputRef = ref(null);

const canSend = computed(
  () => !props.disabled && text.value.trim().length > 0 && text.value.length <= props.maxLength,
);

/** 随内容长高，最多 5 行左右就内部滚动，否则输入区会把消息区挤没 */
function autoGrow(e) {
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

function send() {
  if (!canSend.value) return;
  emit('submit', text.value.trim());
  text.value = '';
  // 清空后要一起把高度收回去，否则留下一个空的大框
  const el = inputRef.value;
  if (el) el.style.height = 'auto';
}

/** 回答回来、解除禁用时把焦点还给输入框：用户大概率要接着问下一句 */
watch(
  () => props.disabled,
  (dis) => {
    if (!dis) inputRef.value?.focus();
  },
);
</script>

<style scoped>
.composer {
  padding: 12px 0 20px;
  background: transparent;
}

.box {
  padding: 10px 12px 8px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  box-shadow: 0 4px 18px rgba(17, 24, 39, 0.06);
  transition: border-color 0.2s;
}
.box:focus-within {
  border-color: #c9d6ff;
}
.box.dis {
  background: #fafbfc;
}

.area {
  display: block;
  width: 100%;
  max-height: 132px;
  padding: 2px 2px 4px;
  font-family: inherit;
  font-size: 14.5px;
  line-height: 1.6;
  color: #1f2937;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  overflow-y: auto;
}
.area::placeholder {
  color: #9aa5b5;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.count {
  font-size: 12px;
  color: #b8c0cc;
  font-variant-numeric: tabular-nums;
}
.count.over {
  color: #e24b4a;
}

.send {
  padding: 7px 20px;
  font-size: 13.5px;
  font-weight: 600;
  color: #fff;
  background: #2f6bff;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
}
.send:hover:not(:disabled) {
  background: #2656cc;
}
.send:disabled {
  color: #fff;
  background: #c1d3ff;
  cursor: not-allowed;
}
</style>
