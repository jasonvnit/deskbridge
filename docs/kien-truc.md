# Kiến trúc

## Tổng quan

```
┌──────────────────────┐        ┌────────────┐        ┌──────────────────────────── Mac ───────────────────────────┐
│ Trình duyệt          │ HTTPS  │ Cloudflare │ tunnel │ cloudflared ─▶ Server Node.js (127.0.0.1:8765)             │
│ (điện thoại/tablet)  │◀──────▶│   Edge     │◀──────▶│                 │  HTTP: trang web, đăng nhập, clipboard   │
│  web/ (HTML/CSS/JS)  │  WSS   │            │        │                 │  WebSocket /ws: khung hình + điều khiển  │
└──────────────────────┘        └────────────┘        │                 ▼ stdin/stdout                             │
                                                      │            Helper Swift (deskbridge-helper)                │
                                                      │             ├─ ScreenCaptureKit → JPEG                     │
                                                      │             ├─ CGEvent → chuột, bàn phím                   │
                                                      │             └─ NSPasteboard → clipboard                    │
                                                      └────────────────────────────────────────────────────────────┘
```

| Thành phần | Thư mục | Vai trò |
|---|---|---|
| Web client | `web/` | Hiển thị màn hình, chuyển cử chỉ/phím thành lệnh, giao diện clipboard và cài đặt |
| Server | `server/src/` | Đăng nhập, phục vụ trang web, WebSocket, chuyển lệnh giữa trình duyệt và helper |
| Helper | `helper-macos/` | Mọi thao tác với macOS: chụp màn hình, giả lập input, clipboard, kiểm tra quyền |
| Scripts | `scripts/` | Cài đặt, bật/tắt server + tunnel + chống ngủ |

Tách helper riêng giúp:

- Dùng API gốc của macOS (nhanh, ổn định, hỗ trợ Unicode) thay vì thư viện Node.js bên thứ ba.
- Server không phụ thuộc hệ điều hành. Sau này muốn hỗ trợ Windows/Linux chỉ cần viết helper mới theo cùng giao thức.
- Helper bị lỗi thì server tự khởi động lại helper, không làm rớt kết nối.

## Server (`server/src/`)

| File | Nội dung |
|---|---|
| `main.ts` | Khởi tạo, HTTP server, xác thực khi nâng cấp WebSocket, tắt an toàn |
| `config.ts` | Đọc và kiểm tra `.env` |
| `auth.ts` | Mật khẩu, phiên đăng nhập, chống dò mật khẩu, cookie, kiểm tra Origin |
| `http.ts` | Các route HTTP và header bảo mật |
| `session.ts` | Quản lý kết nối điều khiển duy nhất, kiểm tra và chuyển tiếp lệnh |
| `helper.ts` | Chạy helper, đóng/mở gói tin, request/response, tự khởi động lại |
| `notify.ts` | Thông báo macOS |

Server chạy TypeScript trực tiếp bằng Node.js ≥ 22.18 (type stripping), không có bước build. Chỉ dùng một thư viện ngoài là `ws`.

### HTTP API

| Method | Đường dẫn | Cần đăng nhập | Mô tả |
|---|---|---|---|
| GET | `/` | Có (chuyển về `/login` nếu chưa) | Trang điều khiển |
| GET | `/login` | Không | Trang đăng nhập |
| GET | `/static/*` | Không | File tĩnh trong `web/` |
| GET | `/api/health` | Không | Kiểm tra server còn sống |
| POST | `/api/login` | Không | `{ password }` → đặt cookie phiên |
| POST | `/api/logout` | Không | Hủy phiên hiện tại |
| GET | `/api/session` | Có | Kiểm tra phiên còn hiệu lực |
| GET | `/api/displays` | Có | Danh sách màn hình |
| GET | `/api/clipboard` | Có | `{ text, image }`, trong đó `image` là PNG dạng base64 |
| POST | `/api/clipboard/text` | Có | `{ text }` → clipboard Mac |
| POST | `/api/clipboard/image` | Có | Body là ảnh (`Content-Type: image/*`, tối đa 30 MB) → clipboard Mac |

Mọi request POST và WebSocket đều phải có header `Origin` trùng với `Host`.

## Giao thức WebSocket (`/ws`)

Trình duyệt ↔ server dùng một kết nối WebSocket:

- **Server → trình duyệt, binary:** mỗi message là một ảnh JPEG hoàn chỉnh.
- **Hai chiều, text:** JSON có trường `t` là loại message.

### Trình duyệt → server

| `t` | Trường | Ý nghĩa |
|---|---|---|
| `stream` | `fps`, `quality` (0.1–1), `maxWidth` (px, 0 = gốc), `displayId` | Bắt đầu/đổi cấu hình stream |
| `ack` | | Đã vẽ xong 1 khung hình (xem *Kiểm soát luồng*) |
| `refresh` | | Gửi lại khung hình hiện tại |
| `mouse` | `action`: `move`/`down`/`up`/`scroll`; `x`, `y` (0–1); `button`: `left`/`right`/`middle`; `dx`, `dy` (px) | Chuột |
| `key` | `code` (giá trị `KeyboardEvent.code`), `down`, `repeat` | Phím theo vị trí vật lý |
| `text` | `text` | Gõ văn bản Unicode |
| `releaseAll` | | Nhả mọi phím và nút chuột |
| `ping` | `ts` | Đo độ trễ |

Tọa độ chuột được chuẩn hóa về khoảng 0–1 theo màn hình đang stream, nên không phụ thuộc độ phân giải hay mức phóng to. Với cuộn, `dy > 0` nghĩa là nội dung di chuyển xuống (giống vuốt ngón tay xuống).

