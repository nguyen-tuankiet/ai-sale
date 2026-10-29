// POST /api/worker {action, workerId, ...} (Authorization: Bearer WORKER_TOKEN): worker chạy trên MÁY BẠN nhận việc viết nội dung,
// gọi Chat Muse tại chỗ (cookie Muse không bao giờ rời khỏi máy bạn) rồi gửi kết quả về. Kết quả chỉ thành BẢN NHÁP chờ duyệt.
//   claim → {job|null}   complete {jobId, result:{title, body}}   fail {jobId, error, retry}   heartbeat
const lib = require('./_lib');
const state = require('./_state');

module.exports = async (req, res) => {
  lib.noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: { code: 'method_not_allowed', message: 'Chỉ nhận POST.' } });
  if (!lib.isWorker(req)) return res.status(401).json({ error: { code: 'unauthorized', message: 'Sai WORKER_TOKEN.' } });
  try {
    const body = lib.parseBody(req);
    const workerId = String(body.workerId || 'worker').replace(/[^\w.-]/g, '').slice(0, 40) || 'worker';
    const result = await state.write(({ agents }) => {
      if (body.action === 'claim') return agents.claim(workerId);
      if (body.action === 'heartbeat') { agents.heartbeat(workerId); return { status: 200, data: { ok: true } }; }
      if (body.action === 'complete') return agents.complete(String(body.jobId || ''), workerId, body.result || {});
      if (body.action === 'fail') return agents.failJob(String(body.jobId || ''), workerId, body.error, { retry: body.retry !== false });
      return { status: 400, error: { code: 'bad_request', message: 'action không hợp lệ.' } };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(result.status).json({ data: result.data });
  } catch (error) {
    console.error('worker:', error.message);
    return res.status(500).json({ error: { code: 'server_error', message: 'Hệ thống đang gặp lỗi.' } });
  }
};
