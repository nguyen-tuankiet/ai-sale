// Kiểm thử hàng đợi nội dung quảng bá (lib/marketing.js): chạy `node tests/06-marketing.js`. Không cần Chrome, mạng hay tài khoản thật.
const assert = require('assert');
const { createMarketing, sanitizeError, mentionedPrices } = require('./lib/marketing');

let failed = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`PASS  ${name}`), (error) => { failed += 1; console.log(`FAIL  ${name}  — ${error.message}`); });

function setup({ adapters = {}, siteUrl = 'https://shop.example.com' } = {}) {
  const store = {};
  let saves = 0;
  const marketing = createMarketing({ getStore: () => store, persist: () => { saves += 1; }, adapters, siteUrl });
  marketing.setOffers([
    { id: 'muse-studio', name: 'Muse Studio', priceVnd: 50000, approvedFeatures: ['Duyệt video trước khi đăng', 'Theo dõi lượt xem các kênh YouTube'] },
    { id: 'pro', name: 'Muse Studio Pro', priceVnd: 99000, approvedFeatures: ['Tool kèm gói prompt'] },
  ]);
  return { marketing, store, saves: () => saves };
}
const okBody = (title = 'Muse Studio giúp duyệt video', extra = '') => ({ channel: 'facebook', campaign: 'muse-studio', title, body: `Duyệt video trước khi đăng, giá 50.000đ một lần. ${extra}` });
const approved = (m, input) => { const created = m.create(input).data; assert.strictEqual(m.submit(created.id).status, 200); assert.strictEqual(m.approve(created.id).status, 200); return m.byId(created.id); };
const fakeAdapter = (impl) => { const calls = []; return { calls, publish: async (payload) => { calls.push(payload); return impl(payload, calls.length); } }; };

