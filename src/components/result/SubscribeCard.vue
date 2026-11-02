<template>
  <!-- 订阅卡片：盯价航班 / 阈值 / 决策截止日 / 邮箱
       ⚠️ 受控组件：本组件**不持有任何表单状态**，四个值全部来自 props，改动一律 emit 回父页。
          理由：那条「选中航班 → 阈值自动跟着变」的联动只能有一处逻辑。
          如果组件自己存一份，父页再存一份，两边迟早不同步，
          表现是「点了订阅、用了旧阈值」——这类 bug 不报错、只在特定操作顺序下出现。 -->
  <div class="sub-card">
    <div class="sec-t sub-title">订阅这条航线</div>

    <div class="field">
      <label>盯价航班</label>
      <div v-if="pickedFlight" class="val">
        <b>{{ pickedFlight.airline }}</b> {{ pickedFlight.departTime }} ·
        {{ pickedFlight.stopText }} · ¥{{ pickedFlight.price.toLocaleString() }}
      </div>
      <div v-else class="val muted">
        未指定，以全列表最低价 ¥{{ lowestPrice.toLocaleString() }} 为基准
      </div>
      <div class="hint">在上方航班列表点「盯价」可指定；改选其他航班时阈值会同步更新</div>
    </div>

    <div class="field">
      <label>降价提醒阈值</label>
      <div class="val">
        ¥<input v-model.number="thresholdModel" class="plain-input" type="number" min="0" step="10" />
      </div>
      <div class="hint">
        低于此价发邮件通知（默认取「典型区间下沿」与「当前价 × 0.95」中更低者，可手动改）
      </div>
    </div>

    <div class="field">
      <label>决策截止日</label>
      <div class="val val-row">
        <el-date-picker
          v-model="deadlineModel"
          type="date"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          :clearable="false"
          :disabled-date="disableDeadline"
          class="deadline-picker"
        />
        <span v-if="isRecommendedDeadline" class="rec">推荐</span>
      </div>
      <div class="hint">到这天还没跌到阈值，我们会提醒你直接下单（系统推荐：起飞前 21 天）</div>
    </div>

    <div class="field">
      <label>通知邮箱</label>
      <div class="val val-row">
        <input
          v-model.trim="emailModel"
          class="plain-input wide"
          type="email"
          placeholder="请输入邮箱"
        />
        <a class="link-set" @click="$emit('go-settings')">去设置</a>
      </div>
      <div class="hint">降价时邮件提醒，不填写邮箱则默认按照设置的邮箱发送</div>
    </div>

    <!-- 线上写入要跑一趟服务器（POST + 重拉列表），比本地慢，必须让「正在提交」看得见，
         否则用户会以为按钮没反应而连点 ⇒ 连点会真的发出第二次请求。
         防连点有两道：这里 :disabled 是第一道，父页 handleSubscribe 入口再判一次是第二道。 -->
    <button class="btn" :disabled="submitting" @click="$emit('submit')">
      <span v-if="submitting" class="btn-spin" aria-hidden="true"></span>
      {{ submitting ? '正在开启监控…' : '订阅监控' }}
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** 用户点「盯价」选中的航班；null = 未指定，以全列表最低价为基准 */
  pickedFlight: { type: Object, default: null },
  /** 全列表最低价，未指定航班时用它说明「以什么为基准」 */
  lowestPrice: { type: Number, default: 0 },
  /** 降价提醒阈值（v-model:threshold） */
  threshold: { type: [Number, String], default: 0 },
  /** 决策截止日 YYYY-MM-DD（v-model:deadline） */
  deadline: { type: String, default: '' },
  /** 通知邮箱（v-model:email） */
  email: { type: String, default: '' },
  /** 系统推荐的截止日，用来判断要不要显示「推荐」标 */
  recommendedDeadline: { type: String, default: '' },
  /** 日期禁用规则由父页提供：涉及「今天」与出发日，属于日期业务逻辑，不该在组件里再算一遍 */
  disableDeadline: { type: Function, default: () => false },
  /** 正在提交：只关按钮，不让整页转圈 */
  submitting: { type: Boolean, default: false },
});

