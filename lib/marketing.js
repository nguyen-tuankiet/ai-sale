'use strict';
// Hàng đợi nội dung quảng bá (YouTube, Facebook, TikTok, website) có bước duyệt, công tắc dừng khẩn cấp và gói đăng thủ công.
// Nguyên tắc: không bài nào được đăng nếu chưa APPROVED; sửa nội dung sau khi duyệt thì phải duyệt lại; không gọi API nền tảng nào
// nếu chưa có adapter, chưa bật kênh và chưa bật đăng tự động. Module này không gọi mạng; adapter do server truyền vào.
const crypto = require('crypto');

const CHANNELS = ['youtube', 'facebook', 'tiktok', 'website'];
const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'REJECTED', 'CANCELLED'];
const EDITABLE_FIELDS = ['title', 'body', 'targetUrl', 'channel', 'campaign', 'format', 'mediaRefs'];
const MAX_ATTEMPTS = 3;
const BACKOFF_MINUTES = [1, 5, 15];
// Giới hạn nội dung theo kênh (theo tài liệu công khai của từng nền tảng; kiểm tra lại khi nền tảng đổi quy định).
const LIMITS = {
  youtube: { title: 100, body: 5000 },
  facebook: { title: 120, body: 5000, advise: 1500 },
  tiktok: { title: 100, body: 2200 },
  website: { title: 70, body: 20000, minBody: 300 },
};
// Các câu hứa hẹn không được chứng minh: chặn ở quality gate.
const RISKY_CLAIMS = [
  /\bviral\b/i, /triệu\s*view/i, /top\s*1\b/i, /lên\s*top/i, /đảm\s*bảo|bảo\s*đảm|cam\s*kết/i, /\b100\s*%/, /kiếm\s*tiền\s*(chắc|ngay|nhanh)/i,
  /không\s*rủi\s*ro/i, /miễn\s*phí\s*(hoàn\s*toàn|trọn\s*đời)/i, /\bđánh\s*giá\s*5\s*sao\b/i,
];
// Dấu hiệu lộ bí mật trong nội dung: không bao giờ được xuất hiện trong bài quảng bá.
const SECRET_PATTERNS = [/hatch_(sess|gw|vml|native)/i, /\bBearer\s+[\w.-]{16,}/i, /\bAIza[\w-]{20,}/, /\bsk-[\w-]{16,}/i, /client_secret/i, /refresh_token/i, /\bapikey\s+\S{8,}/i];

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
const normalize = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
const words = (text) => new Set(normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ').filter((word) => word.length > 2));
function similarity(a, b) {
  const x = words(a); const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0; for (const word of x) if (y.has(word)) shared += 1;
  return shared / (x.size + y.size - shared);
}
// Làm sạch lỗi trước khi lưu/log: che token, khóa, chuỗi dài giống bí mật.
function sanitizeError(value) {
  return String(value?.message || value || '')
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[đã che]')
    .replace(/((?:access_token|refresh_token|client_secret|api_?key|token|key|secret|code)=)[^&\s"']+/gi, '$1[đã che]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[đã che]')
    .slice(0, 300);
}
const contentHash = (item) => sha(JSON.stringify([item.channel, item.title, item.body, item.targetUrl]));

function formatVnd(amount) { return `${Number(amount).toLocaleString('vi-VN')}đ`; }
// Tìm các số tiền được nhắc trong văn bản và quy về đồng: "99.000đ", "99k", "99 nghìn", "99,000 VND".
function mentionedPrices(text) {
  const found = [];
  // Không dùng \b: trong JS nó chỉ hiểu chữ ASCII nên không tách được sau "đ". Dùng lookahead theo ký tự chữ/số Unicode.
  for (const match of String(text || '').matchAll(/(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(vnđ|vnd|nghìn|ngàn|đồng|₫|đ|k)(?![\p{L}\p{N}])/giu)) {
    const digits = Number(match[1].replace(/[.,]/g, ''));
    found.push(/^(k|nghìn|ngàn)$/i.test(match[2]) ? digits * 1000 : digits);
  }
  return found;
}

// Kiểm tra văn bản tự do (nhật ký...): giá lệch bảng giá, cam kết chưa chứng minh, dấu hiệu lộ bí mật.
function checkText(text, allowedPrices = []) {
  const errors = []; const allowed = new Set(allowedPrices);
  for (const price of new Set(mentionedPrices(text))) if (!allowed.has(price)) errors.push(`Giá ${formatVnd(price)} không khớp bảng giá hiện hành.`);
  for (const pattern of RISKY_CLAIMS) if (pattern.test(text)) errors.push(`Có cam kết chưa chứng minh được: "${(String(text).match(pattern) || [''])[0].trim()}".`);
  for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) errors.push('Nội dung có vẻ chứa bí mật (cookie/token/khóa).');
  return errors;
}

function createMarketing({ getStore, persist, now = () => new Date().toISOString(), id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`, adapters = {}, siteUrl = '' }) {
  const state = () => {
    const store = getStore();
    if (!store.marketing) store.marketing = {};
    const m = store.marketing;
    m.settings = { killSwitch: false, autoPublish: false, siteUrl: String(siteUrl || '').replace(/\/+$/, ''), channels: {}, ...m.settings };
    for (const channel of CHANNELS) if (typeof m.settings.channels[channel] !== 'boolean') m.settings.channels[channel] = false; // mặc định tắt, bật từng kênh sau khi test
    m.offers = Array.isArray(m.offers) ? m.offers : [];
    m.content = Array.isArray(m.content) ? m.content : [];
    m.attempts = Array.isArray(m.attempts) ? m.attempts : [];
    m.audit = Array.isArray(m.audit) ? m.audit : [];
    return m;
  };
  const byId = (contentId) => state().content.find((item) => item.id === contentId);
  const audit = (action, entity, result = 'ok', extra = {}) => {
    const m = state();
    m.audit.unshift({ at: now(), actor: 'owner', action, entityType: 'marketing', entityId: entity, result, ...extra });
    m.audit.length = Math.min(m.audit.length, 500);
  };
  const fail = (status, message, code = 'bad_request') => ({ status, error: { code, message } });
  const ok = (data, status = 200) => ({ status, data });

  // ------------------------------------------------------------ Offer: nguồn sự thật về giá và tính năng
  function setOffers(offers) {
    const m = state();
    m.offers = (Array.isArray(offers) ? offers : []).map((offer) => ({
      id: String(offer.id), name: String(offer.name), priceVnd: Number(offer.priceVnd), currency: 'VND',
      approvedFeatures: (offer.approvedFeatures || []).map(String), active: offer.active !== false, source: String(offer.source || 'manual'),
    })).filter((offer) => offer.id && offer.name && Number.isFinite(offer.priceVnd) && offer.priceVnd > 0);
    persist();
    return m.offers;
  }

  // ------------------------------------------------------------ UTM
  function buildUrl(channel, campaign, contentId, path = '') {
    const base = state().settings.siteUrl;
    if (!base) return '';
    const url = new URL(base + path);
    url.searchParams.set('utm_source', channel);
    url.searchParams.set('utm_medium', channel === 'website' ? 'organic' : 'social');
    url.searchParams.set('utm_campaign', String(campaign || 'general').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40));
    if (contentId) url.searchParams.set('utm_content', contentId);
    return url.toString();
  }

  // ------------------------------------------------------------ Quality gate
  // Trả về { errors, warnings }. errors chặn việc gửi duyệt; warnings chỉ nhắc người duyệt.
  function qualityGate(item) {
    const m = state(); const errors = []; const warnings = [];
    const text = `${item.title}\n${item.body}`;
    const limit = LIMITS[item.channel];
    if (!limit) return { errors: [`Kênh không hợp lệ: ${item.channel}`], warnings };
    if (!String(item.title || '').trim()) errors.push('Thiếu tiêu đề.');
    if (!String(item.body || '').trim()) errors.push('Thiếu nội dung.');
    if (String(item.title || '').length > limit.title) errors.push(`Tiêu đề dài quá ${limit.title} ký tự cho ${item.channel}.`);
    if (String(item.body || '').length > limit.body) errors.push(`Nội dung dài quá ${limit.body} ký tự cho ${item.channel}.`);
    if (limit.minBody && String(item.body || '').length < limit.minBody) errors.push(`Bài website quá mỏng (dưới ${limit.minBody} ký tự); viết đủ ý hữu ích trước khi đăng.`);
    if (limit.advise && String(item.body || '').length > limit.advise) warnings.push('Bài Facebook dài; bài ngắn thường dễ đọc hơn.');
    // Link đích phải thuộc trang của bạn và có UTM để đo.
    if (!m.settings.siteUrl) errors.push('Chưa cấu hình địa chỉ trang (siteUrl) nên không thể kiểm tra link đích.');
    else if (!item.targetUrl) errors.push('Thiếu link đích.');
    else {
      try {
        const target = new URL(item.targetUrl); const origin = new URL(m.settings.siteUrl).origin;
        if (target.origin !== origin) errors.push(`Link đích phải thuộc ${origin}.`);
        if (!target.searchParams.get('utm_source') || !target.searchParams.get('utm_campaign')) warnings.push('Link đích thiếu UTM nên không phân biệt được nguồn traffic.');
      } catch { errors.push('Link đích không hợp lệ.'); }
    }
    // Giá chỉ được nhắc khi trùng giá trong Offer đang bán.
    const allowed = new Set(m.offers.filter((offer) => offer.active).map((offer) => offer.priceVnd));
    for (const price of new Set(mentionedPrices(text))) {
      if (!allowed.has(price)) errors.push(`Giá ${formatVnd(price)} không khớp bảng giá hiện hành${allowed.size ? ` (${[...allowed].map(formatVnd).join(', ')})` : ' (chưa cấu hình Offer)'}.`);
    }
    for (const pattern of RISKY_CLAIMS) if (pattern.test(text)) errors.push(`Có cam kết chưa chứng minh được: "${(text.match(pattern) || [''])[0].trim()}".`);
    for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) errors.push('Nội dung có vẻ chứa bí mật (cookie/token/khóa); xóa trước khi gửi duyệt.');
    // Trùng lặp: so với nội dung cùng kênh chưa hủy/từ chối.
    for (const other of m.content) {
      if (other.id === item.id || other.channel !== item.channel || ['CANCELLED', 'REJECTED'].includes(other.status)) continue;
      if (similarity(item.body, other.body) >= 0.85) { errors.push(`Nội dung trùng với bài ${other.id} (${other.title.slice(0, 40)}).`); break; }
    }
    if (item.channel === 'tiktok') warnings.push('TikTok: kiểm tra quyền sử dụng âm thanh và hình ảnh trước khi đăng.');
    return { errors, warnings };
  }

  // ------------------------------------------------------------ CRUD và chuyển trạng thái
  function normalizeInput(input, base = {}) {
    const text = (value, max) => String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
    const next = { ...base };
    if ('channel' in input) next.channel = String(input.channel);
    if ('campaign' in input) next.campaign = text(input.campaign, 60) || 'general';
    if ('format' in input) next.format = text(input.format, 30);
    if ('title' in input) next.title = text(input.title, 300);
    if ('body' in input) next.body = text(input.body, 30000);
    if ('targetUrl' in input) next.targetUrl = text(input.targetUrl, 500);
    if ('mediaRefs' in input) next.mediaRefs = (Array.isArray(input.mediaRefs) ? input.mediaRefs : []).map((ref) => text(ref, 200)).slice(0, 10);
    return next;
  }

  function create(input, { source = 'manual', status = 'DRAFT', productId = null } = {}) {
    if (!CHANNELS.includes(input.channel)) return fail(400, `Kênh phải là một trong: ${CHANNELS.join(', ')}.`);
    const item = {
      id: id('mkt'), productId, source, status: 'DRAFT', mediaRefs: [], format: '', campaign: 'general', approvedBy: null, approvedAt: null, approvedHash: null,
      scheduledAt: null, externalPostId: null, externalUrl: null, manualDue: false, createdAt: now(), updatedAt: now(),
      ...normalizeInput(input),
    };
    if (!item.targetUrl && state().settings.siteUrl) item.targetUrl = buildUrl(item.channel, item.campaign, item.id);
    item.gate = qualityGate(item);
    item.status = status === 'PENDING_APPROVAL' && !item.gate.errors.length ? 'PENDING_APPROVAL' : 'DRAFT'; // bản nháp chưa qua kiểm tra thì ở lại DRAFT
    state().content.unshift(item);
    audit('create', item.id, 'ok', { source });
    persist();
    return ok(item, 201);
  }

  function update(contentId, input) {
    const item = byId(contentId);
    if (!item) return fail(404, 'Không tìm thấy nội dung.', 'not_found');
    if (['PUBLISHING', 'PUBLISHED', 'CANCELLED'].includes(item.status)) return fail(409, `Không sửa được nội dung ở trạng thái ${item.status}.`, 'conflict');
    const changes = Object.fromEntries(Object.entries(input).filter(([key]) => EDITABLE_FIELDS.includes(key)));
    if ('channel' in changes && !CHANNELS.includes(changes.channel)) return fail(400, 'Kênh không hợp lệ.');
    const before = contentHash(item);
    Object.assign(item, normalizeInput(changes, item), { updatedAt: now() });
    const edited = contentHash(item) !== before;
    // Sửa sau khi duyệt/xếp lịch/lỗi: mất quyền đăng, phải duyệt lại.
    if (edited && ['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'FAILED', 'REJECTED'].includes(item.status)) {
      item.status = 'PENDING_APPROVAL'; item.approvedBy = null; item.approvedAt = null; item.approvedHash = null; item.manualDue = false;
    }
    item.gate = qualityGate(item);
    if (item.status === 'PENDING_APPROVAL' && item.gate.errors.length) item.status = 'DRAFT';
    audit('update', item.id, 'ok', { edited });
    persist();
    return ok(item);
  }

  const guard = (contentId, from) => {
    const item = byId(contentId);
    if (!item) return { problem: fail(404, 'Không tìm thấy nội dung.', 'not_found') };
    if (!from.includes(item.status)) return { problem: fail(409, `Trạng thái ${item.status} không cho phép thao tác này.`, 'conflict') };
    return { item };
  };

  function submit(contentId) {
    const { item, problem } = guard(contentId, ['DRAFT', 'REJECTED']); if (problem) return problem;
    item.gate = qualityGate(item);
    if (item.gate.errors.length) { audit('submit', item.id, 'blocked'); persist(); return { status: 422, error: { code: 'quality_gate', message: 'Nội dung chưa qua kiểm tra chất lượng.', issues: item.gate.errors } }; }
    item.status = 'PENDING_APPROVAL'; item.updatedAt = now(); audit('submit', item.id); persist();
    return ok(item);
  }
  function approve(contentId) {
    const { item, problem } = guard(contentId, ['PENDING_APPROVAL']); if (problem) return problem;
    item.gate = qualityGate(item);
    if (item.gate.errors.length) { audit('approve', item.id, 'blocked'); persist(); return { status: 422, error: { code: 'quality_gate', message: 'Không thể duyệt: nội dung chưa qua kiểm tra chất lượng.', issues: item.gate.errors } }; }
    Object.assign(item, { status: 'APPROVED', approvedBy: 'owner', approvedAt: now(), approvedHash: contentHash(item), updatedAt: now() });
    audit('approve', item.id); persist();
    return ok(item);
  }
  function reject(contentId, reason = '') {
    const { item, problem } = guard(contentId, ['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED']); if (problem) return problem;
    Object.assign(item, { status: 'REJECTED', rejectReason: String(reason).slice(0, 300), approvedBy: null, approvedAt: null, approvedHash: null, scheduledAt: null, updatedAt: now() });
    audit('reject', item.id); persist();
    return ok(item);
  }
  function schedule(contentId, when) {
    const { item, problem } = guard(contentId, ['APPROVED', 'SCHEDULED', 'FAILED']); if (problem) return problem;
    if (item.approvedHash !== contentHash(item)) return fail(409, 'Nội dung đã đổi sau khi duyệt; duyệt lại trước khi xếp lịch.', 'needs_reapproval');
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return fail(400, 'Giờ đăng không hợp lệ.');
    Object.assign(item, { status: 'SCHEDULED', scheduledAt: at.toISOString(), manualDue: false, nextAttemptAt: null, updatedAt: now() });
    audit('schedule', item.id); persist();
    return ok(item);
  }
  function cancel(contentId) {
    const { item, problem } = guard(contentId, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'FAILED', 'REJECTED']); if (problem) return problem;
    Object.assign(item, { status: 'CANCELLED', scheduledAt: null, updatedAt: now() });
    audit('cancel', item.id); persist();
    return ok(item);
  }

  // ------------------------------------------------------------ Công tắc và cấu hình
  function setKillSwitch(enabled) {
    const m = state(); m.settings.killSwitch = Boolean(enabled);
    audit(enabled ? 'kill_switch_on' : 'kill_switch_off', 'settings'); persist();
    return ok(m.settings);
  }
  function updateSettings(input) {
    const m = state();
    if (typeof input.autoPublish === 'boolean') m.settings.autoPublish = input.autoPublish;
    if (typeof input.siteUrl === 'string') {
      const value = input.siteUrl.trim().replace(/\/+$/, '');
      if (value) { try { const url = new URL(value); if (!/^https?:$/.test(url.protocol)) throw new Error(); m.settings.siteUrl = url.origin + url.pathname.replace(/\/+$/, ''); } catch { return fail(400, 'siteUrl không hợp lệ.'); } } else m.settings.siteUrl = '';
    }
    for (const [channel, enabled] of Object.entries(input.channels || {})) if (CHANNELS.includes(channel) && typeof enabled === 'boolean') m.settings.channels[channel] = enabled;
    audit('settings', 'settings'); persist();
    return ok(m.settings);
  }

  // ------------------------------------------------------------ Đăng
  // Điều kiện đăng qua API (đều phải đúng): kill switch tắt, đăng tự động bật, kênh bật, có adapter, đã APPROVED/SCHEDULED với nội dung khớp bản đã duyệt.
  function blockers(item, { manual = false } = {}) {
    const m = state(); const list = [];
    if (m.settings.killSwitch) list.push('Công tắc dừng khẩn cấp đang bật.');
    if (!m.settings.channels[item.channel]) list.push(`Kênh ${item.channel} đang tắt.`);
    if (!manual && !m.settings.autoPublish) list.push('Đăng tự động đang tắt.');
    if (!['APPROVED', 'SCHEDULED'].includes(item.status)) list.push(`Trạng thái ${item.status} chưa được duyệt.`);
    else if (item.approvedHash !== contentHash(item)) list.push('Nội dung khác với bản đã duyệt.');
    return list;
  }

  // Gói đăng thủ công: văn bản để copy/upload khi chưa có quyền API.
  function manualPack(item) {
    return { channel: item.channel, title: item.title, body: item.body, link: item.targetUrl, mediaRefs: item.mediaRefs, checklist: [`Đăng lên ${item.channel} bằng tài khoản của bạn.`, 'Dán link đích (đã có UTM) đúng như trên.', 'Sau khi đăng, dán URL bài viết vào mục "Đã đăng" để theo dõi.'] };
  }

  async function publish(contentId, { manual = true } = {}) {
    const item = byId(contentId);
    if (!item) return fail(404, 'Không tìm thấy nội dung.', 'not_found');
    const problems = blockers(item, { manual });
    if (problems.length) { audit('publish', item.id, 'blocked'); persist(); return { status: 409, error: { code: 'blocked', message: problems.join(' '), issues: problems } }; }
    if (item.externalPostId) return fail(409, 'Bài này đã đăng.', 'already_published');
    const adapter = adapters[item.channel];
    if (!adapter) { item.manualDue = true; persist(); return ok({ mode: 'manual', pack: manualPack(item), content: item }); }
    // Một lần đăng trước đó chưa rõ kết quả (mất kết nối/tắt máy giữa chừng): không đăng lại, để người dùng đối chiếu rồi báo "đã đăng".
    const key = `${item.id}:${item.approvedHash}`;
    const m = state();
    if (m.attempts.some((attempt) => attempt.idempotencyKey === key && ['PUBLISHING', 'UNKNOWN'].includes(attempt.status))) {
      item.status = 'FAILED'; item.lastError = 'Lần đăng trước chưa rõ kết quả; kiểm tra kênh rồi bấm "Đã đăng" hoặc hủy.'; persist();
      return fail(409, item.lastError, 'unknown_outcome');
    }
    const attempt = { id: id('att'), contentId: item.id, channel: item.channel, attemptNo: m.attempts.filter((a) => a.contentId === item.id).length + 1, idempotencyKey: key, status: 'PUBLISHING', startedAt: now() };
    m.attempts.unshift(attempt); item.status = 'PUBLISHING'; persist();
    try {
      const result = await adapter.publish({ title: item.title, body: item.body, targetUrl: item.targetUrl, mediaRefs: item.mediaRefs, idempotencyKey: key });
      Object.assign(attempt, { status: 'PUBLISHED', externalPostId: String(result.externalPostId || ''), externalUrl: String(result.externalUrl || ''), finishedAt: now() });
      Object.assign(item, { status: 'PUBLISHED', externalPostId: attempt.externalPostId, externalUrl: attempt.externalUrl, publishedAt: now(), lastError: null, updatedAt: now() });
      audit('publish', item.id); persist();
      return ok(item);
    } catch (error) {
      // Lỗi "không rõ kết quả" (timeout sau khi đã gửi): nền tảng có thể đã nhận bài, nên tuyệt đối không tự đăng lại, chờ người dùng đối chiếu.
      if (error?.ambiguous) {
        Object.assign(attempt, { status: 'UNKNOWN', errorCode: String(error.code || 'TIMEOUT').slice(0, 40), sanitizedError: sanitizeError(error), finishedAt: now() });
        Object.assign(item, { status: 'FAILED', lastError: 'Chưa rõ bài đã lên hay chưa; kiểm tra kênh rồi bấm "Đã đăng" hoặc hủy (không tự đăng lại để tránh trùng bài).', updatedAt: now() });
        audit('publish', item.id, 'unknown'); persist();
        return fail(502, item.lastError, 'unknown_outcome');
      }
      const transient = Boolean(error?.transient);
      const tries = m.attempts.filter((a) => a.contentId === item.id).length;
      Object.assign(attempt, { status: 'FAILED', errorCode: String(error?.code || 'ERROR').slice(0, 40), sanitizedError: sanitizeError(error), finishedAt: now() });
      item.lastError = attempt.sanitizedError;
      if (transient && tries < MAX_ATTEMPTS) { item.status = 'SCHEDULED'; item.nextAttemptAt = new Date(Date.now() + BACKOFF_MINUTES[Math.min(tries - 1, BACKOFF_MINUTES.length - 1)] * 60000).toISOString(); }
      else item.status = 'FAILED'; // lỗi quyền/quota/hết hạn token: không retry
      item.updatedAt = now(); audit('publish', item.id, 'failed', { code: attempt.errorCode }); persist();
      return fail(502, attempt.sanitizedError || 'Đăng thất bại.', 'publish_failed');
    }
  }

  // Người dùng tự đăng xong, dán URL bài viết để theo dõi.
  function markPublished(contentId, url) {
    const { item, problem } = guard(contentId, ['APPROVED', 'SCHEDULED', 'FAILED']); if (problem) return problem;
    if (item.approvedHash !== contentHash(item)) return fail(409, 'Nội dung khác với bản đã duyệt.', 'needs_reapproval');
    let link; try { link = new URL(String(url)); if (!/^https?:$/.test(link.protocol)) throw new Error(); } catch { return fail(400, 'URL bài đăng không hợp lệ.'); }
    Object.assign(item, { status: 'PUBLISHED', externalUrl: link.toString(), externalPostId: item.externalPostId || `manual:${sha(link.toString())}`, publishedAt: now(), manualDue: false, updatedAt: now() });
    state().attempts.unshift({ id: id('att'), contentId: item.id, channel: item.channel, attemptNo: state().attempts.filter((a) => a.contentId === item.id).length + 1, status: 'PUBLISHED', mode: 'manual', externalUrl: item.externalUrl, startedAt: now(), finishedAt: now() });
    audit('mark_published', item.id); persist();
    return ok(item);
  }

  // Chạy định kỳ: xử lý bài đã đến giờ. Không có adapter thì chỉ đánh dấu "đến giờ, hãy đăng tay".
  async function tick() {
    const m = state(); const done = [];
    if (m.settings.killSwitch) return done;
    for (const item of m.content.filter((entry) => entry.status === 'SCHEDULED')) {
      if (Date.parse(item.scheduledAt) > Date.now() || (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > Date.now())) continue;
      if (!m.settings.channels[item.channel]) continue;
      if (!adapters[item.channel] || !m.settings.autoPublish) { if (!item.manualDue && !blockers(item, { manual: true }).length) { item.manualDue = true; persist(); done.push({ id: item.id, mode: 'manual' }); } continue; }
      const result = await publish(item.id, { manual: false });
      done.push({ id: item.id, mode: 'api', ok: !result.error });
    }
    return done;
  }
  // Khởi động lại sau khi tắt máy giữa lúc đăng: không tự đăng lại vì chưa biết bài đã lên hay chưa.
  function recover() {
    const m = state(); let changed = false;
    for (const item of m.content.filter((entry) => entry.status === 'PUBLISHING')) {
      item.status = 'FAILED'; item.lastError = 'Server dừng khi đang đăng; kiểm tra kênh rồi bấm "Đã đăng" hoặc hủy (không đăng lại tự động để tránh trùng bài).'; changed = true;
      for (const attempt of m.attempts.filter((a) => a.contentId === item.id && a.status === 'PUBLISHING')) attempt.status = 'UNKNOWN';
    }
    if (changed) persist();
    return changed;
  }

  // ------------------------------------------------------------ Kế hoạch nội dung (không dùng AI, không tốn phí)
  // Mẫu câu chỉ ghép từ Offer (giá, tính năng đã duyệt): không tự sáng tác claim. Thêm AI sau khi có cấu hình rõ ràng.
  function plan({ campaign = 'rotate', channels = CHANNELS } = {}) {
    const m = state();
    const offers = m.offers.filter((offer) => offer.active);
    if (!offers.length) return fail(422, 'Chưa có Offer nào (giá + tính năng đã xác nhận). Thêm Offer trước khi lập kế hoạch.', 'no_offer');
    if (!m.settings.siteUrl) return fail(422, 'Chưa cấu hình siteUrl của trang bán hàng.', 'no_site_url');
    const planned = Number(m.planRuns) || 0; // đếm theo lượt lập kế hoạch (mỗi lượt gồm nhiều kênh) để luân phiên sản phẩm đều
    const offer = campaign === 'rotate' ? offers[planned % offers.length] : offers.find((entry) => entry.id === campaign);
    if (!offer) return fail(404, 'Không tìm thấy Offer.', 'not_found');
    m.planRuns = planned + 1;
    const features = offer.approvedFeatures.length ? offer.approvedFeatures : [];
    const variant = Math.floor(planned / Math.max(1, offers.length)) % 3;
    const hooks = ['Bạn đang tạo video thủ công từng cái một?', 'Mỗi ngày một video, không phải ngồi canh máy?', 'Muốn kênh YouTube có video đều đặn mà vẫn tự duyệt trước khi đăng?'];
    const bullets = features.slice(0, 4).map((feature) => `• ${feature}`).join('\n');
    const created = [];
    for (const channel of channels.filter((entry) => CHANNELS.includes(entry))) {
      const price = formatVnd(offer.priceVnd);
      let title; let text;
      if (channel === 'website') {
        title = `${offer.name}: tính năng và cách dùng`;
        text = `${offer.name} là công cụ giúp bạn làm việc đều đặn hơn mà vẫn nắm quyền duyệt.\n\nNhững gì ${offer.name} làm được (theo tài liệu hướng dẫn hiện hành):\n${bullets}\n\nGiá hiện tại: ${price}, thanh toán một lần bằng chuyển khoản. Sau khi thanh toán, nút tải về hiện ra ngay trên trang.\n\nTrước khi mua, bạn nên đọc kỹ phần yêu cầu cài đặt (Node.js, trình duyệt Chrome/Edge, tài khoản Muse và kênh YouTube của bạn) để chắc chắn phù hợp với nhu cầu. Mọi dữ liệu nằm trên máy của bạn trong thư mục data, vì vậy hãy bảo vệ máy như bảo vệ tài khoản của chính mình.`;
      } else if (channel === 'youtube') {
        title = `${offer.name} - ${hooks[variant].replace(/\?$/, '')}`.slice(0, 100);
        text = `${hooks[variant]}\n\n${bullets}\n\nGiá ${price}, thanh toán một lần.`;
      } else if (channel === 'facebook') {
        title = `${offer.name} - ${price}`;
        text = `${hooks[variant]}\n\n${offer.name} giúp bạn:\n${bullets}\n\nGiá ${price}, thanh toán một lần bằng chuyển khoản.`;
      } else {
        title = `${offer.name} trong 30 giây`;
        text = `Cảnh 1 (0-3s): chữ lớn "${hooks[variant]}"\nCảnh 2 (3-15s): quay màn hình ${features[0] || offer.name}\nCảnh 3 (15-25s): ${features[1] || 'chọn video và duyệt trước khi đăng'}\nCảnh 4 (25-30s): "${offer.name} ${price}" + link ở bio\nCaption: ${hooks[variant]} ${price} một lần.`;
      }
      const item = create({ channel, campaign: offer.id, title, body: text, format: channel === 'website' ? 'article' : 'post' }, { source: 'planner', status: 'PENDING_APPROVAL', productId: offer.id });
      if (item.data) created.push(item.data);
      else created.push({ error: item.error?.message });
    }
    audit('plan', offer.id); persist();
    return ok(created, 201);
  }

  // ------------------------------------------------------------ Báo cáo
  function report() {
    const m = state(); const count = (predicate) => m.content.filter(predicate).length;
    const byStatus = Object.fromEntries(STATUSES.map((status) => [status, count((item) => item.status === status)]));
    const weekAgo = Date.now() - 7 * 86400000;
    return {
      settings: m.settings, byStatus,
      publishedLast7Days: m.content.filter((item) => item.status === 'PUBLISHED' && Date.parse(item.publishedAt || 0) >= weekAgo).map((item) => ({ id: item.id, channel: item.channel, url: item.externalUrl })),
      failed: m.content.filter((item) => item.status === 'FAILED').map((item) => ({ id: item.id, channel: item.channel, error: item.lastError })),
      dueForManualPost: m.content.filter((item) => item.manualDue && item.status === 'SCHEDULED').map((item) => item.id),
      note: 'Báo cáo chỉ đếm dữ liệu có trong hàng đợi này. Click, đơn hàng và doanh thu theo UTM nằm ở trang quản trị của site (/admin/); không gán doanh thu cho kênh khi chưa có dữ liệu attribution đủ tin cậy.',
    };
  }

  const list = ({ status, channel } = {}) => state().content.filter((item) => (!status || item.status === status) && (!channel || item.channel === channel));

  // Bộ định tuyến thuần: nhận phương thức, phần đường dẫn sau /api/marketing và dữ liệu vào, trả về { status, data | error }.
  async function route(method, parts, query, input) {
    const [head, contentId, action] = parts;
    if (!head && method === 'GET') { const m = state(); return ok({ settings: m.settings, offers: m.offers, counts: report().byStatus, channels: CHANNELS }); }
    if (head === 'report' && method === 'GET') return ok(report());
    if (head === 'audit' && method === 'GET') return ok(state().audit.slice(0, 100));
    if (head === 'settings' && method === 'PATCH') return updateSettings(input);
    if (head === 'kill-switch' && method === 'POST') return setKillSwitch(input.enabled !== false);
    if (head === 'offers' && method === 'PUT') return ok(setOffers(input.offers));
    if (head === 'plan' && method === 'POST') return plan({ campaign: input.campaign, channels: Array.isArray(input.channels) ? input.channels : CHANNELS });
    if (head === 'tick' && method === 'POST') return ok(await tick());
    if (head === 'content') {
      if (!contentId) {
        if (method === 'GET') return ok(list({ status: query.status, channel: query.channel }));
        if (method === 'POST') return create(input);
      } else if (!action) {
        if (method === 'GET') { const item = byId(contentId); return item ? ok({ ...item, attempts: state().attempts.filter((a) => a.contentId === item.id) }) : fail(404, 'Không tìm thấy nội dung.', 'not_found'); }
        if (method === 'PATCH') return update(contentId, input);
      } else if (method === 'POST') {
        if (action === 'submit') return submit(contentId);
        if (action === 'approve') return approve(contentId);
        if (action === 'reject') return reject(contentId, input.reason);
        if (action === 'schedule') return schedule(contentId, input.scheduledAt);
        if (action === 'cancel') return cancel(contentId);
        if (action === 'publish') return publish(contentId, { manual: true });
        if (action === 'mark-published') return markPublished(contentId, input.url);
      }
    }
    return fail(404, 'Không tìm thấy API endpoint.', 'not_found');
  }

  return { route, create, update, submit, approve, reject, schedule, cancel, publish, markPublished, tick, recover, plan, report, setOffers, setKillSwitch, updateSettings, qualityGate, list, byId, state, buildUrl };
}

module.exports = { createMarketing, checkText, CHANNELS, STATUSES, sanitizeError, mentionedPrices, contentHash };
