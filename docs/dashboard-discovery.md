---
title: "Discovery Gate — Hermes VPS environment"
purpose: "Bắt buộc hoàn tất trước khi build dashboard mới (TDD mục 16.2, nguyên tắc kiến trúc #9)"
status: "PASSED ✅ — sẵn sàng bắt đầu DC-001"
last_updated: "2026-07-21 SSH verify + product owner decisions"
vps_ssh_alias: "vocapro"
---

## Chốt quyết định của chủ sản phẩm (2026-07-21)

- **Domain:** Option 1 — 3 subdomain (`app` = dashboard mới, `hermes` = Hermes cũ, `n8n` giữ nguyên)
- **Hermes API auth:** Option A — dashboard mới dùng chung basic_auth `admin` với human login
- **RAM:** 3.9GB đủ cho V1 — Next.js set `mem_limit=512m`, giữ n8n stopped, monitor OOM
- **Secret leak:** 3 secret trong `hermes-or-openclaw/config.txt` đã rotate — file stale, chỉ cần gitignore
- **Google OAuth:** chủ sản phẩm tự tạo, sẽ cung cấp `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` khi cần
- **Email allowlist ban đầu:** `mdinh.dong86@gmail.com` (single user; mở rộng qua bảng `email_allowlist` sau)
- **Production changes:** chạy sau khi build xong code, ở DC-017 (deploy). Không đụng VPS trước đó.
- **Backup `state.db` cron:** chủ sản phẩm tự setup khi phù hợp (không thuộc scope V1 dashboard mới)

