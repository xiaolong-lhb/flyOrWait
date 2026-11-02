<template>
  <!-- 价格日历：弱化 + 可展开，作为「哪天出发最便宜」的原数据佐证
       【API】真实实现：Apify 的 Google Flights 价格日历（见后端 api/_apify.js）
       ⚠️ 颜色按后端给的 level 上色（low / typical / high），**不按 min~max 自己划三档** ——
          level 与「该不该买」是同一套分位算出来的，两处口径才不会打架。 -->
  <details class="cal-fold">
    <summary>
      📅 展开看 {{ monthLabel }} 价格趋势（{{ dayCount }} 天有报价，越绿越便宜）
    </summary>
    <div class="cal">
      <div v-for="d in WEEK_DAYS" :key="d" class="d">{{ d }}</div>
      <div v-for="n in calendarOffset" :key="`pad-${n}`" class="pad"></div>
      <!-- ⚠️ price 为 null = 这天没有报价（窗口够不到，或数据源缺日）。
           这类格子只显示灰色「—」：既不能显示 ¥0.00k 这种凭空冒出来的数字，
           也不能用白字（中性灰底 + 白字等于看不见），所以文字色要单独降下来。 -->
      <div
        v-for="c in calendar"
        :key="c.date"
        class="c"
        :class="{ sel: c.isSelected }"
        :style="{
          background: priceColor(c.level),
          color: c.price === null ? '#6b7280' : undefined,
        }"
      >
        {{ c.day }}<small>{{ cellPrice(c) }}</small>
      </div>
    </div>
    <div class="legend">
      <span><i style="background: #86efac"></i>便宜</span>
      <span><i style="background: #fdba74"></i>适中</span>
      <span><i style="background: #fca5a5"></i>偏贵</span>
      <span><i style="background: #e5e7eb"></i>这天没报价</span>
      <span class="legend-tip">蓝框＝你选的日期</span>
    </div>
  </details>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** 后端给的整月日历格（price 可能为 null，表示这天没报价） */
  calendar: { type: Array, default: () => [] },
  /** 月份标签，形如 '2026-11'；用它算 1 号前面该补几个空格 */
  monthLabel: { type: String, default: '' },
  /** 有报价的天数（不是格子总数） */
  dayCount: { type: Number, default: 0 },
});

const WEEK_DAYS = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 1 号前面要补几个空格。
 * ⚠️ 必须补齐整月（1 号占在正确的星期位）否则整月错位一天。
 * getDay() 里周日是 0，这里换成一=0 的排法：(getDay() + 6) % 7。
 */
const calendarOffset = computed(() => {
  if (!props.monthLabel) return 0;
  const [y, m] = props.monthLabel.split('-').map(Number);
  return (new Date(y, m - 1, 1).getDay() + 6) % 7;
});

/**
 * 档位 → 颜色。档位由**后端**给出（与「该不该买」同一套分位算出来的），
 * 前端不再按 min~max 自己划三档 —— 两套算法必然在某个价格点上给出相反的答案，
 * 那就会出现「结论说便宜、日历格却是橙色」这种自相矛盾的画面。
 * level 为 null（样本不足，后端拒绝编造档位）→ 中性灰，明确表示「这天没有档位」。
 */
const LEVEL_COLOR = { low: '#86efac', typical: '#fdba74', high: '#fca5a5' };
function priceColor(level) {
  return LEVEL_COLOR[level] ?? '#e5e7eb';
}

/**
 * 日历格里的价格文案。
 * ⚠️ price 为 null（这天没有报价）时必须输出「—」——直接写 `c.price / 1000` 会得到
 *    `¥0.00k`，那是**凭空冒出来的数字**，违反「不编造」这条红线。
 */
function cellPrice(c) {
  return c.price === null ? '—' : `¥${(c.price / 1000).toFixed(2)}k`;
}
</script>

<style scoped>
.cal-fold {
  padding: 10px 14px;
  margin: 16px 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
}
.cal-fold summary {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  cursor: pointer;
}
.cal {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  max-width: 560px;
  margin-top: 12px;
}
.cal .d {
  padding-bottom: 2px;
  font-size: 11px;
  color: #9ca3af;
  text-align: center;
}
.cal .c {
  padding: 8px 4px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  text-align: center;
  border-radius: 8px;
}
.cal .c small {
  display: block;
  font-size: 10px;
  font-weight: 400;
  opacity: 0.9;
}
.cal .c.sel {
  outline: 3px solid #2f6bff;
  outline-offset: 1px;
}
.legend {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 10px;
  font-size: 12px;
  color: #6b7280;
}
.legend i {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 5px;
  vertical-align: -1px;
  border-radius: 3px;
}
.legend .legend-tip {
  margin-left: auto;
  color: #2f6bff;
}
</style>
