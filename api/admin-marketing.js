// POST /api/admin-marketing {method, path, input} (cần đăng nhập quản trị): cổng RPC duy nhất cho hàng đợi quảng bá, nhật ký và khai chi phí.
//   path "content/...", "plan", "kill-switch", "settings", "report", "audit" → lib/marketing.js
//   path "diary", "diary/draft", "diary/<id>/publish|unpublish", "costs", "costs/<id>" → xử lý tại đây
// Nhật ký chỉ lên trang công khai khi chủ shop bấm Đăng; nội dung được quét giá sai, cam kết chưa chứng minh và dấu hiệu lộ bí mật.
const crypto = require('crypto');
const lib = require('./_lib');
const { withMarketing, computeLedger } = require('./_mkt');
const { checkText } = require('../lib/marketing');

const newId = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
const money = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;
const clip = (value, max) => String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
const fail = (status, message, code = 'bad_request') => ({ status, error: { code, message } });

module.exports = async (req, res) => {
  lib.noStore(res);
  if (!lib.isAdmin(req)) return res.status(401).json({ error: { code: 'unauthorized', message: 'Chưa đăng nhập quản trị.' } });
  if (req.method !== 'POST') return res.status(405).json({ error: { code: 'method_not_allowed', message: 'Chỉ nhận POST.' } });
  try {
    const { method = 'GET', path = '', input = {} } = lib.parseBody(req);
    const parts = String(path).split('/').filter(Boolean);
    const verb = String(method).toUpperCase();
    const result = await withMarketing(async ({ marketing, state }) => {
      await marketing.tick(); // đánh dấu các bài đã đến giờ đăng tay
      const [head, id, action] = parts;
      if (head === 'diary') return diary({ verb, id, action, input, state, marketing });
      if (head === 'costs') return costs({ verb, id, input, state });
      return marketing.route(verb, parts, {}, input);
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(result.status).json({ data: result.data });
  } catch (error) {
    console.error('admin-marketing:', error.message);
    return res.status(500).json({ error: { code: 'server_error', message: 'Hệ thống đang gặp lỗi.' } });
  }
};

async function diary({ verb, id, action, input, state, marketing }) {
  const prices = marketing.state().offers.map((offer) => offer.priceVnd);
  const find = (entryId) => state.diary.find((entry) => entry.id === entryId);
  if (!id) {
    if (verb === 'GET') return { status: 200, data: state.diary };
    if (verb === 'POST') {
      const entry = { id: newId('diary'), title: clip(input.title, 120), body: clip(input.body, 4000), status: 'DRAFT', source: 'manual', createdAt: new Date().toISOString() };
      if (!entry.title || !entry.body) return fail(400, 'Cần tiêu đề và nội dung.');
      state.diary.unshift(entry); state.diary.length = Math.min(state.diary.length, 200);
      return { status: 201, data: entry };
    }
  }
  if (id === 'draft' && verb === 'POST') {
    // Bản nháp chỉ ghép con số thật từ sổ thu chi; không có câu chuyện bịa. Chủ shop sửa/viết thêm rồi mới đăng.
    const ledger = await computeLedger(state);
    const lines = [
      `${ledger.dayNumber ? `Ngày thứ ${ledger.dayNumber}: ` : ''}${ledger.orders} đơn thật đã thanh toán, doanh thu ${money(ledger.revenue)}.`,
      `Chi phí đã khai: ${money(ledger.costTotal)}. Còn lại: ${money(ledger.net)}.`,
      ledger.goal ? `Mục tiêu ${money(ledger.goal)}: đã đạt ${Math.round(ledger.progress * 100)}%.` : '',
      `${ledger.visitors30d} khách ghé trang trong 30 ngày qua (đếm bởi máy chủ, đã loại bot).`,
    ].filter(Boolean);
    const entry = { id: newId('diary'), title: `Sổ ngày ${new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)}`, body: lines.join('\n'), status: 'DRAFT', source: 'ledger', createdAt: new Date().toISOString() };
    state.diary.unshift(entry);
    return { status: 201, data: entry };
  }
  const entry = find(id);
  if (!entry) return fail(404, 'Không tìm thấy bài nhật ký.', 'not_found');
  if (!action && verb === 'PATCH') {
    const before = `${entry.title}\n${entry.body}`;
    if ('title' in input) entry.title = clip(input.title, 120);
    if ('body' in input) entry.body = clip(input.body, 4000);
    if (entry.status === 'PUBLISHED' && `${entry.title}\n${entry.body}` !== before) entry.status = 'DRAFT'; // sửa sau khi đăng thì phải duyệt lại
    return { status: 200, data: entry };
  }
  if (!action && verb === 'DELETE') { state.diary = state.diary.filter((item) => item.id !== id); return { status: 200, data: { ok: true } }; }
  if (action === 'publish' && verb === 'POST') {
    // Được nhắc: giá đang bán và các con số khớp đúng sổ thu chi hiện tại (doanh thu, chi phí, mục tiêu, từng đơn/khoản chi). Số lạ vẫn bị chặn.
    const ledger = await computeLedger(state);
    const known = [...prices, ledger.revenue, ledger.costTotal, ledger.net, ledger.goal, ...ledger.recent.map((o) => o.amount), ...ledger.costs.map((c) => c.amountVnd)].filter((n) => Number.isFinite(n)); // gồm cả 0đ: "chi phí 0đ" là số thật
    const errors = checkText(`${entry.title}\n${entry.body}`, known);
    if (errors.length) return { status: 422, error: { code: 'quality_gate', message: 'Chưa qua kiểm tra: ' + errors.join(' '), issues: errors } };
    Object.assign(entry, { status: 'PUBLISHED', publishedAt: new Date().toISOString() });
    return { status: 200, data: entry };
  }
  if (action === 'unpublish' && verb === 'POST') { entry.status = 'DRAFT'; return { status: 200, data: entry }; }
  return fail(404, 'Không tìm thấy API endpoint.', 'not_found');
}

function costs({ verb, id, input, state }) {
  if (!id && verb === 'GET') return { status: 200, data: state.costs };
  if (!id && verb === 'POST') {
    const amountVnd = Math.round(Number(input.amountVnd));
    const label = clip(input.label, 100);
    if (!label || !Number.isFinite(amountVnd) || amountVnd <= 0 || amountVnd > 1e9) return fail(400, 'Cần tên khoản chi và số tiền hợp lệ.');
    const cost = { id: newId('cost'), label, amountVnd, at: new Date().toISOString() };
    state.costs.unshift(cost); state.costs.length = Math.min(state.costs.length, 200);
    return { status: 201, data: cost };
  }
  if (id && verb === 'DELETE') { state.costs = state.costs.filter((cost) => cost.id !== id); return { status: 200, data: { ok: true } }; }
  return fail(404, 'Không tìm thấy API endpoint.', 'not_found');
}
