// POST /api/sepay-webhook: SePay gọi vào đây mỗi khi có tiền vào tài khoản. Xác thực bằng API Key, chống xử lý trùng,
// khớp mã đơn trong nội dung chuyển khoản, đủ tiền thì đánh dấu đơn đã trả và gửi email (nếu có).
// Giao dịch bất thường (không khớp đơn, trả thừa, trả cho đơn đã trả) được ghi vào danh sách "cần xem" của trang quản trị.
const lib = require('./_lib');

module.exports = async (req, res) => {
  lib.noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ success: false });
  const key = lib.env('SEPAY_API_KEY');
  if (!key) return res.status(503).json({ success: false, error: 'not_configured' });
  const given = String(req.headers.authorization || '').replace(/^Apikey\s+/i, '');
  if (!lib.safeEqual(given, key)) return res.status(401).json({ success: false });

  const body = lib.parseBody(req);
  if (body.transferType !== 'in') return res.status(200).json({ success: true, ignored: 'not_incoming' });
  const txId = String(body.id ?? body.referenceCode ?? '');
  if (!txId) return res.status(200).json({ success: true, ignored: 'no_id' });

  // SePay có thể gửi lại cùng một giao dịch: chỉ xử lý lần đầu
  const fresh = await lib.redis(['SET', `tx:${txId}`, '1', 'NX', 'EX', String(60 * 60 * 24 * 30)]);
  if (fresh !== 'OK') return res.status(200).json({ success: true, duplicate: true });

  let lockKey = null;
  try {
    const amount = Number(body.transferAmount || 0);
    const content = body.content || body.description || '';
    let matched = null;
    for (const code of lib.findCodes(body.code, body.content, body.description)) {
      const order = await lib.getOrder(code);
      if (order) { matched = order; break; }
    }
    if (!matched) {
      await lib.logReview({ type: 'unmatched', txId, amount, content });
      return res.status(200).json({ success: true, matched: false });
    }
    if (matched.status === 'paid') {
      // Khách chuyển thêm cho đơn đã trả: không đổi trạng thái, nhưng chủ shop cần biết để hoàn tiền.
      await lib.logReview({ type: 'already_paid', code: matched.code, txId, amount });
      return res.status(200).json({ success: true, matched: true, already: true });
    }

    // Hai giao dịch khác nhau cho cùng một đơn có thể tới cùng lúc: chỉ một bên được phép chuyển đơn sang "đã trả" (tránh email và doanh thu tính đôi).
    lockKey = `paylock:${matched.code}`;
    if ((await lib.redis(['SET', lockKey, txId, 'NX', 'EX', '60'])) !== 'OK') {
      lockKey = null;
      await lib.logReview({ type: 'concurrent', code: matched.code, txId, amount });
      return res.status(200).json({ success: true, matched: true, concurrent: true });
    }
    const latest = await lib.getOrder(matched.code);
    if (latest?.status === 'paid') {
      await lib.logReview({ type: 'already_paid', code: matched.code, txId, amount });
      return res.status(200).json({ success: true, matched: true, already: true });
    }
    matched = latest || matched;

    // Cộng dồn các lần chuyển: khách chuyển thiếu rồi chuyển bù thì đủ tiền, không bắt trả lại từ đầu.
    const received = (Number(matched.received) || 0) + amount;
    matched.received = received;
    if (received < matched.amount) {
      matched.underpaid = { amount: received, txId, at: new Date().toISOString() };
      await lib.saveOrder(matched, lib.ORDER_PENDING_TTL);
      return res.status(200).json({ success: true, matched: true, underpaid: true });
    }
    Object.assign(matched, { status: 'paid', paidAt: new Date().toISOString(), txId, paidAmount: received });
    delete matched.underpaid;
    await lib.saveOrder(matched, lib.ORDER_PAID_TTL);
    await lib.statInc(matched.plan === 'pro' ? { paid: 1, revenue: received, paid_pro: 1, revenue_pro: received } : { paid: 1, revenue: received });
    await lib.logPaid({ plan: matched.plan || 'basic', amount: received }); // sổ công khai: chỉ ghi số tiền và gói, không ghi email hay mã đơn
    if (received > matched.amount) await lib.logReview({ type: 'overpaid', code: matched.code, txId, amount: received - matched.amount });

    if (await lib.sendDownloadEmail(matched)) { matched.emailed = true; await lib.saveOrder(matched, lib.ORDER_PAID_TTL); }
    else if (matched.email && lib.emailConfigured()) {
      // Đã thu tiền nhưng email lỗi: khách vẫn tải được trên trang; chủ shop thấy cảnh báo và gửi lại bằng /api/admin-resend.
      await lib.logReview({ type: 'email_failed', code: matched.code, txId, amount: received });
    }
    return res.status(200).json({ success: true, matched: true, paid: true });
  } catch (error) {
    // Xử lý lỗi giữa chừng: bỏ dấu "đã xử lý" để SePay gọi lại sau
    await lib.redis(['DEL', `tx:${txId}`]).catch(() => {});
    console.error('sepay-webhook:', error.message);
    return res.status(500).json({ success: false });
  } finally {
    if (lockKey) await lib.redis(['DEL', lockKey]).catch(() => {});
  }
};
