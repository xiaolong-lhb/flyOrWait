<template>
  <!-- 答案②：购买时机（纵向 · 主角）
       【API】由后端 api/_compose.js 从真实报价算出来（档位 / 百分位 / 典型区间 / 阈值）。
       本轮**不接 AI**：文案是后端按数字拼的，卡片里每个数字都能在下方日历 / 航班列表里找到出处。
       ⚠️ answer 为 null（样本不足 / 这天缺报价）时**如实说判断不了**，绝不硬给一个档位。
          给一个编出来的结论，比说「不知道」更糟。 -->
  <div v-if="answer" class="ans-card ans2" :class="`lv-${answer.level}`">
    <div class="verdict">
      <span class="vt">{{ answer.verdictLabel }}</span>
      <span class="vsub">
        当前最低价 <b>¥{{ answer.currentPrice.toLocaleString() }}</b
        >，在{{ answer.basisLabel }}的报价中排第 {{ answer.positionPct }} 百分位（{{
          answer.levelLabel
        }}），{{ answer.vsTypicalText }}
      </span>
    </div>

    <!-- 「再等等」的三件套：触发条件 + 决策期限 + 数据依据，缺一条就不许出「再等等」-->
    <div class="triple">
      <div class="triple-t">{{ watchTitle }}</div>
      <div class="tri">
        <span class="tri-k">等到什么条件</span>
        <span class="tri-v">{{ answer.action.condition }}</span>
      </div>
      <div class="tri">
        <span class="tri-k">等到什么时候为止</span>
        <span class="tri-v">{{ answer.action.deadlineText }}</span>
      </div>
      <div class="tri">
        <span class="tri-k">凭什么这么说</span>
        <span class="tri-v">{{ answer.action.basisText }}</span>
      </div>
    </div>

    <div class="why">
      <div class="why-t">我是怎么判断的</div>
      <ul>
        <li v-for="(line, i) in answer.reasoning" :key="i">{{ line }}</li>
      </ul>
    </div>

    <div v-if="hints.length" class="ext">
      <div class="ext-t">延展建议</div>
      <p v-for="h in hints" :key="h.type">{{ h.text }}</p>
    </div>
  </div>

  <!-- 判不了的时候：占同一个位置，说清「为什么给不了」，并把出路给出来 -->
  <div v-else class="ans-card ans2 no-verdict">
    <div class="verdict">
      <span class="vt">这次给不了「该不该买」的建议</span>
      <span class="vsub">{{ fallbackText }}</span>
    </div>
    <div class="ans-note">
      宁可告诉你「还没法判断」，也不编一个档位出来。下面的价格日历和航班列表仍然是真实报价。
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** 后端算出的「购买时机」；null = 判断不了，走占位卡 */
  answer: { type: Object, default: null },
  /** 后端给的延展建议（可能为空数组） */
  hints: { type: Array, default: () => [] },
  /** 判断不了时后端写的「为什么给不了」（notices.judgement），原样转达 */
  fallbackText: { type: String, default: '' },
});

/** 「怎么等」的标题：结论是「等」时是三件套；结论是「买」时是兜底方案 */
const watchTitle = computed(() =>
  props.answer?.verdict === 'wait' ? '怎么等（三件套，缺一不可）' : '如果你还想再等等',
);
</script>

<style scoped>
/* 与答案①共用的原子（.ans-card/.verdict/.vt/.vsub/.ans-note）各留一份：
   scoped 样式不跨组件，改成全局会污染其他页面。 */
.ans-card {
  padding: 16px 18px;
  margin-bottom: 14px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
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

/* 答案②：按档位换色（低=绿 正常=蓝 高=橙） */
.ans2.lv-low {
  border-color: #b7e4c7;
  background: linear-gradient(180deg, #fff, #f7fdf9);
}
.ans2.lv-low .vt {
  color: #16a34a;
}
.ans2.lv-typical {
  border-color: #c9d6ff;
  background: linear-gradient(180deg, #fff, #fbfcff);
}
.ans2.lv-typical .vt {
  color: #1e50d8;
}
.ans2.lv-high {
  border-color: #f3d89a;
  background: linear-gradient(180deg, #fff, #fffbf3);
}
.ans2.lv-high .vt {
  color: #b7791f;
}

/* 三件套 */
.triple {
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #f5f7fa;
  border-radius: 12px;
}
.triple-t {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 700;
  color: #6b7280;
}
.tri {
  display: flex;
  gap: 10px;
  margin-bottom: 6px;
  font-size: 13.5px;
  line-height: 1.6;
}
.tri:last-child {
  margin-bottom: 0;
}
.tri-k {
  flex: 0 0 108px;
  color: #6b7280;
}
.tri-v {
  flex: 1;
  color: #1f2937;
  font-weight: 600;
}

/* 推理链 */
.why {
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #fafbfc;
  border: 1px solid #eef0f3;
  border-radius: 12px;
}
.why-t {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
}
.why ul {
  margin: 0;
  padding-left: 18px;
}
.why li {
  margin-bottom: 4px;
  font-size: 13.5px;
  line-height: 1.7;
  color: #374151;
}

/* 延展建议 */
.ext {
  padding: 12px 14px;
  background: #fff9f0;
  border: 1px solid #f3e2c0;
  border-radius: 12px;
}
.ext-t {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 700;
  color: #b7791f;
}
.ext p {
  margin: 0 0 6px;
  font-size: 13.5px;
  line-height: 1.7;
  color: #374151;
}
.ext p:last-child {
  margin-bottom: 0;
}

/* 判断不了时的占位卡（占同位置，不给出编造的档位） */
.ans2.no-verdict {
  border-color: #e5e7eb;
  background: #fafbfc;
}
.ans2.no-verdict .vt {
  color: #6b7280;
}
.ans2.no-verdict .ans-note {
  color: #4a5568;
  background: #f1f3f6;
}

@media (max-width: 640px) {
  .tri-k {
    flex: 0 0 92px;
    font-size: 12.5px;
  }
}
</style>
