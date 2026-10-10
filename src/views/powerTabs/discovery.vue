<template>
  <div class="discovery">
    <!-- 引导文案 -->
    <div class="hero">
      <h1 class="slogan">现在买，还是再等等？</h1>
      <p class="sub">输入航线，AI 帮你判断票价还会不会降</p>
    </div>

    <!-- 查询卡片 -->
    <div class="search">
      <!-- 单程 / 往返 -->
      <el-radio-group v-model="form.tripType" class="seg">
        <el-radio-button value="oneway">单程</el-radio-button>
        <el-radio-button value="round">往返</el-radio-button>
      </el-radio-group>

      <div class="grid">
        <!-- 出发地 / 目的地（中间夹交换按钮） -->
        <div class="od-row">
          <div class="field">
            <label>出发地</label>
            <el-select
              v-model="form.from"
              filterable
              placeholder="选择出发城市"
              class="plain"
              :teleported="true"
            >
              <el-option
                v-for="a in AIRPORTS"
                :key="a.code"
                :label="`${a.city} ${a.code}`"
                :value="a.code"
              />
            </el-select>
          </div>

          <div class="field">
            <label>目的地</label>
            <el-select
              v-model="form.to"
              filterable
              placeholder="选择到达城市"
              class="plain"
              :teleported="true"
            >
              <el-option
                v-for="a in AIRPORTS"
                :key="a.code"
                :label="`${a.city} ${a.code}`"
                :value="a.code"
              />
            </el-select>
          </div>

          <button class="swap-btn" type="button" title="交换出发地与目的地" @click="swapCities">
            ⇄
          </button>
        </div>

        <!-- 出发日期（单程时占满整行；往返时与返回日期平分） -->
        <div class="field" :class="{ full: !isRound }">
          <label>
            出发日期
            <span v-if="dateLocked" class="mut">（整月最优 · 由 AI 决定）</span>
          </label>
          <el-date-picker
            v-model="form.departDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择出发日期"
            :disabled-date="disabledDate"
            :disabled="dateLocked"
            class="plain"
          />
        </div>

        <!-- 返回日期（仅往返时出现） -->
        <div v-if="isRound" class="field">
          <label>返回日期</label>
          <el-date-picker
            v-model="form.returnDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择返回日期"
            :disabled-date="disabledDate"
            class="plain"
          />
        </div>

        <!-- 舱位 / 人数 -->
        <div class="field">
          <label>舱位</label>
          <el-select v-model="form.cabin" class="plain" :teleported="true">
            <el-option v-for="c in CABINS" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </div>

        <div class="field">
          <label>人数</label>
          <el-input-number
            v-model="form.passengers"
            :min="1"
            :max="9"
            :precision="0"
            :value-on-clear="1"
            class="plain"
            @change="onPassengersChange"
          />
        </div>

        <!-- 日期灵活度 -->
        <div class="field full">
          <label>日期灵活度（让 AI 帮你挑最优出发日）</label>
          <div class="flex-row">
            <span
              v-for="f in flexOptions"
              :key="f.value"
              class="flex-opt"
              :class="{ on: form.flexibility === f.value, dis: f.disabled }"
              @click="pickFlex(f)"
            >
              {{ f.label }}
            </span>
          </div>
          <!-- 往返暂不支持灵活日期：停留时长未定 → 「最便宜的行程」无从定义 -->
          <p v-if="isRound" class="flex-tip">
            往返要同时定「去」和「回」，暂时只支持固定日期。后续会加上「停留天数」，那时才能帮你挑最省的一趟。
          </p>
        </div>
      </div>

      <el-button type="primary" class="submit" @click="handleSearch">查询票价</el-button>

      <!-- ⚠️ 临时探针按钮（后端连通性测试，验完删）：同时删脚本里的 probeHealth 与样式 .probe -->
      <button class="probe" type="button" @click="probeHealth">测试 /api/health</button>
    </div>

    <!-- 热门航线 -->
    <div class="chips">
      <span
        v-for="r in HOT_ROUTES"
        :key="`${r.from}-${r.to}`"
        class="chip"
        @click="pickHotRoute(r)"
      >
        {{ findAirport(r.from)?.city }} → {{ findAirport(r.to)?.city }}
      </span>
    </div>

    <p class="hint">登录后可同步订阅与通知记录 · 当前为本地预览，数据来自 Mock</p>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { http } from '../../api/index.js';
