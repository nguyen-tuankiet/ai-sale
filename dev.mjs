// Chạy thử toàn bộ trang + API trên máy: node dev.mjs → http://127.0.0.1:3700
// Dùng bộ nhớ thay cho Redis (DEV_MEMORY) nên KHÔNG đụng vào dịch vụ thật nào. Quản trị: /admin/ (mật khẩu dev-admin).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const require = createRequire(import.meta.url);

process.env.DEV_MEMORY = '1';
process.env.ADMIN_PASSWORD ||= 'dev-admin';
process.env.WORKER_TOKEN ||= 'dev-worker-token-0123456789';
process.env.LANDING_URL ||= 'https://shop.example.com';

const handlers = {};
for (const file of fs.readdirSync(path.join(root, 'api'))) if (file.endsWith('.js') && !file.startsWith('_')) handlers[file.slice(0, -3)] = require(`./api/${file}`);
const types = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };
const port = Number(process.env.PORT || 3700);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = /^\/api\/([a-z-]+)$/.exec(url.pathname);
  if (route) {
    const handler = handlers[route[1]];
    if (!handler) { res.writeHead(404); return res.end('{}'); }
    // Giả lập các tiện ích mà Vercel cung cấp: req.query, req.body, res.status().json()
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    req.query = Object.fromEntries(url.searchParams);
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); return res; };
    return handler(req, res);
  }
  let p = decodeURIComponent(url.pathname); if (p === '/admin') p = '/admin/'; if (p.endsWith('/')) p += 'index.html';
  const file = path.join(pub, p);
  if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Chạy thử Command Center (dữ liệu giả) tại http://127.0.0.1:${port}/admin/ (mật khẩu ${process.env.ADMIN_PASSWORD})
Worker thử: API_BASE=http://127.0.0.1:${port} WORKER_TOKEN=${process.env.WORKER_TOKEN} LOCAL_MODEL=template node worker/worker.mjs`));
