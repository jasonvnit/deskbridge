# Quyết định sản phẩm

Danh sách các quyết định đã chốt cho DeskBridge. Khi thay đổi một quyết định, cập nhật file này và ghi rõ lý do.

## Phạm vi

| # | Quyết định | Lý do |
|---|---|---|
| 1 | **Chỉ hỗ trợ macOS** cho máy được điều khiển trong giai đoạn này. | Tập trung làm tốt trên một nền tảng. Kiến trúc tách helper riêng để có thể thêm Windows/Linux sau. |
| 2 | Thiết bị điều khiển chính là **điện thoại và tablet (kể cả tablet có bàn phím rời)**. Máy tính để bàn vẫn dùng được. | Đây là cách sử dụng chính của team. Giao diện và cử chỉ được thiết kế cho cảm ứng trước. |
| 3 | Thiết bị điều khiển **chỉ cần trình duyệt**, không cài app. | Dùng được ngay trên mọi thiết bị, không phải phát hành app. |
| 4 | Tính năng cốt lõi: xem màn hình, chuột, bàn phím, clipboard text, **dán ảnh** từ thiết bị sang Mac. | Yêu cầu ban đầu của sản phẩm. |

## Truy cập và bảo mật

| # | Quyết định | Lý do |
|---|---|---|
| 5 | Truy cập từ xa qua **Cloudflare Tunnel**. Mặc định dùng named tunnel với hostname riêng; hỗ trợ thêm quick tunnel (không cần domain) và chế độ chỉ chạy local. | Không cần mở port hay IP tĩnh, có sẵn HTTPS. Quick tunnel giúp thành viên chưa có domain vẫn dùng được. |
| 6 | **Không dùng Cloudflare Access**. Bảo vệ bằng **một mật khẩu trong `.env`**. | Thiết lập đơn giản cho mỗi thành viên. Bù lại bằng chống dò mật khẩu, phiên có hạn, kiểm tra Origin và thông báo khi kết nối (xem [Bảo mật](bao-mat.md)). |
| 7 | **Một thiết bị điều khiển tại một thời điểm**; thiết bị mới kết nối sẽ thay thế thiết bị cũ. | Tránh hai người cùng điều khiển gây xung đột; người dùng không bị khóa ngoài khi quên đóng tab ở thiết bị khác. |
| 8 | Có **thông báo trên Mac** khi có thiết bị kết nối (có thể tắt). | Người ở cạnh máy biết máy đang bị điều khiển. |

## Vận hành

| # | Quyết định | Lý do |
|---|---|---|
| 9 | Bật/tắt bằng **2 script**: `scripts/start.sh` và `scripts/stop.sh` (thêm `setup.sh` cài một lần và `status.sh` xem trạng thái). | Theo yêu cầu: bật khi cần, tắt khi xong, không chạy nền thường trực. |
| 10 | Khi DeskBridge chạy, **Mac được giữ không ngủ**; tắt DeskBridge thì chế độ này tắt theo. | Máy ngủ thì mất kết nối điều khiển. |
| 11 | DeskBridge dùng **tunnel và file cấu hình riêng**, không sửa `~/.cloudflared/config.yml`. | Không ảnh hưởng các tunnel khác đang chạy trên máy. |

## Kỹ thuật

| # | Quyết định | Lý do |
|---|---|---|
| 12 | Kiến trúc **server Node.js + helper Swift** giao tiếp qua stdin/stdout. | API gốc của macOS ổn định và hỗ trợ Unicode tốt; các thư viện điều khiển input cho Node.js không còn được bảo trì hoặc đã chuyển sang trả phí. |
| 13 | Truyền hình ảnh bằng **khung JPEG qua WebSocket**, có kiểm soát luồng theo credit. | Cloudflare Tunnel không chuyển được media UDP của WebRTC. JPEG đơn giản, giải mã được trên mọi trình duyệt; kiểm soát luồng giúp chạy ổn trên mạng di động. |
| 14 | Phím từ bàn phím rời được gửi **theo vị trí vật lý**; văn bản từ bàn phím ảo/IME được gửi **dạng Unicode**. | Phím tắt hoạt động đúng với bàn phím rời; tiếng Việt từ điện thoại giữ nguyên dấu. |
| 15 | Giao diện web **không framework, không bước build**; server TypeScript chạy trực tiếp bằng Node.js. | Ít phụ thuộc, dễ đọc, dễ đóng góp. |

## Quy ước dự án

| # | Quyết định |
|---|---|
| 16 | Tài liệu (README, docs) viết bằng **tiếng Việt**. |
| 17 | Code, comment trong code, giao diện người dùng, log và thông điệp của script dùng **tiếng Anh**. |
| 18 | Repository **công khai**, giấy phép MIT. Không commit bí mật (`.env`, credentials của tunnel). |

## Hướng phát triển (chưa chốt thời gian)

- Nén video H.264 (VideoToolbox + WebCodecs) để giảm băng thông.
- Chỉ gửi vùng màn hình thay đổi.
- Gửi/nhận file.
- Âm thanh.
- Hỗ trợ Windows/Linux bằng helper riêng.
