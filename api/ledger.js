// GET /api/ledger (công khai): sổ thu chi thật của dự án. Chỉ gồm số tiền khách đã chuyển (từ webhook SePay đã xác thực) và các khoản chi chủ shop tự khai.
// Đơn thử nhỏ hơn LEDGER_MIN_VND bị loại để không làm đẹp số liệu. Không có email, mã đơn hay dữ liệu cá nhân.
const { loadState, computeLedger } = require('./_mkt');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try { res.status(200).json(await computeLedger(await loadState())); }
  catch (error) { console.error('ledger:', error.message); res.status(500).json({ error: 'server_error' }); }
};
