// Đổ số liệu thật từ /api/ledger và /api/diary vào trang. Chỉ dùng textContent (không chèn HTML) nên nội dung nhật ký không thể chạy mã.
(function () {
  var cfg = window.SITE || {};
  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) { return Number(n || 0).toLocaleString('vi-VN') + 'đ'; };
  var when = function (iso) { try { return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return ''; } };
  var li = function (left, right) { var item = document.createElement('li'); var a = document.createElement('span'); a.textContent = left; var b = document.createElement('b'); b.textContent = right; item.append(a, b); return item; };

  document.querySelectorAll('.js-site-name').forEach(function (el) { el.textContent = cfg.siteName || el.textContent; });
  document.querySelectorAll('.js-intro').forEach(function (el) { el.textContent = cfg.intro || ''; });
  document.querySelectorAll('.js-policy').forEach(function (el) { el.textContent = cfg.policy || ''; });
  document.querySelectorAll('[data-price]').forEach(function (el) { if (cfg.price) el.textContent = cfg.price; });
  document.querySelectorAll('[data-price-pro]').forEach(function (el) { if (cfg.proPrice) el.textContent = cfg.proPrice; });
  document.querySelectorAll('.js-author').forEach(function (el) { if (cfg.author) el.textContent = cfg.author; if (cfg.authorUrl) el.href = cfg.authorUrl; });
  document.querySelectorAll('.js-support-text').forEach(function (el) {
    if (!cfg.supportEmail) return;
    el.textContent = 'Gửi email tới ';
    var a = document.createElement('a'); a.href = 'mailto:' + cfg.supportEmail; a.textContent = cfg.supportEmail; el.append(a, document.createTextNode(' kèm mã đơn hàng và mô tả vấn đề.'));
  });
  $('year').textContent = new Date().getFullYear();

  // Giao diện sáng/tối
  var root = document.documentElement;
  try { var saved = localStorage.getItem('shop-theme'); if (saved) root.setAttribute('data-theme', saved); } catch (e) { /* bỏ qua */ }
  $('theme').addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    var next = dark ? 'light' : 'dark'; root.setAttribute('data-theme', next);
    try { localStorage.setItem('shop-theme', next); } catch (e) { /* bỏ qua */ }
  });

  // Chia sẻ
  var url = location.origin + location.pathname;
  $('share-fb').href = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url);
  $('share-copy').addEventListener('click', function () {
    var button = this;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { button.textContent = 'Đã chép'; setTimeout(function () { button.textContent = 'Chép link'; }, 1500); }).catch(function () {});
  });

  function renderLedger(d) {
    $('v-revenue').textContent = money(d.revenue); $('v-cost').textContent = money(d.costTotal); $('v-net').textContent = money(d.net);
    $('v-orders').textContent = String(d.orders);
    $('v-plans').textContent = d.orders ? d.byPlan.basic + ' gói thường · ' + d.byPlan.pro + ' gói Pro' : 'Chưa có đơn nào';
    $('v-visitors').textContent = String(d.visitors30d); $('v-visitors-today').textContent = 'trong 30 ngày · hôm nay ' + d.visitorsToday;
    $('ledger-updated').textContent = 'Cập nhật ' + when(d.updatedAt) + '. ' + (d.note || '');
    if (d.dayNumber) {
      $('card-day').hidden = false; $('v-day').textContent = 'Ngày thứ ' + d.dayNumber;
      if (d.deadlineDate) { var left = Math.ceil((Date.parse(d.deadlineDate) - Date.now()) / 86400000); $('v-deadline').textContent = left > 0 ? 'Còn ' + left + ' ngày tới ' + d.deadlineDate : 'Đã tới hạn ' + d.deadlineDate; }
    }
    if (d.goal) { $('goal').hidden = false; $('goal-amount').textContent = money(d.goal); $('goal-pct').textContent = (d.progress * 100).toFixed(1) + '%'; $('goal-bar').style.width = Math.max(d.progress * 100, d.revenue ? 1 : 0) + '%'; }
    var recent = $('recent'); recent.replaceChildren();
    if (!d.recent.length) { var empty = document.createElement('li'); empty.className = 'muted'; empty.textContent = 'Chưa có đơn nào.'; recent.append(empty); }
    d.recent.forEach(function (o) { recent.append(li((o.plan === 'pro' ? 'Gói Pro' : 'Muse Studio') + ' · ' + when(o.at), money(o.amount))); });
    var costs = $('costs'); costs.replaceChildren();
    if (!d.costs.length) { var none = document.createElement('li'); none.className = 'muted'; none.textContent = 'Chưa khai khoản chi nào.'; costs.append(none); }
    d.costs.forEach(function (c) { costs.append(li(c.label, money(c.amountVnd))); });
  }
  function renderDiary(d) {
    var box = $('diary'); box.replaceChildren();
    if (!d.entries.length) { var p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Chưa có bài nào được đăng.'; box.append(p); return; }
    d.entries.forEach(function (e) {
      var item = document.createElement('article'); item.className = 'entry';
      var h = document.createElement('h3'); h.textContent = e.title; var t = document.createElement('time'); t.textContent = when(e.at); var p = document.createElement('p'); p.textContent = e.body;
      item.append(h, t, p); box.append(item);
    });
  }
  function load() {
    fetch('/api/ledger').then(function (r) { return r.ok ? r.json() : Promise.reject(); }).then(renderLedger).catch(function () { $('ledger-updated').textContent = 'Chưa tải được số liệu, thử lại sau ít phút.'; });
    fetch('/api/diary').then(function (r) { return r.ok ? r.json() : Promise.reject(); }).then(renderDiary).catch(function () {});
  }
  load(); setInterval(load, 30000);
})();
