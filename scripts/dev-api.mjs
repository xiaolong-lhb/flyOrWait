/**
 * 本地函数运行器（仅开发用 —— 不会被部署，Vercel 只认 api/ 目录）
 *
 * 它干的事，就是把 Vercel 在线上替我们做的那几件事，在本地复刻一遍：
 *   ① 目录即路由       api/health.js         → GET /api/health
 *                      api/subscriptions/[id].js → /api/subscriptions/123（[id] 自动进 req.query）
 *   ② 注入 (req, res)  给每个 handler 喂上 Node 原生的 req/res，外加 query / body
 *   ③ 读 .env.local    相当于线上的环境变量面板，后端读 Key 全靠它
 *   ④ 改动即生效       每次请求重新加载文件，不用重启（对应线上「重新部署」）
 *
 * 用法：npm run dev:api      （前端另开一个终端跑 npm run dev）
 */

import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_DIR = join(ROOT, 'api');
const PORT = Number(process.env.PORT) || 3000;

// ── 环境变量：本地等价于线上 Vercel 的「Environment Variables」面板 ──
try {
  process.loadEnvFile(join(ROOT, '.env.local'));
  console.log('[env] 已加载 .env.local');
} catch {
  console.log('[env] 没有 .env.local（还没密钥，接口会读到空值）');
}

/** 扫描 api/ 目录，把「文件路径」翻译成「路由表」 */
async function collectRoutes(dir, prefix = '') {
  const routes = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return routes;
  }
  for (const entry of entries) {
    // 跳过 . 和 _ 开头的文件/目录	⭐ 将来的非路由工具函数用 _ 开头命名即可（api/_utils.js 不会变成接口）
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...(await collectRoutes(full, `${prefix}/${entry.name}`)));
    } else if (['.js', '.mjs'].includes(extname(entry.name))) {
      const base = entry.name.slice(0, -extname(entry.name).length);
      // index.js 直接挂在它所在的目录上：api/subscriptions/index.js → /api/subscriptions
      const pattern = base === 'index' ? prefix || '/' : `${prefix}/${base}`;
      routes.push({ pattern, file: full });
    }
  }
  return routes;
}

/** 按段匹配路由，并把 [xxx] 段收进 params */
function matchRoute(routes, relPath) {
  const reqSegs = relPath.split('/').filter(Boolean);
  for (const route of routes) {
    const segs = route.pattern.split('/').filter(Boolean);
    if (segs.length !== reqSegs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith('[') && segs[i].endsWith(']')) {
        params[segs[i].slice(1, -1)] = decodeURIComponent(reqSegs[i]);
      } else if (segs[i] !== reqSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/** res 垫片：让 handler 里能照常写 res.status(200).json(...) */
function makeResShim(res, statusRef) {
  return {
    status(code) {
      statusRef.code = code;
      return this;
    },
    setHeader: (k, v) => res.setHeader(k, v),
    json(body) {
      res.writeHead(statusRef.code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return this;
    },
    send(body) {
      const isText = typeof body === 'string';
      res.writeHead(statusRef.code, {
        'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      });
      res.end(isText ? body : JSON.stringify(body));
    },
    redirect(location) {
      res.writeHead(302, { Location: location });
      res.end();
    },
    end: (data) => res.end(data),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const statusRef = { code: 200 };

  // 只接管 /api/*；其余交给 vite（如果前端没单独跑，这里会 404）
  if (!url.pathname.startsWith('/api')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 4040, message: '运行器只管 /api/*', data: null }));
    return;
  }

  const relPath = url.pathname.replace(/^\/api/, '') || '/';
  const routes = await collectRoutes(API_DIR);
  const hit = matchRoute(routes, relPath);

  const log = (extra = '') =>
    console.log(
      `${req.method} ${url.pathname} → ${statusRef.code} (${Date.now() - started}ms) ${extra}`,
    );

  if (!hit) {
    statusRef.code = 404;
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 4040, message: `没有对应函数：${relPath}`, data: null }));
    log();
    return;
  }

  // 每次都加时间戳重新加载 → 改完代码不用重启（开发期便利，别带上线）
  const mod = await import(`${pathToFileURL(hit.route.file).href}?t=${Date.now()}`);
  const handler = mod.default;

  if (typeof handler !== 'function') {
    statusRef.code = 500;
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        code: 5000,
        message: '该文件没有 export default 函数（api/ 里每个文件都要 export default 一个函数）',
        data: null,
      }),
    );
    log();
    return;
  }

  req.query = { ...Object.fromEntries(url.searchParams), ...hit.params };
  req.body = await readBody(req).catch(() => undefined);

  try {
    await handler(req, makeResShim(res, statusRef));
    log(hit.route.pattern);
  } catch (e) {
    statusRef.code = 500;
    console.error(`[error] ${req.method} ${url.pathname}`, e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 5000, message: e.message, data: null }));
    }
    log();
  }
});

server.listen(PORT, () => {
  console.log(`[api] 本地函数运行器已启动  http://localhost:${PORT}/api/health`);
  console.log('[api] 扫描目录：api/   改完文件保存即生效，不用重启');
});
