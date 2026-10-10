<template>
  <div class="subs">
    <template v-if="items.length">
      <!-- 邮件总闸关着时提示一次（没订阅就不提这茬，关不关都无所谓） -->
      <div v-if="!emailNotify" class="notice">
        <span>邮件通知已关闭，降价时不会发邮件（订阅仍在正常监控）</span>
        <a class="notice-link" @click="goSetting">去开启</a>
      </div>

      <!-- 监控中的航线（含已暂停，靠右上角 badge 区分） -->
      <div class="sec-t">监控中的航线</div>

      <div v-for="s in items" :key="s.id" class="sub">
        <div class="top">
          <span class="route">{{ airportLabel(s.from) }} → {{ airportLabel(s.to) }}</span>
          <span class="badge" :class="s.status === 'active' ? 'on' : 'pause'">
            {{ s.status === 'active' ? '监控中' : '已暂停' }}
          </span>
          <span class="date">
            {{ s.returnDate ? `去 ${s.departDate} · 回 ${s.returnDate}` : s.departDate }}
          </span>
        </div>

        <!--
          meta：当前最低 与 上次通知 →【API】由 Cron 每天比价后回写（Supabase）
          盯价航班 为 null 时，监控基准回落为「该航线全列表最低价」
        -->
        <div class="meta">
          <div class="cell">
            当前最低
            <b>{{ money(s.currentPrice) }}</b>
          </div>

          <!-- 提醒阈值：点数字就地改（回车 / 移开焦点生效） -->
          <div class="cell">
            提醒阈值
            <input
              v-if="isEditing(s, 'threshold')"
              :ref="(el) => setEditRef(s.id, 'threshold', el)"
              v-model.number="draftNum"
              type="number"
              min="0"
              step="10"
              @keyup.enter="saveThreshold(s)"
              @keyup.esc="cancelEdit"
              @blur="saveThreshold(s)"
            />
            <b v-else class="edit" title="点击修改" @click="startEdit(s, 'threshold')">
              {{ money(s.threshold) }}
            </b>
          </div>

          <div class="cell">
            盯价航班
            <b>{{
              s.flight ? `${s.flight.airline} ${s.flight.departTime}` : '未指定，按航线最低价'
            }}</b>
          </div>

          <!-- 决策截止日：选完即存，不用再找保存按钮 -->
          <div class="cell">
            决策截止日
            <el-date-picker
              :model-value="s.deadline"
              type="date"
              size="small"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
              :clearable="false"
              :disabled-date="disableDeadline(s)"
              class="mini-date"
              @change="(val) => saveDeadline(s, val)"
            />
          </div>

          <div class="cell">
            上次通知
            <b>{{ s.lastNotified || '—' }}</b>
          </div>

          <!-- 通知邮箱：点文字就地改；只改这条订阅，不动「设置」里的默认邮箱 -->
          <div class="cell">
            通知邮箱
            <input
              v-if="isEditing(s, 'email')"
              :ref="(el) => setEditRef(s.id, 'email', el)"
              v-model.trim="draftEmail"
              type="email"
              class="wide"
              @keyup.enter="saveEmail(s)"
              @keyup.esc="cancelEdit"
              @blur="saveEmail(s)"
            />
            <b v-else class="edit" title="点击修改" @click="startEdit(s, 'email')">
              {{ s.email || '未设置' }}
            </b>
          </div>
        </div>

        <div class="acts">
          <button @click="toggleStatus(s)">{{ s.status === 'active' ? '暂停' : '恢复' }}</button>
          <button class="dan" @click="confirmRemove(s)">取消订阅</button>
        </div>
      </div>

      <!-- 通知记录 →【API】Supabase notify_log 表；正文文案由 AI 生成 -->
      <div class="sec-t">通知记录</div>
      <table v-if="logs.length" class="f">
        <thead>
          <tr>
            <th>时间</th>
            <th>航线</th>
            <th>触发价</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in logs" :key="l.id">
            <td>{{ l.time }}</td>
            <td>{{ airportLabel(l.from) }} → {{ airportLabel(l.to) }}</td>
            <td class="pr">{{ money(l.price) }}</td>
            <td>{{ l.status }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="none">暂无通知记录 —— 跌破阈值后，这里会记下每一次提醒</p>
    </template>

    <!-- 空状态 -->
    <div v-else class="blank">
      <div class="ico">✈</div>
      <p class="blank-t">还没有监控的航线</p>
      <p class="blank-s">去查询页找一条航线，在结果页点「订阅监控」就能开始盯价</p>
      <button class="btn" @click="goQuery">去查询页</button>
    </div>
  </div>
</template>

<script setup>
import { nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { airportLabel } from '../../data/airports';
import { useSubscriptionsStore } from '../../stores/subscriptions';
import { useSettingsStore } from '../../stores/settings';

const router = useRouter();
const store = useSubscriptionsStore();
const { items, logs } = storeToRefs(store);

/** 邮件总闸在「设置」里被关掉时，这里要提醒一声，否则用户会以为监控失效 */
const settings = useSettingsStore();
const { emailNotify } = storeToRefs(settings);

const money = (n) => `¥${Number(n).toLocaleString()}`;

/* ---------------------------------------------------------------------------
 * 就地编辑：点哪个字段改哪个，不用先按「编辑」按钮
 *   阈值 / 邮箱 → 变输入框，回车或移开焦点生效
 *   截止日      → 常驻日期选择器，选完即存
 * 一次只编辑一个字段；改完即生效 → 后端应同步更新该条订阅
 * 约定：成功不弹提示（控件收起、数值更新本身就是反馈），只有失败才打断用户
 * ------------------------------------------------------------------------ */
const editing = ref({ id: '', field: '' });
const draftNum = ref(0);
const draftEmail = ref('');

const isEditing = (s, field) => editing.value.id === s.id && editing.value.field === field;

/** v-for 里的普通 ref 会被收集成数组，这里用函数式 ref 按「卡片 + 字段」精确拿到控件 */
const editRefs = new Map();
function setEditRef(id, field, el) {
  const key = `${id}:${field}`;
  if (el) editRefs.set(key, el);
  else editRefs.delete(key);
}

async function startEdit(s, field) {
  editing.value = { id: s.id, field };
  draftNum.value = s.threshold;
  draftEmail.value = s.email || '';
  await nextTick();
  const el = editRefs.get(`${s.id}:${field}`);
  el?.focus();
  el?.select?.();
}

function cancelEdit() {
  editing.value = { id: '', field: '' };
}

function saveThreshold(s) {
  // 回车保存后元素被移除，可能再触发一次 blur —— 靠这道守卫去重
  if (!isEditing(s, 'threshold')) return;
  const v = Number(draftNum.value);
  if (!Number.isFinite(v) || v <= 0) {
    ElMessage.warning('请输入有效的价格');
    return;
  }
  store.updateSubscription(s.id, { threshold: Math.round(v) });
  cancelEdit();
}

function saveEmail(s) {
  if (!isEditing(s, 'email')) return;
  const v = draftEmail.value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    ElMessage.warning('请填写正确的邮箱');
    return;
  }
  store.updateSubscription(s.id, { email: v });
  cancelEdit();
}

/** 截止日：picker 选完即存，无需额外保存动作 */
function saveDeadline(s, val) {
  if (!val || val === s.deadline) return;
  store.updateSubscription(s.id, { deadline: val });
}

/** 禁用规则：今天之前、以及出发日之后（出发日若已过则不再设上限）—— 与结果页同一套口径 */
const disableFns = new Map();
function disableDeadline(s) {
  if (!disableFns.has(s.id)) {
    disableFns.set(s.id, (date) => {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (date.getTime() < today.getTime()) return true;
      const max = new Date(`${s.departDate}T00:00:00`);
      if (max.getTime() < today.getTime()) return false;
      return date.getTime() > max.getTime();
    });
  }
  return disableFns.get(s.id);
}

/* ---------------------------------------------------------------------------
 * 暂停 / 恢复 · 取消订阅
 * ------------------------------------------------------------------------ */
function toggleStatus(s) {
  store.toggleStatus(s.id);
}

async function confirmRemove(s) {
  try {
    await ElMessageBox.confirm(
      `取消后将不再监控 ${airportLabel(s.from)} → ${airportLabel(s.to)}（${s.departDate}），确定吗？`,
      '取消订阅',
      { confirmButtonText: '确定取消', cancelButtonText: '再想想', type: 'warning' },
    );
  } catch {
    return; // 用户点了「再想想」
  }
  // →【API】后端同时停掉该条订阅的 Cron 检查
  store.removeSubscription(s.id);
  ElMessage.success('已取消订阅');
}

function goQuery() {
  router.push({ name: 'discovery' });
}

function goSetting() {
  router.push({ name: 'setting' });
}
</script>

<style scoped>
.subs {
  max-width: 900px;
  margin: 0 auto;
  padding: 28px 20px 60px;
}

/* ---------- 邮件总闸关闭提示 ---------- */
.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  font-size: 13.5px;
  color: #b7791f;
  background: #fff6e6;
  border: 1px solid #f3e0b8;
  border-radius: 12px;
}
.notice-link {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  color: #2f6bff;
  white-space: nowrap;
  cursor: pointer;
}

