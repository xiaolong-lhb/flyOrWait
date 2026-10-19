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
        <el-switch v-model="emailNotify" :loading="saving" @change="saveNotify" />
      </div>

      <!-- 本月查询次数（服务端统计，只读） -->
      <div class="row">
        <div class="lab">
          <b>本月查询次数</b>
          <small>你在本月发起过多少次比价查询（服务端统计）</small>
        </div>
        <div class="count">
          <span class="count-num">{{ queryCount }}</span>
          <span class="count-unit">次</span>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage } from 'element-plus';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();

/** 邮箱 / 开关 / 次数 都直接读 store，页面只负责展示与触发保存 */
const { emailNotify, queryCount, saving } = storeToRefs(settings);

/**
 * 邮箱草稿：回车或移开焦点即存
 * 成功不弹提示（输入框本身就是反馈），只有格式错误才打断
 */
const email = ref(settings.email);

/** 后端拉回来的邮箱到了就填进草稿（用户已经在敲的话不覆盖） */
function syncDraft() {
  if (!email.value) email.value = settings.email;
}

async function saveEmail() {
  const v = email.value.trim();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    ElMessage.warning('邮箱格式不正确');
    return;
  }
  if (v === settings.email) return; // 没改就别白跑一趟后端
  const ok = await settings.saveSettings({ email: v });
  if (!ok) ElMessage.error(settings.error || '保存失败');
}

/** 开关拨动即存（拨动本身有视觉变化，不弹成功提示；失败才提示） */
async function saveNotify() {
  const ok = await settings.saveSettings({ notifyEnabled: emailNotify.value });
  if (!ok) ElMessage.error(settings.error || '保存失败');
}

/**
 * 进页面拉一次后端配置，拉回来把邮箱回填进草稿。
 */
onMounted(async () => {
  const ok = await settings.fetchSettings();
  if (!ok) {
    ElMessage.error(settings.error || '读取设置失败');
  }
  syncDraft();
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

/* ---------- 本月查询次数 ---------- */
.count {
  display: flex;
  align-items: baseline;
  gap: 4px;
  width: 220px;
  flex: none;
  justify-content: flex-end;
}
.count-num {
  font-size: 22px;
  font-weight: 800;
  color: #2f6bff;
  line-height: 1;
}
.count-unit {
  font-size: 12.5px;
  color: #9ca3af;
}
</style>
