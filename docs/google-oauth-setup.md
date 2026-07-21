---
title: "Google OAuth setup cho DongChannel Ops Hub"
purpose: "Hướng dẫn tạo Google Cloud OAuth 2.0 Client ID để login vào dashboard mới"
last_updated: "2026-07-21"
---

Auth.js cần **Client ID** + **Client Secret** từ Google Cloud để hiển thị nút "Đăng nhập với Google" và verify token trả về.

## Chuẩn bị

- Tài khoản Google (dùng luôn `mdinh.dong86@gmail.com` cho tiện, vì đây cũng là email allowlist V1).
- Truy cập [Google Cloud Console](https://console.cloud.google.com).

## Các bước

### Bước 1 — Tạo project (bỏ qua nếu đã có)

1. Vào https://console.cloud.google.com/projectselector2/home/dashboard
2. Click **New Project** góc trên phải.
3. Name: `dongchannel-ops-hub` (hoặc tên bạn muốn).
4. Location: **No organization** (trừ khi bạn có Google Workspace).
5. Click **Create**, đợi ~30s.
6. Đảm bảo project mới được chọn ở dropdown trên cùng.

### Bước 2 — Cấu hình OAuth consent screen

1. Menu bên trái → **APIs & Services** → **OAuth consent screen**.
2. User type: chọn **External** (Internal cần Workspace org).
3. Click **Create**.
4. Điền:
   - App name: `DongChannel Ops Hub`
   - User support email: chọn email của bạn
   - Developer contact information: email của bạn
5. Click **Save and Continue**.
6. **Scopes** step: click **Add or Remove Scopes**, chọn `.../auth/userinfo.email` và `.../auth/userinfo.profile` và `openid`. Save.
7. **Test users** step: click **Add Users**, thêm `mdinh.dong86@gmail.com` (và bất kỳ email khác trong allowlist). Save.
8. **Summary** → **Back to Dashboard**.

> App ở trạng thái "Testing" — chỉ test users login được. Đó là ĐÚNG cho V1 (dashboard nội bộ). Nếu sau này muốn public → "Publish App" (cần Google verification).

### Bước 3 — Tạo OAuth Client ID

1. Menu bên trái → **APIs & Services** → **Credentials**.
2. Click **+ Create Credentials** → **OAuth client ID**.
3. Application type: **Web application**.
4. Name: `Ops Hub — Local Dev` (bạn có thể tạo Client ID riêng cho prod sau).
5. **Authorized JavaScript origins**:
   - `http://localhost:3000`
6. **Authorized redirect URIs** (chính xác từng ký tự — Google check strict):
   - `http://localhost:3000/api/auth/callback/google`
   - (Sau khi deploy prod: thêm `https://app.dongchannel.com/api/auth/callback/google`)
7. Click **Create**.
8. Modal hiện **Client ID** và **Client Secret**. **Copy cả 2**, dán lại vào chat cho tôi.

### Bước 4 — Đưa vào `.env.local`

Bạn KHÔNG cần tự làm bước này — dán 2 giá trị trong chat, tôi ghi vào `app/.env.local`:

```
GOOGLE_CLIENT_ID=<paste ở đây>
GOOGLE_CLIENT_SECRET=<paste ở đây>
```

## Sau khi có credentials

Tôi sẽ:

1. Ghi 2 giá trị vào `app/.env.local`
2. Chạy `pnpm dev`
3. Bạn mở http://localhost:3000/login → click Google → login bằng `mdinh.dong86@gmail.com`
4. Verify session tạo được + audit event ghi vào Postgres
5. Test logout

## Troubleshooting

- **Error 400: redirect_uri_mismatch** → callback URL trong chat khác với URL đã whitelist. Check exact match.
- **App chưa được verify** → OK cho testing, sẽ có warning screen "Google hasn't verified this app" nhưng vẫn login được.
- **Access blocked** → email login không có trong Test users list. Vào OAuth consent screen → Test users → add.

## Bảo mật

- **Client Secret** là secret cấp app-level. Đừng share qua public channel.
- Nếu lộ, quay lại Credentials → click client name → **Reset Secret**.
- Restrict OAuth client sang production origin sau khi launch (không giữ localhost trong prod client).
- Consider tạo Client ID riêng cho prod (redirect chỉ `https://app.dongchannel.com/...`).