const emit = defineEmits(['update:threshold', 'update:deadline', 'update:email', 'submit', 'go-settings']);

/* 三个受控输入：读 props、写 emit。用 computed 是为了让模板里的 v-model 保持和原生输入一样好读，
   而且 v-model.number / v-model.trim 这两个修饰符仍然生效（编译后是「先转换、再赋值」）。 */
const thresholdModel = computed({
  get: () => props.threshold,
  set: (v) => emit('update:threshold', v),
});
const deadlineModel = computed({
  get: () => props.deadline,
  set: (v) => emit('update:deadline', v),
});
const emailModel = computed({
  get: () => props.email,
  set: (v) => emit('update:email', v),
});

/** 「推荐」标：初值由父页按推荐值填好，用户改过就不再相等，标签自动消失 */
const isRecommendedDeadline = computed(() => props.deadline === props.recommendedDeadline);
</script>

<style scoped>
/* .sec-t / .btn / .link-set / @keyframes spin 是跨组件共用的原子，
   每个组件各留一份 —— scoped 样式不跨组件，改成全局会污染其他页面。 */
.sec-t {
  margin: 18px 0 10px;
  font-size: 15px;
  font-weight: 700;
  color: #1f2937;
}

.sub-card {
  padding: 18px;
  margin-top: 20px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  box-shadow: 0 6px 24px rgba(17, 24, 39, 0.06);
}
.sub-title {
  margin-top: 0;
}
.sub-card .field {
  padding: 10px 14px;
  margin-bottom: 10px;
  background: #f5f7fa;
  border: 1px solid #eef0f3;
  border-radius: 12px;
}
.sub-card .field label {
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
  color: #6b7280;
}
.sub-card .field .val {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}
.sub-card .field .val.muted {
  font-weight: 400;
  color: #9ca3af;
}
.sub-card .field .hint {
  margin-top: 4px;
  font-size: 12px;
  color: #9ca3af;
}
.plain-input {
  width: 96px;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
  background: transparent;
  border: 0;
  border-bottom: 1px dashed #c9d6ff;
  outline: none;
}
.plain-input.wide {
  width: 260px;
}

/* 决策截止日：可改的日期选择器 + 绿字「推荐」标 */
.sub-card .field .val-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sub-card .deadline-picker {
  width: 168px;
}
.sub-card .field :deep(.el-input__wrapper) {
  padding: 0;
  background: transparent;
  box-shadow: none;
  border-bottom: 1px dashed #c9d6ff;
}
.sub-card .field :deep(.el-input__inner) {
  height: 26px;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}
.rec {
  padding: 2px 8px;
  font-size: 12px;
  color: #16a34a;
  background: #e9f8ef;
  border-radius: 999px;
  white-space: nowrap;
}

/* 「去设置」链接 */
.link-set {
  font-size: 13px;
  color: #2f6bff;
  white-space: nowrap;
  cursor: pointer;
}
.link-set:hover {
  text-decoration: underline;
}

.btn {
  width: 100%;
  padding: 14px;
  margin-top: 4px;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  background: #2f6bff;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.2s;
}
.btn:hover:not(:disabled) {
  background: #1e50d8;
}
/* 提交中：颜色压淡 + 禁手，配合按钮上的转圈表达「已经点上了，正在等服务器」 */
.btn:disabled {
  background: #9db6ff;
  cursor: progress;
}
/* 按钮内的小转圈：与整页等待态共用同一套 spin 动画，只是尺寸与配色反白 */
.btn-spin {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  vertical-align: -2px;
  border: 2px solid rgb(255 255 255 / 45%);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .plain-input.wide {
    width: 180px;
  }
}
</style>