### Server → trình duyệt

| `t` | Trường | Ý nghĩa |
|---|---|---|
| `welcome` | `defaults` | Cấu hình stream mặc định từ `.env` |
| `streamInfo` | `displayId`, `width`, `height`, `fps` | Stream đã bắt đầu |
| `streamError` | `message` | Lỗi chụp màn hình (thường do thiếu quyền) |
| `pong` | `ts` | Trả lời `ping` |
| `replaced` | | Thiết bị khác đã chiếm phiên (đóng với mã `4001`) |
| `sessionExpired` | | Phiên hết hạn hoặc đã đăng xuất (đóng với mã `4003`) |

### Kiểm soát luồng (flow control)

DeskBridge không đẩy khung hình liên tục mà dùng cơ chế "tín dụng" (credit):

1. Khi có kết nối mới, server cấp cho helper **2 credit**.
2. Helper chỉ mã hóa và gửi khung hình khi còn credit. Mỗi khung hình tiêu 1 credit.
3. Trình duyệt vẽ xong một khung hình thì gửi `ack`, server cộng thêm 1 credit cho helper.
4. Helper luôn giữ khung hình **mới nhất**. Màn hình không đổi thì không gửi gì.

Kết quả: mạng nhanh thì đạt đủ fps; mạng chậm thì fps tự giảm nhưng hình luôn mới nhất, không bị dồn trễ. Màn hình đứng yên gần như không tốn băng thông và CPU.

## Giao thức server ↔ helper

- **stdin (server → helper):** mỗi dòng là một lệnh JSON, có `type` và tùy chọn `id` (để nhận phản hồi).
- **stdout (helper → server):** gói tin có độ dài: `1 byte loại` + `4 byte độ dài (big-endian)` + `dữ liệu`.
  - Loại `1`: JSON (`ready`, `streamInfo`, `streamError`, `reply`).
  - Loại `2`: khung hình JPEG.
- **stderr:** log, được server ghi vào `server.log`.

| Lệnh (`type`) | Trường | Phản hồi |
|---|---|---|
| `start` | `displayId`, `fps`, `quality`, `maxWidth` | Sự kiện `streamInfo` |
| `stop` | | |
| `credit` / `resetCredits` | `n` | |
| `refresh` | | |
| `mouse` | `action`, `x`, `y`, `button`, `dx`, `dy`, `displayId` | |
| `key` | `code`, `down`, `repeat` | |
| `text` | `text` | |
| `releaseAll` | | |
| `clipboardGet` | `id` | `{ text?, image? }` |
| `clipboardSetText` | `id`, `text` | `{}` |
| `clipboardSetImage` | `id`, `data` (base64) | `{}` |
| `displays` | `id` | `{ displays: [...] }` |
| `permissions` | `id` | `{ screenRecording, accessibility }` |

Helper cũng có các lệnh chạy một lần, dùng trong scripts:

```bash
helper-macos/.build/release/deskbridge-helper permissions          # In trạng thái quyền
helper-macos/.build/release/deskbridge-helper request-permissions  # Hiện hộp thoại xin quyền
helper-macos/.build/release/deskbridge-helper displays             # In danh sách màn hình
```

## Helper (`helper-macos/`)

| File | Nội dung |
|---|---|
| `main.swift` | Đọc lệnh, điều phối, các lệnh chạy một lần |
| `ScreenCapture.swift` | ScreenCaptureKit, scale khung hình, mã hóa JPEG (Core Image), credit |
| `Input.swift` | Giả lập chuột/phím bằng CGEvent, theo dõi phím đang giữ, nhận diện double-click |
| `KeyMap.swift` | Bảng chuyển `KeyboardEvent.code` → mã phím macOS |
| `Clipboard.swift` | Đọc/ghi text và ảnh với NSPasteboard |
| `Permissions.swift` | Kiểm tra/xin quyền Screen Recording và Accessibility |
| `Output.swift` | Ghi gói tin ra stdout |

## Web client (`web/`)

HTML/CSS/JavaScript thuần (ES modules), không framework, không bước build.

| File | Nội dung |
|---|---|
| `js/main.js` | Khởi tạo, thanh công cụ, panel cài đặt, số liệu |
| `js/connection.js` | WebSocket, tự kết nối lại |
| `js/viewer.js` | Giải mã và vẽ JPEG lên canvas, thu phóng/kéo khung nhìn, đổi tọa độ |
| `js/pointer.js` | Cử chỉ cảm ứng (Touch/Trackpad), chuột, cuộn |
| `js/keyboard.js` | Bàn phím rời, bàn phím ảo, IME, phím chốt |
| `js/keymap.js` | Chuẩn hóa mã phím |
| `js/clipboard.js` | ⌘V/⌘C tự động, panel clipboard |
| `js/settings.js` | Cài đặt lưu trong localStorage |
| `js/ui.js` | Toast, overlay trạng thái, panel |

## Scripts

| Script | Việc làm |
|---|---|
| `setup.sh` | Kiểm tra công cụ, `npm install`, build helper, tạo `.env`, xin quyền, tạo tunnel + DNS |
| `start.sh` | Kiểm tra quyền và port, chạy server (nền), chờ server sẵn sàng, bật `caffeinate`, chạy `cloudflared` với file cấu hình riêng, in URL |
| `stop.sh` | Tắt tunnel → server → caffeinate, dọn tiến trình sót lại |
| `status.sh` | Trạng thái và URL |

Trạng thái lưu trong `~/.deskbridge/` (có thể đổi bằng biến `DESKBRIDGE_STATE_DIR`).
