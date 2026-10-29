// Trạng thái quảng bá + nhật ký + chi phí nằm trong một khóa Redis `mkt:state` (JSON). Chủ shop là người duy nhất ghi nên không cần khóa phức tạp.
const lib = require('./_lib');
const { createMarketing } = require('../lib/marketing');

const KEY = 'mkt:state';
const FEATURES = [
  'Tạo video bằng tài khoản Muse theo lịch',
  'Duyệt video trước khi đăng lên YouTube',
  'Quản lý nhiều kênh YouTube trong một bảng điều khiển',
  'Theo dõi lượt xem và subscriber',
  'Chạy trên máy của bạn, dữ liệu nằm trong thư mục data',
];

async function loadState() {
  const raw = await lib.redis(['GET', KEY]);
  const state = raw ? JSON.parse(raw) : {};
  state.diary = state.diary || []; state.costs = state.costs || [];
  return state;
}
const saveState = (state) => lib.redis(['SET', KEY, JSON.stringify(state)]);

// Bảng giá (Offer) luôn lấy theo biến môi trường hiện hành để bài quảng bá không bao giờ nói sai giá.
function syncOffers(marketing) {
  const cfg = lib.settings();
  marketing.setOffers([
    { id: 'muse-studio', name: 'Muse Studio', priceVnd: cfg.priceVnd, approvedFeatures: FEATURES, source: 'biến môi trường PRICE_VND' },
    { id: 'muse-studio-pro', name: 'Muse Studio Pro', priceVnd: cfg.proPriceVnd, approvedFeatures: ['Gồm toàn bộ Muse Studio', 'Kèm gói prompt'], source: 'biến môi trường PRICE_PRO_VND' },
  ]);
}

// Sổ thu chi thật: dùng chung cho trang công khai và bản nháp nhật ký.
async function computeLedger(state) {
  const min = Number(lib.env('LEDGER_MIN_VND', '20000'));
  const rows = ((await lib.redis(['LRANGE', 'paid:log', '0', '999'])) || []).map((row) => { try { return JSON.parse(row); } catch { return null; } }).filter((row) => row && row.amount >= min);
  const costs = state.costs || [];
  const revenue = rows.reduce((sum, row) => sum + row.amount, 0);
  const costTotal = costs.reduce((sum, cost) => sum + cost.amountVnd, 0);
  const goal = Number(lib.env('GOAL_VND', '0'));
  const start = lib.env('START_DATE'); const deadline = lib.env('DEADLINE_DATE');
  const dayNumber = start ? Math.max(1, Math.floor((Date.parse(lib.dayKey()) - Date.parse(start)) / 86400000) + 1) : null;
  const days = Array.from({ length: 30 }, (_, i) => lib.dayKey(i));
  const stats = await lib.pipeline(days.map((day) => ['HGETALL', `st:${day}`]));
  const field = (flat, name) => { for (let i = 0; i < (flat || []).length; i += 2) if (flat[i] === name) return Number(flat[i + 1]) || 0; return 0; };
  return {
    revenue, orders: rows.length, byPlan: { basic: rows.filter((r) => r.plan !== 'pro').length, pro: rows.filter((r) => r.plan === 'pro').length },
    costs: costs.slice(0, 30).map(({ label, amountVnd, at }) => ({ label, amountVnd, at })), costTotal, net: revenue - costTotal,
    goal, progress: goal ? Math.min(1, Math.max(0, revenue / goal)) : null, startDate: start || null, deadlineDate: deadline || null, dayNumber,
    visitorsToday: field(stats[0], 'uniq'), visitors30d: stats.reduce((sum, flat) => sum + field(flat, 'uniq'), 0),
    recent: rows.slice(0, 8).map(({ at, plan, amount }) => ({ at, plan, amount })), updatedAt: new Date().toISOString(),
    note: 'Số liệu lấy trực tiếp từ giao dịch đã xác thực; đơn thử và đơn chưa thanh toán không được tính.',
  };
}

async function withMarketing(fn) {
  const state = await loadState();
  const marketing = createMarketing({ getStore: () => ({ marketing: state.marketing || (state.marketing = {}) }), persist: () => {}, siteUrl: lib.settings().siteUrl });
  const m = marketing.state();
  if (lib.settings().siteUrl) m.settings.siteUrl = lib.settings().siteUrl; // địa chỉ trang luôn theo SITE_URL
  syncOffers(marketing);
  const result = await fn({ marketing, state });
  await saveState(state);
  return result;
}
module.exports = { loadState, saveState, withMarketing, computeLedger };
