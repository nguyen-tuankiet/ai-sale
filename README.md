# muse-sales: trang bán Muse Studio và gói prompt

Dự án **tách riêng** khỏi tool `museinsight`. Khách mua tool không nhận bất cứ thứ gì trong thư mục này.

Gồm:
- **Trang công khai** (`public/`): sổ thu chi trực tiếp (doanh thu thật, chi phí đã khai, số đơn, thanh mục tiêu), sản phẩm, nhật ký, hỏi đáp, nút chia sẻ.
- **Thanh toán tự động**: khách chuyển khoản (SePay) → webhook xác thực → nút Tải về hiện ngay. Có chống xử lý trùng, cộng dồn tiền chuyển thiếu, danh sách "Giao dịch cần xem", gửi lại email.
- **Quảng bá có kiểm soát** (`/admin/marketing.html`): nháp cho YouTube/Facebook/TikTok/website, quality gate (giá sai, cam kết viral, lộ bí mật, trùng lặp), duyệt, xếp lịch, gói đăng thủ công, công tắc dừng khẩn cấp.
- **Nhật ký công khai**: bản nháp ghép từ số liệu thật; chỉ lên trang khi bạn bấm Đăng.

## Nguyên tắc số liệu (không làm giả)
- Doanh thu trên trang = các giao dịch đã được webhook xác thực, từ `LEDGER_MIN_VND` trở lên. Đơn thử và đơn chưa trả không tính.
- Chi phí do bạn tự khai trong trang quản trị.
- Lượt khách do máy chủ đếm, đã loại bot. Không có số giả, không có "người đang xem" bịa.

## Chạy thử trên máy (dữ liệu giả, không đụng dịch vụ thật)

```
node dev.mjs
```

Mở http://127.0.0.1:3700 · quản trị http://127.0.0.1:3700/admin/ (mật khẩu `dev-admin`). Giả lập thanh toán: `POST /api/sepay-webhook` với header `Authorization: Apikey dev-key` và mã đơn trong `content`.

Kiểm thử tự động: `node marketing.test.js` và `node selftest.mjs`.

## Triển khai (Vercel, gói miễn phí đủ dùng)

1. Tạo repo GitHub riêng cho thư mục `muse-sales`, nối với Vercel (Framework: Other; `vercel.json` đã chỉ thư mục `public`).
2. Đặt biến môi trường theo `.env.example`. Hướng dẫn chi tiết SePay, Upstash, repo release và email nằm ở `museinsight/site/HUONG-DAN-THANH-TOAN.md` (cùng bộ biến).
3. Tạo file bán: `node release.mjs`, tải `release/*.zip` lên repo release **riêng tư**.
4. Trong SePay, đặt webhook tới `https://<tên-miền>/api/sepay-webhook` với API Key = `SEPAY_API_KEY`.
5. Thử một đơn nhỏ (ví dụ đặt tạm `PRICE_VND=2000`; vì nhỏ hơn `LEDGER_MIN_VND` nên không vào sổ công khai), kiểm tra tải được file, rồi đặt lại giá thật.
6. Đặt `START_DATE`, `DEADLINE_DATE`, `GOAL_VND` nếu muốn hiện thanh mục tiêu và đếm ngày.

## Vận hành hằng ngày
- `/admin/`: đơn hàng, doanh thu, giao dịch cần xem (tiền vào không khớp, trả thừa, email lỗi).
- `/admin/marketing.html`: tạo nháp → duyệt → lấy gói đăng, dán lên kênh, bấm "Đã đăng"; soạn nhật ký từ số liệu thật; khai chi phí.
- Chưa có kênh nào nối API đăng bài (YouTube/Facebook/TikTok cần OAuth và duyệt app của bạn), nên đăng bài là thao tác tay có hướng dẫn.

## Giới hạn đã biết
- Không có cron: bài "đến giờ đăng tay" được đánh dấu khi bạn mở trang quản trị.
- Sổ doanh thu lưu 1.000 đơn gần nhất.
- Webhook SePay chỉ xác thực bằng API Key (SePay không ký HMAC): giữ key dài, ngẫu nhiên và xoay định kỳ.
- Trang không hứa lợi nhuận hay lượt xem cho khách. Đừng thêm các cam kết đó; cổng kiểm tra sẽ chặn trong nội dung quảng bá.
