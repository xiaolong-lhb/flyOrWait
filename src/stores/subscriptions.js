import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

const LS_KEY = 'fow:subscriptions';

const pad2 = (n) => String(n).padStart(2, '0');
const nowText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * 订阅（盯价监控）
 *
 * ⚠️ 未接入后端：先落 localStorage，让未登录状态也能攒下订阅。
 *    接入后替换点：
 *      ① 读取      → Supabase `subscriptions` / `notify_log`（按登录用户过滤）
 *      ② 新建订阅  → 写 `subscriptions` 表，同时注册该条的 Cron 检查
 *      ③ currentPrice / lastNotified → 由 Vercel Cron 每天比价后回写
 *      ④ 取消订阅  → 停掉该条的 Cron 检查（验收点：取消后不再监控）
 *      ⑤ 改配置    → 阈值 / 邮箱 / 截止日在「我的订阅」里就地改，改完即回写
 */

/** 首次进入时给的示例（对应原型屏幕③的两条）——本地已有记录则不再注入 */
const SEED = {
  items: [
    {
      id: 'sub_seed_1',
      from: 'SZX',
      to: 'TYO',
      departDate: '2026-11-12',
      flight: { id: 'ZH0820', airline: '深航 ZH', departTime: '08:20', stopText: '直飞' },
      basePrice: 2180, // 订阅那一刻的价格（全列表最低 or 指定航班价）
      currentPrice: 2180, // →【API】Cron 每天回写的「当前最低」
      threshold: 2000,
      deadline: '2026-10-22',
      email: 'master@mail.com',
      status: 'active', // active 监控中 / paused 已暂停
      createdAt: '2026-10-05 10:20',
      lastNotified: null,
    },
    {
      id: 'sub_seed_2',
      from: 'PVG',
      to: 'SEL',
      departDate: '2026-12-01',
      flight: { id: 'MU5101', airline: '东航 MU', departTime: '10:35', stopText: '直飞' },
      basePrice: 1560,
      currentPrice: 1540,
      threshold: 1400,
      deadline: '2026-11-10',
      email: 'master@mail.com',
      status: 'paused',
      createdAt: '2026-09-10 09:30',
      lastNotified: '09-25 降价至 ¥1,520',
    },
  ],
  // →【API】notify_log 表：每次跌破阈值发信后追加一条
  logs: [
    { id: 'log_1', time: '09-25 09:12', from: 'PVG', to: 'SEL', price: 1520, status: '已邮件通知' },
    { id: 'log_2', time: '09-18 09:12', from: 'PVG', to: 'SEL', price: 1560, status: '已邮件通知' },
  ],
};

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const cached = (() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();

  const items = ref(cached?.items ?? SEED.items);
  const logs = ref(cached?.logs ?? SEED.logs);

  watch(
    [items, logs],
    () => {
      localStorage.setItem(LS_KEY, JSON.stringify({ items: items.value, logs: logs.value }));
    },
    { deep: true },
  );

  /** 同航线 + 同出发日 + 同邮箱 = 重复订阅（原型验收点：不重复订阅） */
  const findDuplicate = ({ from, to, departDate, email }) =>
    items.value.find(
      (s) => s.from === from && s.to === to && s.departDate === departDate && s.email === email,
    );

  /**
   * 新建订阅
   * @param {{from:string,to:string,departDate:string,returnDate?:string|null,flight:object|null,basePrice:number,threshold:number,deadline:string,email:string,cabin?:string,passengers?:number}} payload
   *   returnDate 为往返的返程日（单程为 null）—— Cron 比价必须按「往返组合价」查，不能只查去程
   *   @returns {{ok:boolean, item?:object}} ok=false 表示重复订阅
   */
  function addSubscription(payload) {
    const dup = findDuplicate(payload);
    if (dup) return { ok: false, item: dup };
    const item = {
      id: `sub_${Date.now()}`,
      status: 'active',
      createdAt: nowText(),
      currentPrice: payload.basePrice,
      lastNotified: null,
      ...payload,
    };
    items.value.unshift(item);
    return { ok: true, item };
  }

  /** 取消订阅 → 后端应同时停掉该条的 Cron 检查 */
  function removeSubscription(id) {
    items.value = items.value.filter((s) => s.id !== id);
  }

  /** 暂停 / 恢复（暂停期间后端跳过比价） */
  function toggleStatus(id) {
    const s = items.value.find((x) => x.id === id);
    if (s) s.status = s.status === 'active' ? 'paused' : 'active';
  }

  /**
   * 改订阅配置：提醒阈值 / 通知邮箱 / 决策截止日 —— 改完实时生效（验收点）
   * →【API】后端需同步更新该条订阅：Cron 比价目标、收信地址、决策期限
   */
  function updateSubscription(id, patch) {
    const s = items.value.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  }

  return {
    items,
    logs,
    findDuplicate,
    addSubscription,
    removeSubscription,
    toggleStatus,
    updateSubscription,
  };
});