/* ---------- 区块标题 ---------- */
.sec-t {
  margin: 18px 0 10px;
  font-size: 15px;
  font-weight: 700;
  color: #1f2937;
}
.sec-t:first-child {
  margin-top: 0;
}

/* ---------- 订阅卡片 ---------- */
.sub {
  padding: 16px 18px;
  margin-bottom: 12px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
}
.sub .top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sub .route {
  font-size: 16px;
  font-weight: 800;
  color: #1f2937;
}
.badge {
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 999px;
}
.badge.on {
  color: #16a34a;
  background: #e9f8ef;
}
.badge.pause {
  color: #b7791f;
  background: #fff6e6;
}
.sub .date {
  margin-left: auto;
  font-size: 13px;
  color: #9ca3af;
}

.sub .meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 26px;
  margin-top: 12px;
  font-size: 13px;
  color: #6b7280;
}
.sub .meta .cell b {
  display: block;
  margin-top: 2px;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}
.sub .meta input {
  width: 120px;
  margin-top: 2px;
  padding: 0 2px;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
  background: transparent;
  border: 0;
  border-bottom: 2px solid #2f6bff;
  outline: none;
}
.sub .meta input.wide {
  width: 220px;
}

/* 可改的字段：平时是文字，hover 才透出「可以点」 */
.sub .meta .cell b.edit {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition:
    color 0.15s,
    border-color 0.15s;
}
.sub .meta .cell b.edit:hover {
  color: #2f6bff;
  border-bottom-color: #c9d6ff;
}

