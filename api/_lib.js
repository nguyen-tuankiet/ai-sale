// Phần dùng chung cho các hàm API (Vercel Functions; cũng chạy được ở dev.mjs). Không có thư viện ngoài, chỉ dùng fetch có sẵn của Node.
// Mọi cấu hình bí mật nằm trong biến môi trường, không nằm trong mã.
const crypto = require('crypto');

const env = (name, fallback = '') => process.env[name] || fallback;
const landingUrl = () => env('LANDING_URL', 'https://muse-studio-landing.vercel.app').replace(/\/+$/, '');

// ---------------------------------------------------------------- Redis (Upstash, gọi qua HTTP)
const memory = new Map(); // chỉ dùng khi DEV_MEMORY=1 (chạy thử trên máy)
function memoryCommand([cmd, key, ...args]) {
  const now = Date.now();
  const entry = memory.get(key);
  const alive = entry && (!entry.expires || entry.expires > now) ? entry : null;
  const put = (value, expires = alive ? alive.expires : 0) => memory.set(key, { value, expires });
  switch (String(cmd).toUpperCase()) {
    case 'GET': return alive ? alive.value : null;
    case 'SET': {
      const nx = args.map(String).some((item) => item.toUpperCase() === 'NX');
      if (nx && alive) return null;
      const exIndex = args.findIndex((item) => String(item).toUpperCase() === 'EX');
      put(String(args[0]), exIndex >= 0 ? now + Number(args[exIndex + 1]) * 1000 : 0);
      return 'OK';
    }
    case 'INCR': { const next = (alive ? Number(alive.value) : 0) + 1; put(String(next)); return next; }
    case 'EXPIRE': if (alive) alive.expires = now + Number(args[0]) * 1000; return alive ? 1 : 0;
    case 'DEL': memory.delete(key); return 1;
    default: throw new Error(`Lệnh Redis chưa hỗ trợ: ${cmd}`);
  }
}
function redisConfig() {
  const url = env('UPSTASH_REDIS_REST_URL') || env('KV_REST_API_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN') || env('KV_REST_API_TOKEN');
  if (!url || !token) throw new Error('Chưa cấu hình Upstash Redis (UPSTASH_REDIS_REST_URL và UPSTASH_REDIS_REST_TOKEN).');
  return { url: url.replace(/\/+$/, ''), token };
}
async function redis(command) {
  if (env('DEV_MEMORY') === '1') return memoryCommand(command);
  const { url, token } = redisConfig();
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Redis lỗi: ${data.error || response.status}`);
  return data.result;
}

// ---------------------------------------------------------------- tiện ích
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const parseBody = (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
};

// ---------------------------------------------------------------- đăng nhập quản trị (cookie ký bằng HMAC, hết hạn sau 12 giờ)
const ADMIN_COOKIE = 'sales_admin';
const adminSecret = () => env('ADMIN_SECRET') || crypto.createHash('sha256').update(`sales-admin:${env('ADMIN_PASSWORD')}`).digest('hex');
const hmac = (value) => crypto.createHmac('sha256', adminSecret()).update(value).digest('hex');
function adminToken(hours = 12) { const expires = Date.now() + hours * 3600e3; return `${expires}.${hmac(String(expires))}`; }
function isAdmin(req) {
  if (!env('ADMIN_PASSWORD')) return false;
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_COOKIE}=`));
  if (!cookie) return false;
  const [expires, signature] = cookie.slice(ADMIN_COOKIE.length + 1).split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  try { return safeEqual(signature, hmac(expires)); } catch { return false; }
}
const adminCookie = (req, value, maxAge) => {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
};
// Worker trên máy bạn gọi bằng "Authorization: Bearer <WORKER_TOKEN>".
function isWorker(req) {
  const token = env('WORKER_TOKEN');
  if (!token || token.length < 16) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { return safeEqual(given, token); } catch { return false; }
}

module.exports = { env, landingUrl, redis, memory, safeEqual, clientIp, noStore, parseBody, adminToken, isAdmin, adminCookie, isWorker, ADMIN_COOKIE };
