// Tự kiểm thử trang bán hàng bằng SePay giả và Redis giả trong bộ nhớ: node selftest.mjs (tự bật dev.mjs ở cổng 3798).
// Thanh toán gốc (đơn, webhook, tải file) đã có bộ kiểm thử riêng ở dự án museinsight/site; ở đây kiểm tra phần mới: sổ công khai, nhật ký, chi phí, quảng bá.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 3798; const base = `http://127.0.0.1:${port}`; const key = 'test-key';
const server = spawn(process.execPath, [path.join(root, 'dev.mjs')], { env: { ...process.env, PORT: String(port), SEPAY_API_KEY: key, ADMIN_PASSWORD: 'test-admin', GOAL_VND: '500000', SITE_URL: 'https://shop.example.com' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failed += 1; };
const call = async (url, options = {}) => { const response = await fetch(base + url, options); const type = response.headers.get('content-type') || ''; return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : await response.text() }; };
const post = (url, body, headers = {}) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
let tx = 5000;
const pay = (code, amount) => post('/api/sepay-webhook', { id: (tx += 1), transferType: 'in', transferAmount: amount, content: code, description: code }, { Authorization: `Apikey ${key}` });

try {
  for (let i = 0; i < 30; i += 1) { try { if ((await fetch(base + '/')).status) break; } catch { await sleep(200); } }

  // --- trang tĩnh và an toàn nguồn
  let r = await call('/');
  check('trang chủ phục vụ được, có sổ thu chi và khung sản phẩm', r.status === 200 && r.body.includes('id="so"') && r.body.includes('data-plan="pro"'));
  check('mã nguồn API/lib không bị phát ra như file tĩnh', (await call('/api/_lib.js')).status === 404 && (await call('/lib/marketing.js')).status === 404 && (await call('/../.env')).status === 404);

  // --- sổ công khai bắt đầu từ 0, không số giả
  r = await call('/api/ledger');
  check('sổ rỗng: doanh thu 0, 0 đơn, có mục tiêu 500.000đ', r.status === 200 && r.body.revenue === 0 && r.body.orders === 0 && r.body.goal === 500000 && r.body.progress === 0, JSON.stringify(r.body).slice(0, 160));

  // --- đơn thật vào sổ; đơn thử nhỏ bị loại; đơn chưa trả không tính
  const real = (await post('/api/order', { email: 'khach@example.com' })).body;
  const pro = (await post('/api/order', { plan: 'pro' })).body;
  await post('/api/order', {}); // đơn chưa trả
  check('trước khi trả tiền sổ vẫn 0', (await call('/api/ledger')).body.revenue === 0);
  await pay(real.code, 50000); await pay(pro.code, 99000);
  r = await call('/api/ledger');
  check('sau 2 đơn trả đủ: doanh thu 149.000đ, 2 đơn (1 thường, 1 Pro), tiến độ ~29.8%', r.body.revenue === 149000 && r.body.orders === 2 && r.body.byPlan.basic === 1 && r.body.byPlan.pro === 1 && Math.abs(r.body.progress - 0.298) < 0.001, JSON.stringify(r.body).slice(0, 200));
  const publicText = JSON.stringify(r.body);
  check('sổ công khai không lộ email, mã đơn hay token', !publicText.includes('khach@') && !publicText.includes(real.code) && !publicText.includes(real.token) && r.body.recent.length === 2 && Object.keys(r.body.recent[0]).sort().join() === 'amount,at,plan');
  check('đơn nhỏ hơn mức tối thiểu (đơn thử) bị loại khỏi sổ', await (async () => { const t = (await post('/api/order', {})).body; await pay(t.code, 2000); return (await call('/api/ledger')).body.revenue === 149000; })());

  // --- quản trị yêu cầu đăng nhập
  check('admin-marketing chưa đăng nhập → 401', (await post('/api/admin-marketing', { method: 'GET', path: 'diary' })).status === 401);
  const login = await fetch(base + '/api/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const rpc = (method, p, input) => post('/api/admin-marketing', { method, path: p, input }, { Cookie: cookie });

  // --- nhật ký: bản nháp không lộ, đăng phải qua kiểm tra
  r = await rpc('POST', 'diary/draft');
  const draft = r.body.data;
  check('soạn nháp từ số liệu thật: chứa đúng doanh thu và số đơn, ở trạng thái nháp', r.status === 201 && draft.status === 'DRAFT' && draft.body.includes('149.000đ') && draft.body.includes('2 đơn'), draft?.body);
  check('bản nháp chưa lộ ra trang công khai', (await call('/api/diary')).body.entries.length === 0);
  const bad = (await rpc('POST', 'diary', { title: 'Khuyến mãi', body: 'Chỉ 9.000đ, đảm bảo lên top, video chắc chắn viral.' })).body.data;
  r = await rpc('POST', `diary/${bad.id}/publish`);
  check('bài có giá sai/cam kết viral bị chặn khi đăng', r.status === 422 && /không khớp bảng giá/.test(r.body.error.message) && /cam kết/.test(r.body.error.message), r.body.error?.message);
  check('bài bị chặn vẫn không lộ công khai', (await call('/api/diary')).body.entries.length === 0);
  r = await rpc('POST', `diary/${draft.id}/publish`);
  const entries = (await call('/api/diary')).body.entries;
  check('bài số liệu thật đăng được và hiện công khai', r.status === 200 && entries.length === 1 && entries[0].id === draft.id);
  await rpc('PATCH', `diary/${draft.id}`, { body: draft.body + '\nCảm ơn các bạn đã ghé.' });
  check('sửa bài đã đăng → về nháp, biến mất khỏi trang công khai tới khi duyệt lại', (await call('/api/diary')).body.entries.length === 0);

  // --- chi phí hiện trên sổ
  check('khoản chi sai bị từ chối', (await rpc('POST', 'costs', { label: '', amountVnd: -5 })).status === 400);
  await rpc('POST', 'costs', { label: 'Tên miền', amountVnd: 30000 });
  r = await call('/api/ledger');
  check('khoản chi vào sổ: chi 30.000đ, còn lại 119.000đ', r.body.costTotal === 30000 && r.body.net === 119000 && r.body.costs[0].label === 'Tên miền');

  // --- hàng đợi quảng bá lưu bền qua các lần gọi
  r = await rpc('POST', 'plan', {});
  check('tạo nháp 4 kênh từ bảng giá hiện hành (50.000đ), link đích thuộc SITE_URL kèm UTM', r.status === 201 && r.body.data.length === 4 && r.body.data.every((c) => c.targetUrl.startsWith('https://shop.example.com') && c.targetUrl.includes('utm_source=')) && r.body.data[0].body.includes('50.000đ'), r.body.error?.message);
  const item = r.body.data[0];
  check('nội dung vẫn còn ở lần gọi sau (lưu trên Redis) và chưa được duyệt', (await rpc('GET', 'content')).body.data.length === 4 && item.status === 'PENDING_APPROVAL');
  check('chưa duyệt → lấy gói đăng bị chặn', (await rpc('POST', `content/${item.id}/publish`)).status === 409);
  await rpc('POST', `content/${item.id}/approve`); await rpc('PATCH', 'settings', { channels: { [item.channel]: true } });
  r = await rpc('POST', `content/${item.id}/publish`);
  check('đã duyệt + bật kênh → có gói đăng thủ công', r.status === 200 && r.body.data.mode === 'manual' && r.body.data.pack.link.includes('utm_'), JSON.stringify(r.body).slice(0, 120));
  await rpc('POST', 'kill-switch', { enabled: true });
  check('công tắc dừng khẩn cấp chặn lấy gói đăng', (await rpc('POST', `content/${item.id}/publish`)).status === 409);
} catch (error) { console.error(error); failed += 1; }
server.kill();
console.log(failed ? `\n${failed} lỗi` : '\nTẤT CẢ ĐẠT');
process.exit(failed ? 1 : 0);
