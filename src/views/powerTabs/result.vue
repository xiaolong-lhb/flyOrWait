<template>
  <div class="result">
    <!-- ① 查询条件回显条 -->
    <!-- 说明：任意时刻的判断都基于「此刻报价」，会过期。若后续需要告知数据新鲜度，
         可在后端返回 snapshotAt 后于此处补一行时间展示。 -->
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

    <!-- ② 答案①：哪天出发最便宜（横向 · 仅日期不固定时出现）
         【AI + API】真实实现：Agent 扫日历求最优出发日，再查该日的历史档位（多一次调用） -->
    <div v-if="data.dateAnswer" class="ans-card ans1">
      <div class="ans-head">
        <span class="snap">扫描 {{ data.dateAnswer.scannedDays }} 天</span>
      </div>
      <div class="verdict">
        <span class="vt">最优出发日 {{ data.dateAnswer.bestDate }}</span>
        <span class="vsub">
          ¥{{ data.dateAnswer.bestPrice.toLocaleString() }} · {{ data.dateAnswer.savedText }}
        </span>
      </div>
      <div class="ans-note">
        {{ data.dateAnswer.historyText }} —— 这一天「便宜」只说明日期划算；今天要不要下手，
        看下面的购买建议。
      </div>
    </div>

    <!-- ③ 答案②：购买时机（纵向 · 永远有 · 主角）
         【AI】真实实现：DeepSeek 解释层，输入 = 当前最低价 + 62 天历史 + 典型区间 + 档位
         红线：卡片里每个数字都必须能在下方航班列表 / 日历里找到出处，AI 不得编造价格 -->
    <div class="ans-card ans2" :class="`lv-${data.timingAnswer.level}`">
      <div class="verdict">
        <span class="vt">{{ data.timingAnswer.verdictLabel }}</span>
        <span class="vsub">
          当前最低价 <b>¥{{ data.timingAnswer.currentPrice.toLocaleString() }}</b
          >，处于近 62 天第 {{ data.timingAnswer.positionPct }} 百分位（{{
            data.timingAnswer.levelLabel
          }}），{{ data.timingAnswer.vsTypicalText }}
        </span>
      </div>

      <!-- 「再等等」的三件套：触发条件 + 决策期限 + 数据依据，缺一条就不许出「再等等」-->
      <div class="triple">
        <div class="triple-t">{{ watchTitle }}</div>
        <div class="tri">
          <span class="tri-k">等到什么条件</span>
          <span class="tri-v">{{ data.timingAnswer.action.condition }}</span>
        </div>
        <div class="tri">
          <span class="tri-k">等到什么时候为止</span>
          <span class="tri-v">{{ data.timingAnswer.action.deadlineText }}</span>
        </div>
        <div class="tri">
          <span class="tri-k">凭什么这么说</span>
          <span class="tri-v">{{ data.timingAnswer.action.basisText }}</span>
        </div>
      </div>

      <div class="why">
        <div class="why-t">我是怎么判断的</div>
        <ul>
          <li v-for="(line, i) in data.timingAnswer.reasoning" :key="i">{{ line }}</li>
        </ul>
      </div>

      <div v-if="data.hints.length" class="ext">
        <div class="ext-t">延展建议</div>
        <p v-for="h in data.hints" :key="h.type">{{ h.text }}</p>
      </div>
    </div>

    <!-- ⑤ 价格日历：弱化 + 可展开，作为答案①的原数据佐证
         【API】真实实现：价格日历 API（Sky Scrapper getPriceCalendar / 聚合数据） -->
    <details class="cal-fold">
      <summary>📅 展开看全部 {{ data.calendar.length }} 天价格趋势（越绿越便宜，供你核对）</summary>
      <div class="cal">
        <div v-for="d in WEEK_DAYS" :key="d" class="d">{{ d }}</div>
        <div v-for="n in calendarOffset" :key="`pad-${n}`" class="pad"></div>
        <div
          v-for="c in data.calendar"
          :key="c.date"
          class="c"
          :class="{ sel: c.isSelected }"
          :style="{ background: priceColor(c.price) }"
        >
          {{ c.day }}<small>¥{{ (c.price / 1000).toFixed(2) }}k</small>
        </div>
      </div>
      <div class="legend">
        <span><i style="background: #86efac"></i>便宜</span>
        <span><i style="background: #fdba74"></i>适中</span>
        <span><i style="background: #fca5a5"></i>偏贵</span>
        <span class="legend-tip">蓝框＝你选的日期</span>
      </div>
    </details>

    <!-- ⑥ 航班列表
         【API】真实实现：实时价 API（Sky Scrapper searchFlights / SerpApi google_flights），走代理
         「当天最低」标记用的是 lowest_price 的正确用途：选哪一班，而不是该不该买 -->
    <div class="sec-t">航班列表（实时价）</div>
    <table class="f">
      <thead>
        <tr>
          <th>航司</th>
          <th>起飞</th>
          <th>时长</th>
          <th>类型</th>
          <th>价格</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="f in data.flights"
          :key="f.id"
          :class="{ picked: f.id === pickedId }"
          @click="togglePick(f)"
        >
          <td>{{ f.airline }}</td>
          <td>{{ f.departTime }}</td>
          <td>{{ f.duration }}</td>
          <td>{{ f.stopText }}</td>
          <td class="pr">
            ¥{{ f.price.toLocaleString() }}
            <span v-if="f.isLowest" class="lowest">当天最低</span>
          </td>
          <td>
            <button class="pick" @click.stop="togglePick(f)">
              {{ f.id === pickedId ? '已盯' : '盯价' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- ⑦ 订阅卡片：盯价航班 / 阈值 / 决策截止日 / 邮箱 -->
    <div class="sub-card">
      <div class="sec-t sub-title">订阅这条航线</div>

      <div class="field">
        <label>盯价航班</label>
        <div v-if="pickedFlight" class="val">
          <b>{{ pickedFlight.airline }}</b> {{ pickedFlight.departTime }} ·
          {{ pickedFlight.stopText }} · ¥{{ pickedFlight.price.toLocaleString() }}
        </div>
        <div v-else class="val muted">
          未指定，以全列表最低价 ¥{{ data.lowestPrice.toLocaleString() }} 为基准
        </div>
        <div class="hint">在上方航班列表点「盯价」可指定；改选其他航班时阈值会同步更新</div>
      </div>

      <div class="field">
        <label>降价提醒阈值</label>
        <div class="val">
          ¥<input v-model.number="threshold" class="plain-input" type="number" min="0" step="10" />
        </div>
        <div class="hint">
          低于此价发邮件通知（默认取「典型区间下沿」与「当前价 × 0.95」中更低者，可手动改）
        </div>
      </div>

      <div class="field">
        <label>决策截止日</label>
        <div class="val val-row">
          <el-date-picker
            v-model="deadline"
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
            v-model.trim="email"
            class="plain-input wide"
            type="email"
            placeholder="请输入邮箱"
          />
          <a class="link-set" @click="goSetting">去设置</a>
        </div>
        <div class="hint">降价时邮件提醒，不填写邮箱则默认按照设置的邮箱发送</div>
      </div>

      <button class="btn" @click="handleSubscribe">订阅监控</button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { airportLabel } from '../../data/airports';
import { buildMockResult } from '../../data/mockResult';
import { useSettingsStore } from '../../stores/settings';
import { useSubscriptionsStore } from '../../stores/subscriptions';

const route = useRoute();
const router = useRouter();
const settings = useSettingsStore();
const subscriptions = useSubscriptionsStore();

/* ---------------------------------------------------------------------------
 * 查询参数：来自查询页的 router query
 * ------------------------------------------------------------------------ */
const params = {
  from: route.query.from || 'SZX',
  to: route.query.to || 'TYO',
  departDate: route.query.departDate || null,
  returnDate: route.query.returnDate || null,
  cabin: route.query.cabin || 'economy',
  passengers: Number(route.query.passengers) || 1,
  flexibility: route.query.flexibility || 'fixed',
};

const CABIN_LABEL = {
  economy: '经济舱',
  premium: '超级经济舱',
  business: '商务舱',
  first: '头等舱',
};
const cabinLabel = CABIN_LABEL[params.cabin] ?? '经济舱';

const WEEK_DAYS = ['一', '二', '三', '四', '五', '六', '日'];

/* ---------------------------------------------------------------------------
 * ⚠️ MOCK 数据入口：真实实现时这里要换成
 *    ① 并发请求「实时价 API + 价格日历 API」（走 Serverless 代理，key 不进前端）
 *    ② 把真实数据喂给 DeepSeek，拿回答案②（购买时机）的推理与文案
 *    详见 src/data/mockResult.js 顶部说明
 * ------------------------------------------------------------------------ */
const data = computed(() => buildMockResult(params));

/** 「怎么等」的标题：结论是「等」时是三件套；结论是「买」时是兜底方案 */
const watchTitle = computed(() =>
  data.value.timingAnswer.verdict === 'wait' ? '怎么等（三件套，缺一不可）' : '如果你还想再等等',
);

/* ---------------------------------------------------------------------------
 * 盯价（选一条航班作为监控基准；FlyOrWait 不卖票，不能下单）
 * MVP 做「航班级盯价」；若该航班连续多日匹配不到（售完/停飞），后端降级为「盯该航线最低价」
 * ------------------------------------------------------------------------ */
const pickedId = ref('');
const pickedFlight = computed(
  () => data.value.flights.find((f) => f.id === pickedId.value) ?? null,
);

/** 点「选」只是换盯价基准，列表高亮 + 下方订阅卡片回填已是反馈，不再弹提示 */
function togglePick(flight) {
  pickedId.value = pickedId.value === flight.id ? '' : flight.id;
}

/** 阈值：盯了航班用「该航班价 × 0.95」；没盯用数据层给的建议值 */
const threshold = ref(0);

/** 通知邮箱：默认回填「设置」里存的默认邮箱（没设过则为空，可在这里临时改） */
const email = ref(settings.email);

watch(
  pickedFlight,
  (flight) => {
    threshold.value = flight
      ? Math.round((flight.price * 0.95) / 10) * 10
      : data.value.suggestedThreshold;
  },
  { immediate: true },
);

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
  const suggested = data.value.timingAnswer.action.deadline;
  return suggested && suggested >= todayISO ? suggested : todayISO;
});

