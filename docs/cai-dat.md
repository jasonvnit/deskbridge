# Cài đặt

Tài liệu này hướng dẫn cài DeskBridge trên máy Mac **cần được điều khiển**. Thiết bị dùng để điều khiển (điện thoại, tablet, laptop) chỉ cần trình duyệt.

## 1. Chuẩn bị công cụ

```bash
xcode-select --install          # Swift (bỏ qua nếu đã có)
brew install node cloudflared   # Node.js >= 22.18 và cloudflared
brew install qrencode           # Không bắt buộc: in mã QR của URL khi start
```

## 2. Lấy mã nguồn và chạy setup

```bash
git clone https://github.com/jasonvnit/deskbridge.git
cd deskbridge
scripts/setup.sh --skip-tunnel
```

`setup.sh` sẽ:

1. Kiểm tra macOS, Node.js, Swift.
2. Cài thư viện Node.js (`npm install`).
3. Build helper Swift (`helper-macos/.build/release/deskbridge-helper`).
4. Tạo file `.env` từ `.env.example` với **mật khẩu ngẫu nhiên** và in mật khẩu ra màn hình. Hãy lưu mật khẩu này lại.
5. Kiểm tra và xin quyền macOS (xem mục 3).
6. Thiết lập Cloudflare Tunnel (bỏ qua khi có `--skip-tunnel`).

Chạy lại `setup.sh` nhiều lần không sao: các bước đã xong sẽ được giữ nguyên, `.env` có sẵn không bị ghi đè.

## 3. Cấp quyền macOS

DeskBridge cần 2 quyền:

| Quyền | Dùng để |
|---|---|
| **Screen & System Audio Recording** (Ghi màn hình) | Chụp màn hình để stream |
| **Accessibility** (Trợ năng) | Giả lập chuột và bàn phím |

macOS cấp quyền cho **ứng dụng terminal** chạy DeskBridge (Terminal, iTerm, Warp…), không phải cho từng script. Vào **System Settings → Privacy & Security**, bật công tắc cho đúng ứng dụng terminal ở cả 2 mục trên. Sau khi bật, có thể phải mở lại ứng dụng terminal.

> Nếu bạn chạy `start.sh` từ một terminal khác (ví dụ chuyển từ Terminal sang iTerm), cần cấp quyền lại cho terminal đó.

## 4. Cấu hình `.env`

Các biến quan trọng (danh sách đầy đủ có trong `.env.example`):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DESKBRIDGE_PASSWORD` | (bắt buộc) | Mật khẩu đăng nhập, tối thiểu 12 ký tự. Nếu có ký tự đặc biệt hoặc khoảng trắng, bọc trong dấu nháy đơn. |
| `DESKBRIDGE_PORT` | `8765` | Port của server local |
| `DESKBRIDGE_SESSION_TTL_HOURS` | `12` | Thời gian tối đa của một phiên đăng nhập |
| `DESKBRIDGE_SESSION_IDLE_MINUTES` | `60` | Tự đăng xuất sau bao nhiêu phút không dùng |
| `DESKBRIDGE_STREAM_FPS` | `15` | Số khung hình/giây mặc định |
| `DESKBRIDGE_STREAM_QUALITY` | `50` | Chất lượng JPEG mặc định (10–100) |
| `DESKBRIDGE_STREAM_MAX_WIDTH` | `1600` | Chiều rộng tối đa của khung hình (px), `0` = độ phân giải gốc |
| `DESKBRIDGE_NOTIFY_ON_CONNECT` | `true` | Hiện thông báo trên Mac khi có thiết bị kết nối |
| `DESKBRIDGE_TUNNEL_MODE` | `named` | `named`, `quick` hoặc `none` (xem mục 5) |
| `DESKBRIDGE_TUNNEL_NAME` | `deskbridge` | Tên tunnel trên Cloudflare |
| `DESKBRIDGE_TUNNEL_HOSTNAME` | | Tên miền truy cập, ví dụ `desk.tenmien.com` |

Sau khi sửa `.env`, chạy `scripts/stop.sh` rồi `scripts/start.sh` để áp dụng.

## 5. Cloudflare Tunnel

### Cách A: Named tunnel, có domain riêng (khuyên dùng)

URL cố định, ví dụ `https://desk.tenmien.com`. Yêu cầu domain đã được quản lý DNS trên Cloudflare.

1. Trong `.env`, đặt:
   ```
   DESKBRIDGE_TUNNEL_MODE=named
   DESKBRIDGE_TUNNEL_HOSTNAME=desk.tenmien.com
   ```
2. Chạy `scripts/setup.sh`. Script sẽ:
   - Mở trình duyệt để đăng nhập Cloudflare (`cloudflared tunnel login`) nếu máy chưa đăng nhập.
   - Tạo tunnel tên `deskbridge` (`cloudflared tunnel create`).
   - Tạo bản ghi DNS trỏ `desk.tenmien.com` về tunnel (`cloudflared tunnel route dns`).

Mỗi thành viên trong team nên dùng **hostname và tên tunnel riêng** cho máy của mình, ví dụ `desk-an.tenmien.com` với tunnel `deskbridge-an`.

DeskBridge tự tạo file cấu hình tunnel riêng tại `~/.deskbridge/run/cloudflared.yml`, **không** đụng tới `~/.cloudflared/config.yml` hay các tunnel khác đang chạy trên máy.

### Cách B: Quick tunnel, không cần domain

```
DESKBRIDGE_TUNNEL_MODE=quick
```

Mỗi lần `start.sh` sẽ tạo một URL ngẫu nhiên dạng `https://xxx.trycloudflare.com`. Tiện để thử, nhưng URL đổi sau mỗi lần khởi động.

### Cách C: Không dùng tunnel

```
DESKBRIDGE_TUNNEL_MODE=none
```

Chỉ truy cập được ngay trên máy Mac tại `http://127.0.0.1:8765`. Dùng để phát triển hoặc kiểm tra.

## 6. Bật, tắt, kiểm tra

```bash
scripts/start.sh    # Bật: server + tunnel + chống ngủ máy, in URL truy cập
scripts/status.sh   # Xem trạng thái
scripts/stop.sh     # Tắt: ngắt tunnel trước, sau đó tắt server
```

Có thể dùng `npm start`, `npm stop`, `npm run status` tương đương.

Khi đang chạy, Mac được giữ không ngủ (`caffeinate`). Khi tắt DeskBridge, chế độ chống ngủ cũng tắt theo.

File log và trạng thái nằm trong `~/.deskbridge/`:

```
~/.deskbridge/
├── logs/server.log        # Log server và helper
├── logs/cloudflared.log   # Log tunnel
└── run/                   # PID và cấu hình tunnel sinh tự động
```

## 7. Cập nhật phiên bản mới

```bash
scripts/stop.sh
git pull
scripts/setup.sh --skip-tunnel   # build lại helper và cài thư viện mới
scripts/start.sh
```

> Sau khi build lại helper, macOS thường vẫn giữ quyền vì quyền được cấp cho ứng dụng terminal. Nếu bị mất quyền, xem [Xử lý sự cố](xu-ly-su-co.md).

## 8. Phát triển

```bash
npm install          # Cài cả devDependencies (TypeScript)
npm run typecheck    # Kiểm tra kiểu dữ liệu của server
npm run dev          # Chạy server và tự khởi động lại khi sửa code
npm run build:helper # Build lại helper Swift
```

Server được viết bằng TypeScript và chạy trực tiếp bằng Node.js (tính năng type stripping), không có bước build. Giao diện web là HTML/CSS/JS thuần trong `web/`.
