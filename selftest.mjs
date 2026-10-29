// Kiểm thử đầu-cuối qua HTTP với Redis giả trong bộ nhớ: node selftest.mjs (tự bật dev.mjs ở cổng 3798).
// Kiểm tra: xác thực admin/worker, Registry, Campaign, Sales Manager, worker nhận việc và gửi bản nháp, duyệt, công tắc dừng khẩn cấp, ghi song song.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob, extractJson } from './worker/worker.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 3798; const base = `http://127.0.0.1:${port}`; const workerToken = 'test-worker-token-0123456789';
const server = spawn(process.execPath, [path.join(root, 'dev.mjs')], { env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: 'test-admin', WORKER_TOKEN: workerToken, LANDING_URL: 'https://shop.example.com' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failed += 1; };
const post = async (url, body, headers = {}) => { const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); const type = response.headers.get('content-type') || ''; return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : await response.text() }; };
const worker = (body, token = workerToken) => post('/api/worker', { workerId: 'w1', ...body }, { Authorization: `Bearer ${token}` });

try {
  for (let i = 0; i < 30; i += 1) { try { if ((await fetch(base + '/')).status) break; } catch { await sleep(200); } }

  // --- xác thực
  check('admin chưa đăng nhập → 401', (await post('/api/admin', { method: 'GET', path: 'overview' })).status === 401);
  check('worker sai token → 401; thiếu token → 401', (await worker({ action: 'claim' }, 'sai-token-sai-token-sai')).status === 401 && (await post('/api/worker', { action: 'claim' })).status === 401);
  check('trang gốc không phải trang bán hàng (chuyển về quản trị, noindex)', await (async () => { const r = await post('/api/nope', {}); const home = await fetch(base + '/'); const text = await home.text(); return r.status === 404 && /noindex/.test(text) && !/Mua ngay|doanh thu/i.test(text); })());
  const login = await fetch(base + '/api/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('đăng nhập đúng: cookie HttpOnly + SameSite=Strict', login.status === 200 && /HttpOnly/.test(login.headers.get('set-cookie')) && /SameSite=Strict/.test(login.headers.get('set-cookie')));
  const rpc = (method, p, input) => post('/api/admin', { method, path: p, input }, { Cookie: cookie });

  // --- Registry có sẵn hai sản phẩm đang bán; thêm sản phẩm thứ ba chỉ bằng dữ liệu
  let r = await rpc('GET', 'products');
  check('Registry nạp sẵn Muse Studio (50.000đ) và Muse Studio Pro (99.000đ), đang bán, link mua thuộc trang bán', r.body.data.length === 2 && r.body.data.every((p) => p.status === 'selling' && p.buyUrl.startsWith('https://shop.example.com')) && r.body.data.map((p) => p.priceVnd).sort().join() === '50000,99000', JSON.stringify(r.body).slice(0, 160));
  r = await rpc('POST', 'products', { name: 'Master Prompt AI Video', type: 'digital', priceVnd: 79000, buyUrl: 'https://shop.example.com/#mua', benefits: 'Prompt dùng ngay', approvedFeatures: 'Bộ prompt dạng PDF' });
  check('thêm sản phẩm mới bằng dữ liệu → ở trạng thái nháp', r.status === 201 && r.body.data.status === 'draft' && r.body.data.id === 'master-prompt-ai-video');
  check('link mua ngoài trang bán bị từ chối', (await rpc('POST', 'products', { name: 'X', type: 'tool', priceVnd: 1000, buyUrl: 'https://evil.example.com/' })).status === 400);
  check('mở bán sản phẩm', (await rpc('POST', 'products/master-prompt-ai-video/status', { status: 'selling' })).status === 200);

  // --- Campaign: phải duyệt mới chạy
  r = await rpc('POST', 'campaigns', { productId: 'muse-studio', channels: ['youtube', 'facebook'] });
  const campaign = r.body.data;
  check('chiến dịch mới ở trạng thái CHỜ DUYỆT, hồ sơ suy ra từ Registry', r.status === 201 && campaign.status === 'PENDING_APPROVAL' && campaign.messages.length === 3);
  r = await rpc('POST', 'manager/run');
  check('Sales Manager chưa duyệt chiến dịch thì không tạo việc', r.status === 200 && r.body.data.created.length === 0);
  check('worker chưa có việc → null', (await worker({ action: 'claim' })).body.data.job === null);
  await rpc('POST', `campaigns/${campaign.id}/approve`);
  r = await rpc('POST', 'manager/run');
  check('duyệt xong, Sales Manager tạo 2 việc (youtube, facebook)', r.body.data.created.length === 2);
  check('mỗi kênh giữ sẵn tối đa 2 nháp: lượt 2 bổ sung đủ, lượt 3 không tạo việc trùng', (await rpc('POST', 'manager/run')).body.data.created.length === 2 && (await rpc('POST', 'manager/run')).body.data.created.length === 0);

  // --- Worker nhận việc, "AI" trả lời qua runJob (Muse giả), gửi bản nháp
  const claimed = (await worker({ action: 'claim' })).body.data.job;
  check('worker nhận việc kèm prompt chứa đúng dữ liệu sản phẩm, không có bí mật', claimed && claimed.prompt.includes('Muse Studio') && claimed.prompt.includes('50.000đ') && !/hatch_|cookie|token/i.test(claimed.prompt), claimed?.prompt.slice(0, 60));
  const fakeMuse = async () => 'Đây là bản nháp:\n```json\n{"title": "Đăng video đều đặn", "body": "Muse Studio giúp bạn duyệt video trước khi đăng. Giá 50.000đ một lần."}\n```';
  const aiResult = await runJob(claimed, fakeMuse);
  check('runJob tách được JSON từ câu trả lời kèm lời dẫn; trả lời sai định dạng → lỗi cho phép thử lại', aiResult.title === 'Đăng video đều đặn' && await runJob(claimed, async () => 'xin lỗi tôi không biết').then(() => false, (e) => e.retry === true) && extractJson('{"a":1}', 'title') === null);
  check('hết cookie/quota → lỗi KHÔNG retry', await runJob(claimed, async () => { const e = new Error('hết hạn'); e.code = 'AUTH_REQUIRED'; throw e; }).then(() => false, (e) => e.retry === false));
  check('worker khác không hoàn thành được việc của worker này', (await post('/api/worker', { workerId: 'w2', action: 'complete', jobId: claimed.id, result: aiResult }, { Authorization: `Bearer ${workerToken}` })).status === 409);
  r = await worker({ action: 'complete', jobId: claimed.id, result: aiResult });
  const draft = r.body.data.content;
  check('bản nháp của agent vào hàng CHỜ DUYỆT, chưa duyệt, link có UTM riêng', r.status === 200 && draft.status === 'PENDING_APPROVAL' && draft.approvedBy === null && draft.targetUrl.includes('utm_source=') && draft.targetUrl.includes(`utm_content=${draft.id}`), draft?.targetUrl);
  const bad = (await worker({ action: 'claim' })).body.data.job;
  r = await worker({ action: 'complete', jobId: bad.id, result: { title: 'Giảm còn 9.000đ', body: 'Chắc chắn viral, đảm bảo lên top.' } });
  check('AI viết giá sai/cam kết viral → giữ ở NHÁP kèm lý do, không vào hàng chờ duyệt', r.body.data.content.status === 'DRAFT' && r.body.data.content.gate.errors.length >= 2);

  // --- Human Approval
  check('chưa duyệt → không lấy được gói đăng', (await rpc('POST', `content/${draft.id}/publish`)).status === 409);
  await rpc('POST', `content/${draft.id}/approve`); await rpc('PATCH', 'settings', { channels: { [draft.channel]: true } });
  r = await rpc('POST', `content/${draft.id}/publish`);
  check('duyệt + bật kênh → có gói đăng thủ công', r.status === 200 && r.body.data.mode === 'manual');
  r = await rpc('GET', 'overview');
  check('Command Center: worker đang kết nối, Research Agent ghi rõ "chưa xây"', r.body.data.agents.find((a) => a.name === 'Content Agent').state === 'online' && r.body.data.agents.find((a) => a.name === 'Research Agent').state === 'off' && r.body.data.content.PENDING_APPROVAL === 0);

  // --- ghi song song không mất dữ liệu
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc('POST', 'content', { channel: 'facebook', title: `Bài thử ${i}`, body: `Nội dung khác nhau số ${i} ${'abc'.repeat(i + 1)} giá 50.000đ ${'x'.repeat(i * 7)}` })));
  const all = (await rpc('GET', 'content')).body.data;
  check('8 yêu cầu ghi song song đều được lưu (khóa chống ghi đè)', results.every((x) => x.status === 201) && all.filter((c) => /^Bài thử/.test(c.title)).length === 8, `${all.filter((c) => /^Bài thử/.test(c.title)).length}/8`);

  // --- công tắc dừng khẩn cấp
  await rpc('POST', 'kill-switch', { enabled: true });
  check('dừng khẩn cấp: worker không nhận được việc, Sales Manager bị chặn, không lấy được gói đăng', (await worker({ action: 'claim' })).body.data.reason === 'kill_switch' && (await rpc('POST', 'manager/run')).status === 409 && (await rpc('POST', `content/${draft.id}/publish`)).status === 409);
  await rpc('POST', 'kill-switch', { enabled: false });

  // --- đổi giá sản phẩm → chiến dịch phải duyệt lại
  await rpc('PATCH', 'products/muse-studio', { priceVnd: 60000 });
  check('đổi giá sản phẩm → chiến dịch đang chạy về CHỜ DUYỆT', (await rpc('GET', 'campaigns')).body.data[0].status === 'PENDING_APPROVAL');
} catch (error) { console.error(error); failed += 1; }
server.kill();
console.log(failed ? `\n${failed} lỗi` : '\nTẤT CẢ ĐẠT');
process.exit(failed ? 1 : 0);
