<template>
  <!-- v-loading：进页面拉取、以及每次写完重新拉时转圈 —— 让「数据正在从服务器更新」看得见 -->
  <div v-loading="loading" element-loading-background="rgba(255, 255, 255, 0.6)" class="subs">
    <template v-if="items.length">
      <!--
        定时比价还没做 ⇒ 卡片上的价格**不会自动更新**，必须在最上面说清一次。
        ⚠️ 原文案是「邮件通知已关闭，降价时不会发邮件（订阅仍在正常监控）」——
           「仍在正常监控」是**反向的谎**：监控根本没实现。别再改回去。
           （等 Cron + 通知真做出来，这句换回「邮件通知已关闭…去开启」）
      -->
      <div class="notice">
        <span>定时比价尚未开通 —— 下面的价格是你订阅时查到的，暂时不会自动更新</span>
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
          meta：上次价格（= 订阅那一刻查到的真实价，落库在 base_price）
                + 提醒阈值 / 盯价航班 / 决策截止日 / 通知邮箱
          盯价航班 为 null 时，监控基准回落为「该航线全列表最低价」
        -->
        <div class="meta">
          <div class="cell">
            上次价格
            <!--
              ⚠️ 别改回 currentPrice：那是「由 Cron 每天比价后回写」的字段，
                 Cron 没做 ⇒ 它永远停在创建时那个值或 null，显示出来会让人以为是实时价。
                 basePrice 是**有据可依**的：就是用户订阅这条航线时查到的价格。
            -->
            <b>{{ money(s.basePrice) }}</b>
          </div>

          <!-- 提醒阈值：只有编辑态才变输入框，平时只读 -->
          <div class="cell">
            提醒阈值
            <input
              v-if="editingId === s.id"
              :ref="setFirstInput"
              v-model.number="draft.threshold"
              type="number"
              min="1"
              step="10"
              @keyup.enter="saveEdit(s)"
              @keyup.esc="cancelEdit"
            />
            <b v-else>{{ money(s.threshold) }}</b>
          </div>

          <div class="cell">
            盯价航班
            <b>{{
              s.flight ? `${s.flight.airline} ${s.flight.departTime}` : '未指定，按航线最低价'
            }}</b>
          </div>

          <!-- 决策截止日：只有编辑态才出日期选择器，平时只读 -->
          <div class="cell">
            决策截止日
            <el-date-picker
              v-if="editingId === s.id"
              v-model="draft.deadline"
              type="date"
              size="small"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
              :clearable="false"
              :disabled-date="disableDeadline(s)"
              class="mini-date"
            />
            <b v-else>{{ s.deadline }}</b>
          </div>

          <!-- 通知邮箱：只改这条订阅，不动「设置」里的默认邮箱 -->
          <div class="cell">
            通知邮箱
            <input
              v-if="editingId === s.id"
              v-model.trim="draft.email"
              type="email"
              class="wide"
              @keyup.enter="saveEdit(s)"
              @keyup.esc="cancelEdit"
            />
            <b v-else>{{ s.email || '未设置' }}</b>
          </div>
        </div>

        <!-- 平时：编辑 / 暂停恢复 / 取消订阅；编辑态：只留 保存 / 取消 -->
        <div class="acts">
          <template v-if="editingId === s.id">
            <button class="pri" @click="saveEdit(s)">保存</button>
            <button @click="cancelEdit">取消</button>
          </template>
          <template v-else>
            <button @click="startEdit(s)">编辑</button>
            <button @click="toggleStatus(s)">{{ s.status === 'active' ? '暂停' : '恢复' }}</button>
            <button class="dan" @click="confirmRemove(s)">取消订阅</button>
          </template>
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
      <p v-else class="none">定时比价尚未开通，暂无通知记录</p>
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
import { nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { airportLabel } from '../../data/airports';
import { useSubscriptionsStore } from '../../stores/subscriptions';

const router = useRouter();
const store = useSubscriptionsStore();
const { items, logs, loading } = storeToRefs(store);

const money = (n) => `¥${Number(n).toLocaleString()}`;

/* ---------------------------------------------------------------------------
 * 进入页面时，从后端拉一次「我的订阅」
 *   成功 → 覆盖本地列表（后端为准，库里那条会出现在这里）
 *   失败 → 保留当前显示不动，并弹一次提示
 *          （不静默失败：否则用户会以为眼前这份就是最新数据）
 * 约定：读操作（进页面拉取）成功不弹，只有失败才打断用户
 * ------------------------------------------------------------------------ */
onMounted(async () => {
  try {
    await store.fetchSubscriptions();
  } catch (e) {
    ElMessage.error(e.message || '订阅列表读取失败');
  }
});

/* ---------------------------------------------------------------------------
 * 编辑态：点「编辑」把这条订阅的 阈值 / 邮箱 / 截止日 一起变成可改
 *   · 编辑期间只改「草稿」(draft)，不碰 store —— 所以「取消」天然就是
 *     「不做任何处理、显示原来的数据」，不需要额外做备份 / 还原
 *   · 「保存」才一次性写回；校验不过会停在编辑态让你继续改，
 *     但「取消」永远点得动 —— 不会出现「填错了就被卡住、只能刷新」的死局
 *   约定：按钮触发的写操作，成功 / 失败都要给反馈。
 *     原因：写库要等一次网络往返，「卡片收起、数值变了」不再是「存上了」的证据。
 *     （旧的「成功不弹」只适用于就地编辑那种「控件本身即反馈」的交互。）
 * ------------------------------------------------------------------------ */
const editingId = ref(''); // 正在编辑哪一条（'' = 全部只读）
const draft = ref({ threshold: 0, email: '', deadline: '' });

/** 进入编辑后自动聚焦第一个输入框；v-for 里要用函数式 ref 才拿得到控件 */
const firstInput = ref(null);
const setFirstInput = (el) => {
  if (el) firstInput.value = el;
};

async function startEdit(s) {
  editingId.value = s.id;
  draft.value = { threshold: s.threshold, email: s.email || '', deadline: s.deadline };
  await nextTick();
  firstInput.value?.focus();
  firstInput.value?.select?.();
}

/** 取消 = 丢掉草稿、直接回到只读（s 从头到尾没被改过，显示的就是原数据） */
function cancelEdit() {
  editingId.value = '';
}

/** 校验草稿：返回错误文案，通过则返回空串 */
function draftError() {
  const t = Number(draft.value.threshold);
  if (!Number.isFinite(t) || t <= 0) return '请输入有效的提醒阈值';
  if (!draft.value.email) return '请填写通知邮箱';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.value.email)) return '请填写正确的邮箱';
  if (!draft.value.deadline) return '请选择决策截止日';
  return '';
}

