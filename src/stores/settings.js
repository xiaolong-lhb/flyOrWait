import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

const LS_KEY = 'fow:settings';

/**
 * 免费层额度（成本红线参考值：约撑 3 个订阅）
 * →【API】接入后改为读服务端返回的实际配额与用量
 */
const MONTHLY_QUOTA = 100;

const pad2 = (n) => String(n).padStart(2, '0');
/** 当前年月，用于「本月用量」跨月归零 */
const monthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};

/**
 * 用户设置 + 本地用量账本
 *
 * ⚠️ 未接入后端：先落 localStorage。
 *    接入后替换点：
 *      ① 初始化 → 登录后从「用户配置」接口拉取（邮箱 / 邮件开关）
 *      ② 写回   → 调「保存用户配置」接口
 *      ③ 用量   → 改为读服务端统计，trackApiCall 的调用点一并删掉
 */
export const useSettingsStore = defineStore('settings', () => {
  const cached = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  })();

  /** 默认通知邮箱：结果页的订阅卡片用它作为初始值（没设过则为空） */
  const email = ref(cached.email || '');

  /** 邮件通知总开关：关掉后不再发降价邮件（订阅本身仍在监控） */
  const emailNotify = ref(cached.emailNotify !== false);

  /** 本月 API 用量 { month: 'YYYY-MM', used: n } —— 与当前月份不符时视为过期，从 0 起算 */
  const usage = ref(
    cached.usage?.month === monthKey() ? cached.usage : { month: monthKey(), used: 0 },
  );

  watch(
    [email, emailNotify, usage],
    () => {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          email: email.value,
          emailNotify: emailNotify.value,
          usage: usage.value,
        }),
      );
    },
    { deep: true },
  );

  /** 已用次数：读取时再校一次月份，防止页面开着跨了月还显示上月数字 */
  const apiUsed = computed(() => (usage.value.month === monthKey() ? usage.value.used : 0));

  const apiQuota = MONTHLY_QUOTA;

  /**
   * 记一次 API 调用（联调前的本地账本）
   * @param {number} n 次数 —— 一次查询按数据源用量估算：固定日期 2 次、±3/±7 为 3 次、整月最优 2 次
   */
  function trackApiCall(n = 1) {
    if (usage.value.month !== monthKey()) usage.value = { month: monthKey(), used: 0 };
    usage.value.used += n;
  }

  return { email, emailNotify, apiUsed, apiQuota, trackApiCall };
});
