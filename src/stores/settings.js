import { defineStore } from 'pinia';
import { ref } from 'vue';
import http from '../api/index.js';

/**
 * 用户设置（通知邮箱 / 邮件开关）+ 本月查询次数
 *
 * ── 为什么从 localStorage 搬到后端 ──
 * 原来这两项配置存在浏览器里，有两个毛病：
 *   ① 换浏览器 / 清缓存就没了；
 *   ② 更要命的是 —— 将来 Cron 在**服务端**跑，读的是数据库，
 *      读不到 localStorage。于是「订阅时带的邮箱」只在设置它的那台机器上有效，
 *      等于半个摆设。落库之后，配置才真正跟着用户走（见 api/settings.js 顶部说明）。
 *
 * ── 数据分工（与订阅那套完全一致）──
 * 前端不维护数据，只把后端当前的样子画出来：
 *   · 读 → fetchSettings()，「注册完成」标志保证结果页拿到真邮箱再初始化表单
 *   · 写 → saveSettings()，写到后端后**用后端回传的形状覆盖本地**，不自己拼
 *   · 「本月查询次数」是纯只读的服务端统计，前端算不出来也不该算
 *     （谁查的、查了几次，只有后端记账，见 api/_queryLog.js）
 *
 * ⚠️ 与订阅的区别：设置失败只影响设置本身，不该拖住整个应用，
 *    所以**不抛错给页面**，而是记在 `error` 上由设置页决定怎么提示。
 */
export const useSettingsStore = defineStore('settings', () => {
  /** 默认通知邮箱：结果页的订阅卡片用它作为初始值（没设过则为空） */
  const email = ref('');

  /** 邮件通知总开关：关掉后不再发降价邮件（订阅本身仍在监控） */
  const emailNotify = ref(true);

  /** 本月查询次数（服务端统计） */
  const queryCount = ref(0);

  /** 统计所属月份 'YYYY-MM' —— 页面展示用得上 */
  const month = ref('');

  /** 「已从后端取过一轮」—— 结果页据此判断「能不能拿 email 初始化表单了」 */
  const loaded = ref(false);

  /** 最近一次同步失败的原因（null = 没有错误）。页面按需展示，不弹全局提示 */
  const error = ref(null);

  /** 是否正在与后端同步（保存时给输入框一个禁用态，防止重复提交） */
  const saving = ref(false);

  /**
   * 从后端拉配置 + 本月查询次数。
   * 进入应用后调用一次即可；失败不抛错，把原因记在 error 上。
   * @returns {Promise<boolean>} 是否成功
   */
  async function fetchSettings() {
    try {
      const data = await http.get('/settings');
      applySettings(data);
      error.value = null;
      return true;
    } catch (e) {
      error.value = e?.message || '读取设置失败';
      return false;
    } finally {
      // 无论成败都标记「跑过一轮」：否则网络坏掉时结果页会永远空等一个邮箱。
      // 拿不到就用默认值（空邮箱）—— 至少页面可操作，用户能自己填。
      loaded.value = true;
    }
  }

  /**
   * 保存配置。PUT 之后**用后端回传覆盖本地**，与订阅「写指令 → 以后端为准」一致。
   * @param {{email?: string, notifyEnabled?: boolean}} patch 只传要改的字段
   * @returns {Promise<boolean>} 是否成功
   */
  async function saveSettings(patch) {
    // 先算出「提交后的样子」——邮箱和开关可能只改一个，另一个保持现值
    const payload = {
      email: patch.email !== undefined ? patch.email : email.value,
      notifyEnabled: patch.notifyEnabled !== undefined ? patch.notifyEnabled : emailNotify.value,
    };

    saving.value = true;
    try {
      const data = await http.put('/settings', payload);
      applySettings(data);
      error.value = null;
      return true;
    } catch (e) {
      error.value = e?.message || '保存设置失败';
      // ⚠️ 写失败时**不回滚本地**：用户刚敲的东西留在框里，让他能改完再试。
      //    这与订阅不同（订阅是列表，回滚不影响输入）——
      //    设置页的输入框若被我们悄悄改回旧值，用户会觉得「白填了」。
      return false;
    } finally {
      saving.value = false;
    }
  }

  /** 把后端返回的形状铺到本地（读与写共用，防止两处字段映射漂移） */
  function applySettings(data) {
    if (!data) return;
    if (data.email !== undefined) email.value = data.email ?? '';
    if (data.notifyEnabled !== undefined) emailNotify.value = data.notifyEnabled !== false;
    // 查询次数只在 GET 时返回（PUT 不返回），有才覆盖 —— 免得保存一次把数字清零
    if (data.queryCount !== undefined) queryCount.value = data.queryCount ?? 0;
    if (data.month !== undefined) month.value = data.month ?? '';
  }

  return {
    email,
    emailNotify,
    queryCount,
    month,
    loaded,
    error,
    saving,
    fetchSettings,
    saveSettings,
  };
});