/** 用户当前设定的截止日（只初始化一次，用户改后不再被覆盖） */
const deadline = ref(recommendedDeadline.value);

const isRecommendedDeadline = computed(() => deadline.value === recommendedDeadline.value);

/** 出发日（整月最优时即 Agent 挑出的最优日）；截止日不得晚于它 */
const departISO = computed(() => data.value.selected.date);

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

/** 日历首格偏移：让 1 号对齐到正确的星期列（周一开头） */
const calendarOffset = computed(() => {
  const [y, m] = data.value.monthLabel.split('-').map(Number);
  return (new Date(y, m - 1, 1).getDay() + 6) % 7;
});

/** 价格 → 颜色（按当月价格分位映射：便宜绿 / 适中橙 / 偏贵红） */
function priceColor(price) {
  const { monthMin, monthMax } = data.value;
  const t = monthMax === monthMin ? 0 : (price - monthMin) / (monthMax - monthMin);
  if (t <= 0.33) return '#86efac';
  if (t <= 0.66) return '#fdba74';
  return '#fca5a5';
}

/** 回查询页，并带上当前条件回填表单 */
function handleEdit() {
  const query = {
    from: params.from,
    to: params.to,
    cabin: params.cabin,
    passengers: String(params.passengers),
    flexibility: params.flexibility,
  };
  if (params.departDate) query.departDate = params.departDate;
  if (params.returnDate) query.returnDate = params.returnDate;
  router.push({ name: 'discovery', query });
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

async function handleSubscribe() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    ElMessage.warning('请填写正确的通知邮箱');
    return;
  }

  // 出发日：固定日期用用户选的；整月最优时用 Agent 挑出的最优日
  const departDate = params.departDate || data.value.selected.date;
  const flight = pickedFlight.value;

  // TODO(后端 · W4)：改为调「新建订阅」接口写入 Supabase，同时注册该条的 Cron 检查。
  // 后端由 Vercel Cron 每天定时调用实时价 API 比价，低于阈值时发邮件。
  // 【AI】降价邮件正文由 DeepSeek 生成（含紧迫度 + 当前价 vs 阈值对比 + 下一步建议），不用固定模板。
  // 若已盯航班连续多日匹配不到 → 降级为「盯该航线最低价」并邮件告知用户。
  const res = subscriptions.addSubscription({
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

/* ---------- ②③ 两个答案卡片 ---------- */
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

/* 答案①：紫色系 */
.ans1 {
  border-color: #d9ccff;
  background: #fbfaff;
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

/* ---------- 区块标题 ---------- */
.sec-t {
  margin: 18px 0 10px;
  font-size: 15px;
  font-weight: 700;
  color: #1f2937;
}

/* ---------- ⑤ 价格日历（可展开） ---------- */
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

/* ---------- ⑥ 航班列表 ---------- */
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
table.f tbody tr {
  cursor: pointer;
  transition: background 0.15s;
}
table.f tbody tr:hover {
  background: #fafbff;
}
table.f tbody tr.picked {
  background: #eef3ff;
}
table.f .pr {
  font-weight: 800;
  color: #dc2626;
}
table.f .lowest {
  margin-left: 6px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 600;
  color: #16a34a;
  background: #e9f8ef;
  border-radius: 999px;
  vertical-align: 1px;
}
table.f .pick {
  padding: 6px 14px;
  font-size: 13px;
  color: #2f6bff;
  background: #fff;
  border: 1px solid #c9d6ff;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
table.f .pick:hover {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
}
table.f tr.picked .pick {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
}

/* ---------- ⑦ 订阅卡片 ---------- */
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
.btn:hover {
  background: #1e50d8;
}

@media (max-width: 640px) {
  table.f th:nth-child(3),
  table.f td:nth-child(3) {
    display: none;
  }
  .plain-input.wide {
    width: 180px;
  }
  .tri-k {
    flex: 0 0 92px;
    font-size: 12.5px;
  }
}
</style>
