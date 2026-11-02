<template>
  <div class="result">
    <!-- ① 查询条件回显条
         说明：任意时刻的判断都基于「此刻报价」，会过期 —— 具体的快照时间在下方的
         `.fresh` 那一行（数据回来之后才显示，等待态里还没有快照可报）。 -->
    <div class="cond">
      <span class="r">{{ airportLabel(params.from) }}</span>
      <span class="dot">→</span>
      <span class="r">{{ airportLabel(params.to) }}</span>
      <span class="dot">·</span>
      <template v-if="params.returnDate">
        <span>去 {{ withWeekday(params.departDate) }}</span>
        <span class="dot">·</span>
        <span>回 {{ withWeekday(params.returnDate) }}</span>
      </template>
      <span v-else>{{ withWeekday(params.departDate) }}</span>
      <span class="dot">·</span>
      <span>{{ cabinLabel }} {{ params.passengers }}人</span>
      <a class="edit" @click="handleEdit">修改</a>
    </div>

    <!-- ⚠️ 三态互斥，且必须是**相邻**兄弟节点（v-if / v-else-if / v-else-if）：
         ① 查询中 ② 查询失败 ③ 有数据
         为什么「进页面先看到等待态」是必须的，而不是可选的优化：
         后端要现场爬 Google 航班日历，**实测 20~60 秒**。这几十秒里如果没有整屏反馈，
         用户只会看到一个空页面，第一反应是「坏了」然后关掉、白花一次钱。 -->
    <div v-if="loading" class="state">
      <div class="spin" aria-hidden="true"></div>
      <p class="state-t">正在实时查询票价…</p>
      <p class="state-s">
        正在直连航司与比价源，最长约 60 秒（通常 20~40 秒）。<br />
        请保持页面打开 —— 已等待 {{ elapsed }} 秒
      </p>
    </div>

    <!--
      失败态（A2）：内容区**只显示失败原因**，其余模块一个都不渲染
      （日历/答案①②/航班/订阅卡全在下面的 v-else-if="data" 分支里，失败时 data 为 null）。
      顶部那条查询条件是无 v-if 的常驻框架，留着是为了让用户看清「查的是什么」。
    -->
    <div v-else-if="error" class="state err">
      <p class="state-t">这条航线此刻查不到报价</p>
      <p class="state-s">{{ error }}</p>
      <div class="state-act">
        <button class="btn narrow" @click="reload">重试</button>
        <a class="link-set" @click="handleEdit">修改查询条件</a>
      </div>
    </div>

    <template v-else-if="data">
      <!-- ⑤ 数据快照 + 缺块提示（已抽成组件 src/components/result/MetaBar.vue）
           「哪些提示该显示」这条筛选规则跟着搬进组件，父页不再拼文案。 -->
      <MetaBar :snapshot-at="data.snapshotAt" :notices="data.notices" />

      <!-- ② 答案①：哪天出发最便宜（已抽成组件 src/components/result/DateAnswerCard.vue） -->
      <DateAnswerCard :answer="data.dateAnswer" />

      <!-- ③ 答案②：购买时机（已抽成组件 src/components/result/TimingAnswerCard.vue）
           「判断不了」的占位卡在组件内部用 v-else 占同一个位置 —— 位置关系属于组件自己的契约，
           不该让每个调用方各自再写一遍 if/else。 -->
      <TimingAnswerCard
        :answer="data.timingAnswer"
        :hints="data.hints"
        :fallback-text="data.notices.judgement"
      />

      <!-- ⑤ 价格日历（已抽成组件 src/components/result/PriceCalendar.vue）
           颜色/补位/「—」兜底三件事都跟标记一起搬走了，本页不再参与日历的任何计算。 -->
      <PriceCalendar
        :calendar="data.calendar"
        :month-label="data.monthLabel"
        :day-count="data.dayCount"
      />

      <!-- ⑥ 航班列表（已抽成组件 src/components/result/FlightTable.vue）
           抽出的原因不是「代码好看」，而是卡片化之后要能被 agent 按 block 类型单独渲染。
           选中态仍留在本页（pickedId）：订阅阈值的联动只该有一处真相。 -->
      <FlightTable
        :flights="data.flights"
        :picked-id="pickedId"
        :lowest-price="data.lowestPrice"
        @pick="togglePick"
      />

      <!-- ⑦ 订阅卡片（已抽成组件 src/components/result/SubscribeCard.vue）
           ⚠️ 受控组件：四个表单值仍由本页持有（threshold / deadline / email），
              组件只负责画 + emit。状态留在这里，是因为「选了航班→阈值跟着变」这条联动、
              以及提交后的跳转追问，都属于本页的流程，不该拆进卡片。 -->
      <SubscribeCard
        v-model:threshold="threshold"
        v-model:deadline="deadline"
        v-model:email="email"
        :picked-flight="pickedFlight"
        :lowest-price="data.lowestPrice"
        :recommended-deadline="recommendedDeadline"
        :disable-deadline="disableDeadline"
        :submitting="subscribing"
        @submit="handleSubscribe"
        @go-settings="goSetting"
      />
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import FlightTable from '../../components/result/FlightTable.vue';
import PriceCalendar from '../../components/result/PriceCalendar.vue';
import DateAnswerCard from '../../components/result/DateAnswerCard.vue';
import TimingAnswerCard from '../../components/result/TimingAnswerCard.vue';
import MetaBar from '../../components/result/MetaBar.vue';
import SubscribeCard from '../../components/result/SubscribeCard.vue';
import { airportLabel } from '../../data/airports';
import { useResultStore } from '../../stores/result';
import { useSettingsStore } from '../../stores/settings';
import { useSubscriptionsStore } from '../../stores/subscriptions';