(async () => {
  await check('AC-01: bản nháp/chờ duyệt không bao giờ gọi API đăng, kể cả khi bật hết công tắc', async () => {
    const adapter = fakeAdapter(() => ({ externalPostId: 'p1', externalUrl: 'https://fb.example/p1' }));
    const { marketing } = setup({ adapters: { facebook: adapter } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const draft = marketing.create(okBody()).data;
    assert.strictEqual((await marketing.publish(draft.id, { manual: false })).status, 409);
    marketing.submit(draft.id);
    assert.strictEqual((await marketing.publish(draft.id, { manual: false })).status, 409);
    await marketing.tick();
    assert.strictEqual(adapter.calls.length, 0);
  });

  await check('AC-02: sửa title/body sau khi duyệt → quay về PENDING_APPROVAL, mất quyền đăng', async () => {
    const adapter = fakeAdapter(() => ({ externalPostId: 'p1' }));
    const { marketing } = setup({ adapters: { facebook: adapter } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const item = approved(marketing, okBody());
    assert.strictEqual(marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString()).status, 200);
    marketing.update(item.id, { body: 'Duyệt video trước khi đăng, giá 50.000đ. Nội dung đã sửa.' });
    assert.strictEqual(marketing.byId(item.id).status, 'PENDING_APPROVAL');
    assert.strictEqual(marketing.byId(item.id).approvedBy, null);
    await marketing.tick();
    assert.strictEqual(adapter.calls.length, 0);
  });

  await check('sửa trực tiếp dữ liệu đã duyệt (bỏ qua API) vẫn bị chặn nhờ so khớp mã băm lúc đăng', async () => {
    const adapter = fakeAdapter(() => ({ externalPostId: 'p1' }));
    const { marketing } = setup({ adapters: { facebook: adapter } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const item = approved(marketing, okBody());
    marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    item.body += ' Đã bị sửa ngầm.';
    const result = await marketing.publish(item.id, { manual: false });
    assert.strictEqual(result.status, 409);
    assert.strictEqual(adapter.calls.length, 0);
  });

  await check('AC-09: công tắc dừng khẩn cấp chặn đăng và chặn tick; tắt công tắc thì chạy lại được', async () => {
    const adapter = fakeAdapter(() => ({ externalPostId: 'p1', externalUrl: 'https://fb.example/p1' }));
    const { marketing } = setup({ adapters: { facebook: adapter } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const item = approved(marketing, okBody());
    marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    marketing.setKillSwitch(true);
    await marketing.tick();
    assert.strictEqual((await marketing.publish(item.id, { manual: true })).status, 409);
    assert.strictEqual(adapter.calls.length, 0);
    marketing.setKillSwitch(false);
    await marketing.tick();
    assert.strictEqual(adapter.calls.length, 1);
    assert.strictEqual(marketing.byId(item.id).status, 'PUBLISHED');
  });

  await check('tắt riêng từng kênh: kênh tắt không đăng, kênh bật vẫn đăng', async () => {
    const fb = fakeAdapter(() => ({ externalPostId: 'f' })); const tk = fakeAdapter(() => ({ externalPostId: 't' }));
    const { marketing } = setup({ adapters: { facebook: fb, tiktok: tk } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: false, tiktok: true } });
    const a = approved(marketing, okBody('Bài Facebook')); const b = approved(marketing, { ...okBody('Cảnh quay TikTok', 'Cảnh một mở đầu.'), channel: 'tiktok' });
    for (const item of [a, b]) marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    await marketing.tick();
    assert.strictEqual(fb.calls.length, 0); assert.strictEqual(tk.calls.length, 1);
  });

  await check('mặc định: không adapter/không bật đăng tự động → chỉ đánh dấu đến giờ đăng tay, kèm gói nội dung', async () => {
    const { marketing } = setup();
    marketing.updateSettings({ channels: { facebook: true } });
    const item = approved(marketing, okBody());
    marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    const done = await marketing.tick();
    assert.deepStrictEqual(done.map((entry) => entry.mode), ['manual']);
    const result = await marketing.publish(item.id, { manual: true });
    assert.strictEqual(result.data.mode, 'manual'); assert.ok(result.data.pack.link.includes('utm_source=facebook'));
    assert.strictEqual(marketing.markPublished(item.id, 'not a url').status, 400);
    assert.strictEqual(marketing.markPublished(item.id, 'https://facebook.com/page/posts/1').data.status, 'PUBLISHED');
    assert.strictEqual(marketing.report().publishedLast7Days.length, 1);
  });

  await check('AC-07: timeout không rõ kết quả → không tự đăng lại, không tạo bài trùng', async () => {
    const adapter = fakeAdapter(() => { const error = new Error('socket timeout'); error.ambiguous = true; throw error; });
    const { marketing } = setup({ adapters: { facebook: adapter } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const item = approved(marketing, okBody());
    marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    await marketing.tick(); await marketing.tick(); await marketing.tick();
    assert.strictEqual(adapter.calls.length, 1);
    assert.strictEqual(marketing.byId(item.id).status, 'FAILED');
    // Gọi đăng lại thủ công khi chưa đối chiếu cũng bị từ chối
    marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    assert.strictEqual((await marketing.publish(item.id, { manual: false })).error.code, 'unknown_outcome');
    assert.strictEqual(adapter.calls.length, 1);
  });

  await check('AC-07: lỗi tạm thời được retry có giới hạn và backoff, lỗi quyền/token hết hạn thì không retry (AC-08)', async () => {
    const flaky = fakeAdapter((payload, n) => { if (n < 3) { const error = new Error('503 Service Unavailable'); error.transient = true; throw error; } return { externalPostId: 'ok', externalUrl: 'https://fb.example/ok' }; });
    const first = setup({ adapters: { facebook: flaky } });
    first.marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const item = approved(first.marketing, okBody());
    first.marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    await first.marketing.tick();
    assert.strictEqual(first.marketing.byId(item.id).status, 'SCHEDULED'); assert.ok(Date.parse(first.marketing.byId(item.id).nextAttemptAt) > Date.now());
    await first.marketing.tick(); // chưa tới giờ retry nên không gọi thêm
    assert.strictEqual(flaky.calls.length, 1);
    first.marketing.byId(item.id).nextAttemptAt = null; await first.marketing.tick();
    first.marketing.byId(item.id).nextAttemptAt = null; await first.marketing.tick();
    assert.strictEqual(first.marketing.byId(item.id).status, 'PUBLISHED'); assert.strictEqual(flaky.calls.length, 3);

    const expired = fakeAdapter(() => { const error = new Error('Token hết hạn: access_token=ya29.SECRETSECRETSECRETSECRET123456'); error.code = 'TOKEN_EXPIRED'; throw error; });
    const second = setup({ adapters: { facebook: expired } });
    second.marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const other = approved(second.marketing, okBody());
    second.marketing.schedule(other.id, new Date(Date.now() - 1000).toISOString());
    await second.marketing.tick(); await second.marketing.tick();
    assert.strictEqual(expired.calls.length, 1);
    assert.strictEqual(second.marketing.byId(other.id).status, 'FAILED');
    assert.match(second.marketing.byId(other.id).lastError, /Token hết hạn/);
  });

  await check('AC-10: lỗi lưu/log đã che token, khóa và chuỗi dài giống bí mật', () => {
    const cleaned = sanitizeError(new Error('Bearer abc123.def456-ghi789 failed access_token=ya29.SECRET&x=1 key=AIzaSyA1234567890abcdefghijklmnopqrstu'));
    assert.ok(!cleaned.includes('ya29') && !cleaned.includes('abc123') && !cleaned.includes('AIzaSy'), cleaned);
    const { marketing, store } = setup({ adapters: { facebook: fakeAdapter(() => { throw new Error('boom access_token=ya29.TOPSECRETTOKEN0123456789'); }) } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const item = approved(marketing, okBody());
    marketing.schedule(item.id, new Date(Date.now() - 1000).toISOString());
    return marketing.tick().then(() => assert.ok(!JSON.stringify(store).includes('TOPSECRETTOKEN')));
  });

  await check('AC-14: giá sai, cam kết viral/lên top, bí mật và link ngoài trang đều bị chặn khi gửi duyệt', () => {
    const { marketing } = setup();
    const cases = [
      [{ ...okBody(), body: 'Chỉ 29.000đ thôi!' }, /không khớp bảng giá/],
      [{ ...okBody(), body: 'Giá 50k, video chắc chắn viral.' }, /cam kết/],
      [{ ...okBody(), body: 'Giá 50.000đ, đảm bảo lên top Google.' }, /cam kết/],
      [{ ...okBody(), body: 'Giá 50.000đ. hatch_sess=abcdef' }, /bí mật/],
      [{ ...okBody(), targetUrl: 'https://evil.example.com/?utm_source=x&utm_campaign=y' }, /thuộc https:\/\/shop\.example\.com/],
    ];
    for (const [input, pattern] of cases) {
      const item = marketing.create(input).data;
      const result = marketing.submit(item.id);
      assert.strictEqual(result.status, 422, JSON.stringify(input.body));
      assert.match(result.error.issues.join(' | '), pattern);
    }
    assert.deepStrictEqual(mentionedPrices('Giá 99k hoặc 129.000 VND, 5 nghìn'), [99000, 129000, 5000]);
  });

  await check('chặn bài trùng nội dung trên cùng một kênh; website mỏng bị từ chối', () => {
    const { marketing } = setup();
    marketing.submit(marketing.create(okBody('Bài một')).data.id);
    const twin = marketing.create(okBody('Bài hai giống hệt')).data;
    assert.match(marketing.submit(twin.id).error.issues.join(' '), /trùng/);
    const thin = marketing.create({ channel: 'website', title: 'Bài SEO', body: 'Quá ngắn.' }).data;
    assert.match(marketing.submit(thin.id).error.issues.join(' '), /mỏng/);
  });

  await check('chưa cấu hình siteUrl hoặc Offer → không lập kế hoạch và không cho gửi duyệt', () => {
    const noSite = setup({ siteUrl: '' }).marketing;
    assert.strictEqual(noSite.plan({}).error.code, 'no_site_url');
    assert.strictEqual(noSite.submit(noSite.create(okBody()).data.id).status, 422);
    const noOffer = setup().marketing; noOffer.setOffers([]);
    assert.strictEqual(noOffer.plan({}).error.code, 'no_offer');
  });

  await check('planner: tạo nháp cho cả 4 kênh từ Offer, giá lấy từ Offer, có UTM riêng từng kênh, luân phiên sản phẩm, không tự đăng', async () => {
    const { marketing } = setup();
    const first = marketing.plan({}).data; const second = marketing.plan({}).data;
    assert.strictEqual(first.length, 4);
    for (const item of [...first, ...second]) {
      assert.ok(item.error === undefined, item.error);
      assert.ok(['DRAFT', 'PENDING_APPROVAL'].includes(item.status), item.status);
      assert.ok(item.targetUrl.includes(`utm_source=${item.channel}`) && item.targetUrl.includes(`utm_content=${item.id}`));
      assert.strictEqual(item.approvedBy, null);
    }
    assert.ok(first.every((item) => item.productId === 'muse-studio') && second.every((item) => item.productId === 'pro'));
    assert.ok(first.find((item) => item.channel === 'facebook').body.includes('50.000đ'));
    assert.ok(second.find((item) => item.channel === 'facebook').body.includes('99.000đ'));
    assert.strictEqual(marketing.list({ status: 'APPROVED' }).length, 0);
  });

  await check('khởi động lại giữa lúc đăng: bài PUBLISHING chuyển FAILED, không tự đăng lại', async () => {
    const adapter = fakeAdapter(() => ({ externalPostId: 'x' }));
    const { marketing } = setup({ adapters: { facebook: adapter } });
    marketing.updateSettings({ autoPublish: true, channels: { facebook: true } });
    const item = approved(marketing, okBody());
    item.status = 'PUBLISHING';
    marketing.state().attempts.push({ id: 'a1', contentId: item.id, status: 'PUBLISHING', idempotencyKey: `${item.id}:${item.approvedHash}` });
    assert.strictEqual(marketing.recover(), true);
    assert.strictEqual(marketing.byId(item.id).status, 'FAILED');
    await marketing.tick();
    assert.strictEqual(adapter.calls.length, 0);
  });

  await check('bộ định tuyến: tạo → gửi duyệt → duyệt → xếp lịch → báo cáo; thao tác sai trạng thái trả 409; có nhật ký', async () => {
    const { marketing } = setup();
    let r = await marketing.route('POST', ['content'], {}, okBody());
    assert.strictEqual(r.status, 201); const contentId = r.data.id;
    assert.strictEqual((await marketing.route('POST', ['content', contentId, 'approve'], {}, {})).status, 409);
    assert.strictEqual((await marketing.route('POST', ['content', contentId, 'submit'], {}, {})).status, 200);
    assert.strictEqual((await marketing.route('POST', ['content', contentId, 'approve'], {}, {})).data.status, 'APPROVED');
    assert.strictEqual((await marketing.route('POST', ['content', contentId, 'schedule'], {}, { scheduledAt: 'không phải ngày' })).status, 400);
    assert.strictEqual((await marketing.route('POST', ['content', contentId, 'schedule'], {}, { scheduledAt: new Date(Date.now() + 3600e3).toISOString() })).data.status, 'SCHEDULED');
    assert.strictEqual((await marketing.route('GET', ['report'], {}, {})).data.byStatus.SCHEDULED, 1);
    assert.strictEqual((await marketing.route('POST', ['kill-switch'], {}, { enabled: true })).data.killSwitch, true);
    assert.strictEqual((await marketing.route('GET', ['content', 'khong-co'], {}, {})).status, 404);
    const log = (await marketing.route('GET', ['audit'], {}, {})).data.map((entry) => entry.action);
    assert.ok(['create', 'submit', 'approve', 'schedule', 'kill_switch_on'].every((action) => log.includes(action)), log.join(','));
  });

  console.log(failed ? `\n${failed} lỗi` : '\nTẤT CẢ ĐẠT');
  process.exit(failed ? 1 : 0);
})();
