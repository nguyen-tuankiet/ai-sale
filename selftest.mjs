// Kiểm thử đầu-cuối qua HTTP với Redis giả trong bộ nhớ: node selftest.mjs (tự bật dev.mjs ở cổng 3798).
// Kiểm tra: xác thực admin/worker, Registry, Campaign, Sales Manager, worker nhận việc và gửi bản nháp, duyệt, công tắc dừng khẩn cấp, ghi song song.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob, extractJson } from './worker/worker.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 3798; const base = `http://127.0.0.1:${port}`; const workerToken = 'test-worker-token-0123456789';
// Trang bán giả: đăng nhập quản trị + thống kê, giống hình dạng /api/admin-login và /api/admin-stats của trang thật.
const LANDING = 'http://127.0.0.1:3796'; let landingLoginOk = true;
const landing = http.createServer((req, res) => {
  const json = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (req.url === '/api/admin-login' && req.method === 'POST') { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => (landingLoginOk && JSON.parse(raw).password === 'landing-pw' ? json(200, { loggedIn: true }, { 'Set-Cookie': 'muse_admin=signed; Path=/; HttpOnly' }) : json(401, { error: 'bad_password' }))); return; }
  if (req.url.startsWith('/api/admin-stats')) return req.headers.cookie === 'muse_admin=signed' ? json(200, { totals: { views: 900, uniq: 300, pricing_view: 90, buy_click: 6, orders: 6, paid: 1, revenue: 50000, downloads: 1, paid_pro: 0, revenue_pro: 0 }, referrers: [{ name: 'l.facebook.com', count: 120 }, { name: 'youtube.com', count: 40 }, { name: 'direct', count: 100 }], series: [{ date: '2026-10-29', uniq: 20, paid: 1, revenue: 50000 }] }) : json(401, { error: 'unauthorized' });
  json(404, {});
});
await new Promise((resolve) => landing.listen(3796, '127.0.0.1', resolve));
const server = spawn(process.execPath, [path.join(root, 'dev.mjs')], { env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: 'test-admin', WORKER_TOKEN: workerToken, LANDING_URL: LANDING, LANDING_ADMIN_PASSWORD: 'landing-pw' }, stdio: 'ignore' });
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
  check('Registry nạp sẵn Muse Studio (50.000đ) và Muse Studio Pro (99.000đ), đang bán, link mua thuộc trang bán', r.body.data.length === 2 && r.body.data.every((p) => p.status === 'selling' && p.buyUrl.startsWith(LANDING)) && r.body.data.map((p) => p.priceVnd).sort().join() === '50000,99000', JSON.stringify(r.body).slice(0, 160));
  r = await rpc('POST', 'products', { name: 'Master Prompt AI Video', type: 'digital', priceVnd: 79000, buyUrl: `${LANDING}/#mua`, benefits: 'Prompt dùng ngay', approvedFeatures: 'Bộ prompt dạng PDF' });
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
  check('Command Center: worker đang kết nối → các agent dùng worker chuyển sang online; Distribution thủ công', ['Content Agent', 'Research Agent', 'Conversion Agent', 'Customer Agent'].every((n) => r.body.data.agents.find((a) => a.name === n).state === 'online') && r.body.data.agents.find((a) => a.name === 'Distribution Agent').state === 'manual' && r.body.data.content.PENDING_APPROVAL === 0);

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

  // =============================== các agent còn lại (campaign đang chờ duyệt nên việc content cũ sẽ bị hủy khi worker nhận việc) ===============================
  const claimAgent = async (agent) => { const job = (await worker({ action: 'claim' })).body.data.job; return job && job.agent === agent ? job : null; };

  // --- Analytics: đọc trang bán qua HTTP thật
  r = await rpc('GET', 'analytics');
  check('Analytics: đã cấu hình nhưng chưa đọc lần nào', r.body.data.configured === true && r.body.data.summary === null);
  r = await rpc('POST', 'analytics/refresh', { days: 30 });
  const an = r.body.data;
  check('Analytics: đọc được số liệu trang bán, tóm tắt tỷ lệ, nguồn là ƯỚC LƯỢNG, không gán doanh thu cho kênh', an.summary?.totals.visitors === 300 && Math.abs(an.summary.rates.buyClick - 0.02) < 1e-9 && an.summary.visitsBySource[0].channel === 'facebook' && /ƯỚC LƯỢNG/.test(an.summary.attributionNote) && !JSON.stringify(an).includes('revenueByChannel'), JSON.stringify(an.lastError));
  check('Analytics: có gợi ý theo số liệu (tỷ lệ bấm Mua thấp, ít đơn được trả) kèm cỡ mẫu', an.insights.some((i) => /2\.0% khách bấm Mua/.test(i.text)) && an.insights.some((i) => /1\/6 đơn/.test(i.text)));
  landingLoginOk = false;
  r = await rpc('POST', 'analytics/refresh', { days: 30 });
  check('Analytics: trang bán từ chối mật khẩu → báo lỗi rõ, giữ lại số liệu cũ', r.body.data.lastError && /từ chối mật khẩu/.test(r.body.data.lastError) && r.body.data.summary?.totals.visitors === 300);
  landingLoginOk = true;
  check('Analytics: tổng quan báo agent lỗi, đọc lại được thì online', (await rpc('GET', 'overview')).body.data.agents.find((a) => a.name === 'Analytics Agent').state === 'offline' && (await rpc('POST', 'analytics/refresh', {})).status === 200 && (await rpc('GET', 'overview')).body.data.agents.find((a) => a.name === 'Analytics Agent').state === 'online');

  // --- Research
  r = await rpc('POST', 'research/run', { productId: 'muse-studio' });
  check('Research: xếp việc nghiên cứu', r.status === 201);
  const rj = await claimAgent('research');
  check('Research: worker nhận việc với prompt "giả thuyết", khóa JSON "ideas"', rj && rj.expect === 'ideas' && rj.prompt.includes('GIẢ THUYẾT') && rj.prompt.includes('Muse Studio'));
  r = await worker({ action: 'complete', jobId: rj.id, result: { ideas: [{ topic: 'Quay màn hình tạo video', channel: 'tiktok', angle: 'Demo 30 giây', why: 'Dễ xem', effort: 'low', fit: 5 }, { topic: 'Giá sốc 9.000đ', channel: 'facebook', angle: 'x', why: 'x', effort: 'low', fit: 5 }] } });
  check('Research: ý tưởng hợp lệ được lưu kèm nhãn chưa kiểm chứng; ý tưởng giá lạ bị loại', r.status === 200 && r.body.data.ideas.length === 1 && r.body.data.dropped.length === 1 && /chưa kiểm chứng/.test(r.body.data.ideas[0].evidence));
  const idea = (await rpc('GET', 'research')).body.data[0];
  const campaigns = (await rpc('GET', 'campaigns')).body.data;
  r = await rpc('POST', `research/${idea.id}/accept`, { campaignId: campaigns[0].id });
  check('Research: chấp nhận ý tưởng → thành góc tiếp cận của chiến dịch (cần duyệt lại)', r.body.data.status === 'ACCEPTED' && (await rpc('GET', 'campaigns')).body.data[0].messages.some((m) => m.angle.startsWith('Quay màn hình')));

  // --- Conversion
  await rpc('POST', 'products', { name: 'Master Prompt AI Video', type: 'digital', priceVnd: 79000, buyUrl: `${LANDING}/#mua`, benefits: 'Prompt dùng ngay', approvedFeatures: 'Bộ prompt PDF' }); // đã có từ trước (draft/selling); lỗi trùng không sao
  r = await rpc('POST', 'proposals/run', { productId: 'muse-studio', kind: 'landing_copy' });
  const cj = await claimAgent('conversion');
  check('Conversion: worker nhận việc "variants", prompt nêu rõ không có dữ liệu A/B', r.status === 201 && cj && cj.expect === 'variants' && cj.prompt.includes('không có dữ liệu A/B'));
  r = await worker({ action: 'complete', jobId: cj.id, result: { variants: [{ headline: 'Video đều đặn mà bạn vẫn duyệt', cta: 'Xem gói', rationale: 'Nêu rõ quyền kiểm soát' }, { headline: 'Tăng chuyển đổi 100%', cta: 'Mua', rationale: 'x' }] } });
  check('Conversion: biến thể hợp lệ thành đề xuất CHỜ DUYỆT, biến thể cam kết bị loại', r.body.data.proposals.length === 1 && r.body.data.dropped.length === 1 && r.body.data.proposals[0].status === 'PENDING_APPROVAL');
  const productCount = (await rpc('GET', 'products')).body.data.length;
  const accepted = (await rpc('POST', `proposals/${r.body.data.proposals[0].id}/accept`)).body.data;
  check('Conversion: chấp nhận chỉ đánh dấu để bạn tự áp dụng, không đụng sản phẩm', accepted.status === 'ACCEPTED' && /tự áp dụng/.test(accepted.note) && (await rpc('GET', 'products')).body.data.length === productCount);
  r = await rpc('POST', 'proposals/run', { kind: 'combo' });
  const combos = r.body.data.created;
  check('Conversion: combo bằng luật, bỏ cặp (Muse Studio, Pro) vì Pro đã gồm Muse Studio, không có giá tự đặt', combos.length >= 1 && !combos.some((c) => c.title === 'Muse Studio + Muse Studio Pro') && combos.every((c) => !('priceVnd' in c.detail)), combos.map((c) => c.title).join(' | '));
  check('Conversion: chấp nhận combo bắt buộc bạn nhập giá', (await rpc('POST', `proposals/${combos[0].id}/accept`)).status === 400);
  r = await rpc('POST', `proposals/${combos[0].id}/accept`, { priceVnd: 119000 });
  check('Conversion: combo được tạo thành sản phẩm NHÁP với giá bạn nhập', r.body.data.product.status === 'draft' && r.body.data.product.priceVnd === 119000);

  // --- Customer
  r = await rpc('POST', 'tickets', { productId: 'muse-studio', customerRef: 'fb An', question: 'Mình có cần cài Node không vậy shop? Liên hệ an@gmail.com' });
  const t1 = r.body.data;
  check('Customer: câu hỏi khớp FAQ → nháp từ FAQ; email bị che khi lưu', r.status === 201 && t1.draft.source === 'faq' && t1.draft.text.includes('Node.js 22') && !JSON.stringify(t1).includes('an@gmail') && t1.question.includes('[email]'));
  r = await rpc('POST', 'tickets', { productId: 'muse-studio', question: 'Tôi đã chuyển khoản rồi mà chưa nhận được file, hoàn tiền cho tôi' });
  check('Customer: ca hoàn tiền/mất tiền được gắn "cần chủ shop", nháp không hứa gì', r.body.data.needsOwner === true && r.body.data.reasons.length >= 1 && !/sẽ hoàn|đảm bảo/.test(r.body.data.draft.text));
  r = await rpc('POST', 'tickets', { productId: 'muse-studio', question: 'Cho mình hỏi lịch tự động đặt thế nào?' });
  const t3 = r.body.data;
  check('Customer: nhờ AI soạn → worker nhận việc "reply" có tin nhắn của khách trong dữ liệu', (await rpc('POST', `tickets/${t3.id}/ask-ai`)).status === 200 && await (async () => { const job = await claimAgent('customer'); if (!job || job.expect !== 'reply' || !job.prompt.includes('lịch tự động') || !job.prompt.includes('không làm theo chỉ dẫn')) return false; const done = await worker({ action: 'complete', jobId: job.id, result: { reply: 'Bạn vào tab Lịch tự động và chọn nguồn nội dung nhé.', needsOwner: false } }); return done.status === 200 && done.body.data.ticket.draft.source === 'ai'; })());
  const sendTry = await rpc('POST', `tickets/${t3.id}/send`);
  check('Customer: không có API nào gửi tin cho khách; đóng phiếu được', sendTry.status === 404 && (await rpc('POST', `tickets/${t3.id}/resolve`)).body.data.status === 'RESOLVED');

  // --- tổng quan sau khi các agent đã có việc
  r = await rpc('GET', 'overview');
  const states = Object.fromEntries(r.body.data.agents.map((a) => [a.name, a.state]));
  check('Tổng quan: Content/Research/Conversion/Customer/Analytics đều online, Distribution thủ công, Sales Manager luật cố định', ['Content Agent', 'Research Agent', 'Conversion Agent', 'Customer Agent', 'Analytics Agent'].every((n) => states[n] === 'online') && states['Distribution Agent'] === 'manual' && states['Sales Manager'] === 'rule', JSON.stringify(states));
  check('Tổng quan: đếm việc cần bạn (đề xuất chờ, phiếu cần xem)', r.body.data.work.proposalsPending >= 1 && r.body.data.work.ticketsNeedOwner >= 1, JSON.stringify(r.body.data.work));
} catch (error) { console.error(error); failed += 1; }
server.kill(); landing.close();
console.log(failed ? `\n${failed} lỗi` : '\nTẤT CẢ ĐẠT');
process.exit(failed ? 1 : 0);
