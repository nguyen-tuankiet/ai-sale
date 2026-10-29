# muse-sales: Sales Command Center

Hệ thống agent hỗ trợ **marketing để kéo khách về trang bán hàng hiện có** (`LANDING_URL`). Dự án này **không bán hàng, không thanh toán, không công khai gì**: khách mua ở trang cũ; doanh thu và lượt xem bạn xem ở `/admin/` của trang đó.

```
Command Center (Vercel, có mật khẩu) ── Product Registry ── Campaign (bạn duyệt) ── Sales Manager (luật cố định)
                                                                                      │ tạo việc
                       Content Agent (worker trên MÁY BẠN, dùng Chat Muse) ◄──────────┘
                                │ bản nháp (không bao giờ tự duyệt)
                                ▼
                  Quality gate → Human Approval (bạn) → lịch → gói đăng thủ công → bạn đăng, dán URL
```

## Trạng thái từng agent (nói thật)
| Thành phần | Trạng thái |
|---|---|
| Human Approval, công tắc dừng khẩn cấp, quality gate | Có |
| Product Registry (thêm sản phẩm bằng dữ liệu, không sửa mã) | Có |
| Sales Manager | Có, **luật cố định, không phải AI**: bổ sung việc cho kênh còn thiếu bản nháp, có trần việc mỗi ngày |
| Content Agent | Có, qua worker + Chat Muse. **Chưa kiểm chứng với Muse thật** (xem Giới hạn) |
| Distribution Agent | Chỉ gói đăng thủ công; chưa nối API YouTube/Facebook/TikTok |
| Research, Conversion, Customer, Analytics Agent | **Chưa xây** (hiển thị "Chưa xây" trên màn hình) |

## Chạy thử trên máy (dữ liệu giả)
```
node dev.mjs                      # http://127.0.0.1:3700/admin/  (mật khẩu dev-admin)
set API_BASE=http://127.0.0.1:3700 & set WORKER_TOKEN=dev-worker-token-0123456789 & set LOCAL_MODEL=template & node worker/worker.mjs
node marketing.test.js & node agents.test.js & node selftest.mjs
```

## Triển khai
1. Vercel: nối repo này (Framework: Other, `vercel.json` đã chỉ `public/`). Đặt biến theo `.env.example` (Upstash Redis miễn phí).
2. Mở `/admin/`, đăng nhập. Registry đã nạp sẵn Muse Studio (50.000đ) và Muse Studio Pro (99.000đ) theo trang bán hiện tại; **kiểm tra giá khớp trang bán**, sửa/thêm sản phẩm ở tab Sản phẩm (ví dụ Master Prompt nếu bán riêng).
3. Tab Chiến dịch → tạo → đọc → **Duyệt**. Tab Tổng quan → **Chạy Sales Manager**.
4. Trên máy bạn chạy worker (Cài đặt trong Command Center có sẵn lệnh): `node worker/worker.mjs`. Bản nháp xuất hiện ở tab Duyệt nội dung.
5. Duyệt → Lấy gói đăng → dán lên kênh → "Đã đăng" + URL.

## Quy tắc cố định
- Agent chỉ tạo bản nháp; không bài nào đăng khi chưa APPROVED; sửa sau khi duyệt phải duyệt lại.
- Agent không đổi giá, không giảm giá, không gửi tin hàng loạt. Đổi giá/tính năng sản phẩm thì chiến dịch đang chạy tự về "chờ duyệt".
- Quality gate chặn: giá lệch Registry, cam kết viral/lên top/100%, lộ bí mật, nội dung trùng, link ngoài trang bán.
- Cookie Muse ở lại máy bạn; chỉ prompt và JSON kết quả đi qua mạng.

## Giới hạn đã biết
- Worker dùng lại `museinsight/lib/muse.js` và cookie của Muse Studio. **Chưa thử với Muse thật**; dùng chung hồ sơ trình duyệt với tool nên **không chạy cùng lúc Muse Studio đang tạo video**.
- Mỗi việc mở một cuộc chat Muse mới và tốn quota tài khoản Muse của bạn: hãy giữ trần mỗi ngày thấp (mặc định 8).
- Giá trong Registry không tự đồng bộ từ trang bán.
- Không có cron: bài "đến giờ đăng tay" được đánh dấu khi bạn mở trang quản trị; Sales Manager chạy khi bạn bấm.
- Trạng thái nằm trong một khóa Redis (dùng khóa ngắn hạn khi ghi), phù hợp một người dùng.
