import { defineStore } from 'pinia';
import { ref } from 'vue';

import { http } from '../api/index.js';

/**
 * 订阅（盯价监控）· 数据唯一来源是后端
 *
 * 没有前端缓存：items / logs 都从空数组起步，进页面 fetchSubscriptions() 拉到什么就以什么为准。
 * localStorage 已退场 —— 它被「写完重新拉」取代后只剩害处：会留下「本地有、库里没有」的假象
 * （尤其那些 id 根本不在库里的种子数据，点暂停 / 保存会打到不存在的 id）。
 *
 *   列表        → GET    /api/subscriptions
 *   新建        → POST   /api/subscriptions          （重复 → 409 / 4090）
 *   取消        → DELETE /api/subscriptions/:id
 *   暂停 / 恢复 → PATCH  /api/subscriptions/:id      { status }
 *   改配置      → PATCH  /api/subscriptions/:id      { threshold, email, deadline }
 *
 * ★★ 一条总规则：**前端不维护数据，只把数据库的当前样子画出来。**
 *    写操作一律「发指令 → 重新拉一次 → 整体覆盖」，见 writeAndSync()。
 *    不在本地 unshift / filter / Object.assign —— 位置、顺序、条数全由后端说了算，
 *    否则等于把后端的排序 / 过滤规则抄一份到前端，后端一改前端就静默排错。
 *
 * loading 由 store 统一管（每次触达后端都置位），页面拿它显示转圈。
 * 失败不在这里吞 —— 抛给调用方（页面）决定弹什么、要不要停在编辑态。
 *
 * currentPrice / lastNotified 由 Cron 每天比价后回写，前端只读。
 * 字段翻译（from ↔ origin 等）只在后端做，store 只说业务语言，见 api/_translate.js。
 */

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  /** 订阅列表 —— 唯一来源是后端，进页面 fetchSubscriptions() 拉到什么就是什么 */
  const items = ref([]);

  /**
   * 通知流水（降价提醒的历史记录）
   *   形状：[{ id, from, to, price, status, notifiedAt }]，见 api/notifications.js
   *   status 是枚举 'sent' / 'failed'，翻成人话由页面做（与 items 的 status 同一套做法）
   *   谁来写入这张表：将来 Cron 比价跌破阈值时写；现在库里是测试数据
   */
  const logs = ref([]);

  /** 是否正在和后端同步（进页面拉取、写完重新拉都算）→ 页面据此显示 loading */
  const loading = ref(false);

  /**
   * 拉取「我的订阅」：从后端读，成功后整体覆盖本地列表
   *
   * 失败不在这里吞掉，直接把错误抛给调用方：约定是「只有失败才提示」，
   * 至于弹什么，由调用方（页面）决定，store 不替它做主。
   * 抛出的错误已是归一化后的 { code, message, status }，见 src/api/index.js 的拦截器。
   *
   * 注意 http.get 拿到的已经是「响应体的 data」本身（拦截器帮剥了壳），
   * 所以下面赋值时不需要再 .data 一次，拿到的就是订阅数组。
   */
  async function fetchSubscriptions() {
    loading.value = true;
    try {
      items.value = await http.get('/subscriptions');
    } finally {
      loading.value = false;
    }
  }

  /**
   * 拉取通知记录 → GET /api/notifications
   *
   * 刻意**不动 loading**：它和 fetchSubscriptions 是并行发的两个请求，
   * 谁先回来都把 loading 置 false 的话，另一个还在路上页面就提前撤掉转圈了。
   * loading 只归「主内容」（订阅列表）管，通知记录是附加信息。
   *
   * 失败不吞，抛给页面 —— 但页面会区分对待：列表失败是致命的，记录失败只提醒一句。
   */
  async function fetchLogs() {
    logs.value = await http.get('/notifications');
  }

  /**
   * 写操作的统一外壳：跑完这个写请求 → 重新拉一次列表，让后端的当前状态覆盖本地。
   *
   * ★ 前端不维护列表：不 unshift、不 filter、不 assign —— 顺序、条数、字段全由后端说了算。
   *   否则等于把后端的排序 / 过滤规则抄了一份到前端，后端一改，前端就静默排错。
   *   代价是多一次 list 请求（本项目可忽略）。
   *
   * ⚠️ 两层 try 是刻意的，别合并：
   *   外层 = 写请求失败（真·操作失败，交给调用方翻译，比如 4090 = 重复订阅）；
   *   内层 = 写**已经成功**、只是紧接着的刷新失败。这时必须说「操作已完成」，
   *          否则页面会报「操作失败」—— 那是反向的谎（明明存上了却说没存上）。
   */
  async function writeAndSync(request, { refreshLogs = false } = {}) {
    loading.value = true;
    try {
      await request;
      try {
        items.value = await http.get('/subscriptions');
        // 只有「取消订阅」需要刷记录：删订阅后，**没有航线快照的老行**会失去 join 结果，
        // 不重拉的话页面还留着「有航线」的旧渲染，下次进页面才突然变空（前后不一致）。
        // 有快照的行内容其实不变 —— 记录本来就该留下；但「后端为准」这条不搞例外。
        // 刷记录失败**不该**连累「操作已完成」的判定，所以单独 catch 掉。
        if (refreshLogs) await fetchLogs().catch(() => {});
      } catch {
        throw { code: -1, message: '操作已完成，但列表刷新失败，请刷新页面查看', status: 0 };
      }
    } finally {
      loading.value = false;
    }
  }

  /** 同航线 + 同出发日 + 同邮箱 = 重复订阅（原型验收点：不重复订阅） */
  const findDuplicate = ({ from, to, departDate, email }) =>
    items.value.find(
      (s) => s.from === from && s.to === to && s.departDate === departDate && s.email === email,
    );

  /**
   * 新建订阅 → POST /api/subscriptions
   *
   * @param {{from:string,to:string,departDate:string,returnDate?:string|null,flight:object|null,basePrice:number,threshold:number,deadline:string,email:string,cabin?:string,passengers?:number}} payload
   *   returnDate 为往返的返程日（单程为 null）—— Cron 比价必须按「往返组合价」查，不能只查去程
   *   payload 只说业务语言（from / departDate…），数据库列名由后端翻译，这里不碰
   * @returns {Promise<{ok:boolean}>} ok=false 表示「重复订阅」
   *
   * 两层防重是刻意的（与「前端体验门 / 后端防线」同一套思路）：
   *   ① 先查本地列表 —— 命中就省掉一次注定 409 的请求（不用调接口能判的事，前端先判）
   *   ② 后端唯一约束才是事实 —— 本地列表可能不全（比如刚被别处加过），
   *      所以还要接住后端回的 409 / 4090。两处都撞不到，才真的写进去。
   */
  async function addSubscription(payload) {
    const dup = findDuplicate(payload);
    if (dup) return { ok: false };

    try {
      await writeAndSync(http.post('/subscriptions', payload));
    } catch (e) {
      // 4090 = 撞了数据库唯一索引（同航线 + 同出发日 + 同邮箱）
      if (e.code === 4090) return { ok: false };
      throw e; // 其它失败（断网 / 500…）交给页面提示
    }

    return { ok: true };
  }

  /**
   * 取消订阅 → DELETE /api/subscriptions/:id
   * 后端同时停掉该条的比价；它的历史通知流水**保留**（记录是已经发生过的事实，
   * 删订阅只表示「别再盯了」）。所以写完两样都要重拉：订阅少一条，通知记录一条不少。
   */
  async function removeSubscription(id) {
    await writeAndSync(http.delete(`/subscriptions/${id}`), { refreshLogs: true });
  }

  /**
   * 暂停 / 恢复 → PATCH /api/subscriptions/:id { status }
   * 目标值由当前状态推出来（active ↔ paused），不由调用方传 —— 调用方只需给 id。
   */
  async function toggleStatus(id) {
    const s = items.value.find((x) => x.id === id);
    if (!s) return;
    // 过期的没有「暂停 / 恢复」这回事（航班已经飞了）。
    // 页面不会给这个入口，但 store 是公共出口 —— 不靠 UI 兜底，否则三元会把 expired 推成 'active'。
    if (s.status === 'expired') {
      throw { code: 4000, message: '该订阅已过期，不能切换状态', status: 400 };
    }
    const status = s.status === 'active' ? 'paused' : 'active';
    await writeAndSync(http.patch(`/subscriptions/${id}`, { status }));
  }

  /**
   * 改订阅配置 → PATCH /api/subscriptions/:id { threshold, email, deadline }
   * @param {object} patch 只放要改的字段；后端用白名单过滤，其余键一律丢弃
   */
  async function updateSubscription(id, patch) {
    await writeAndSync(http.patch(`/subscriptions/${id}`, patch));
  }

  return {
    items,
    logs,
    loading,
    fetchSubscriptions,
    fetchLogs,
    findDuplicate,
    addSubscription,
    removeSubscription,
    toggleStatus,
    updateSubscription,
  };
});
