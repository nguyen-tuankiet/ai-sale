// Toàn bộ trạng thái (sản phẩm, chiến dịch, việc, nội dung, nhật ký kiểm toán) nằm trong MỘT khóa Redis `sales:state` (JSON).
// Admin và worker cùng ghi, nên mọi thao tác ghi đi qua một khóa Redis ngắn hạn để không ghi đè lẫn nhau.
const lib = require('./_lib');
const { createMarketing } = require('../lib/marketing');
const { createAgents } = require('../lib/agents');

const KEY = 'sales:state';
const LOCK = 'sales:lock';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function load() {
  const raw = await lib.redis(['GET', KEY]);
  return raw ? JSON.parse(raw) : {};
}
const save = (state) => lib.redis(['SET', KEY, JSON.stringify(state)]);

function services(state) {
  const siteUrl = lib.landingUrl();
  const marketing = createMarketing({ getStore: () => ({ marketing: state.marketing || (state.marketing = {}) }), persist: () => {}, siteUrl });
  marketing.state().settings.siteUrl = siteUrl; // địa chỉ trang bán luôn theo LANDING_URL
  const agents = createAgents({ state, marketing, siteUrl });
  seedProducts(state, agents);
  agents.syncOffers();
  return { marketing, agents };
}

// Lần đầu chạy: nạp hai sản phẩm đang bán trên trang hiện tại (giá lấy từ cấu hình trang bán). Sửa tại tab Sản phẩm.
function seedProducts(state, agents) {
  if (state.seeded) return;
  state.seeded = true;
  const buyUrl = `${lib.landingUrl()}/#mua`;
  const features = ['Tạo video bằng tài khoản Muse theo lịch', 'Duyệt video trước khi đăng lên YouTube', 'Quản lý nhiều kênh YouTube trong một bảng điều khiển', 'Theo dõi lượt xem và subscriber', 'Chạy trên máy của bạn, dữ liệu nằm trong thư mục data'];
  const seeds = [
    { name: 'Muse Studio', type: 'tool', priceVnd: 50000, buyUrl, audience: 'Chủ kênh YouTube muốn đăng video đều đặn bằng AI', benefits: ['Video ra đều đặn theo lịch mà vẫn do bạn duyệt', 'Quản lý nhiều kênh ở một nơi', 'Dữ liệu nằm trên máy của bạn'], approvedFeatures: features, deliveryNote: 'Tải file zip trên trang bán sau khi thanh toán.' },
    { name: 'Muse Studio Pro', type: 'tool', priceVnd: 99000, buyUrl, audience: 'Người dùng Muse Studio muốn có thêm bộ prompt', benefits: ['Toàn bộ Muse Studio', 'Kèm gói prompt để bắt đầu nhanh'], approvedFeatures: ['Gồm toàn bộ Muse Studio', 'Kèm gói prompt'], deliveryNote: 'Tải file zip trên trang bán sau khi thanh toán.' },
  ];
  for (const seed of seeds) { const saved = agents.saveProduct(seed); if (saved.data) agents.setProductStatus(saved.data.id, 'selling'); }
}

// Đọc: không cần khóa. Ghi: giữ khóa tối đa ~10 giây rồi lưu lại toàn bộ trạng thái.
async function read(fn) {
  const state = await load();
  return fn({ state, ...services(state) });
}
async function write(fn) {
  const holder = Math.random().toString(36).slice(2);
  let locked = false;
  for (let i = 0; i < 40 && !locked; i += 1) {
    locked = (await lib.redis(['SET', LOCK, holder, 'NX', 'EX', '10'])) === 'OK';
    if (!locked) await sleep(150);
  }
  if (!locked) throw new Error('Hệ thống đang bận, thử lại sau giây lát.');
  try {
    const state = await load();
    const result = await fn({ state, ...services(state) });
    await save(state);
    return result;
  } finally {
    if ((await lib.redis(['GET', LOCK]).catch(() => null)) === holder) await lib.redis(['DEL', LOCK]).catch(() => {});
  }
}
module.exports = { read, write };
