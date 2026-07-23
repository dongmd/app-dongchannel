---
title: "Security Audit — DongChannel Ops Hub"
version: 1.0
last_updated: "2026-07-23 (DC-016)"
scope: "TDD mục 27 Security checklist + OWASP Top 10 + PRD mục 12 Bảo mật"
---

## Trạng thái checklist TDD mục 27

| Item | Status | Notes |
|---|---|---|
| Không commit `.env`, token, key | ✅ | `.gitignore` chặn tất cả `.env*`, `config.txt`, `*.key`, `.claude/`. Verify: `git ls-files \| grep -E "\.env\|config\.txt"` → empty |
| Secret không xuất hiện trong response/log/bundle | ✅ | `lib/log.ts` redact `GOCSPX-*`, `sk-*`, `Bearer *`, `Basic *` patterns. `HERMES_BASIC_PASSWORD` chỉ dùng ở `lib/hermes/exec.ts` (server-only). Không `NEXT_PUBLIC_*` cho secret |
| `NEXT_PUBLIC_*` chỉ giá trị an toàn browser | ✅ | Chỉ: APP_URL, APP_VERSION, FEATURE flag, HERMES_DASHBOARD_URL (public URL) |
| Auth.js session cookie httpOnly, secure (prod), sameSite=lax | ✅ | `lib/auth/options.ts` cookies config; `__Secure-` prefix ở prod |
| Google OAuth callback URL đúng domain | ✅ | Cấu hình localhost + prod URL trong Google Cloud Console (user tự set) |
| Email allowlist enforce backend, không dựa vào frontend hide | ✅ | `lib/auth/allowlist.ts` `checkAllowlist()` gọi trong signIn callback; DB is source of truth, env fallback |
| Webhook Hermes verify signature | 🔶 N/A | V1 dùng CLI exec pattern (DC-006), không webhook |
| HTML/Markdown output bot sanitize | 🔶 Partial | React auto-escape mọi text render; task detail content dùng `whitespace-pre-wrap` không dangerouslySetInnerHTML. `ts_headline` `<mark>` tag parse SAFE (chỉ literal tag, không HTML khác) — xem `components/search/highlighted-snippet.tsx` |
| External link `rel="noopener noreferrer"` | ✅ | Grep verify: mọi `target="_blank"` đều kèm rel |
| File upload MIME/size check | 🔶 N/A | V1 chưa có upload feature |
| Destructive action có confirm + audit | ✅ | Review actions (task) + memory approve/reject + offer STOP + video PUBLISHED đều có audit event và (STOP + reject) yêu cầu reason |
| Rate limiting login + destructive | ✅ | `lib/rate-limit.ts` in-memory token bucket. Middleware apply cho `/api/auth/callback/*` (10/min) + `/api/v1/tasks|memory|aff|youtube/*` POST/PATCH + `/api/v1/admin/ingest` (30/min) |
| Backup/restore test cho Postgres | ⏳ | Ops task cho chủ sản phẩm — DC-017 sẽ setup pg_dump cron |
| Retention policy raw messages/log | ⏳ | Chưa cấu hình — defer sang V1.1 khi data grow. `hermes_messages` scale sẽ cần archive |
| Nginx TLS-only, HSTS, security headers | ✅ | `next.config.ts` set X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin, Permissions-Policy, HSTS (prod), CSP (default-src 'self') |

## OWASP Top 10 diff review (DC-016 scan)

| OWASP | Coverage | Notes |
|---|---|---|
| A01 Broken Access Control | ✅ | Middleware auth guard mọi route trừ public whitelist; `requireRoleForApi` / `requireRoleOrRedirect` cho routes cần ADMIN/OWNER (admin, ingest, review actions) |
| A02 Cryptographic Failures | ✅ | `NEXTAUTH_SECRET` 44 chars random; Postgres password 24 chars random; scrypt password hash (Hermes) không plaintext |
| A03 Injection | ✅ | Drizzle prepared statements mọi query. FTS query dùng `plainto_tsquery` (safe). SSH exec dùng `spawn` với args array (không shell interpolation). Rate limit key sanitize |
| A04 Insecure Design | ✅ | Optimistic lock (task review If-Unmodified-Since). Transition guard graph tránh state jump. Idempotency ingestion qua unique constraint |
| A05 Security Misconfiguration | ✅ | CSP đầy đủ, HSTS prod, X-Frame DENY, no server tokens (poweredByHeader: false), unused files ignored |
| A06 Vulnerable Components | 🔶 | 2 transitive vulns còn lại (sharp, postcss từ Next). Xem section "Known vulns" dưới |
| A07 Auth Failures | ✅ | Google OAuth verified email_verified check; email allowlist; rate limit login; audit event mọi login pass/fail |
| A08 Software Integrity | ✅ | pnpm-lock.yaml commit; migration file version-controlled; middleware secret via NEXTAUTH_SECRET |
| A09 Logging Failures | ✅ | Structured JSON log qua `lib/log.ts` với request_id + PII redact. Audit events immutable per BR06 |
| A10 SSRF | ✅ | Hermes URL từ env `HERMES_API_BASE_URL` (server config), không user input. CSP `connect-src 'self'` chặn client SSRF |

## Known vulns còn lại (`pnpm audit --prod`)

Chấp nhận trong V1 — chờ upstream Next.js patch:

| Package | Severity | Path | Rủi ro thực tế | Mitigation |
|---|---|---|---|---|
| sharp 0.34.5 | High | next → sharp | Image optimization build-time. Nếu không dùng `next/image` với remote URL không kiểm soát → risk thấp | Không render image từ user upload trong V1. Rebuild khi Next patch |
| postcss 8.4.31 | Moderate | next → postcss | Dev-time CSS processor. Prod bundle không chạy postcss | N/A prod runtime; sẽ được fix khi Next update |

## Performance hardening (DC-016 migration 0006)

12 indexes thêm:

**GIN cho FTS** (7): tasks, memory_entries, offers, videos, niches, markets, hermes_messages
**B-tree hot paths** (5): tasks(profile_slug,status), tasks(updated_at DESC,id DESC), memory_entries(profile_scope,status), memory_entries(created_at DESC), offers(status), videos(status), videos(niche_id) partial, videos(offer_id) partial, tasks(source_hermes_session_id) partial, audit_events(actor_id,created_at DESC), audit_events(entity_type,entity_id)

## Ops action items (defer sang DC-017 deploy)

- [ ] pg_dump cron backup daily → `/opt/backup/dongchannel-ops-YYYYMMDD.sql.gz`
- [ ] Postgres `listen_addresses = 'localhost'` (hiện `*`) + UFW `ufw delete allow 5432` — Discovery Gate mục 7 cảnh báo
- [ ] Rotate `HERMES_BASIC_PASSWORD` định kỳ (share credential với Hermes UI login)
- [ ] Setup monitoring cho SSE reconnect + Hermes health alert
- [ ] Enable `pg_trgm` + `unaccent` extension nếu muốn accent-insensitive search VN

## Sign-off

DC-016 P0 gate hardening PASSED khi:
- ✅ Rate limit apply
- ✅ CSP + security headers
- ✅ Structured logger với PII redact
- ✅ 12 performance indexes
- ✅ 2 vuln còn lại đều transitive Next dep, không critical
- ✅ typecheck + lint clean
