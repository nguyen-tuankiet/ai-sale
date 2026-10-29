// POST /api/admin-resend {code} (cần đăng nhập quản trị): gửi lại email link tải cho đơn ĐÃ thanh toán. Không thu tiền lại, không đổi trạng thái đơn.
const lib = require('./_lib');

module.exports = async (req, res) => {
  lib.noStore(res);
  if (!lib.isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const code = String(lib.parseBody(req).code || '').toUpperCase();
    const order = /^MS[A-Z0-9]{8}$/.test(code) ? await lib.getOrder(code) : null;
    if (!order) return res.status(404).json({ error: 'not_found', message: 'Không tìm thấy đơn.' });
    if (order.status !== 'paid') return res.status(409).json({ error: 'not_paid', message: 'Đơn chưa thanh toán nên không gửi file.' });
    if (!order.email) return res.status(409).json({ error: 'no_email', message: 'Đơn này không có email; gửi link tải thủ công.' });
    if (!lib.emailConfigured()) return res.status(503).json({ error: 'email_not_configured', message: 'Chưa cấu hình RESEND_API_KEY và MAIL_FROM.' });
    if (!(await lib.sendDownloadEmail(order))) return res.status(502).json({ error: 'email_failed', message: 'Gửi email thất bại, thử lại sau.' });
    order.emailed = true;
    await lib.saveOrder(order, lib.ORDER_PAID_TTL);
    return res.status(200).json({ ok: true, code });
  } catch (error) {
    console.error('admin-resend:', error.message);
    return res.status(500).json({ error: 'server_error', message: 'Hệ thống đang gặp lỗi.' });
  }
};
