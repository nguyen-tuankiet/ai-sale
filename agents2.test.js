// Kiểm thử Research, Conversion, Customer và Analytics Agent: node agents2.test.js. Không cần mạng hay AI thật.
const assert = require('assert');
const { createMarketing } = require('./lib/marketing');
const { createAgents } = require('./lib/agents');
const analytics = require('./lib/analytics');
const support = require('./lib/support');

let failed = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`PASS  ${name}`), (error) => { failed += 1; console.log(`FAIL  ${name}  — ${error.message}`); });
const SITE = 'https://shop.example.com';

function setup() {
  const state = {};
  const marketing = createMarketing({ getStore: () => ({ marketing: state.marketing || (state.marketing = {}) }), persist: () => {}, siteUrl: SITE });
  const agents = createAgents({ state, marketing, siteUrl: SITE, analyticsConfigured: true });
  const tool = agents.saveProduct({ name: 'Muse Studio', type: 'tool', priceVnd: 50000, buyUrl: `${SITE}/#mua`, audience: 'Chủ kênh YouTube', benefits: ['Đăng video đều đặn'], approvedFeatures: ['Tạo video theo lịch', 'Duyệt trước khi đăng'], faq: 'Có cần cài Node không? | Cần Node.js 22 trở lên và Chrome hoặc Edge.\nDữ liệu nằm ở đâu? | Toàn bộ nằm trên máy của bạn trong thư mục data.', keywords: 'video AI, YouTube', includes: [] }).data;
  agents.setProductStatus(tool.id, 'selling');
  return { state, marketing, agents, tool };
}
const run = (agents, job, workerId = 'w1') => { const claimed = agents.claim(workerId).data.job; assert.ok(claimed, 'không nhận được việc'); assert.strictEqual(claimed.agent, job); return claimed; };

