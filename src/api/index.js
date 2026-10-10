import axios from 'axios';

/**
 * 前端唯一出口：指向自家后端代理的 axios 实例
 *
 * baseURL 写 `/api`（相对路径）—— 前端与函数同源，不需要写任何域名，
 * 也就不存在跨域；本地开发由 vite 代理转发，线上由 Vercel 直接接管。
 * 这样「本地 / 线上」代码完全一致，不用改一行。
 *
 * ══════════════════════════════════════════════════════════════════
 *  接口返回约定（前后端共同遵守，新接口一律照此办理）
 * ══════════════════════════════════════════════════════════════════
 * 响应体永远是三件套：{ code, message, data }
 *
 *   code     0 = 业务成功；非 0 = 业务失败（四位数字，见下表）
 *   message  说明文字（中文，可直接展示给用户）
 *   data     业务数据；失败时一律 null（不省略字段，前端好判）
 *
 * 配套的 HTTP 状态码 —— 业务失败也用真实语义，便于 DevTools 一眼看出错、
 * 平台日志能统计错误率（这正是当初选「真实 4xx」而不是「一律 200」的原因）：
 *
 *   场景                               HTTP    code
 *   ─────────────────────────────────────────────────────
 *   业务成功                           200     0
 *   参数校验失败                       400     4000
 *   资源不存在（订阅找不到）           404     4040
 *   资源冲突（同一航线已订阅）         409     4090
 *   服务端内部错误                     500     5000
 *   外部数据源失败（SerpApi 挂了）     502     5020
 *
 *   ⭐ 编号规则：前三位 = 对应的 HTTP 状态码，末位是序号。同类错误将来要细分
 *      （比如两种参数错），就往下排 4001、4002。看到 code 就能反推 HTTP 语义。
 *
 * ══════════════════════════════════════════════════════════════════
 *  因此调用方（store）只需要 try/catch
 * ══════════════════════════════════════════════════════════════════
 *   try {
 *     const list = await http.get('/subscriptions');   // 拿到的就是 data 本身
 *   } catch (e) {
 *     // e = { code, message, status } —— 已归一化
 *     // 「非 2xx」与「200 但 code≠0」两种失败长得一模一样，可直接丢给 ElMessage
 *   }
 */

export const http = axios.create({
  baseURL: '/api',
  // 30s：我们的接口要串联调外部数据源（SerpApi 往返 + price_insights），
  // 15s 会误杀正常请求；超过 30s 基本是外部源挂了，早点失败更好。
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

/** 网络层错误（请求压根没到服务器）用的伪 code：负数，永远撞不上业务码 */
const NETWORK_ERROR_CODE = -1;

http.interceptors.response.use(
  // ── 2xx：传输没问题，还要再判一次业务码 ──────────────────────────
  (res) => {
    const body = res.data;

    if (body?.code !== 0) {
      // 正常情况下走不到这（业务失败都已在后端返回 4xx）。
      // 兜底：万一哪个接口漏改了、返回 200 + 非 0 code，在这里也要当失败抛出，
      // 否则 store 会把一个「错误对象」当成数据用，埋下更隐蔽的 bug。
      return Promise.reject({
        code: body?.code ?? 5000,
        message: body?.message ?? '响应格式不符合约定',
        status: res.status,
      });
    }

    return body.data;
  },

  // ── 非 2xx：把 axios 五花八门的错误统一成 { code, message, status } ──
  (err) => {
    // 情况一：压根没收到响应 —— 断网 / 超时 / 地址不对
    if (!err.response) {
      const timeout = err.code === 'ECONNABORTED';
      return Promise.reject({
        code: NETWORK_ERROR_CODE,
        message: timeout ? '请求超时，请稍后重试' : '网络异常，请稍后重试',
        status: 0,
      });
    }

    // 情况二：收到了响应但是 4xx / 5xx —— body 里应有 { code, message }
    const body = err.response.data;
    return Promise.reject({
      code: body?.code ?? 5000,
      message: body?.message ?? `请求失败（${err.response.status}）`,
      status: err.response.status,
    });
  },
);

export default http;
