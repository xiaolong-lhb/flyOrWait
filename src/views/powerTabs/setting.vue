<template>
  <div class="setting">
    <h2 class="title">设置</h2>

    <!-- 首屏是从后端读的：读完之前盖一层 loading，避免先闪一遍默认值（0 次 / 空邮箱） -->
    <div v-loading="loading" element-loading-text="正在读取设置…" class="card">
      <!-- 通知邮箱：默认收信地址（单条订阅的收信地址在「我的订阅」里改） -->
      <div class="row">
        <div class="lab">
          <b>通知邮箱</b>
          <small>默认收信地址：新建订阅时自动填入；已有订阅可在「我的订阅」里单独改</small>
        </div>
        <!--
          重置按钮放在输入框右侧（append 槽），把草稿退回「库里已保存的那份」。
          @mousedown.prevent 是必须的：点按钮会先让输入框失焦 → 触发 @blur 保存，
          于是「重置」会先把想丢掉的内容存进去、再重制成它 —— 等于反向操作。
          原来输入框右侧那个「×」（clearable）已经去掉：它和重置长得像、行为却相反
          （× 是清空并**存进库**，重置是丢掉草稿、库里不动），两个并排放只会误点。
        -->
        <div class="mail-wrap">
          <el-input
            v-model.trim="email"
            class="mail"
            placeholder="you@example.com"
            @blur="saveEmail"
            @keyup.enter="saveEmail"
          >
            <template #append>
              <el-button
                :disabled="email === settings.email"
                title="放弃当前输入，恢复为已保存的邮箱"
                @mousedown.prevent
                @click="resetEmail"
              >
                重置
              </el-button>
            </template>
          </el-input>
          <!--
            一行状态字（不是弹窗）：自动保存最大的毛病是「存没存上，界面看不出来」。
            用常驻的一行小字补上这个反馈，就不必为了「确认存上了」再加编辑/保存/取消三个按钮。
          -->
          <p class="mail-hint" :class="mailHint.tone">{{ mailHint.text }}</p>
        </div>
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
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage } from 'element-plus';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();

/** 邮箱 / 开关 / 次数 都直接读 store，页面只负责展示与触发保存 */
const { emailNotify, queryCount, saving } = storeToRefs(settings);

/** 首屏读取中（读完才撤掉遮罩，见 onMounted） */
const loading = ref(true);

/** 邮箱单独一个「保存中」标记：store 那个 saving 是开关和邮箱共用的，
 *  直接拿它会让「拨开关」时邮箱下面也闪一句「保存中…」 */
const savingEmail = ref(false);

/**
 * 邮箱草稿：回车或移开焦点即存
 * 成功不弹提示（输入框本身就是反馈），只有格式错误才打断
 */
const email = ref(settings.email);

/** 后端拉回来的邮箱到了就填进草稿（用户已经在敲的话不覆盖） */
function syncDraft() {
  if (!email.value) email.value = settings.email;
}

/** 邮箱格式：校验与「状态字」共用一个正则，免得两处各写一份、日后改漏一处 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function saveEmail() {
  const v = email.value.trim();
  if (v && !EMAIL_RE.test(v)) {
    ElMessage.warning('邮箱格式不正确');
    return;
  }
  if (v === settings.email) return; // 没改就别白跑一趟后端

  savingEmail.value = true;
  const ok = await settings.saveSettings({ email: v });
  savingEmail.value = false;
  if (!ok) ElMessage.error(settings.error || '保存失败');
}

/**
 * 重置：只把草稿退回库里已保存的值，**不发请求**。
 * 什么都不用提示 —— 输入框内容变了本身就是反馈。
 */
function resetEmail() {
  email.value = settings.email;
}

/**
 * 输入框下面那行状态字 —— 自动保存最大的毛病是「存没存上，界面看不出来」，
 * 这一行就是补这个反馈的。所以**不加编辑/保存/取消三个按钮**：
 * 那等于为了一处「确认」引入一整套模式（编辑态、草稿、取消回滚），
 * 而这一行字 + 一个「重置」，已经把「我改错了想反悔」和「到底存上没」都答了。
 * （真到了要改多个字段的时候再上编辑态，那时才是划算的 —— 见「我的订阅」的做法。）
 */
const mailHint = computed(() => {
  const v = email.value.trim();
  if (loading.value) return { text: '', tone: '' };
  if (v && !EMAIL_RE.test(v)) return { text: '邮箱格式不正确，尚未保存', tone: 'bad' };
  if (savingEmail.value) return { text: '保存中…', tone: '' };
  if (v === settings.email) {
    return settings.email ? { text: '已保存', tone: 'ok' } : { text: '', tone: '' };
  }
  return { text: '离开输入框后自动保存', tone: '' };
});

/** 开关拨动即存。这次要明确告诉用户成没成（开关已拨过去，光看界面分不出存没存上） */
async function saveNotify(value) {
  const ok = await settings.saveSettings({ notifyEnabled: value });
  if (ok) {
    ElMessage.success(value ? '邮件通知已开启' : '邮件通知已关闭');
    return;
  }
  // 失败必须把开关拨回去：否则界面显示「已开」而库里是关的，是反向的谎
  emailNotify.value = !value;
  ElMessage.error(settings.error || '保存失败，开关已还原');
}

/**
 * 进页面拉一次后端配置，拉回来把邮箱回填进草稿。
 * 无论成败都要撤掉遮罩 —— 失败时页面得能操作（用户自己填邮箱）。
 */
onMounted(async () => {
  const ok = await settings.fetchSettings();
  syncDraft();
  loading.value = false;
  if (!ok) ElMessage.error(settings.error || '读取设置失败');
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

/* 右侧多了一个「重置」，宽度要留够，否则输入区被挤得太窄 */
.mail-wrap {
  width: 344px;
  flex: none;
}
.mail {
  width: 100%;
}
/* 状态字：常驻一行（min-height 固定），几种状态来回切时行高不跳 */
.mail-hint {
  min-height: 16px;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 16px;
  color: #9ca3af;
  text-align: right;
}
.mail-hint.ok {
  color: #16a34a;
}
.mail-hint.bad {
  color: #d97706;
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
