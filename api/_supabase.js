/**
 * Supabase 客户端（内部共享工具，不是接口）
 *
 * 文件名以 _ 开头是刻意的：本地运行器（scripts/dev-api.mjs）与 Vercel 都会跳过
 * _ 开头的文件，所以它不会变成一个可访问的路由。好处是「数据库连接信息只写一处」，
 * 后面每个接口 import 一下就能用。
 *
 * ⚠️ 用的是 secret key —— 后端专用，能绕过行级安全（RLS）。
 *    它只能待在服务端：绝不可加 VITE_ 前缀、绝不进前端代码，
 *    否则等于把数据库钥匙交给浏览器。
 */
import { createClient } from '@supabase/supabase-js';

let client = null;

/**
 * 拿到 Supabase 客户端（惰性创建、之后复用）。
 * 环境变量缺失时直接抛错 —— 让调用方的 try/catch 统一兜成 500，不去猜。
 */
export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error('缺少环境变量 SUPABASE_URL / SUPABASE_SECRET_KEY');
  }

  if (!client) {
    client = createClient(url, key, {
      // 我们没接 Supabase Auth，后端也不保存任何登录会话：
      // 关掉会话持久化与自动续期，少一层用不上的状态和定时器。
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return client;
}