import { AIRPORTS, findAirport } from '../../data/airports';
import { useSettingsStore } from '../../stores/settings';

const route = useRoute();
const router = useRouter();
/** 本地用量账本：每次查询按数据源用量累加，设置页据此展示「本月 API 用量」 */
const settings = useSettingsStore();

/** 舱位选项 */
const CABINS = [
  { value: 'economy', label: '经济舱' },
  { value: 'premium', label: '超级经济舱' },
  { value: 'business', label: '商务舱' },
  { value: 'first', label: '头等舱' },
];

/** 日期灵活度：非「固定日期」时把日期范围交给 Agent 扫描 */
const FLEX_OPTIONS = [
  { value: 'fixed', label: '固定日期' },
  { value: 'plus3', label: '±3 天' },
  { value: 'plus7', label: '±7 天' },
  { value: 'month', label: '整月最优' },
];

/** 热门航线（点击仅回填表单，需用户自己点「查询票价」） */
const HOT_ROUTES = [
  { from: 'SZX', to: 'TYO' },
  { from: 'PVG', to: 'SEL' },
  { from: 'PEK', to: 'BKK' },
  { from: 'CAN', to: 'SIN' },
];

const form = reactive({
  tripType: 'oneway', // oneway 单程 / round 往返
  from: 'SZX',
  to: 'TYO',
  departDate: '',
  returnDate: '',
  cabin: 'economy',
  passengers: 1,
  flexibility: 'fixed', // fixed / plus3 / plus7 / month
});

const isRound = computed(() => form.tripType === 'round');
/** 整月最优：出发日期交给 Agent 定，日期框灰显 */
const dateLocked = computed(() => form.flexibility === 'month');

/**
 * 日期灵活度：往返时锁死为「固定日期」（见下方 pickFlex 说明）
 * 「单程」那一侧才有「让 AI 挑最优日」的空间
 */
const flexOptions = computed(() =>
  FLEX_OPTIONS.map((f) => ({ ...f, disabled: isRound.value && f.value !== 'fixed' })),
);

/** 往返暂不支持灵活日期：停留时长未定，二维里没有「最便宜」只有「最便宜的某个行程」 */
function pickFlex(f) {
  if (f.disabled) return;
  form.flexibility = f.value;
}

/**
 * 往返 ↔ 单程切换
 *   切到往返 → 灵活度回落「固定日期」（灵活日期在往返下未支持）
 *   切回单程 → 清掉返回日期，避免残留脏数据
 *   （初始化从 URL 回填时不触发：watch 非 immediate）
 */
watch(isRound, (round, wasRound) => {
  if (round) {
    form.flexibility = 'fixed';
  } else if (wasRound) {
    form.returnDate = '';
  }
});

/** 今天零点，用于禁用过去的日期 */
const todayZero = new Date();
todayZero.setHours(0, 0, 0, 0);
const disabledDate = (date) => date.getTime() < todayZero.getTime();

/** 把表单整理成结果页需要的 query 参数（空值不传，保持 URL 干净） */
function toQuery() {
  const query = {
    from: form.from,
    to: form.to,
    cabin: form.cabin,
    passengers: String(form.passengers),
    flexibility: form.flexibility,
  };
  if (!dateLocked.value && form.departDate) query.departDate = form.departDate;
  if (isRound.value && form.returnDate) query.returnDate = form.returnDate;
  return query;
}

