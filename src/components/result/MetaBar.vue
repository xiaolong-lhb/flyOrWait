<template>
  <!-- 数据快照时间：任何「此刻这个价」的判断都会过期，如实说出来 -->
  <div class="fresh">数据快照 {{ snapshotAt }} · 票价实时变动，这份结论会过期</div>

  <!-- 后端说清了「哪块缺了什么」——原样转达，不要留个空白让用户猜 -->
  <div v-if="list.length" class="notices">
    <p v-for="(n, i) in list" :key="i">· {{ n }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** 这次查询的数据快照时间（后端给，前端不自己取当前时间） */
  snapshotAt: { type: String, default: '' },
  /** 后端原样给的通知对象：{ 某块: '缺了什么' } */
  notices: { type: Object, default: () => ({}) },
});

/**
 * 把后端的 notices 摊平成一段段文字，原样转达。
 * judgement 单独排除：那一条由答案②卡片自己说（判断不了时的占位卡），
 * 在这里再列一遍等于同一句话说两遍。
 */
const list = computed(() =>
  Object.entries(props.notices ?? {})
    .filter(([key]) => key !== 'judgement')
    .map(([, text]) => text),
);
</script>

<style scoped>
.fresh {
  margin: 0 0 10px;
  font-size: 12px;
  color: #9ca3af;
  text-align: right;
}

/* 后端如实报出的「哪一块缺了什么」（航班没取到 / 部分方案没给价 / 航班日期与所选不同） */
.notices {
  padding: 10px 14px;
  margin-bottom: 14px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #8a6d1f;
  background: #fffbf0;
  border: 1px solid #f3e2c0;
  border-radius: 10px;
}
.notices p {
  margin: 0;
}
</style>
