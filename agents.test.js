// Kiểm thử Product Registry, Campaign, hàng đợi việc và Sales Manager (lib/agents.js): node agents.test.js. Không cần mạng hay AI thật.
const assert = require('assert');
const { createMarketing } = require('./lib/marketing');
const { createAgents } = require('./lib/agents');

let failed = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`PASS  ${name}`), (error) => { failed += 1; console.log(`FAIL  ${name}  — ${error.message}`); });
const SITE = 'https://shop.example.com';

function setup() {
  const state = {};
  const marketing = createMarketing({ getStore: () => ({ marketing: state.marketing || (state.marketing = {}) }), persist: () => {}, siteUrl: SITE });
  const agents = createAgents({ state, marketing, siteUrl: SITE });
  return { state, marketing, agents };
}
const tool = { name: 'Muse Studio', type: 'tool', priceVnd: 50000, buyUrl: `${SITE}/#mua`, audience: 'Chủ kênh YouTube', benefits: ['Đăng video đều đặn', 'Duyệt trước khi đăng'], approvedFeatures: ['Tạo video bằng tài khoản Muse theo lịch', 'Duyệt video trước khi đăng'] };
const doc = { name: 'Master Prompt', type: 'digital', priceVnd: 99000, buyUrl: `${SITE}/#mua`, benefits: ['Prompt mẫu dùng ngay'], approvedFeatures: ['Bộ prompt dạng PDF'] };
const sell = (agents, product) => { const saved = agents.saveProduct(product).data; assert.strictEqual(agents.setProductStatus(saved.id, 'selling').status, 200); return saved; };
const activeCampaign = (agents, product) => { const campaign = agents.createCampaign({ productId: product.id }).data; assert.strictEqual(agents.setCampaignStatus(campaign.id, 'approve').status, 200); return campaign; };

