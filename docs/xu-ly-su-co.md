# Xử lý sự cố

Trước tiên hãy xem log:

```bash
scripts/status.sh
tail -n 50 ~/.deskbridge/logs/server.log
tail -n 50 ~/.deskbridge/logs/cloudflared.log
```

## Không khởi động được

| Thông báo | Cách xử lý |
|---|---|
| `The helper is not built yet` | Chạy `scripts/setup.sh --skip-tunnel`. |
| `DESKBRIDGE_PASSWORD … at least 12 characters` | Đặt mật khẩu đủ dài trong `.env`. |
| `Port 8765 is already in use` | Một chương trình khác đang dùng port. Đổi `DESKBRIDGE_PORT` trong `.env`, hoặc kiểm tra bằng `lsof -i :8765`. |
| `macOS permissions are missing` | Xem mục *Quyền macOS* bên dưới. |
| `Tunnel "deskbridge" not found` | Chạy `scripts/setup.sh` để tạo tunnel. |
| `Set DESKBRIDGE_TUNNEL_HOSTNAME` | Đặt hostname trong `.env`, hoặc dùng `DESKBRIDGE_TUNNEL_MODE=quick`. |
| `Node.js … is too old` | Cập nhật Node.js: `brew upgrade node`. |

## Quyền macOS

**Màn hình đen, hoặc báo "Screen capture failed"**: thiếu quyền ghi màn hình.

**Thấy màn hình nhưng chuột/phím không có tác dụng**: thiếu quyền Accessibility.

Cách xử lý:

1. Mở **System Settings → Privacy & Security → Screen & System Audio Recording** và **Accessibility**.
2. Bật công tắc cho **ứng dụng terminal** dùng để chạy `start.sh` (Terminal, iTerm, Warp…).
3. Nếu đã bật mà vẫn lỗi: tắt công tắc, bấm `−` để xóa ứng dụng khỏi danh sách, thêm lại, rồi mở lại ứng dụng terminal.
4. Chạy `scripts/stop.sh && scripts/start.sh`.

**Báo "capture stopped: … application connection being interrupted"**: macOS đang chặn riêng file helper. Điều này có thể xảy ra khi `setup.sh` hỏi quyền lúc chạy từ một terminal chưa được cấp quyền (ví dụ terminal tích hợp của VS Code). Mở **Screen & System Audio Recording**, tìm mục `deskbridge-helper`: bật công tắc, hoặc xóa mục đó (`−`) rồi chạy lại `scripts/start.sh` từ terminal đã được cấp quyền.

Kiểm tra nhanh trạng thái quyền:

```bash
helper-macos/.build/release/deskbridge-helper permissions
```

> Các bản macOS mới định kỳ hỏi lại có tiếp tục cho phép ghi màn hình hay không. Nếu stream đột ngột đen, hãy kiểm tra hộp thoại trên máy Mac.

## Không truy cập được từ xa

| Hiện tượng | Cách xử lý |
|---|---|
| Lỗi 1033 / 530 của Cloudflare | Tunnel chưa kết nối, **hoặc bản ghi DNS trỏ sang tunnel khác**. Chạy `scripts/status.sh`: nếu tunnel đang chạy mà vẫn lỗi 1033, chạy `scripts/setup.sh --overwrite-dns` để trỏ lại hostname về tunnel DeskBridge. Nếu tunnel không chạy, xem `cloudflared.log` và chạy lại `scripts/start.sh`. |
| Lỗi 404 của Cloudflare | Bản ghi DNS chưa trỏ đúng tunnel. Chạy lại `scripts/setup.sh`, hoặc kiểm tra tab DNS trên Cloudflare (bản ghi CNAME trỏ tới `<tunnel-id>.cfargotunnel.com`). |
| Lỗi 502 | Tunnel chạy nhưng server đã tắt. Chạy `scripts/stop.sh && scripts/start.sh`. |
| Quick tunnel không in ra URL | Kiểm tra mạng, xem `cloudflared.log`. |

## Đăng nhập

| Hiện tượng | Cách xử lý |
|---|---|
| `Wrong password` | Kiểm tra `DESKBRIDGE_PASSWORD` trong `.env` trên Mac. Nếu mật khẩu chứa ký tự đặc biệt, bọc trong dấu nháy đơn. |
| `Too many attempts` | Chờ hết thời gian khóa (15–30 phút), hoặc khởi động lại DeskBridge trên Mac. |
| Bị đăng xuất liên tục | Phiên hết hạn do không dùng (`DESKBRIDGE_SESSION_IDLE_MINUTES`) hoặc server đã khởi động lại. |
| "Another device took over this session" | Có thiết bị khác vừa kết nối. Tải lại trang để lấy lại quyền điều khiển. |

## Hình ảnh và độ trễ

| Hiện tượng | Cách xử lý |
|---|---|
| Hình giật, chậm | **⚙ → Quality: Low**, giảm Frame rate. Xem băng thông và độ trễ ở mục Status. |
| Chữ mờ | Chọn Quality `High`/`Max`, hoặc chụm 2 ngón để phóng to vùng cần xem. |
| Màn hình Mac có nhiều màn hình | Chọn màn hình trong **⚙ → Display**. |

## Bàn phím và clipboard

| Hiện tượng | Cách xử lý |
|---|---|
| Mac như đang giữ ⌘/⇧ | **⚙ → Release stuck keys**. |
| Gõ tiếng Việt bị sai dấu | Chỉ bật bộ gõ tiếng Việt ở **một phía** (xem [Hướng dẫn sử dụng](su-dung.md#gõ-tiếng-việt)). |
| Phím tắt ⌘Tab, ⌘H… không gửi được | Tablet giữ lại các phím này; dùng thanh **⌘ Keys**. |
| ⌘V không dán ảnh | Cho phép trình duyệt truy cập clipboard khi được hỏi; hoặc dùng **Clip → Choose image…**. |
| ⌘C không chép về tablet | Trình duyệt chặn ghi clipboard; dùng **Clip → Get Mac clipboard → Copy to this device**. |

## Dọn dẹp hoàn toàn

```bash
scripts/stop.sh
cloudflared tunnel delete deskbridge          # Xóa tunnel (xóa thêm bản ghi DNS trên Cloudflare nếu muốn)
rm -rf ~/.deskbridge
```