async function saveEdit(s) {
  const err = draftError();
  if (err) {
    ElMessage.warning(err);
    return; // 停在编辑态：可以接着改，也可以点「取消」离开
  }

  try {
    // 写入后端（PATCH）：Cron 比价目标 / 收信地址 / 决策期限一起更新
    await store.updateSubscription(s.id, {
      threshold: Math.round(Number(draft.value.threshold)),
      email: draft.value.email,
      deadline: draft.value.deadline,
    });
  } catch (e) {
    // 存失败也停在编辑态：草稿还在，用户能重试，也永远能点「取消」退出
    ElMessage.error(e.message || '保存失败，请稍后重试');
    return;
  }

  editingId.value = '';
  // 成功也要说一声：写库要等一次网络往返，「卡片收起」不再等于「存上了」
  ElMessage.success('已保存');
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
async function toggleStatus(s) {
  // 方向要在 await 之前记下来：请求成功后 store 会就地改 s.status，之后就判不出来了
  const pausing = s.status === 'active';
  try {
    await store.toggleStatus(s.id); // 后端改成功后，本地那条才跟着变
  } catch (e) {
    ElMessage.error(e.message || '操作失败，请稍后重试');
    return;
  }
  ElMessage.success(pausing ? '已暂停监控' : '已恢复监控');
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

  try {
    // 后端同时停掉该条订阅的比价——删成功才从列表里移除
    await store.removeSubscription(s.id);
  } catch (e) {
    ElMessage.error(e.message || '取消失败，请稍后重试');
    return;
  }

  ElMessage.success('已取消订阅');
}

function goQuery() {
  router.push({ name: 'discovery' });
}
</script>

<style scoped>
.subs {
  max-width: 900px;
  margin: 0 auto;
  padding: 28px 20px 60px;
}

/* ---------- 顶部提示（定时比价未开通 / 邮件关闭） ---------- */
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
