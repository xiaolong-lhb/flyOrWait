<template>
  <!-- 答案①：哪天出发最便宜（横向 · 仅「日期不固定」时出现）
       【API】由后端 api/_compose.js::buildDateAnswer 从**同一份**日历窗口扫出来，
       不需要额外调用（历史「多一次调用」的旧设计已随 mock 一起退休）。 -->
  <div v-if="answer" class="ans-card ans1">
    <!-- 「扫描 7 天」这种孤立数字没法被核对：±3 天 = 前 3 + 当天 + 后 3 = 7 天，
         用户看到 7 只会怀疑算错。所以把后端算好的实际区间一并显示出来
         （scopeText 由 buildDateAnswer 与 scannedDays 同一次计算产出，有前者必有后者）。 -->
    <div class="ans-head">
      <span class="snap">扫描 {{ answer.scopeText }}（{{ answer.scannedDays }} 天）</span>
    </div>
    <div class="verdict">
      <span class="vt">最优出发日 {{ answer.bestDate }}</span>
      <span class="vsub"> ¥{{ answer.bestPrice.toLocaleString() }} · {{ answer.savedText }} </span>
    </div>
    <div class="ans-note">
      {{ answer.historyText }} —— 这一天「便宜」只说明日期划算；今天要不要下手，看下面的购买建议。
    </div>
  </div>
</template>

<script setup>
defineProps({
  /** 后端算出的「最优出发日」；null = 用户已指定具体日期，本卡不出现 */
  answer: { type: Object, default: null },
});
</script>

<style scoped>
/* 与答案②共用的原子（.ans-card/.verdict/.vt/.vsub/.ans-note）各留一份：
   scoped 样式不跨组件，改成全局会污染其他页面。 */
.ans-card {
  padding: 16px 18px;
  margin-bottom: 14px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
}
.ans-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.ans-head .snap {
  margin-left: auto;
  font-size: 12px;
  color: #6b7280;
}
.verdict {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}
.verdict .vt {
  font-size: 19px;
  font-weight: 800;
  color: #1f2937;
}
.verdict .vsub {
  font-size: 13.5px;
  color: #4a5568;
  line-height: 1.6;
}
.verdict .vsub b {
  color: #dc2626;
}
.ans-note {
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  color: #4c3a99;
  background: #f1ecff;
  border-radius: 10px;
}

/* 答案①：紫色系 */
.ans1 {
  border-color: #d9ccff;
  background: #fbfaff;
}
</style>
