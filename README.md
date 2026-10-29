# muse-sales: Sales Command Center

Hệ thống agent hỗ trợ **marketing để kéo khách về trang bán hàng hiện có** (`LANDING_URL`). Dự án này **không bán hàng, không thanh toán, không công khai gì**: khách mua ở trang cũ; bạn quản lý quảng bá, nghiên cứu, đề xuất và hỗ trợ khách ở đây. Mọi thứ agent làm ra đều là **bản nháp/đề xuất chờ bạn duyệt**.

```
                  Command Center (có mật khẩu) ── Product Registry (sản phẩm = dữ liệu)
                                     │
  Sales Manager (luật cố định) ──► hàng đợi việc ──► worker trên MÁY BẠN (Chat Muse)
                                                         │ kết quả = bản nháp / đề xuất
        Content · Research · Conversion · Customer ◄─────┘
        Analytics (đọc số liệu từ /admin/ của trang bán)
                                     │
            Quality gate ──► Human Approval (bạn) ──► gói đăng thủ công ──► bạn đăng / bạn trả lời khách
```

## Từng agent làm gì và KHÔNG làm gì
| Agent | Làm | Không làm |
|---|---|---|
| Sales Manager | Luật cố định (không phải AI): bổ sung việc cho kênh còn thiếu bản nháp, có trần việc mỗi ngày | Không tự duyệt, không tự đăng |
| Content | Viết bản nháp bài cho YouTube/Facebook/TikTok/website từ Registry và góc tiếp cận của chiến dịch | Không bịa tính năng/giá; không đăng |
| Research | Đề xuất ý tưởng nội dung, xếp hạng theo *độ phù hợp trừ công sức* | Không có dữ liệu thị trường nên **mọi ý tưởng là giả thuyết "chưa kiểm chứng"**; không nói viral |
| Conversion | Đề xuất biến thể tiêu đề/CTA (AI) và combo (luật cố định) | Không sửa trang bán, **không tự đặt giá/giảm giá** (giá combo do bạn nhập), không có A/B |
| Customer | Soạn **nháp** trả lời từ FAQ của bạn (không cần AI), hoặc nhờ AI soạn | Không gửi gì cho khách; ca hoàn tiền/mất tiền/khiếu nại luôn chuyển cho bạn; che email, số điện thoại, cookie/token |
| Analytics | Đọc số liệu từ trang bán, tính tỷ lệ chuyển đổi, đưa gợi ý có căn cứ và cỡ mẫu | Trang bán không ghi UTM nên **không gán doanh thu cho kênh**; lượt truy cập theo nguồn chỉ là ước lượng |
| Distribution | Chuẩn bị gói đăng thủ công + link UTM | Chưa nối API YouTube/Facebook/TikTok (cần OAuth và duyệt app của bạn) |

Cố định cho mọi agent: không bài nào đăng khi chưa APPROVED; sửa sau khi duyệt phải duyệt lại; đổi giá/tính năng thì chiến dịch tự về "chờ duyệt"; quality gate chặn giá lệch Registry, cam kết viral/lên top/"100%", lộ bí mật, nội dung trùng, link ngoài trang bán; công tắc dừng khẩn cấp chặn cả Sales Manager, worker và gói đăng.

## Test ở local (không cần deploy, không đụng dịch vụ thật)

Chạy hết bộ test tự động:
```
node marketing.test.js
node agents.test.js
node agents2.test.js
node selftest.mjs
```

Dùng thử bằng tay (dữ liệu giả trong bộ nhớ, tắt server là mất):
```
node dev.mjs                       # http://127.0.0.1:3700/admin/   mật khẩu: dev-admin
```
Trong cửa sổ lệnh khác, cho Content/Research/Conversion/Customer chạy bằng worker **chế độ thử** (không dùng AI, trả dữ liệu mẫu ghi rõ "bản thử"):
```
set API_BASE=http://127.0.0.1:3700
set WORKER_TOKEN=dev-worker-token-0123456789
set LOCAL_MODEL=template
node worker/worker.mjs
```
Gợi ý các bước thử: Chiến dịch → tạo → Duyệt → Tổng quan → "Chạy Sales Manager" → xem Duyệt nội dung; Nghiên cứu → "Nhờ Research Agent"; Chuyển đổi → "Đề xuất tiêu đề và CTA"; Hỗ trợ khách → dán câu hỏi, thử câu có chữ "hoàn tiền"; công tắc "Dừng khẩn cấp".

**Thử với Muse thật** (bỏ `LOCAL_MODEL`): `set MUSE_STUDIO_DIR=..\museinsight` rồi `node worker/worker.mjs`. Cần đã dán cookie Muse trong Muse Studio; **chưa kiểm chứng**, và đừng chạy lúc Muse Studio đang tạo video (dùng chung hồ sơ trình duyệt). Mỗi việc tốn quota Muse của bạn.

**Thử Analytics với trang bán thật**: 
```
set LANDING_URL=https://muse-studio-landing.vercel.app
set LANDING_ADMIN_PASSWORD=<mật khẩu /admin/ của trang bán>
node dev.mjs
```
Agent chỉ đăng nhập và đọc `/api/admin-stats`; mật khẩu chỉ gửi tới chính trang bán của bạn. Trang bán giới hạn 8 lần đăng nhập sai mỗi 15 phút.

## Triển khai (làm một lần sau khi test xong)
1. Vercel: nối repo (Framework: Other; `vercel.json` đã chỉ `public/`). Đặt biến theo `.env.example` (Upstash Redis miễn phí). Không đặt `API_BASE`, `MUSE_STUDIO_DIR` trên Vercel.
2. `/admin/` → kiểm tra giá trong tab Sản phẩm khớp trang bán; xem lại FAQ nạp sẵn (chỉ lấy từ README của tool), thêm FAQ thật của bạn.
3. Trên máy bạn chạy worker với `API_BASE` là địa chỉ Vercel và `WORKER_TOKEN` như trên Vercel.

## Giới hạn đã biết
- Khớp FAQ là so từ khóa đơn giản: không chắc thì chuyển cho bạn; mọi nháp đều do bạn đọc trước khi trả lời.
- Giá trong Registry không tự đồng bộ từ trang bán.
- Không có cron: "đến giờ đăng tay" được đánh dấu khi bạn mở trang; Sales Manager và các agent AI chạy khi bạn bấm.
- Worker chưa thử với Muse thật; Analytics chưa thử với trang bán thật (chỉ thử với trang giả cùng hình dạng API).
- Trạng thái nằm trong một khóa Redis có khóa ghi ngắn hạn, phù hợp một người dùng.
