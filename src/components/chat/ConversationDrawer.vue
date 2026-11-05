<template>
  <el-drawer v-model="visible" class="conv-drawer" direction="ltr" size="320px" :with-header="false">
    <div class="drawer">
      <div class="drawer-head">
        <span class="drawer-title">历史对话</span>
        <button class="new-btn" type="button" :disabled="disabled" @click="$emit('create')">
          ＋ 新对话
        </button>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="!conversations.length" class="hint">还没有对话记录</p>

      <ul v-else class="conv-list">
        <li v-for="c in conversations" :key="c.id" class="conv-item">
          <button
            class="conv"
            type="button"
            :class="{ on: c.id === activeId }"
            :disabled="disabled"
            @click="$emit('select', c.id)"
          >
            <span class="conv-title">{{ c.title }}</span>
            <span class="conv-time">{{ formatTime(c.updatedAt) }}</span>
          </button>
          <button
            class="del"
            type="button"
            title="删除这段对话"
            :disabled="disabled"
            @click.stop="$emit('remove', c.id)"
          >
            ×
          </button>
        </li>
      </ul>
    </div>
  </el-drawer>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  conversations: { type: Array, default: () => [] },
  activeId: { type: String, default: null },
  /** 发送中 / 正在切换会话时为真：此时不允许再切、再删、再新建 */
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue', 'create', 'select', 'remove']);

/** el-drawer 要 v-model，但外面用的是 modelValue —— 用可写计算属性转一道 */
const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

/**
 * 列表里的时间。
 * 今天的显示时刻（12:40），今年的显示月日（11-03），更早的带年份。
 * 用本地字段拼，不走 toISOString —— 那是 UTC，中国人的「今天」会错一天。
 */
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
</script>

<style scoped>
.drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 18px 12px;
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 14px;
  border-bottom: 1px solid #eef1f5;
}
.drawer-title {
  font-size: 14px;
  font-weight: 700;
  color: #1a2233;
}
.new-btn {
  padding: 5px 12px;
  font-family: inherit;
  font-size: 12px;
  color: #2f6bff;
  background: #eef3ff;
  border: 1px solid #d7e2ff;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.new-btn:hover:not(:disabled) {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
}
.new-btn:disabled {
  color: #c4c8d0;
  background: #f5f7fa;
  border-color: #e5e7eb;
  cursor: not-allowed;
}

.hint {
  margin: 28px 0 0;
  font-size: 13px;
  color: #9aa5b5;
  text-align: center;
}

.conv-list {
  flex: 1;
  min-height: 0;
  margin: 10px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

/* 每项是「会话按钮 + 绝对定位的删除按钮」 */
.conv-item {
  position: relative;
}
.conv {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 30px 9px 12px;
  font-family: inherit;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.15s;
}
.conv:hover:not(:disabled) {
  background: #f3f6fc;
}
.conv.on {
  background: #eef3ff;
}
.conv:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.conv-title {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  color: #1f2937;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv.on .conv-title {
  color: #2f6bff;
  font-weight: 600;
}
.conv-time {
  font-size: 11px;
  color: #9aa5b5;
}

/* 删除按钮：平时藏着，hover / 键盘聚焦时出现 —— 列表里常驻一排 × 太吵 */
.del {
  position: absolute;
  top: 50%;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: #9aa5b5;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transform: translateY(-50%);
  transition: all 0.15s;
}
.conv-item:hover .del,
.del:focus-visible {
  opacity: 1;
}
.del:hover:not(:disabled) {
  color: #e5484d;
  background: #fdecec;
}
.del:disabled {
  cursor: not-allowed;
}
</style>

<style>
/* 抽屉被 teleport 到 body 下，scoped 的选择器够不着它的内层容器。
 * 这里只写两条、且都用 .conv-drawer 限定 —— 不会碰到别的页面。 */
.conv-drawer .el-drawer__body {
  padding: 0 8px;
}
</style>