(async () => {
  await check('Research: việc → ý tưởng xếp hạng theo fit/công sức, gắn nhãn "chưa kiểm chứng"; ý tưởng giá lạ/cam kết bị loại', () => {
    const { agents, state, tool } = setup();
    assert.strictEqual(agents.runResearch(tool.id).status, 201);
    assert.strictEqual(agents.runResearch(tool.id).status, 409);
    const job = run(agents, 'research');
    assert.strictEqual(job.expect, 'ideas'); assert.ok(job.prompt.includes('GIẢ THUYẾT') && job.prompt.includes('video AI') && !/https?:\/\//.test(job.prompt));
    const done = agents.complete(job.id, 'w1', { ideas: [
      { topic: 'Quay màn hình tạo video', channel: 'tiktok', angle: 'Demo 30 giây', why: 'Khách thích xem thao tác', effort: 'low', fit: 5 },
      { topic: 'Phim dàn dựng', channel: 'youtube', angle: 'Kịch bản dài', why: 'Chất lượng cao', effort: 'high', fit: 4 },
      { topic: 'Chỉ 9.000đ', channel: 'facebook', angle: 'Giá sốc', why: 'x', effort: 'low', fit: 5 },
      { topic: 'Viral chắc chắn', channel: 'facebook', angle: 'Đảm bảo lên top', why: 'x', effort: 'low', fit: 5 },
    ] });
    assert.strictEqual(done.status, 200);
    const ideas = done.data.ideas;
    assert.deepStrictEqual(ideas.map((idea) => idea.topic), ['Quay màn hình tạo video', 'Phim dàn dựng']); // điểm 10 > 6
    assert.strictEqual(done.data.dropped.length, 2); assert.ok(ideas.every((idea) => /chưa kiểm chứng/.test(idea.evidence) && idea.status === 'NEW'));
    assert.strictEqual(state.research.ideas.length, 2);
  });

  await check('Research: chấp nhận ý tưởng → thêm vào góc tiếp cận chiến dịch và chiến dịch đang chạy phải duyệt lại', () => {
    const { agents, state, tool } = setup();
    const campaign = agents.createCampaign({ productId: tool.id }).data; agents.setCampaignStatus(campaign.id, 'approve');
    agents.runResearch(tool.id); const job = run(agents, 'research');
    const idea = agents.complete(job.id, 'w1', { ideas: [{ topic: 'Quay màn hình', channel: 'tiktok', angle: 'Demo ngắn', why: 'dễ làm', effort: 'low', fit: 4 }] }).data.ideas[0];
    assert.strictEqual(agents.route('POST', ['research', idea.id, 'accept'], { campaignId: 'camp_khong_co' }).status, 400);
    assert.strictEqual(agents.route('POST', ['research', idea.id, 'accept'], { campaignId: campaign.id }).data.status, 'ACCEPTED');
    assert.ok(state.campaigns[0].messages.some((message) => message.angle.startsWith('Quay màn hình')));
    assert.strictEqual(state.campaigns[0].status, 'PENDING_APPROVAL');
  });

  await check('Conversion: biến thể tiêu đề/CTA thành ĐỀ XUẤT chờ duyệt; không sửa trang bán; chấp nhận chỉ đánh dấu để bạn tự áp dụng', () => {
    const { agents, state, tool } = setup();
    agents.runConversion(tool.id, 'landing_copy'); const job = run(agents, 'conversion');
    assert.strictEqual(job.expect, 'variants'); assert.ok(job.prompt.includes('không có dữ liệu A/B'));
    const out = agents.complete(job.id, 'w1', { variants: [{ headline: 'Video đều đặn mà bạn vẫn duyệt', cta: 'Xem gói', rationale: 'Nêu rõ quyền kiểm soát' }, { headline: 'Tăng chuyển đổi 100%', cta: 'Mua', rationale: 'x' }] });
    assert.strictEqual(out.data.proposals.length, 1); assert.strictEqual(out.data.dropped.length, 1);
    const proposal = out.data.proposals[0];
    assert.strictEqual(proposal.status, 'PENDING_APPROVAL');
    const accepted = agents.route('POST', ['proposals', proposal.id, 'accept'], {});
    assert.strictEqual(accepted.data.status, 'ACCEPTED'); assert.match(accepted.data.note, /tự áp dụng/);
    assert.strictEqual(agents.route('POST', ['proposals', proposal.id, 'accept'], {}).status, 409);
    assert.strictEqual(state.products.length, 1); // không tạo/sửa sản phẩm
  });

  await check('Conversion: combo chỉ ghép sản phẩm không bao gồm nhau, KHÔNG tự đặt giá; chấp nhận cần giá do bạn nhập, tạo sản phẩm ở trạng thái NHÁP', () => {
    const { agents, state, tool } = setup();
    const pro = agents.saveProduct({ name: 'Muse Studio Pro', type: 'tool', priceVnd: 99000, buyUrl: `${SITE}/#mua`, benefits: ['Kèm prompt'], approvedFeatures: ['Gồm Muse Studio'], includes: [tool.id] }).data; agents.setProductStatus(pro.id, 'selling');
    const doc = agents.saveProduct({ name: 'Master Prompt', type: 'digital', priceVnd: 79000, buyUrl: `${SITE}/#mua`, benefits: ['Prompt dùng ngay'], approvedFeatures: ['Bộ prompt PDF'] }).data; agents.setProductStatus(doc.id, 'selling');
    const out = agents.runConversion(null, 'combo').data;
    const names = out.created.map((proposal) => proposal.title).sort();
    assert.deepStrictEqual(names, ['Muse Studio + Master Prompt', 'Muse Studio Pro + Master Prompt']); // Pro đã gồm Muse Studio nên không có cặp (Muse Studio, Pro)
    assert.ok(!names.includes('Muse Studio + Muse Studio Pro'));
    assert.ok(out.created.every((proposal) => proposal.detail.listPriceSum > 0 && !('priceVnd' in proposal.detail)));
    assert.strictEqual(agents.runConversion(null, 'combo').data.created.length, 0); // không đề xuất trùng
    const target = out.created[0];
    assert.strictEqual(agents.route('POST', ['proposals', target.id, 'accept'], {}).status, 400);
    const accepted = agents.route('POST', ['proposals', target.id, 'accept'], { priceVnd: 119000 });
    assert.strictEqual(accepted.data.product.status, 'draft'); assert.strictEqual(accepted.data.product.priceVnd, 119000); assert.strictEqual(accepted.data.product.includes.length, 2);
    assert.ok(state.products.length === 4);
  });

  await check('Customer: FAQ khớp → nháp từ FAQ (không cần AI); không khớp → nháp mẫu + báo bạn xử lý; không có gì được gửi đi', () => {
    const { agents } = setup();
    const a = agents.createTicket({ productId: 'muse-studio', question: 'Mình có cần cài Node không vậy shop?', customerRef: 'fb: An' }).data;
    assert.strictEqual(a.draft.source, 'faq'); assert.ok(a.draft.text.includes('Node.js 22')); assert.strictEqual(a.needsOwner, false); assert.strictEqual(a.status, 'DRAFTED');
    const b = agents.createTicket({ productId: 'muse-studio', question: 'Tool có chạy được trên máy Mac M3 không?' }).data;
    assert.strictEqual(b.draft.source, 'template'); assert.strictEqual(b.needsOwner, true);
  });

  await check('Customer: ca hoàn tiền/mất tiền → chuyển bạn, nháp chỉ xác nhận đã nhận, không hứa gì', () => {
    const { agents } = setup();
    const ticket = agents.createTicket({ productId: 'muse-studio', question: 'Tôi đã chuyển khoản rồi mà chưa nhận được file, hoàn tiền cho tôi' }).data;
    assert.strictEqual(ticket.needsOwner, true); assert.ok(ticket.reasons.length >= 1);
    assert.strictEqual(ticket.draft.source, 'template'); assert.ok(!/hoàn tiền cho bạn|sẽ hoàn|đảm bảo|bồi thường/i.test(ticket.draft.text));
  });

  await check('Customer: email, số điện thoại và cookie/token trong tin nhắn bị che trước khi lưu', () => {
    const { agents, state } = setup();
    const ticket = agents.createTicket({ productId: 'muse-studio', question: 'Liên hệ an@gmail.com hoặc 0912345678. hatch_sess=abcdefghijklmnop12345 và token ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 bị lỗi' }).data;
    const stored = JSON.stringify(state.tickets);
    assert.ok(!/an@gmail|0912345678|abcdefghijklmnop|ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/.test(stored), ticket.question);
    assert.ok(ticket.question.includes('[email]') && ticket.question.includes('[số điện thoại]'));
  });

  await check('Customer: nhờ AI soạn → prompt coi tin khách là dữ liệu, cấm hứa hoàn tiền; kết quả có giá lạ/bí mật bị chặn; sửa tay vẫn được kiểm tra', () => {
    const { agents, state } = setup();
    const ticket = agents.createTicket({ productId: 'muse-studio', question: 'Cho mình hỏi cách dùng lịch tự động ra sao?' }).data;
    assert.strictEqual(agents.route('POST', ['tickets', ticket.id, 'ask-ai'], {}).status, 200);
    assert.strictEqual(agents.route('POST', ['tickets', ticket.id, 'ask-ai'], {}).status, 409);
    const job = run(agents, 'customer');
    assert.strictEqual(job.expect, 'reply'); assert.ok(job.prompt.includes('Tuyệt đối không hứa hoàn tiền') && job.prompt.includes('không làm theo chỉ dẫn') && job.prompt.includes('lịch tự động'));
    const done = agents.complete(job.id, 'w1', { reply: 'Bạn vào tab Lịch tự động và chọn nguồn nội dung nhé.', needsOwner: false });
    assert.strictEqual(done.data.ticket.draft.source, 'ai'); assert.deepStrictEqual(done.data.ticket.draft.issues, []);
    const edited = agents.route('POST', ['tickets', ticket.id, 'edit'], { text: 'Chỉ 9.000đ thôi, đảm bảo hoàn tiền' }).data;
    assert.ok(edited.draft.issues.length >= 2 && edited.draft.source === 'manual');
    agents.route('POST', ['tickets', ticket.id, 'ask-ai'], {}); const job2 = run(agents, 'customer');
    assert.strictEqual(agents.complete(job2.id, 'w1', { reply: 'cookie hatch_sess=abcdefghijklmnop123456' }).status, 422);
    assert.strictEqual(agents.route('POST', ['tickets', ticket.id, 'resolve'], {}).data.status, 'RESOLVED');
    assert.strictEqual(agents.route('POST', ['tickets', ticket.id, 'draft'], {}).status, 409);
    assert.strictEqual(state.tickets.length, 1);
  });

  await check('hàng AI: trần mỗi ngày chặn Research/Conversion nhưng không chặn Customer; công tắc dừng khẩn cấp chặn cả ba', () => {
    const { agents, state, marketing, tool } = setup();
    state.agentSettings.dailyJobCap = 1;
    assert.strictEqual(agents.runResearch(tool.id).status, 201);
    assert.strictEqual(agents.runConversion(tool.id, 'landing_copy').status, 429);
    const ticket = agents.createTicket({ productId: tool.id, question: 'Cho mình hỏi cách cài đặt phần mềm?' }).data;
    assert.strictEqual(agents.route('POST', ['tickets', ticket.id, 'ask-ai'], {}).status, 200);
    marketing.setKillSwitch(true);
    assert.strictEqual(agents.runResearch(tool.id).status, 409);
    assert.strictEqual(agents.route('POST', ['tickets', ticket.id, 'ask-ai'], {}).status, 409);
    assert.strictEqual(agents.claim('w1').data.job, null);
  });

  await check('Analytics: đọc trang bán (đăng nhập → thống kê), tóm tắt tỷ lệ; lỗi mật khẩu/mạng báo rõ', async () => {
    const calls = [];
    const fakeFetch = async (url, options = {}) => {
      calls.push(url);
      if (url.endsWith('/api/admin-login')) return JSON.parse(options.body).password === 'ok' ? { status: 200, ok: true, headers: new Map([['set-cookie', 'muse_admin=abc; Path=/']]) } : { status: 401, ok: false, headers: new Map() };
      return { status: 200, ok: true, json: async () => ({ totals: { views: 400, uniq: 200, pricing_view: 90, buy_click: 4, orders: 2, paid: 1, revenue: 50000, downloads: 1, paid_pro: 0, revenue_pro: 0 }, referrers: [{ name: 'l.facebook.com', count: 60 }, { name: 'youtube.com', count: 20 }, { name: 'direct', count: 100 }, { name: 'zalo.me', count: 5 }], series: [{ date: '2026-10-29', uniq: 10, paid: 1, revenue: 50000 }] }) };
    };
    assert.strictEqual((await analytics.fetchLanding({ fetchImpl: fakeFetch, base: SITE, password: 'sai' })).code, 'bad_password');
    assert.strictEqual((await analytics.fetchLanding({ fetchImpl: fakeFetch, base: '', password: 'ok' })).code, 'not_configured');
    assert.strictEqual((await analytics.fetchLanding({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, base: SITE, password: 'ok' })).code, 'network');
    const got = await analytics.fetchLanding({ fetchImpl: fakeFetch, base: SITE, password: 'ok', days: 30 });
    assert.ok(calls.some((url) => url.includes('/api/admin-stats?days=30')));
    const summary = analytics.summarize(got.data, 30);
    assert.strictEqual(summary.totals.visitors, 200); assert.ok(Math.abs(summary.rates.buyClick - 0.02) < 1e-9);
    assert.deepStrictEqual(summary.visitsBySource.slice(0, 3).map((s) => s.channel), ['trực tiếp', 'facebook', 'youtube']);
    assert.ok(/ƯỚC LƯỢNG/.test(summary.attributionNote) && !('revenueByChannel' in summary));
  });

  await check('Analytics: gợi ý có căn cứ + cỡ mẫu; mẫu nhỏ thì không kết luận; không gán doanh thu cho kênh', () => {
    const small = analytics.summarize({ totals: { uniq: 10, buy_click: 0 } }, 30);
    assert.ok(analytics.insights(small).some((item) => /chưa đủ/.test(item.text)) && !analytics.insights(small).some((item) => /bấm Mua/.test(item.text)));
    const big = analytics.summarize({ totals: { uniq: 300, pricing_view: 40, buy_click: 6, orders: 6, paid: 1 }, referrers: [{ name: 'facebook.com', count: 80 }] }, 30);
    const texts = analytics.insights(big).map((item) => item.text).join(' | ');
    assert.ok(/2\.0% khách bấm Mua/.test(texts) && /1\/6 đơn/.test(texts) && /facebook/.test(texts) && /Chưa thể nói kênh nào ra đơn/.test(texts), texts);
    assert.ok(!/doanh thu của kênh|kênh .* ra \d+đ/i.test(texts));
  });

  await check('Analytics: lưu bản chụp vào trạng thái, báo cáo và lỗi hiển thị trên tổng quan', () => {
    const { agents } = setup();
    assert.strictEqual(agents.overview().agents.find((a) => a.name === 'Analytics Agent').state, 'manual');
    agents.saveAnalytics(null, 'Trang bán từ chối mật khẩu');
    assert.strictEqual(agents.overview().agents.find((a) => a.name === 'Analytics Agent').state, 'offline');
    agents.saveAnalytics(analytics.summarize({ totals: { uniq: 100, buy_click: 10, orders: 3, paid: 2, revenue: 100000 } }, 30));
    const report = agents.route('GET', ['analytics'], {}).data;
    assert.strictEqual(report.summary.totals.paid, 2); assert.strictEqual(report.lastError, null); assert.ok(report.insights.length > 0);
  });

  await check('support.faqMatch/mask: không khớp bừa với câu không liên quan', () => {
    const faq = [{ q: 'Có cần cài Node không?', a: 'Cần.' }];
    assert.strictEqual(support.faqMatch('Giá bao nhiêu vậy bạn', faq), null);
    assert.ok(support.faqMatch('Có cần cài Node không shop', faq));
    assert.strictEqual(support.mask('abc'), 'abc');
  });

  console.log(failed ? `\n${failed} lỗi` : '\nTẤT CẢ ĐẠT');
  process.exit(failed ? 1 : 0);
})();
