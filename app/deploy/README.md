# Deploy — DongChannel Ops Hub

> **DRAFT playbook** — chưa apply lên VPS. Chờ chủ sản phẩm duyệt Discovery Gate ([docs/dashboard-discovery.md](../../docs/dashboard-discovery.md) mục 6 & blocker checklist).

## VPS thật (đã verify SSH 2026-07-21)

- **Host:** `vocapro` = `180.93.1.148` root, Ubuntu 24.04, 4 vCPU / 3.9GB RAM / 42GB disk
- **Reverse proxy:** Nginx quản bởi **CloudPanel 6.0.8** (`clpctl` CLI)
- **PostgreSQL 16:** ✅ đã cài trên host (`postgresql@16-main`)
- **Hermes:** container `hermes`, `network_mode: host`, bind `127.0.0.1:9119`, basic auth
- **Domain hiện tại:** `app.dongchannel.com` → Hermes (sẽ chuyển)

## Kiến trúc deploy khuyến nghị

```
Internet
   │
   ▼
CloudPanel Nginx (host, port 80/443, Let's Encrypt)
   │
   ├─── app.dongchannel.com     → 127.0.0.1:3000 (Next.js standalone, systemd)
   └─── hermes.dongchannel.com  → 127.0.0.1:9119 (Hermes container, đã có)

Postgres 16 (host, 127.0.0.1:5432, DB: dongchannel_ops)
Hermes REST + basic auth ← Next.js gọi qua 127.0.0.1:9119
```

**KHÔNG container hoá Next.js** — chạy trực tiếp qua CloudPanel Node.js site (systemd) để:
- Không tốn RAM overhead của Docker
- Không cần expose port qua Docker network
- Reach Hermes và Postgres trực tiếp qua 127.0.0.1

## Playbook production (chờ duyệt)

### Bước 1 — DNS & subdomain mới cho Hermes

```bash
# 1a. Trỏ DNS: A record hermes.dongchannel.com → 180.93.1.148
# 1b. Đợi DNS propagate (kiểm tra: dig +short hermes.dongchannel.com)
```

### Bước 2 — CloudPanel site cho Hermes ở subdomain mới

```bash
ssh vocapro '
  clpctl site:add:reverse-proxy \
    --domainName=hermes.dongchannel.com \
    --reverseProxyUrl=http://127.0.0.1:9119 \
    --siteUser=hermessite \
    --siteUserPassword="$(cat /root/hermes-notes/site-credentials.txt | grep password | awk "{print \$2}")"

  clpctl lets-encrypt:install:certificate --domainName=hermes.dongchannel.com
'
```

### Bước 3 — Update Hermes public URL

Sửa `/opt/hermes-stack/docker-compose.yml`:

```yaml
- HERMES_DASHBOARD_PUBLIC_URL=https://hermes.dongchannel.com
```

Restart Hermes (downtime ~30s, không ảnh hưởng bot Telegram):

```bash
cd /opt/hermes-stack && docker compose up -d --force-recreate
docker exec hermes hermes -p aff gateway start
docker exec hermes hermes -p yt gateway start
```

Verify: `curl -I https://hermes.dongchannel.com` → 200/302.

### Bước 4 — Xoá site cũ app.dongchannel.com (đang trỏ Hermes)

```bash
clpctl site:delete --domainName=app.dongchannel.com
```

### Bước 5 — Tạo Node.js site cho dashboard mới

```bash
ssh vocapro '
  clpctl site:add:nodejs \
    --domainName=app.dongchannel.com \
    --nodejsVersion=22 \
    --appPort=3000 \
    --siteUser=opssite \
    --siteUserPassword="$(openssl rand -base64 24)"

  clpctl lets-encrypt:install:certificate --domainName=app.dongchannel.com
'
```

CloudPanel sẽ tự tạo `/home/opssite/htdocs/app.dongchannel.com/` và systemd unit chạy `npm start` trên port 3000.

### Bước 6 — Tạo Postgres DB

```bash
ssh vocapro '
  clpctl db:add \
    --domainName=app.dongchannel.com \
    --databaseName=dongchannel_ops \
    --databaseUserName=opsdash \
    --databaseUserPassword="$(openssl rand -base64 24)"

  # Ghi lại password → dán vào .env DATABASE_URL sau
  clpctl db:show:master-credentials
'
```

### Bước 7 — Deploy code

```bash
# Local build (Windows dev)
cd D:/Project/app-agent/app
pnpm install --frozen-lockfile
pnpm build

# Upload standalone bundle
scp -r .next/standalone/* .next/static public vocapro:/home/opssite/htdocs/app.dongchannel.com/

# Trên VPS: setup .env production
ssh vocapro '
  cd /home/opssite/htdocs/app.dongchannel.com
  cp .env.example .env  # rồi vim .env điền:
  #   NEXTAUTH_SECRET=$(openssl rand -base64 32)
  #   NEXTAUTH_URL=https://app.dongchannel.com
  #   GOOGLE_CLIENT_ID=...
  #   GOOGLE_CLIENT_SECRET=...
  #   AUTH_EMAIL_ALLOWLIST=your@email.com
  #   DATABASE_URL=postgres://opsdash:<pw>@127.0.0.1:5432/dongchannel_ops
  #   HERMES_API_BASE_URL=http://127.0.0.1:9119
  #   HERMES_BASIC_USER=admin
  #   HERMES_BASIC_PASSWORD=<from /root/hermes-notes/dashboard-credentials.txt>
  chmod 600 .env

  # Chạy migration
  npx drizzle-kit migrate

  # Restart node app qua CloudPanel
  systemctl restart opssite-nodejs-app.service
'
```

### Bước 8 — Google OAuth callback

Trong Google Cloud console → OAuth Client → Authorized redirect URIs, thêm:

```
https://app.dongchannel.com/api/auth/callback/google
```

## Rollback

- **Rollback app**: `systemctl stop opssite-nodejs-app.service` — CloudPanel Nginx sẽ 502; user không lên được. Bước sau chuyển DNS `app` → về Hermes tạm thời, hoặc rerun bước 3 với `HERMES_DASHBOARD_PUBLIC_URL=https://app.dongchannel.com`.
- **Rollback Hermes URL**: sửa compose ngược lại + `--force-recreate`.
- **Feature flag**: `NEXT_PUBLIC_FEATURE_NEW_OPS_DASHBOARD=false` để hide UI mới nhưng giữ auth.

## Dev local (Windows)

```bash
# Postgres local qua Docker
docker run -d --name pg-dev -e POSTGRES_PASSWORD=ops -e POSTGRES_USER=ops -e POSTGRES_DB=dongchannel_ops -p 5432:5432 postgres:16-alpine

# SSH tunnel để reach Hermes trên VPS
ssh -N -L 9119:127.0.0.1:9119 vocapro &

cd app
pnpm install
cp .env.example .env.local  # điền
pnpm db:migrate
pnpm dev
# → http://localhost:3000
```

## Cảnh báo

- **RAM VPS 3.9GB tight** — thêm Next.js sẽ đẩy tổng usage lên ~2.5GB. Nếu bật n8n lại → nguy cơ OOM. Chủ sản phẩm dự định nâng 8GB trước launch.
- **Postgres shared** — cluster đang có DB `vocapro`, `pronunciation_coach`. `opsdash` user phải KHÔNG được cấp superuser hoặc access DB khác.
- **Basic auth cho Hermes** — nếu rotate password, phải update Next.js `.env` cùng lúc để tránh downtime ingestion.