/** 表单校验，通过返回 true */
function validate() {
  if (!form.from || !form.to) {
    ElMessage.error('请选择出发地与目的地');
    return false;
  }
  if (form.from === form.to) {
    ElMessage.error('出发地与目的地不能相同');
    return false;
  }
  if (!dateLocked.value && !form.departDate) {
    ElMessage.error('请选择出发日期');
    return false;
  }
  if (isRound.value) {
    if (!form.returnDate) {
      ElMessage.error('往返行程请选择返回日期');
      return false;
    }
    const base = form.departDate || new Date().toISOString().slice(0, 10);
    if (form.returnDate < base) {
      ElMessage.error('返回日期不能早于出发日期');
      return false;
    }
  }
  return true;
}

/**
 * 一次查询的 API 调用次数（对齐已定的调用模型）
 *   固定日期 / 整月最优 → 2 次（1 次日历 + 1 次单日航班含时机数据）
 *   ±3 / ±7            → 3 次（多一次查最优日的历史档位）
 */
const API_CALLS_BY_FLEX = { fixed: 2, plus3: 3, plus7: 3, month: 2 };

/**
 * ⚠️ 临时探针（后端连通性测试，验完即删）
 * 点一下调一次 `/api/health`，把返回打到浏览器控制台（F12 → Console）。
 * 验的是整条链路：页面 → vite 代理 → 本地函数运行器(3000) → api/health.js
 * 按约定：成功只打控制台，失败才弹提示。
 */
async function probeHealth() {
  try {
    const data = await http.get('/health');
    console.log('[探针] ✅ /api/health 通了，返回：', data);
  } catch (e) {
    console.error('[探针] ❌ /api/health 失败：', e);
    ElMessage.error(`探针失败：${e.message}`);
  }
}

/** →【API】接入后这里改为真实请求，用量统计交给服务端，trackApiCall 删掉即可 */
function handleSearch() {
  if (!validate()) return;
  settings.trackApiCall(API_CALLS_BY_FLEX[form.flexibility] ?? 2);
  router.push({ name: 'result', query: toQuery() });
}

/** 热门航线：只回填表单，不触发查询 */
function pickHotRoute(route) {
  form.from = route.from;
  form.to = route.to;
}

/** 交换出发地与目的地 */
function swapCities() {
  const t = form.from;
  form.from = form.to;
  form.to = t;
}

/** 人数兜底：只接受 1~9 的整数，空值 / 小数 / 非正数一律回落为 1 */
function onPassengersChange(val) {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) {
    form.passengers = 1;
  } else if (n > 9) {
    form.passengers = 9;
  }
}

/** 从结果页点「修改」回来时，用 URL 上的 query 回填表单 */
onMounted(() => {
  const q = route.query;
  if (!q.from) return;

  form.from = q.from;
  form.to = q.to || form.to;
  if (q.cabin) form.cabin = q.cabin;
  if (q.passengers) form.passengers = Number(q.passengers) || 1;
  if (q.flexibility) form.flexibility = q.flexibility;
  if (q.departDate) form.departDate = q.departDate;
  if (q.returnDate) {
    form.tripType = 'round';
    form.returnDate = q.returnDate;
  }
});
</script>

<style scoped>
.discovery {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 20px 60px;
}

/* ---------- 引导文案 ---------- */
.hero {
  margin-bottom: 26px;
  text-align: center;
}
.slogan {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: 0.5px;
  color: #1f2937;
}
.sub {
  margin: 0;
  font-size: 15px;
  color: #6b7280;
}

/* ---------- 查询卡片 ---------- */
.search {
  max-width: 760px;
  margin: 0 auto;
  padding: 20px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  box-shadow: 0 6px 24px rgba(17, 24, 39, 0.08);
}

