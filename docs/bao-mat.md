# Bảo mật

DeskBridge cho phép điều khiển toàn bộ máy Mac qua Internet. Ai có mật khẩu là có toàn quyền như người đang ngồi trước máy. Hãy đọc kỹ phần này trước khi dùng.

## Các lớp bảo vệ

| Lớp | Chi tiết |
|---|---|
| Không mở port | Server chỉ nghe trên `127.0.0.1`. Truy cập từ ngoài chỉ đi qua Cloudflare Tunnel (kết nối do máy Mac chủ động mở ra). |
| HTTPS | Cloudflare cung cấp HTTPS/WSS cho toàn bộ kết nối. |
| Mật khẩu | Lưu trong `.env` (không commit lên git), tối thiểu 12 ký tự; `setup.sh` sinh mật khẩu ngẫu nhiên 24 ký tự. So sánh bằng hàm thời gian hằng (chống tấn công đo thời gian). |
| Chống dò mật khẩu | Mỗi lần sai chờ thêm 0,6 giây. Sai 5 lần trong 15 phút: khóa IP đó 15 phút. Sai tổng cộng 30 lần trong 1 giờ (từ mọi IP): khóa đăng nhập toàn bộ 30 phút và hiện thông báo trên Mac. |
| Phiên đăng nhập | Token ngẫu nhiên 256 bit, server chỉ lưu bản băm. Cookie `HttpOnly`, `Secure`, `SameSite=Strict`. Hết hạn sau 12 giờ hoặc 60 phút không dùng (cấu hình được). Server khởi động lại thì mọi phiên bị hủy. |
| Chống CSRF / WebSocket hijacking | Mọi POST và kết nối WebSocket phải có `Origin` trùng `Host`. |
| Header bảo mật | Content-Security-Policy chặt (chỉ script cùng nguồn), chặn nhúng iframe, `no-referrer`. |
| Một phiên điều khiển | Chỉ một thiết bị điều khiển tại một thời điểm; thiết bị mới sẽ ngắt thiết bị cũ. |
| Minh bạch | Thông báo trên Mac mỗi khi có thiết bị kết nối; biểu tượng ghi màn hình của macOS hiện trên thanh menu khi đang stream; log ghi lại đăng nhập thành công/thất bại kèm IP. |
| Kiểm tra đầu vào | Server kiểm tra và giới hạn mọi lệnh trước khi chuyển cho helper (loại lệnh, khoảng giá trị, độ dài văn bản, kích thước ảnh). |
| Tắt nhanh | `scripts/stop.sh` ngắt tunnel ngay lập tức. |

## Khuyến nghị

1. **Dùng mật khẩu do `setup.sh` sinh ra** hoặc mật khẩu dài, ngẫu nhiên. Không dùng lại mật khẩu của dịch vụ khác.
2. **Không chia sẻ URL kèm mật khẩu** qua kênh chat công khai.
3. **Chỉ bật khi cần**: chạy `scripts/stop.sh` khi không dùng.
4. **Không commit `.env`**. File đã có trong `.gitignore`; `setup.sh` đặt quyền `600` cho file.
5. **Đổi mật khẩu** khi nghi bị lộ: sửa `.env`, sau đó `scripts/stop.sh && scripts/start.sh`. Mọi phiên cũ bị hủy khi server khởi động lại.
6. **Kiểm tra log** định kỳ: `grep -E "login|connected" ~/.deskbridge/logs/server.log`.
7. **Mỗi người một tunnel/hostname** khi dùng trong team, để dễ quản lý và thu hồi.

## Có thể tăng cường thêm (tùy chọn)

DeskBridge chủ động không phụ thuộc Cloudflare Access, nhưng nếu muốn có thêm một lớp xác thực, bạn có thể bật **Cloudflare Zero Trust → Access** cho hostname của mình (đăng nhập bằng email OTP). Lớp này hoạt động độc lập và không cần sửa code.

## Báo lỗi bảo mật

Nếu phát hiện lỗ hổng, vui lòng liên hệ trực tiếp người quản lý repository thay vì tạo issue công khai.
