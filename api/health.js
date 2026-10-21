/**
 * 探活接口  GET /api/health
 *
 * 作用有两个，缺一不可：
 *   ① 证明「Serverless 函数能跑起来」—— 部署后能访问到，说明 api/ 目录被平台认了；
 *   ② 证明「环境变量能读到」—— 后端能不能拿到 API Key，全靠 data.env 那段布尔值。
 *
 * 这是整个后端的地基：它不通，后面所有接口都不用写。
 *
 * ⚠️ 只返回「有没有配」，绝不返回 Key 的值 —— 哪怕这是后端，日志/响应里泄露 Key 同样危险。
 *
 * 响应体遵循全局约定 { code, message, data }，完整规则见 src/api/index.js 顶部注释。
 */

export default function handler(req, res) {
  // 动态接口，显式声明「任何一层都不要缓存」。
  // （Vercel 默认本来就不缓存函数响应，这里写出来是为了语义明确、不依赖平台默认值）
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ code: 4050, message: '仅支持 GET', data: null });
    return;
  }

  res.status(200).json({
    code: 0,
    message: 'ok',
    data: {
      ok: true,
      service: 'flyorwait-api',
      runtime: `node ${process.version}`,
      time: new Date().toISOString(),
      // 诊断用：回显收到的身份标识，证明请求头 X-Owner-Id 真的到达了后端。
      // 它不是密钥（当前是固定值、每次请求明文发送），回显给同一个客户端没有泄露风险。
      identityId: req.headers['x-owner-id'] || null,
      env: {
        SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
        // 2026 年 Supabase 把 service_role key 改名叫 secret key，
        // 变量名跟着官方走（旧名 SUPABASE_SERVICE_KEY 已弃用）。
        SUPABASE_SECRET_KEY: Boolean(process.env.SUPABASE_SECRET_KEY),
        // 两个主数据源的 Key：日历靠 Apify、航班列表靠 SerpApi。
        // 缺一个，查询就会在某一步失败 —— 所以必须在这里能看出来（之前漏了 APIFY_TOKEN）。
        APIFY_TOKEN: Boolean(process.env.APIFY_TOKEN),
        SERPAPI_KEY: Boolean(process.env.SERPAPI_KEY),
        SKYSCRAPPER_KEY: Boolean(process.env.SKYSCRAPPER_KEY),
        DEEPSEEK_KEY: Boolean(process.env.DEEPSEEK_KEY),
      },
      // 数据来源：live = 真的打外部 API（花额度）；replay = 读 samples/ 里的录像（不花钱）。
      // 线上必须是 live —— 一旦这里显示 replay，说明环境变量里误配了 APIFY_REPLAY / SERP_REPLAY，
      // 而 samples/ 被 .vercelignore 排除了，那种情况下每次查询都会报「找不到样本」。
      dataMode:
        process.env.APIFY_REPLAY === '1' || process.env.SERP_REPLAY === '1' ? 'replay' : 'live',
    },
  });
}
