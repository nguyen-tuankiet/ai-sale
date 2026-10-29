// GET /api/diary (công khai): các bài nhật ký đã được chủ shop duyệt và đăng. Bản nháp không bao giờ lộ ra đây.
const { loadState } = require('./_mkt');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const state = await loadState();
    const entries = (state.diary || []).filter((entry) => entry.status === 'PUBLISHED').slice(0, 30).map(({ id, title, body, publishedAt }) => ({ id, title, body, at: publishedAt }));
    res.status(200).json({ entries });
  } catch (error) {
    console.error('diary:', error.message);
    res.status(500).json({ error: 'server_error' });
  }
};