(async () => {
  await check('Registry: thêm sản phẩm bằng dữ liệu, thiếu thông tin thì không cho "đang bán"', () => {
    const { agents } = setup();
    const saved = agents.saveProduct({ name: 'Sản phẩm mới', type: 'tool', priceVnd: 10000 }).data;
    assert.strictEqual(saved.id, 'san-pham-moi'); assert.ok(saved.missing.includes('link mua'));
    assert.strictEqual(agents.setProductStatus(saved.id, 'selling').status, 422);
    assert.strictEqual(agents.saveProduct({ ...tool, priceVnd: -1 }).status, 400);
    assert.strictEqual(agents.saveProduct({ ...tool, buyUrl: 'https://evil.example.com/' }).status, 400);
    assert.strictEqual(agents.saveProduct({ ...tool }).status, 201); assert.strictEqual(agents.saveProduct({ ...tool }).status, 409);
  });

  await check('thêm sản phẩm thứ hai không cần sửa logic: cả hai có chiến dịch và việc riêng, link/giá riêng', () => {
    const { agents, state } = setup();
    const a = sell(agents, tool); const b = sell(agents, doc);
    activeCampaign(agents, a); activeCampaign(agents, b);
    agents.runManager();
    const prompts = state.jobs.map((job) => agents.claim('w1').data.job.prompt);
    assert.ok(prompts.some((p) => p.includes('Muse Studio') && p.includes('50.000đ')));
    assert.ok(prompts.some((p) => p.includes('Master Prompt') && p.includes('99.000đ')));
    assert.ok(!prompts.some((p) => p.includes('Master Prompt') && p.includes('50.000đ')));
  });

  await check('Campaign phải được duyệt mới chạy; chưa duyệt thì Sales Manager không tạo việc', () => {
    const { agents, state } = setup();
    const product = sell(agents, tool);
    const campaign = agents.createCampaign({ productId: product.id }).data;
    assert.strictEqual(campaign.status, 'PENDING_APPROVAL');
    assert.strictEqual(agents.runManager().data.created.length, 0); assert.strictEqual(state.jobs.length, 0);
    agents.setCampaignStatus(campaign.id, 'approve');
    assert.strictEqual(agents.runManager().data.created.length, 4); // 4 kênh, mỗi kênh thiếu bản nháp
  });

  await check('chiến dịch cho sản phẩm chưa bán bị từ chối; sửa chiến dịch đang chạy → duyệt lại', () => {
    const { agents } = setup();
    const draft = agents.saveProduct(tool).data;
    assert.strictEqual(agents.createCampaign({ productId: draft.id }).status, 201);
    assert.strictEqual(agents.setCampaignStatus(agents.createCampaign({ productId: draft.id }).data.id, 'approve').status, 409);
    const product = sell(agents, doc); const campaign = activeCampaign(agents, product);
    agents.updateCampaign(campaign.id, { audience: 'Người mới' });
    assert.strictEqual(agents.campaignById(campaign.id).status, 'PENDING_APPROVAL');
  });

  await check('đổi giá sản phẩm → chiến dịch đang chạy phải duyệt lại; ngừng bán → chiến dịch tạm dừng', () => {
    const { agents } = setup();
    const product = sell(agents, tool); const campaign = activeCampaign(agents, product);
    agents.saveProduct({ priceVnd: 60000 }, product.id);
    assert.strictEqual(agents.campaignById(campaign.id).status, 'PENDING_APPROVAL');
    agents.setCampaignStatus(campaign.id, 'approve');
    agents.setProductStatus(product.id, 'paused');
    assert.strictEqual(agents.campaignById(campaign.id).status, 'PAUSED');
  });

  await check('Content Agent: hoàn thành việc → bản nháp CHỜ DUYỆT (không bao giờ tự duyệt/đăng), link có UTM + utm_content riêng', () => {
    const { agents, marketing } = setup();
    const product = sell(agents, tool); activeCampaign(agents, product);
    agents.runManager();
    const job = agents.claim('w1').data.job;
    const done = agents.complete(job.id, 'w1', { title: 'Đăng video đều đặn', body: 'Muse Studio giúp bạn duyệt video trước khi đăng. Giá 50.000đ một lần.' });
    assert.strictEqual(done.status, 200);
    const content = done.data.content;
    assert.strictEqual(content.status, 'PENDING_APPROVAL'); assert.strictEqual(content.approvedBy, null); assert.strictEqual(content.productId, product.id);
    assert.ok(content.targetUrl.includes(`utm_source=${job.channel}`) && content.targetUrl.includes(`utm_content=${content.id}`) && !content.targetUrl.includes('__ID__'), content.targetUrl);
    assert.strictEqual(marketing.list({ status: 'APPROVED' }).length, 0);
  });

  await check('kết quả AI có giá sai/cam kết viral → bản nháp bị giữ ở DRAFT kèm lý do (không vào hàng chờ duyệt)', () => {
    const { agents } = setup();
    const product = sell(agents, tool); activeCampaign(agents, product); agents.runManager();
    const job = agents.claim('w1').data.job;
    const result = agents.complete(job.id, 'w1', { title: 'Giảm còn 9.000đ', body: 'Chắc chắn viral, đảm bảo lên top.' });
    assert.strictEqual(result.data.content.status, 'DRAFT'); assert.ok(result.data.content.gate.errors.length >= 2);
  });

  await check('kết quả rỗng/sai định dạng → việc FAILED; HTML bị loại khỏi nội dung', () => {
    const { agents } = setup();
    const product = sell(agents, tool); activeCampaign(agents, product); agents.runManager();
    const a = agents.claim('w1').data.job;
    assert.strictEqual(agents.complete(a.id, 'w1', { title: '', body: 'x' }).status, 422);
    const b = agents.claim('w1').data.job;
    const out = agents.complete(b.id, 'w1', { title: '<b>Tiêu đề</b>', body: 'Nội dung <script>alert(1)</script> bình thường. Giá 50.000đ.' }).data.content;
    assert.ok(!out.title.includes('<') && !out.body.includes('<'));
  });

  await check('worker khác không hoàn thành được việc của worker này; việc đã xong không nhận lại', () => {
    const { agents } = setup();
    const product = sell(agents, tool); activeCampaign(agents, product); agents.runManager();
    const job = agents.claim('w1').data.job;
    assert.strictEqual(agents.complete(job.id, 'w2', { title: 't', body: 'b' }).status, 409);
    agents.complete(job.id, 'w1', { title: 'Tiêu đề', body: 'Giá 50.000đ.' });
    assert.strictEqual(agents.complete(job.id, 'w1', { title: 'Tiêu đề', body: 'Giá 50.000đ.' }).status, 409);
  });

  await check('lỗi thì thử lại có giới hạn (3 lần) rồi FAILED; lease hết hạn thì việc quay lại hàng đợi', () => {
    const { agents, state } = setup();
    const product = sell(agents, tool); activeCampaign(agents, product); agents.runManager();
    let id;
    for (let i = 0; i < 3; i += 1) { const job = agents.claim('w1').data.job; id = job.id; agents.failJob(id, 'w1', 'Muse hết quota'); }
    assert.strictEqual(state.jobs.find((job) => job.id === id).status, 'FAILED');
    const next = state.jobs.slice().reverse().find((job) => job.status === 'QUEUED'); // claim lấy việc cũ nhất trước
    agents.claim('w1'); next.leaseUntil = new Date(Date.now() - 1000).toISOString();
    agents.claim('w2');
    assert.strictEqual(next.workerId, 'w2'); assert.strictEqual(next.attempts, 2);
  });

  await check('giới hạn số việc mỗi ngày và số bản nháp mỗi kênh được tôn trọng, không tạo việc trùng', () => {
    const { agents, state } = setup();
    const product = sell(agents, tool); activeCampaign(agents, product);
    state.agentSettings.dailyJobCap = 3;
    assert.strictEqual(agents.runManager().data.created.length, 3);
    assert.strictEqual(agents.runManager().data.created.length, 0);
    state.agentSettings.dailyJobCap = 50; state.agentSettings.draftsPerChannel = 1;
    assert.strictEqual(agents.runManager().data.created.length, 1); // 3 kênh đã có việc chờ, chỉ còn kênh thứ 4
    assert.strictEqual(state.jobs.length, 4);
  });

  await check('công tắc dừng khẩn cấp: Sales Manager không tạo việc, worker không nhận được việc', () => {
    const { agents, marketing } = setup();
    const product = sell(agents, tool); activeCampaign(agents, product); agents.runManager();
    marketing.setKillSwitch(true);
    assert.strictEqual(agents.runManager().status, 409);
    assert.strictEqual(agents.claim('w1').data.job, null);
    marketing.setKillSwitch(false);
    assert.ok(agents.claim('w1').data.job);
  });

  await check('prompt cho AI chỉ chứa dữ liệu Registry, cấm bịa/giá lạ/cam kết, không chứa link hay bí mật', () => {
    const { agents } = setup();
    const product = sell(agents, tool);
    const prompt = agents.buildContentPrompt(agents.productById(product.id), {}, 'tiktok', 'Duyệt trước khi đăng');
    assert.ok(prompt.includes('50.000đ') && prompt.includes('Tạo video bằng tài khoản Muse theo lịch') && prompt.includes('Không hứa viral') && prompt.includes('TikTok'));
    assert.ok(!/https?:\/\//.test(prompt.replace('Không chèn đường link', '')) && !/hatch_|token|cookie/i.test(prompt));
  });

  await check('Command Center: tổng quan trung thực về từng agent (chưa cấu hình/chưa kết nối thì nói rõ)', () => {
    const { agents } = setup();
    const view = agents.overview();
    const byName = Object.fromEntries(view.agents.map((agent) => [agent.name, agent.state]));
    assert.strictEqual(byName['Content Agent'], 'offline'); assert.strictEqual(byName['Research Agent'], 'offline'); assert.strictEqual(byName['Analytics Agent'], 'off'); assert.strictEqual(byName['Distribution Agent'], 'manual');
    agents.heartbeat('w1');
    assert.strictEqual(agents.overview().agents.find((agent) => agent.name === 'Content Agent').state, 'online');
  });

  console.log(failed ? `\n${failed} lỗi` : '\nTẤT CẢ ĐẠT');
  process.exit(failed ? 1 : 0);
})();