.seg {
  margin-bottom: 16px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.field {
  padding: 10px 14px;
  background: #f5f7fa;
  border: 1px solid #eef0f3;
  border-radius: 12px;
  transition: border-color 0.2s;
}
.field:focus-within {
  border-color: #c9d6ff;
}
.field.full {
  grid-column: 1 / -1;
}
.field label {
  display: flex;
  align-items: center;
  margin-bottom: 2px;
  font-size: 12px;
  color: #6b7280;
}
.field .mut {
  margin-left: 4px;
  font-size: 12px;
  color: #9ca3af;
}
/* 出发地 / 目的地：交换按钮悬浮在两框正中间 */
.od-row {
  position: relative;
  display: grid;
  grid-column: 1 / -1;
  /* 留出 40px 按钮 + 左右各 12px 的间距，按钮不会压到输入框 */
  grid-template-columns: 1fr 1fr;
  gap: 64px;
}
.swap-btn {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  font-size: 20px;
  line-height: 1;
  color: #2f6bff;
  background: #fff;
  border: 1px solid #dbe4ff;
  border-radius: 50%;
  box-shadow: 0 2px 10px rgba(47, 107, 255, 0.2);
  cursor: pointer;
  transform: translate(-50%, -50%);
  transition:
    color 0.2s,
    background 0.2s,
    border-color 0.2s,
    transform 0.3s;
}
.swap-btn:hover {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
  transform: translate(-50%, -50%) rotate(180deg);
}

/* 日期灵活度 */
.flex-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
.flex-opt {
  padding: 7px 14px;
  font-size: 13px;
  color: #6b7280;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.flex-opt:hover {
  border-color: #c9d6ff;
}
.flex-opt.on {
  font-weight: 600;
  color: #1e50d8;
  background: #eef3ff;
  border-color: #2f6bff;
}
/* 往返下禁用（灵活日期未支持） */
.flex-opt.dis {
  color: #c4c8d0;
  background: #f7f8fa;
  cursor: not-allowed;
}
.flex-opt.dis:hover {
  border-color: #e5e7eb;
}
.flex-tip {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: #9ca3af;
}

.submit {
  width: 100%;
  height: 48px;
  margin-top: 16px;
  font-size: 16px;
  font-weight: 700;
  border-radius: 12px;
}

/* ⚠️ 临时探针按钮（验完删） */
.probe {
  width: 100%;
  height: 34px;
  margin-top: 10px;
  font-size: 12.5px;
  color: #6b7280;
  background: #fff;
  border: 1px dashed #d1d5db;
  border-radius: 10px;
  cursor: pointer;
}
.probe:hover {
  color: #2f6bff;
  border-color: #2f6bff;
}

/* ---------- 热门航线 ---------- */
.chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 22px 0 6px;
}
.chip {
  padding: 8px 16px;
  font-size: 13px;
  color: #1f2937;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.2s;
}
.chip:hover {
  color: #1e50d8;
  background: #eef3ff;
  border-color: #2f6bff;
}

.hint {
  margin-top: 14px;
  font-size: 13px;
  color: #9ca3af;
  text-align: center;
}

/* ---------- 让 Element 控件嵌进 field 卡片（去边框、去底色） ---------- */
.plain {
  width: 100%;
}
.field :deep(.el-select__wrapper),
.field :deep(.el-input__wrapper) {
  padding: 0;
  background: transparent;
  box-shadow: none;
}
.field :deep(.el-input__inner) {
  height: 26px;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}
.field :deep(.el-input-number) {
  width: 100%;
}
/* 人数：给左右两侧的 − / + 步进按钮让出位置，避免文字被图标遮挡 */
.field :deep(.el-input-number) {
  --el-input-number-controls-width: 30px;
}
.field :deep(.el-input-number .el-input__wrapper) {
  padding: 0 46px;
}
.field :deep(.el-input-number .el-input__inner) {
  text-align: left;
}
.field :deep(.el-input-number__decrease),
.field :deep(.el-input-number__increase) {
  width: 30px;
  color: #6b7280;
  background: transparent;
}

/* 移动端单列 */
@media (max-width: 640px) {
  .grid,
  .od-row {
    grid-template-columns: 1fr;
  }
  /* 单列时交换按钮改为竖排在两个输入框中间 */
  .od-row .field:first-of-type {
    order: 1;
  }
  .swap-btn {
    position: static;
    order: 2;
    margin: -2px auto;
    transform: rotate(90deg);
  }
  .swap-btn:hover {
    transform: rotate(90deg);
  }
  .od-row .field:last-of-type {
    order: 3;
  }
  .slogan {
    font-size: 24px;
  }
}
</style>