> **Quy tắc:** Không tạo migration Postgres production, không sửa Hermes config cho đến khi Discovery Gate được duyệt (nguyên tắc kiến trúc #10).

## 0. Nguồn thông tin

- SSH `vocapro` = `180.93.1.148` root (verified 2026-07-21)
- `hermes-or-openclaw/` — local snapshot (KHÔNG phải file thật trên VPS)
- ⚠️ `hermes-or-openclaw/config.txt` chứa **secret cũ đã bị lộ** (OpenRouter key + 2 bot token của lần cài trước) — cần rotate.

---

## 1. Cách Hermes hiện được chạy trên VPS

| Hạng mục | Giá trị thực tế |
|---|---|
| VPS | `vocapro` = `180.93.1.148`, Ubuntu 24.04 (kernel 6.8), 4 vCPU, 3.9GB RAM, 42GB disk (25GB used) |
| Docker | 29.3.0 |
| Compose file | `/opt/hermes-stack/docker-compose.yml` (1 service `hermes`) |
| Container image | `nousresearch/hermes-agent:latest` (Hermes v0.18.2, build 2026.7.7.2) |
| Container name | `hermes` (+ helper `hermes-bca94ce9` — plugin/skill runtime) |
| Command | `gateway run` |
| Restart policy | `unless-stopped` |
| Data mount | `/opt/hermes-data:/opt/data` (bind mount) |
| Docker socket | `/var/run/docker.sock` mount |
| shm_size | 1gb (Playwright/Chromium) |
| Resource limits | `mem_limit: 3g`, `cpus: 2.0` |
| **Network mode** | `host` (bind trực tiếp interface host, không NAT) |
| env_file | `/opt/hermes-data/.env` |

**Hàm ý cho dashboard mới:**
- Hermes bind `127.0.0.1:9119` (via `HERMES_DASHBOARD_HOST=0.0.0.0` nhưng UFW chặn ngoài). Next.js container muốn reach → dùng `network_mode: host` HOẶC `extra_hosts: host.docker.internal:host-gateway`.
- Docker socket mount trong Hermes cho phép Hermes spawn container con (`hermes-bca94ce9`). Không ảnh hưởng dashboard mới.

---

## 2. Ports và endpoints

| Endpoint | Kết quả (không auth) | Ghi chú |
|---|---|---|
| `http://127.0.0.1:9119/` | 302 (redirect) | Trang login/dashboard |
| `/api` | 302 | Cần trailing slash hoặc login |
| **`/api/status`** | **200 (public)** | Health check public, không cần auth |
| `/api/health` | 401 | Cần basic auth |
| `/api/openapi.json` | 401 | OpenAPI schema — cần auth để đọc |
| `/api/sessions` | 401 | Endpoint chính cho session list |
| `/api/agents` | 401 | |
| `/api/gateway/status` | 401 | |
| `/openapi.json` | 302 | Redirect (chưa xác định về đâu) |

**Cổng mở (UFW):** 22, 80, 443, 443/udp, 3030, 5432, 8433-8443.

**Public URL cũ:** `https://app.dongchannel.com` — đang trỏ Hermes qua CloudPanel Nginx `→ 127.0.0.1:9119`.
**Public URL mới (target):** `https://app.dongchannel.com` — **CONFLICT**, xem mục 6.

**Hermes có thêm giao thức khác:** `hermes serve --help` mô tả *"JSON-RPC/WebSocket gateway the desktop app and remote clients connect to"*. Nghĩa là Hermes có 2 giao thức song song:
- HTTP REST `/api/*` (basic auth) — dashboard UI dùng.
- JSON-RPC/WebSocket — desktop app + remote client.

**Quyết định:** Dashboard mới dùng **HTTP REST** (đơn giản, đủ cho V1). Không phải JSON-RPC.

---

## 3. Authentication Hermes hiện tại

| Hạng mục | Giá trị thực tế |
|---|---|
| Cơ chế | **Basic auth interim** (chưa có Nous Portal OAuth) |
| Username | `admin` |
| Password + secret | `/root/hermes-notes/dashboard-credentials.txt` (chmod 600) |
| Config location | `/opt/hermes-data/config.yaml` khối `dashboard.basic_auth` |
| Env vars | KHÔNG dùng — Hermes chạy s6 supervision, env không tới service (xem [feedback memory](../../../.claude/projects/D--Project-aff-research-hermes-or-openclaw/memory/feedback_docker_compose_env.md)) |
| Nous Portal OAuth | Chưa cài (`hermes dashboard register` command có sẵn để activate) |

**Auth cho bên thứ ba (dashboard mới):**

Hermes CLI KHÔNG có "service account API key" hay pairing riêng cho dịch vụ. Options:

- **Option A (V1 recommended):** Dashboard mới gọi `/api/*` bằng **basic auth `admin` + password** (đọc từ `/root/hermes-notes/dashboard-credentials.txt`, lưu Next.js env `HERMES_BASIC_USER` / `HERMES_BASIC_PASSWORD`). Đơn giản, không cần đổi Hermes.
- **Option B (V1.1):** Set up Nous Portal OAuth (`hermes dashboard register --redirect-uri https://app.dongchannel.com/auth/callback`); dashboard mới cấp OAuth token qua Nous Portal cho service account.
- **Option C:** Tách một Hermes basic_auth user riêng — hiện `config.yaml.basic_auth` chỉ hỗ trợ 1 user. Không khả thi mà không patch Hermes.

**Chọn A cho V1.** Rủi ro: cùng credential dùng cho human login + service → nếu rotate phải update cả 2 chỗ. Chấp nhận trong V1.

---

## 4. Hai profile AFF và YouTube

| Hạng mục | Giá trị thực tế |
|---|---|
| Profile slug | `aff`, `yt` (KHÔNG phải `youtube` như tôi giả định ban đầu) |
| Bot AFF | `@hermes_dongmd_bot` (token trong `/opt/hermes-data/profiles/aff/.env`, chmod 600) |
| Bot YouTube | `@my_hermes_agent_ytb_bot` (token trong `/opt/hermes-data/profiles/yt/.env`) |
| Owner Telegram user ID | `727833485` (`TELEGRAM_ALLOWED_USERS`) |
| Gateway status | ✓ aff, ✓ yt, ✗ default (stopped) |
| Kanban boards | 3 (`default`, `aff-global` 💰, `youtube` 📹) |
| Model chính | `deepseek/deepseek-v4-pro` + fallback `deepseek-v4-flash` |

**⚠️ Điều chỉnh:** TDD ban đầu ghi profile slug là `youtube`, thực tế là `yt`. Đã cập nhật `docs/TDD.md` (mục 32) và scaffold (`profiles` table seed).

---

## 5. Vị trí `state.db` (SQLite)

| Path trong container | Path trên host | Chức năng |
|---|---|---|
| `/opt/data/state.db` | `/opt/hermes-data/state.db` | Session store MACHINE-LEVEL |
| `/opt/data/profiles/aff/state.db` | `/opt/hermes-data/profiles/aff/state.db` | Session store profile `aff` |
| `/opt/data/profiles/yt/state.db` | `/opt/hermes-data/profiles/yt/state.db` | Session store profile `yt` |
| `/opt/data/kanban.db` | `/opt/hermes-data/kanban.db` | Kanban tasks |
| `/opt/data/cron/executions.db` | `/opt/hermes-data/cron/executions.db` | Cron history |
| `/opt/data/projects.db` | `/opt/hermes-data/projects.db` | Projects |

**⚠️ QUY TẮC BẤT DI (nguyên tắc kiến trúc #2):** Dashboard mới **TUYỆT ĐỐI KHÔNG** mount hay đọc `state.db` file. Chỉ đọc qua Hermes HTTP REST `/api/sessions` (basic auth). Nếu Hermes REST không cung cấp field cần thiết, mở issue với Hermes upstream, không bypass qua SQLite.

**Backup:** Có backup snapshot của lần install cũ (`/opt/hermes-data.bak-20260720-2308`), nhưng chưa có **cron backup định kỳ**. Cần thêm — không phải task của dashboard mới nhưng khuyến nghị chủ sản phẩm setup.

Hermes CLI có `hermes backup` command sẵn — dùng cron:

```bash
# /etc/cron.daily/hermes-backup
docker exec hermes hermes backup /opt/data/backups/$(date +%Y%m%d).zip
```

---

## 6. Docker + reverse proxy hiện tại (⚠️ DOMAIN CONFLICT)

**Reverse proxy:** **CloudPanel 6.0.8** quản Nginx trên host. **Không dùng Caddy** như local `hermes-or-openclaw/caddy/Caddyfile` — file đó là snapshot cũ. Sự thật trên VPS là Nginx qua CloudPanel.

**Nginx sites đang enabled:**
- `app.dongchannel.com.conf` → reverse-proxy `127.0.0.1:9119` (Hermes dashboard) — SSL Let's Encrypt sẵn
- `n8n.dongchannel.com.conf` → n8n (stopped)
- `dongchannel.top.conf`
- `default.conf`, `vocapro.conf`

**Nội dung `app.dongchannel.com.conf`** (rút gọn):
```nginx
server {
  listen 443 ssl quic;
  server_name app.dongchannel.com;
  ssl_certificate     /etc/nginx/ssl-certificates/app.dongchannel.com.crt;
  ssl_certificate_key /etc/nginx/ssl-certificates/app.dongchannel.com.key;
  location @reverse_proxy {
    proxy_pass http://127.0.0.1:9119;
    # ... proxy headers, SSE-friendly timeouts 900s
  }
  location / { try_files $uri @reverse_proxy; }
}
```

### ⚠️ QUYẾT ĐỊNH CẦN CHỦ SẢN PHẨM CHỐT

`app.dongchannel.com` **hiện đang là Hermes dashboard**. PRD nói dashboard mới cũng dùng domain này. Cần chọn:

**Option 1 (Recommended)** — 3 subdomain rõ ràng:
- `app.dongchannel.com` = **Dashboard mới** (Next.js, port 3000)
- `hermes.dongchannel.com` = **Hermes dashboard cũ** (được `/admin` link tới)
- `n8n.dongchannel.com` = n8n (giữ nguyên)

Việc cần làm (production changes, chờ chủ sản phẩm duyệt):
1. Add DNS A record `hermes.dongchannel.com` → `180.93.1.148`
2. `clpctl site:add:reverse-proxy --domainName=hermes.dongchannel.com --reverseProxyUrl=http://127.0.0.1:9119 --siteUser=hermessite --siteUserPassword=...`
3. `clpctl lets-encrypt:install:certificate --domainName=hermes.dongchannel.com`
4. Sửa `/opt/hermes-stack/docker-compose.yml`: `HERMES_DASHBOARD_PUBLIC_URL=https://hermes.dongchannel.com`
5. `cd /opt/hermes-stack && docker compose up -d --force-recreate` (downtime ~30s)
6. `clpctl site:delete --domainName=app.dongchannel.com` (Hermes site)
7. `clpctl site:add:nodejs --domainName=app.dongchannel.com --nodejsVersion=22 --appPort=3000 --siteUser=opssite --siteUserPassword=... ` (site mới cho Next.js)
8. `clpctl lets-encrypt:install:certificate --domainName=app.dongchannel.com`

**Option 2** — Giữ `app.dongchannel.com` cho Hermes, dashboard mới ở subdomain khác:
- Dashboard mới ở `ops.dongchannel.com` hoặc `dashboard.dongchannel.com`
- Hermes giữ nguyên
- Đơn giản hơn, KHÔNG đụng Hermes, nhưng **trái với PRD** (PRD ghi rõ target là `app.dongchannel.com`).

**Option 3** — Sub-path reverse proxy:
- `app.dongchannel.com/` = Next.js (root)
- `app.dongchannel.com/hermes/` = Hermes dashboard (nested)
- **KHÔNG khuyến nghị**: Hermes dashboard SPA có internal routing, sub-path proxying phá vỡ nhiều.

**Đề nghị: Option 1.** Bạn xác nhận A/B/C?

---

## 7. Database và source code hiện có

| Hạng mục | Giá trị thực tế |
|---|---|
| **PostgreSQL 16** | ✅ Đã cài trên host: `postgresql@16-main.service` running |
| Postgres listen | `listen_addresses = '*'` (tất cả interface) — ⚠️ security concern |
| Postgres port | 5432 (open UFW) — ⚠️ có thể exposed từ internet |
| Existing databases | `vocapro`, `vocapro_test`, `pronunciation_coach` |
| Existing roles | `vocapro`, `pronunciation_user` |
| Source Hermes | Không có repo fork — dùng image official `nousresearch/hermes-agent:latest` |
| Custom plugin | Không thấy plugin custom trong `plugins.enabled: []` |

**Postgres cho dashboard mới (KHÔNG chạm production DB khác):**

```bash
# Chờ chủ sản phẩm duyệt trước khi chạy
clpctl db:add --domainName=app.dongchannel.com --databaseName=dongchannel_ops --databaseUserName=opsdash --databaseUserPassword='<generated>'
```

**⚠️ Security khuyến nghị (không thuộc scope V1 nhưng nên fix):**

- Đổi `listen_addresses = 'localhost'` (nếu Postgres không cần reach từ container/host khác) HOẶC restrict `pg_hba.conf` chỉ cho phép IP nội bộ.
- UFW `ufw delete allow 5432` để đóng port từ internet.
- Dashboard mới nếu chạy Docker sẽ reach Postgres qua `host.docker.internal:5432` (bridge) hoặc `127.0.0.1:5432` (host mode).

---

## 8. Cách session/message/tool-call đang được lưu

Chưa `sqlite3 .schema` (cần vào container hoặc dừng Hermes để tránh lock). Ưu tiên **truy vấn qua HTTP REST** thay vì đọc trực tiếp SQLite:

Hermes CLI mở đường vào:
- `docker exec hermes hermes sessions list --format json` — liệt kê session per-profile (chưa test format thực tế)
- `docker exec hermes hermes sessions export --format jsonl` — export bulk
- `docker exec hermes hermes sessions stats` — statistics

Sau khi có basic auth password, tôi sẽ `curl -u admin:PASS http://127.0.0.1:9119/api/openapi.json` → có full API contract, viết `HermesAdapter` chính xác.

**Task DC-006 (Task projection):** dùng `HermesAdapter` gọi `/api/sessions` per profile, cursor pagination, upsert vào Postgres bảng `hermes_sessions` + `hermes_messages` + derive `tasks`.

---

## 9. Test framework, CI/CD, hosting và env vars

| Hạng mục | Giá trị thực tế / đề xuất |
|---|---|
| Hosting | VPS `vocapro` (VPS provider chưa biết — hỏi user nếu cần cho backup off-site) |
| CI/CD | Chưa có. Deploy hiện tại bằng tay (SSH + `docker compose up -d`) |
| Test framework | Chưa có. Đề xuất Vitest (unit) + Playwright (E2E) — sẽ scaffold ở DC-016 |
| Env vars Hermes | `/opt/hermes-data/.env` (chmod 600, root:root khi host xem, UID 10000 khi container) |
| Env vars mới cho Next.js | Sẽ đặt tại `/home/opssite/.env.production` hoặc systemd unit env |

**Env vars mới cần chuẩn bị** (chờ chủ sản phẩm cấp/tạo):

- `NEXTAUTH_SECRET` (auto-generate: `openssl rand -base64 32`)
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` — user tạo tại console.cloud.google.com, callback `https://app.dongchannel.com/api/auth/callback/google`
- `AUTH_EMAIL_ALLOWLIST` — email của user (và team nếu có)
- `DATABASE_URL` — sau khi `clpctl db:add`
- `HERMES_API_BASE_URL=http://127.0.0.1:9119` (network host mode) hoặc `http://host.docker.internal:9119` (bridge)
- `HERMES_BASIC_USER=admin` + `HERMES_BASIC_PASSWORD=<from /root/hermes-notes/dashboard-credentials.txt>`

---

## 10. Chức năng có nguy cơ regression

| Rủi ro | Mô tả | Giảm thiểu |
|---|---|---|
| Load thêm trên Hermes REST | Ingestion projector poll `/api/sessions` liên tục | Rate limit ở `HermesAdapter` (max 1 req/s per profile ban đầu); observe CPU Hermes |
| RAM tight (3.9GB) | Hermes ~1.9GB + Next.js standalone ~250MB + Postgres đã có → sát trần | Chờ chủ sản phẩm nâng RAM 8GB trước khi bật full projection loop; hoặc chạy Next.js `mem_limit=512m` |
| CloudPanel nginx overwrite | Nếu edit `/etc/nginx/sites-enabled/*.conf` thủ công, CloudPanel có thể ghi đè | Chỉ dùng `clpctl` (nginx conf sinh từ template `/etc/nginx/nginx-templates/`) |
| Domain switch downtime | Bước 4-6 Option 1 làm Hermes dashboard xuống ~30s | Chọn thời gian rảnh; báo trước; user Telegram bot không bị ảnh hưởng (bot chạy độc lập với dashboard UI) |
| Postgres shared với vocapro | 2 DB khác đang chạy trên cùng cluster | Tạo user riêng `opsdash`, quyền chỉ trên DB `dongchannel_ops`; không dùng superuser |
| Basic auth credential leak | Password Hermes trong Next.js env | Đảm bảo `.env` chmod 600; không commit; log redact |
| SQLite lock khi Hermes ghi | Nếu bao giờ đọc trực tiếp state.db | KHÔNG đọc trực tiếp — quy tắc #2 |
| N8N restart chiếm RAM | n8n hiện stopped để nhường Hermes | Khi user bật n8n lại + Next.js chạy → RAM sẽ chạm trần, có OOM risk |

---

## Blocker checklist — ALL RESOLVED ✅

- [x] Domain: Option 1 (3 subdomain)
- [x] Hermes auth: Option A (shared basic_auth)
- [x] Google OAuth + allowlist: chủ sản phẩm tự cấp; allowlist = `mdinh.dong86@gmail.com`
- [x] RAM: 3.9GB đủ V1 (mem_limit=512m)
- [x] Backup state.db: chủ sản phẩm tự setup (không thuộc scope V1)
- [x] Secret leak: đã rotate, chỉ cần gitignore
- [x] Production changes: defer đến DC-017

## Exit criteria đã đạt

- ✅ Framework, runtime, container config biết đủ
- ✅ Ports, endpoints, auth mechanism biết đủ
- ✅ Profile slug + bot mapping biết đủ (`aff`, `yt`)
- ✅ SQLite path biết đủ (không đụng)
- ✅ Postgres 16 đã có → không phải scaffold container Postgres riêng
- ✅ Reverse proxy stack rõ (CloudPanel Nginx, không Caddy)
- ✅ Rủi ro regression đã map
- ⏳ Chờ 7 blocker ở trên → sau đó bắt đầu DC-001

## Implementation plan mapping (P0 stories → thay đổi cụ thể)

| Story | Sẽ động vào | Đầu ra |
|---|---|---|
| DC-000 | (Discovery) | File này |
| DC-001 | `app/src/lib/auth/*` | Google OAuth thật + email allowlist bảng Postgres |
| DC-002 | `app/src/app/(dashboard)/layout.tsx`, `components/nav/*` | AppShell mới, 6-nav |
| DC-003 | `components/nav/ProfileSwitcher.tsx` | Filter global `aff` / `yt` / all |
| DC-004 | `app/src/app/admin/page.tsx` (đã stub) | Link ngoài tới `hermes.dongchannel.com` |
| DC-005 | `app/api/v1/dashboard/summary/route.ts` | KPI + inbox aggregate |
| DC-006 | `app/src/lib/hermes/*`, `app/src/lib/ingestion/*` | Projector poll `/api/sessions` per profile |
| DC-007, DC-008, DC-009 | `app/api/v1/tasks/*`, `app/(dashboard)/tasks/*` | Task list, detail, review |
| DC-010 | `app/api/v1/memory/*`, `lib/knowledge/*` | Memory approval |
| DC-011, DC-012 | `lib/aff/*`, `lib/youtube/*`, routes tương ứng | Pipeline |
| DC-013 | Postgres FTS index + `api/v1/search` | Search |
| DC-015 | `api/v1/notifications/stream/route.ts` (SSE) | Realtime |
| DC-016 | Toàn app | A11y/security hardening |
| DC-017 | `deploy/`, CloudPanel commands | Deploy production |
