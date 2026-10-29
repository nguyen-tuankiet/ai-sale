// POST /api/admin {method, path, input} (cần đăng nhập quản trị): cổng RPC duy nhất cho Command Center.
//   overview, products, campaigns, manager/run, jobs, agent-settings → lib/agents.js
//   content/..., plan (mẫu cố định), kill-switch, settings, report, audit → lib/marketing.js
const lib = require('./_lib');
const state = require('./_state');

module.exports = async (req, res) => {
  lib.noStore(res);
  if (!lib.isAdmin(req)) return res.status(401).json({ error: { code: 'unauthorized', message: 'Chưa đăng nhập quản trị.' } });
  if (req.method !== 'POST') return res.status(405).json({ error: { code: 'method_not_allowed', message: 'Chỉ nhận POST.' } });
  try {
    const { method = 'GET', path = '', input = {} } = lib.parseBody(req);
    const verb = String(method).toUpperCase(); const parts = String(path).split('/').filter(Boolean);
    const run = async ({ agents, marketing }) => { await marketing.tick(); return agents.route(verb, parts, input) || marketing.route(verb, parts, {}, input); }; // tick: đánh dấu bài đã đến giờ đăng tay
    const result = await state.write(run); // đọc cũng đi qua write: lưu lại dữ liệu khởi tạo và các đánh dấu của tick
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(result.status).json({ data: result.data });
  } catch (error) {
    console.error('admin:', error.message);
    return res.status(500).json({ error: { code: 'server_error', message: 'Hệ thống đang gặp lỗi, thử lại sau.' } });
  }
};
