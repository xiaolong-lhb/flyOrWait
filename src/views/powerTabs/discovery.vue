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

        <!--
          舱位：**已砍掉**（2026-10-23 决定）。
          日历源 api/_apify.js 里 cabinClass 是硬编码 economy，判据也按经济舱分位算，
          留着「商务舱 / 头等舱」选项 = 让人以为选了就查商务舱，实际返回的是经济舱的数。
          与其做一个算错的选项，不如不提供 —— 这不是产品核心，以后要加成本很低。
          ⇒ 人数独占一行（原来是和舱位平分一行，舱位删了不补 full 会留半个空格子）。
        -->
        <div class="field full">
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
    </div>

    <!-- 热门航线 -->
    <div class="chips">
      <span
        v-for="r in HOT_ROUTES"
        :key="`${r.from}-${r.to}`"
        class="chip"
        @click="pickHotRoute(r)"
      >
        {{ findAirport(r.from)?.city ?? r.from }} → {{ findAirport(r.to)?.city ?? r.to }}
      </span>
    </div>

    <p class="hint">
      票价与日历均来自实时查询（Google Flights 数据链路），价格随行情变动，仅供参考
    </p>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { AIRPORTS, findAirport } from '../../data/airports';

const route = useRoute();
const router = useRouter();

/** 日期灵活度：非「固定日期」时把日期范围交给 Agent 扫描 */
const FLEX_OPTIONS = [
  { value: 'fixed', label: '固定日期' },
  { value: 'plus3', label: '±3 天' },
  { value: 'plus7', label: '±7 天' },
  { value: 'month', label: '整月最优' },
];

/**
 * 热门航线（点击仅回填表单，需用户自己点「查询票价」）
 * ⚠️ 这里的每个 code 都必须存在于 src/data/airports.js —— 机场表只收国内 + 中国港澳台，
 *    写表外的 code 不会报错，只会让 chip 上的城市名静默变空白（10-14 删国际机场时踩过）。
 */
const HOT_ROUTES = [
  { from: 'SZX', to: 'PEK' },
  { from: 'PVG', to: 'CTU' },
  { from: 'PEK', to: 'LJG' },
  { from: 'CAN', to: 'TPE' },
];

const form = reactive({
  tripType: 'oneway', // oneway 单程 / round 往返
  from: 'SZX',
  to: 'PEK',
  departDate: '',
  returnDate: '',
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
    ElMessage.warning('请选择出发地与目的地');
    return false;
  }
  if (form.from === form.to) {
    ElMessage.warning('出发地与目的地不能相同');
    return false;
  }
  if (!dateLocked.value && !form.departDate) {
    ElMessage.warning('请选择出发日期');
    return false;
  }
  if (isRound.value) {
    if (!form.returnDate) {
      ElMessage.warning('往返行程请选择返回日期');
      return false;
    }
    const base = form.departDate || new Date().toISOString().slice(0, 10);
    if (form.returnDate < base) {
      ElMessage.warning('返回日期不能早于出发日期');
      return false;
    }
  }
  return true;
}

/** 发起查询：只负责校验 + 跳转，跳过去由结果页真正打后端（次数由后端记账） */
function handleSearch() {
  if (!validate()) return;
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
