'use strict';
// Analytics Agent: đọc số liệu từ trang bán hàng hiện có (/api/admin-stats) rồi tóm tắt và đưa ra GỢI Ý để bạn xem xét.
// Giới hạn trung thực: trang bán chỉ ghi nguồn giới thiệu theo tên miền (không ghi UTM), nên KHÔNG gán doanh thu cho từng kênh;
// chỉ ước lượng lượt truy cập theo nguồn giới thiệu và nói rõ đó là ước lượng.

const REFERRER_CHANNEL = [
  [/(^|\.)(facebook|fb)\.com$|^fb\.me$|^l\.facebook\.com$/i, 'facebook'],
  [/(^|\.)youtube\.com$|^youtu\.be$/i, 'youtube'],
  [/(^|\.)tiktok\.com$/i, 'tiktok'],
  [/(^|\.)(google|bing|duckduckgo)\.[a-z.]+$/i, 'tìm kiếm'],
];
const MIN_VISITORS = 30; // dưới ngưỡng này không kết luận về tỷ lệ

const pct = (a, b) => (b > 0 ? a / b : null);

// Đăng nhập trang bán (cookie quản trị của họ) rồi đọc thống kê. fetchImpl được truyền vào để kiểm thử.
async function fetchLanding({ fetchImpl = fetch, base, password, days = 30, timeoutMs = 8000 }) {
  if (!base || !password) return { error: 'Chưa cấu hình LANDING_URL và LANDING_ADMIN_PASSWORD.', code: 'not_configured' };
  const withTimeout = (url, options) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); return fetchImpl(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer)); };
  try {
    const login = await withTimeout(`${base}/api/admin-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (login.status === 401) return { error: 'Trang bán từ chối mật khẩu quản trị (LANDING_ADMIN_PASSWORD sai).', code: 'bad_password' };
    if (login.status === 429) return { error: 'Trang bán đang giới hạn đăng nhập; thử lại sau 15 phút.', code: 'rate_limited' };
    if (!login.ok) return { error: `Đăng nhập trang bán lỗi (${login.status}).`, code: 'login_failed' };
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) return { error: 'Trang bán không trả cookie đăng nhập.', code: 'no_cookie' };
    const stats = await withTimeout(`${base}/api/admin-stats?days=${Math.min(90, Math.max(1, days))}`, { headers: { Cookie: cookie } });
    if (!stats.ok) return { error: `Đọc thống kê trang bán lỗi (${stats.status}).`, code: 'stats_failed' };
    return { data: await stats.json() };
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'Trang bán phản hồi quá chậm.' : `Không kết nối được trang bán: ${error.message}`, code: 'network' };
  }
}

const channelOfReferrer = (host) => { if (host === 'direct') return 'trực tiếp'; for (const [pattern, channel] of REFERRER_CHANNEL) if (pattern.test(host)) return channel; return 'khác'; };

// Chuẩn hóa dữ liệu thô của trang bán thành bản tóm tắt gọn, lưu được.
function summarize(raw, days) {
  const totals = raw.totals || {};
  const num = (name) => Number(totals[name]) || 0;
  const t = { views: num('views'), visitors: num('uniq'), pricingViews: num('pricing_view'), buyClicks: num('buy_click'), demoPlays: num('demo_play'), orders: num('orders'), paid: num('paid'), revenue: num('revenue'), downloads: num('downloads'), paidPro: num('paid_pro'), revenuePro: num('revenue_pro') };
  const rates = { pricing: pct(t.pricingViews, t.visitors), buyClick: pct(t.buyClicks, t.visitors), orderAfterClick: pct(t.orders, t.buyClicks), paidAfterOrder: pct(t.paid, t.orders), paidPerVisitor: pct(t.paid, t.visitors) };
  const sources = {};
  for (const item of raw.referrers || []) { const channel = channelOfReferrer(String(item.name)); sources[channel] = (sources[channel] || 0) + (Number(item.count) || 0); }
  return {
    days, fetchedAt: new Date().toISOString(), totals: t, rates,
    visitsBySource: Object.entries(sources).map(([channel, visits]) => ({ channel, visits })).sort((a, b) => b.visits - a.visits),
    series: (raw.series || []).map((point) => ({ date: point.date, visitors: Number(point.uniq) || 0, paid: Number(point.paid) || 0, revenue: Number(point.revenue) || 0 })),
    attributionNote: 'Trang bán chỉ ghi nguồn giới thiệu theo tên miền, không ghi UTM. Lượt truy cập theo nguồn là ƯỚC LƯỢNG; doanh thu không được gán cho kênh nào.',
  };
}

// Gợi ý theo luật đơn giản. Mỗi gợi ý ghi rõ căn cứ và cỡ mẫu; không khẳng định nguyên nhân.
function insights(summary, content = {}) {
  const out = []; const { totals: t, rates: r } = summary;
  if (t.visitors < MIN_VISITORS) {
    out.push({ level: 'info', text: `Mới có ${t.visitors} khách trong ${summary.days} ngày, chưa đủ (cần ≥ ${MIN_VISITORS}) để kết luận về tỷ lệ chuyển đổi. Ưu tiên đưa thêm khách về trang.` });
  } else {
    if (r.buyClick != null && r.buyClick < 0.03) out.push({ level: 'warn', text: `Chỉ ${(r.buyClick * 100).toFixed(1)}% khách bấm Mua (${t.buyClicks}/${t.visitors}). Có thể tiêu đề/CTA đầu trang chưa đủ rõ: thử nhờ Conversion Agent đề xuất biến thể.` });
    if (t.buyClicks >= 10 && r.orderAfterClick != null && r.orderAfterClick < 0.2) out.push({ level: 'warn', text: `Nhiều người bấm Mua (${t.buyClicks}) nhưng chỉ ${t.orders} đơn được tạo. Kiểm tra cửa sổ thanh toán có lỗi/khó hiểu không.` });
    if (t.orders >= 5 && r.paidAfterOrder != null && r.paidAfterOrder < 0.3) out.push({ level: 'warn', text: `Chỉ ${t.paid}/${t.orders} đơn được thanh toán. Kiểm tra mã QR, hướng dẫn chuyển khoản và danh sách "Giao dịch cần xem" ở trang bán.` });
    if (r.pricing != null && r.pricing < 0.25) out.push({ level: 'info', text: `Chỉ ${(r.pricing * 100).toFixed(0)}% khách cuộn tới khung giá: nội dung phía trên có thể chưa giữ chân được khách.` });
  }
  if (t.paid > 0 && t.visitors >= MIN_VISITORS && r.paidPerVisitor != null) out.push({ level: 'info', text: `Tỷ lệ mua trên khách: ${(r.paidPerVisitor * 100).toFixed(1)}% (${t.paid} đơn/${t.visitors} khách), trong ${summary.days} ngày.` });
  const top = summary.visitsBySource.filter((item) => !['trực tiếp', 'khác'].includes(item.channel))[0];
  if (top) out.push({ level: 'info', text: `Nguồn giới thiệu nhiều nhất (ước lượng): ${top.channel} (${top.visits} lượt). Chưa thể nói kênh nào ra đơn.` });
  if (!(content.PUBLISHED > 0)) out.push({ level: 'info', text: 'Chưa có bài quảng bá nào được ghi nhận là đã đăng trong hàng đợi.' });
  return out;
}

module.exports = { fetchLanding, summarize, insights, channelOfReferrer, MIN_VISITORS };