const route = useRoute();
const router = useRouter();
const settings = useSettingsStore();
const subscriptions = useSubscriptionsStore();
const result = useResultStore();

/* ---------------------------------------------------------------------------
 * 查询参数：来自查询页的 router query
 * ------------------------------------------------------------------------ */
const params = {
  from: route.query.from || 'SZX',
  to: route.query.to || 'PEK',
  departDate: route.query.departDate || null,
  returnDate: route.query.returnDate || null,
  cabin: route.query.cabin || 'economy',
  passengers: Number(route.query.passengers) || 1,
  flexibility: route.query.flexibility || 'fixed',
};

/**
 * 当前条件 → 后端要的查询参数（空值不传，URL 干净）。
 * 「发起查询」与「回查询页修改」共用它 —— 一处生成，两处不会走样。
 */
function currentQuery() {
  const q = {
    from: params.from,
    to: params.to,
    cabin: params.cabin,
    passengers: String(params.passengers),
    flexibility: params.flexibility,
  };
  if (params.departDate) q.departDate = params.departDate;
  if (params.returnDate) q.returnDate = params.returnDate;
  return q;
}

const CABIN_LABEL = {
  economy: '经济舱',
  premium: '超级经济舱',
  business: '商务舱',
  first: '头等舱',
};
const cabinLabel = CABIN_LABEL[params.cabin] ?? '经济舱';

/* ---------------------------------------------------------------------------
 * 真实数据入口：进页面就查一次
 *
 * 一次请求拿回整页数据（价格日历 + 该不该买 + 航班列表），由后端 api/result.js 聚合。
 * 为什么不在前端并发打两个接口：见那个文件顶部 —— 核心是「答案①与答案②必须建立在
 * 同一份窗口数据上」，交给前端拼等于把口径交给两个异步回调的先后顺序。
 *
 * ⚠️ 这一次查询要 20~60 秒（后端要现场爬 Google 航班日历），
 *    所以整屏等待态不是「优化」，是**必须**：否则这几十秒里用户看到的是空白页，会以为坏了。
 * ------------------------------------------------------------------------ */
const data = computed(() => result.data);
const loading = computed(() => result.loading);
const error = computed(() => result.error);

/** 已等待秒数 —— 让等待可感知（静止的转圈会让人怀疑卡死） */
const elapsed = ref(0);
let ticker = null;

/**
 * 查一次（进页面时 + 失败后点「重试」都是它）。
 * 计时器只覆盖这一次请求的生命周期：请求结束就停表。
 */
