# DeskBridge

Điều khiển máy Mac từ xa ngay trên trình duyệt của điện thoại hoặc tablet, thông qua Cloudflare Tunnel. Không cần cài app trên thiết bị điều khiển, không cần mở port router.

```
Điện thoại / tablet ──HTTPS──▶ Cloudflare ──tunnel──▶ DeskBridge trên Mac ──▶ màn hình, chuột, bàn phím, clipboard
```

## Tính năng

- **Xem màn hình** theo thời gian thực, tự giảm khung hình khi mạng chậm, hỗ trợ nhiều màn hình.
- **Chuột**: mặc định ở chế độ *Trackpad* (vuốt để di con trỏ, chạm để click) để điều khiển chính xác; có chế độ *Touch* (chạm đâu click đó). Cuộn 2 ngón, chụm để phóng to.
- **Bàn phím**: dùng bàn phím rời của tablet (kể cả phím tắt ⌘), bàn phím ảo, gõ tiếng Việt, thanh phím đặc biệt (esc, tab, mũi tên, F1–F12, ⌘Tab…).
- **Clipboard**: ⌘V trên tablet dán nội dung clipboard của tablet vào Mac (cả **ảnh**); ⌘C trên Mac tự chép về tablet; panel Clipboard để gửi/lấy text và ảnh.
- **Bảo mật**: đăng nhập bằng mật khẩu trong `.env`, chống dò mật khẩu, server chỉ nghe trên `127.0.0.1`, thông báo trên Mac khi có thiết bị kết nối.
- **2 lệnh bật/tắt**: `scripts/start.sh` và `scripts/stop.sh`.

## Yêu cầu

| Thành phần | Phiên bản |
|---|---|
| macOS | 13 (Ventura) trở lên |
| Node.js | 22.18 trở lên |
| Xcode Command Line Tools (Swift) | `xcode-select --install` |
| cloudflared | `brew install cloudflared` |
| Domain trên Cloudflare | Không bắt buộc (có thể dùng quick tunnel) |

## Bắt đầu nhanh

```bash
git clone https://github.com/jasonvnit/deskbridge.git
cd deskbridge

# 1. Cài đặt một lần: build helper, tạo .env (kèm mật khẩu ngẫu nhiên), xin quyền macOS
scripts/setup.sh --skip-tunnel

# 2. Sửa .env: đặt DESKBRIDGE_TUNNEL_HOSTNAME (ví dụ desk.tenmien.com) hoặc dùng TUNNEL_MODE=quick
#    rồi chạy lại setup để tạo tunnel + DNS
scripts/setup.sh

# 3. Bật điều khiển từ xa
scripts/start.sh

# 4. Tắt điều khiển từ xa
scripts/stop.sh
```

Mở URL mà `start.sh` in ra trên điện thoại/tablet, nhập mật khẩu trong `.env` là dùng được. Mẹo: trên iPad/iPhone, bấm **Chia sẻ → Thêm vào MH chính** để mở toàn màn hình như app.

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| [Cài đặt](docs/cai-dat.md) | Cài từng bước, cấu hình `.env`, Cloudflare Tunnel, quyền macOS |
| [Hướng dẫn sử dụng](docs/su-dung.md) | Cử chỉ, bàn phím, clipboard, phím tắt, mẹo |
| [Kiến trúc](docs/kien-truc.md) | Thành phần, luồng dữ liệu, giao thức |
| [Bảo mật](docs/bao-mat.md) | Mô hình bảo mật và khuyến nghị |
| [Quyết định sản phẩm](docs/quyet-dinh-san-pham.md) | Các quyết định đã chốt và lý do |
| [Xử lý sự cố](docs/xu-ly-su-co.md) | Lỗi thường gặp và cách khắc phục |

## Cấu trúc thư mục

```
deskbridge/
├── scripts/        setup.sh, start.sh, stop.sh, status.sh
├── server/src/     Server Node.js (TypeScript): HTTP, WebSocket, đăng nhập
├── helper-macos/   Helper Swift: chụp màn hình, giả lập chuột/phím, clipboard
├── web/            Giao diện web (HTML/CSS/JS thuần, không cần build)
└── docs/           Tài liệu
```

## Giấy phép

[MIT](LICENSE)