/* 截止日：默认像一行文字，hover / 聚焦才显边框 */
.sub .meta :deep(.mini-date) {
  display: flex;
  width: 138px;
  margin-top: 2px;
}
.sub .meta :deep(.mini-date .el-input__wrapper) {
  padding: 0 8px;
  background: transparent;
  box-shadow: none;
}
.sub .meta :deep(.mini-date .el-input__wrapper:hover),
.sub .meta :deep(.mini-date .el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #c9d6ff inset;
}
.sub .meta :deep(.mini-date .el-input__inner) {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
  cursor: pointer;
}

.sub .acts {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.sub .acts button {
  padding: 6px 14px;
  font-size: 13px;
  color: #1f2937;
  background: #f5f7fa;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.sub .acts button:hover {
  color: #2f6bff;
  border-color: #c9d6ff;
}
.sub .acts button.pri {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
}
.sub .acts button.pri:hover {
  background: #1e50d8;
  color: #fff;
}
.sub .acts button.dan {
  color: #dc2626;
  border-color: #f3c9c9;
}
.sub .acts button.dan:hover {
  color: #dc2626;
  background: #fdecec;
  border-color: #f3c9c9;
}

/* ---------- 通知记录 ---------- */
table.f {
  width: 100%;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-collapse: separate;
  border-spacing: 0;
  border-radius: 12px;
}
table.f th {
  padding: 11px 14px;
  font-size: 12px;
  font-weight: 600;
  color: #6b7280;
  text-align: left;
  background: #fafbfc;
  border-bottom: 1px solid #eef0f3;
}
table.f td {
  padding: 13px 14px;
  font-size: 14px;
  color: #374151;
  border-bottom: 1px solid #f2f4f7;
}
table.f tbody tr:last-child td {
  border-bottom: 0;
}
table.f .pr {
  font-weight: 800;
  color: #dc2626;
}
.none {
  padding: 18px;
  margin: 0;
  font-size: 13px;
  color: #9ca3af;
  text-align: center;
  background: #fff;
  border: 1px dashed #e5e7eb;
  border-radius: 12px;
}

/* ---------- 空状态 ---------- */
.blank {
  padding: 56px 20px;
  text-align: center;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
}
.blank .ico {
  font-size: 28px;
  line-height: 1;
  color: #2f6bff;
}
.blank-t {
  margin: 14px 0 6px;
  font-size: 17px;
  font-weight: 700;
  color: #1f2937;
}
.blank-s {
  margin: 0 0 18px;
  font-size: 13.5px;
  color: #6b7280;
}
.btn {
  padding: 11px 26px;
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  background: #2f6bff;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.2s;
}
.btn:hover {
  background: #1e50d8;
}
</style>