async function reload() {
  elapsed.value = 0;
  clearInterval(ticker);
  ticker = setInterval(() => {
    elapsed.value += 1;
  }, 1000);
  try {
    await result.fetchResult(currentQuery());
  } finally {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * 进页面：① 拉一次用户设置（好让下面的订阅卡片有默认邮箱可填）
 *        ② 发起本次比价查询
 * 两件事互不依赖，并行发起 —— 设置那一路很轻（一个 GET），
 * 不等它回来才去查票，免得白白把那几十秒的等待又往后推。
 */
onMounted(() => {
  // 设置拿回来后再把邮箱补进草稿 —— 若用户手快已经在框里敲了，就不覆盖
  settings.fetchSettings().then(() => {
    if (!email.value) email.value = settings.email;
  });
  reload();
});
onUnmounted(() => clearInterval(ticker));

/* ---------------------------------------------------------------------------
 * 盯价（选一条航班作为监控基准；FlyOrWait 不卖票，不能下单）
 * MVP 做「航班级盯价」；若该航班连续多日匹配不到（售完/停飞），后端降级为「盯该航线最低价」
 * ------------------------------------------------------------------------ */
const pickedId = ref('');
// ⚠️ data 在「查询中」是 null ⇒ 这里必须可选链，否则 setup 阶段就会炸
const pickedFlight = computed(
  () => data.value?.flights.find((f) => f.id === pickedId.value) ?? null,
);

/** 点「选」只是换盯价基准，列表高亮 + 下方订阅卡片回填已是反馈，不再弹提示 */
function togglePick(flight) {
  pickedId.value = pickedId.value === flight.id ? '' : flight.id;
}

/** 阈值：盯了航班用「该航班价 × 0.95」；没盯用后端给的建议值 */
const threshold = ref(0);

/** 通知邮箱：默认回填「设置」里存的默认邮箱（没设过则为空，可在这里临时改） */
const email = ref(settings.email);

/** 盯了 / 取消了航班 → 阈值跟着走（**初值**由下面的 watch(data) 负责补） */
watch(pickedFlight, (flight) => {
  if (!data.value) return;
  threshold.value = flight
    ? Math.round((flight.price * 0.95) / 10) * 10
    : data.value.suggestedThreshold;
});

/* ---------------------------------------------------------------------------
 * 决策截止日（＝「等到什么时候为止」的那条线，用户自己的决定）
 *   默认值 = 系统推荐（出发日 − 21 天），旁边标绿字「推荐」
 *   用户可自行改；改完不再是推荐值 → 标签消失
 * ⚠️ 系统推荐值若已过期（早于今天），落到今天 —— 「今天就是最后决定日」
 * ------------------------------------------------------------------------ */
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const todayISO = toISODate(new Date());

const recommendedDeadline = computed(() => {
  const suggested = data.value?.timingAnswer?.action.deadline;
  return suggested && suggested >= todayISO ? suggested : todayISO;
});

/** 用户当前设定的截止日。初值等数据到了再补（见下面 watch(data)），用户改过之后不再被覆盖 */
const deadline = ref('');

/* 「推荐」标的判断在 SubscribeCard 内部完成（deadline === recommendedDeadline），
   本页只提供那个推荐值 —— 判断只写一处，免得两边口径漂。 */

/**
 * 数据到达后补上「阈值」与「截止日」的初值。
 *
 * ⚠️ 为什么 watch 的是 data，而不是 pickedFlight：
 *    pickedFlight 在「没盯任何航班」时前后都是 null，**值没变 ⇒ watch 不触发**，
 *    阈值就会一直停在 0。只有 watch(data) 才能保证「数据一到就补上初值」。
 * ⚠️ 这条 watch 必须放在 deadline 声明**之后**：immediate 会立即同步执行回调，
 *    放到前面会撞上 const 的暂时性死区（TDZ）当场报错。
 */
watch(
  data,
  (d) => {
    if (!d) return;
    threshold.value = pickedFlight.value
      ? Math.round((pickedFlight.value.price * 0.95) / 10) * 10
      : d.suggestedThreshold;
    deadline.value = recommendedDeadline.value;
  },
  { immediate: true },
);

/** 出发日（整月最优时即后端挑出的最优日）；截止日不得晚于它 */
const departISO = computed(() => data.value?.selected.date ?? '');

/** 禁用：今天之前；若出发日还没过，也禁用晚于出发日的日期 */
function disableDeadline(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date.getTime() < today.getTime()) return true;
  const max = new Date(`${departISO.value}T00:00:00`);
  if (max.getTime() < today.getTime()) return false; // 出发日已过（极端情况）→ 不再设上限
  return date.getTime() > max.getTime();
}

/* ---------------------------------------------------------------------------
 * 展示辅助
 * ------------------------------------------------------------------------ */
function withWeekday(dateStr) {
  if (!dateStr) return '日期待定';
  const d = new Date(`${dateStr}T00:00:00`);
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${dateStr} ${w}`;
}

/** 日历首格偏移 / 档位配色 / 「—」兜底：已随标记迁入 PriceCalendar.vue，
    本页不再参与日历的任何计算（两处各算一遍必然会漂）。 */

/** 回查询页，并带上当前条件回填表单 */
function handleEdit() {
  router.push({ name: 'discovery', query: currentQuery() });
}

/** 去「设置」页配置默认通知邮箱 */
function goSetting() {
  router.push({ name: 'setting' });
}

/** 订阅成功后问一句要不要去看（无缝衔接到「我的订阅」） */
async function askGoSubscriptions() {
  try {
    await ElMessageBox.confirm('要现在去「我的订阅」看看吗？', '已开启监控', {
      confirmButtonText: '去看看',
      cancelButtonText: '留在这里',
      type: 'success',
    });
    router.push({ name: 'mySubscribtion' });
  } catch {
    // 用户选择留在当前页
  }
}

/**
 * 订阅前的前端校验（体验层）
 *
 * 只做一件事：把「用户自己能改对」的错误在本地拦下来，省掉一次注定失败的请求。
 * 这里刻意只查「用户有可能填错/填漏」的字段（阈值可被删空、邮箱可留空或写错）；
 * 像 from / to / departDate / basePrice 这些来自查询条件与数据层、用户根本碰不到的，
 * 不在前端查 —— 查了也是永远为真的死代码。
 *
 * ⚠️ 它不替代后端校验。后端仍会独立校验一遍，那是唯一挡得住 curl / Cron 等
 *    旁路调用的防线（见 api/subscriptions/index.js 的 REQUIRED_FIELDS）。
 *    两边各写一份是刻意的：前端求「即时 + 友好」，后端求「不可绕过」，目标不同。
 *    （将来若嫌两处规则容易走样，可把它抽成一个前后端共用的模块，目前先各留一份。）
 */
function validateSubscribe() {
  // 阈值是原生输入框，用户可删空 —— 这是目前唯一真会漏的必填项
  const t = threshold.value;
  if (t === '' || t === null || t === undefined) {
    ElMessage.error('请填写降价提醒阈值');
    return false;
  }

  if (!email.value) {
    ElMessage.error('请填写通知邮箱');
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    ElMessage.error('通知邮箱格式不正确');
    return false;
  }

  return true;
}

/**
 * 提交中（只关按钮，不影响整页）。
 *
 * 为什么不用 store 的 loading：那个是「列表正在从后端同步」的总开关，
 * 结果页根本没有列表可转圈；拿它来关按钮会把两件不相干的事绑在一起。
 *
 * 它同时承担防连点：按钮 :disabled 是第一道，函数入口再判一次是第二道
 * （禁用态在某些浏览器里仍可能被回车/双击抢进一次点击事件）。
 */
const subscribing = ref(false);

async function handleSubscribe() {
  if (subscribing.value) return;
  if (!validateSubscribe()) return;

  // 出发日：固定日期用用户选的；整月最优时用**后端算出的**最低价日
  // （api/result.js 里对整段窗口 reduce 取最低价 → _compose.js:488 selectedCell，不是模型挑的）
  const departDate = params.departDate || data.value.selected.date;
  const flight = pickedFlight.value;

  let res;
  subscribing.value = true;
  try {
    // 写入后端（POST /api/subscriptions）。字段只说业务语言，数据库列名由后端翻译。
    // 后端由 Vercel Cron 每天定时调用实时价 API 比价，低于阈值时发邮件；
    // 邮件正文是**服务端固定模板**（api/_mail.js 的 buildHitMail / buildDeadlineMail），
    // 不由模型生成 —— 发出去收不回，判定句与数字必须可复现、可审。
    res = await subscriptions.addSubscription({
      from: params.from,
      to: params.to,
      departDate,
      // 往返：返程日（单程为 null）。往返不支持灵活日期，故 departDate 必为用户所选，两者恒定配对
      returnDate: params.returnDate,
      // 盯价航班：只存展示与匹配需要的字段；没选中则监控基准回落为全列表最低价
      flight: flight
        ? {
            id: flight.id,
            airline: flight.airline,
            departTime: flight.departTime,
            stopText: flight.stopText,
          }
        : null,
      basePrice: flight ? flight.price : data.value.lowestPrice,
      threshold: threshold.value,
      deadline: deadline.value,
      email: email.value,
      // 舱位与人数会显著影响比价结果，Cron 回查时必须带上
      cabin: params.cabin,
      passengers: params.passengers,
    });
  } catch (e) {
    // 断网 / 500 这类真正的失败才弹；成功不弹（约定）
    ElMessage.error(e.message || '订阅失败，请稍后重试');
    return;
  } finally {
    // 成功、失败、重复订阅都要把按钮放回去 —— 否则一次失败就永久锁死按钮
    subscribing.value = false;
  }

  if (!res.ok) {
    ElMessage.warning('这条航线已经在监控中，可在「我的订阅」里查看或修改');
    return;
  }

  await askGoSubscriptions();
}
</script>

<style scoped>
.result {
  max-width: 900px;
  margin: 0 auto;
  padding: 28px 20px 60px;
}

/* ---------- ① 查询条件回显条 ---------- */
.cond {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 14px;
  font-size: 14px;
  color: #4a5568;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
}
.cond .r {
  font-weight: 700;
  font-size: 16px;
  color: #1f2937;
}
.cond .dot {
  color: #9ca3af;
}
.cond .edit {
  margin-left: auto;
  font-size: 13px;
  color: #2f6bff;
  cursor: pointer;
}
.cond .edit:hover {
  text-decoration: underline;
}

/* ---------- ②③ 两个答案卡片 ----------
   样式已随标记迁入 src/components/result/DateAnswerCard.vue 与 TimingAnswerCard.vue。
   ⚠️ .ans-card / .verdict / .vt / .vsub / .ans-note 在两个组件里各留一份：
      scoped 不跨组件，改成全局（去掉 scoped）会污染其他页面的同名类。 */

/* ---------- 区块标题 ----------
   .sec-t 的唯一使用者（订阅卡标题）已随卡片迁走，本页不再保留。 */

/* ---------- ⑤ 价格日历 ----------
   样式已随标记迁入 src/components/result/PriceCalendar.vue。 */

/* ---------- ⑥ 航班列表 ----------
   样式已随标记迁入 src/components/result/FlightTable.vue。
   ⚠️ 不要试图在这里补 table.f 的样式：scoped 样式不跨组件，写了也不会生效（且不报错）。 */

/* ---------- ⑦ 订阅卡片 ----------
   样式已随标记迁入 src/components/result/SubscribeCard.vue（含 .sec-t / .rec /
   .plain-input / :deep(日期选择器) / .btn-spin 与它的 @keyframes spin）。
   ⚠️ 唯独 .link-set 与 .btn 本页仍要留一份：失败态里的「重试」和「修改查询条件」还在用。 */

/* 「去设置 / 修改查询条件」链接 */
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

/* ---------- 三态：等待 / 失败 / 提示 ---------- */
/* 等待态是 Apify 现场抓数据那 20~60 秒里用户唯一看得到的东西，
   所以不能只放一个孤零零的转圈 —— 要说清「在干什么、要多久、还在动」。 */
.state {
  padding: 56px 20px;
  text-align: center;
}
.state .spin {
  width: 38px;
  height: 38px;
  margin: 0 auto 16px;
  border: 3px solid #e5e7eb;
  border-top-color: #2f6bff;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.state-t {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 700;
  color: #1f2937;
}
.state-s {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.8;
  color: #6b7280;
}
.state-act {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin-top: 20px;
}

/* 失败态（A2）：内容区只放失败原因 ⇒ 做成一张**左对齐**的卡片。
   居中大字本来是用来配「整屏等待」的，失败时页面就这一块东西，居中会显得空。
   下面这些特异性都比上面高，所以写在后面；不靠顺序取胜，但仍保持从低到高。 */
.state.err {
  padding: 20px 22px;
  text-align: left;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 14px;
}
.state.err .state-t {
  color: #dc2626;
}
.state.err .state-s {
  color: #7f1d1d;
}
/* 按钮跟着文字左对齐 —— 居中按钮配左对齐正文会很怪 */
.state.err .state-act {
  justify-content: flex-start;
}

.btn.narrow {
  width: auto;
  padding: 10px 28px;
  font-size: 14px;
}

/* ---------- 数据快照 + 缺块提示 ----------
   样式已随标记迁入 src/components/result/MetaBar.vue。 */

/* 窄屏适配已全部随各自组件迁走（订阅邮箱框 / 三件套 / 航班时长列），
   本页目前没有需要单独处理的窄屏规则。 */
</style>
