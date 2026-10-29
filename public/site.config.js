// Cấu hình hiển thị của trang bán hàng: sửa file này, không cần đụng vào index.html.
// Giá THẬT do máy chủ quyết định (biến môi trường PRICE_VND, PRICE_PRO_VND); các chuỗi dưới đây chỉ để hiển thị, nhớ sửa cho khớp.
window.SITE = {
  siteName: 'Muse Studio',
  // true: thanh toán chuyển khoản ngay trên trang (SePay), xem README.
  bankCheckout: true,
  price: '50.000đ', priceVndLabel: '50.000đ',
  proPrice: '99.000đ', proPriceVndLabel: '99.000đ',
  supportEmail: 'tech.dev.fit@gmail.com',
  author: 'Nguyễn Tuấn Kiệt',
  authorUrl: 'https://github.com/nguyen-tuankiet',
  // Dòng giải thích đầu trang. Viết đúng sự thật: ai làm, ai duyệt nội dung.
  intro: 'Mọi con số trong sổ bên dưới lấy trực tiếp từ giao dịch ngân hàng đã được xác thực và các khoản chi do chủ dự án tự khai. Nhật ký do công cụ soạn nháp từ số liệu thật; chủ dự án đọc và duyệt trước khi đăng.',
  // Chính sách hiển thị cho khách. Không ghi cam kết hoàn tiền nếu bạn chưa quyết định áp dụng.
  policy: 'Sản phẩm số, giao ngay sau khi thanh toán. Gặp lỗi khi cài đặt hoặc chạy, gửi email hỗ trợ kèm mã đơn để được trợ giúp.',
  socials: { youtube: '', facebook: '', tiktok: '' },
};
