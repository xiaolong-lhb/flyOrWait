<template>
  <div class="setting">
    <h2 class="title">设置</h2>

    <div class="card">
      <!-- 通知邮箱：默认收信地址（单条订阅的收信地址在「我的订阅」里改） -->
      <div class="row">
        <div class="lab">
          <b>通知邮箱</b>
          <small>默认收信地址：新建订阅时自动填入；已有订阅可在「我的订阅」里单独改</small>
        </div>
        <el-input
          v-model.trim="email"
          class="mail"
          placeholder="you@example.com"
          clearable
          @blur="saveEmail"
          @keyup.enter="saveEmail"
        />
      </div>

      <!-- 邮件通知总开关 -->
      <div class="row">
        <div class="lab">
          <b>邮件通知</b>
          <small>价格跌破阈值时发邮件；关掉后订阅仍在监控，只是不再发信</small>
        </div>
        <el-switch v-model="emailNotify" />
      </div>

      <!-- 本月 API 用量 →【API】接入后改为读服务端统计 -->
      <div class="row">
        <div class="lab">
          <b>本月 API 用量</b>
          <small>免费额度监控，防超额</small>
        </div>
        <div class="usage">
          <div class="usage-top">
            <span class="usage-num" :class="usageLevel">{{ apiUsed }} / {{ apiQuota }}</span>
            <span class="usage-pct">{{ usagePercent }}%</span>
          </div>
          <div class="bar">
            <i :class="usageLevel" :style="{ width: `${usagePercent}%` }"></i>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage } from 'element-plus';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();

/** 邮件开关直接双向绑定 store，拨一下立即生效（无需保存） */
const { emailNotify } = storeToRefs(settings);

/**
 * 邮箱草稿：回车或移开焦点即存
 * 成功不弹提示（输入框本身就是反馈），只有格式错误才打断
 */
const email = ref(settings.email);

function saveEmail() {
  const v = email.value;
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    ElMessage.warning('邮箱格式不正确');
    return;
  }
  // →【API】接入后改为调「保存用户配置」接口
  settings.email = v;
}

/* 用量展示：进度条按 70% / 100% 分三级变色，超限时数字照实显示 */
const usagePercent = computed(() => {
  const p = (settings.apiUsed / settings.apiQuota) * 100;
  return Math.min(100, Math.round(p));
});

const usageLevel = computed(() => {
  const p = settings.apiUsed / settings.apiQuota;
  if (p >= 1) return 'over';
  if (p >= 0.7) return 'warn';
  return 'ok';
});
</script>

<style scoped>
.setting {
  max-width: 820px;
  margin: 0 auto;
  padding: 28px 20px 60px;
}
.title {
  margin: 0 0 16px;
  font-size: 20px;
  font-weight: 800;
  color: #1f2937;
}

/* ---------- 卡片与行 ---------- */
.card {
  padding: 4px 18px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 18px 0;
  border-bottom: 1px solid #f2f4f7;
}
.row:last-child {
  border-bottom: 0;
}
.lab b {
  display: block;
  font-size: 15px;
  font-weight: 700;
  color: #1f2937;
}
.lab small {
  display: block;
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.6;
  color: #9ca3af;
}

.mail {
  width: 300px;
  flex: none;
}

/* ---------- 用量 ---------- */
.usage {
  width: 220px;
  flex: none;
}
.usage-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}
.usage-num {
  font-size: 15px;
  font-weight: 700;
}
.usage-pct {
  font-size: 12px;
  color: #9ca3af;
}
.bar {
  height: 6px;
  overflow: hidden;
  background: #eef0f3;
  border-radius: 999px;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s;
}
/* 三级：正常 / 接近上限 / 已超额 */
.usage-num.ok {
  color: #16a34a;
}
.bar i.ok {
  background: #16a34a;
}
.usage-num.warn {
  color: #b7791f;
}
.bar i.warn {
  background: #b7791f;
}
.usage-num.over {
  color: #dc2626;
}
.bar i.over {
  background: #dc2626;
}
</style>
