import { defineStore } from 'pinia';
import { ref } from 'vue';

import { http } from '../api/index.js';

/**
 * 结果页查询 · 一次查询的全部状态
 *
 * 与 subscriptions store 的区别（刻意不照抄它的写法）：
 *   subscriptions 是**长期存在的资源**（列表要跨页面保持、写操作后重拉），所以它的写方法
 *   把错误**抛给调用方**，由页面决定弹什么。
 *   而这里是一次**一次性查询**：loading / 成功 / 失败 三种状态本身就是整屏的 UI，
 *   没有一个「调用方还要再决定」的余地 ⇒ 错误由 store 收成 error 字段，页面直接渲染。
 *
 * ⚠️ 为什么不在前端做缓存、不做「同参数跳过重复请求」：
 *   /api/result 每打一次就真花一次钱（Apify 按行计费），但**缓存会让用户以为看到的是新价**。
 *   票价的产品语义就是「此刻的报价」，宁可每次真查、页面明说快照时间，也不给一个假的新鲜感。
 *   真要省，就省在别处（开发期用 APIFY_REPLAY=1 / SERP_REPLAY=1，零成本）。
 *
 *   查询     → GET /api/result?from=&to=&departDate=&cabin=&passengers=&flexibility=
 */

export const useResultStore = defineStore('result', () => {
  /** 结果页的全部数据（形状由 api/_compose.js 的 composeResult 决定） */
  const data = ref(null);

  /** 是否正在查询 —— 首次查询要 20~60 秒，页面必须整屏显示等待态 */
  const loading = ref(false);

  /** 失败原因（后端那句能看懂的中文，原样展示；空串 = 没失败） */
  const error = ref('');

  /**
   * 发起一次查询。
   * @param {object} query { from, to, departDate?, returnDate?, cabin, passengers, flexibility }
   */
  async function fetchResult(query) {
    loading.value = true;
    error.value = '';
    // 先清空旧数据：否则「修改条件重新查询」时会先闪一下上一次的结果，
    // 而这一次要等 60 秒 —— 那一闪会让用户以为页面没反应。
    data.value = null;
    try {
      data.value = await http.get('/result', { params: query });
    } catch (e) {
      // 已被拦截器归一化成 { code, message, status }，message 可以直接展示
      error.value = e?.message || '查询失败，请稍后重试';
    } finally {
      loading.value = false;
    }
  }

  return { data, loading, error, fetchResult };
});
