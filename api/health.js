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
      env: {
        SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
        SUPABASE_SERVICE_KEY: Boolean(process.env.SUPABASE_SERVICE_KEY),
        SERPAPI_KEY: Boolean(process.env.SERPAPI_KEY),
        SKYSCRAPPER_KEY: Boolean(process.env.SKYSCRAPPER_KEY),
        DEEPSEEK_KEY: Boolean(process.env.DEEPSEEK_KEY),
      },
    },
  });
}
