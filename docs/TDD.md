---
title: "TDD — DongChannel AI Operations Hub"
subtitle: "Technical Design Document"
date: "Phiên bản 1.0 • 21/07/2026"
source: "Tách từ PRD_TDD_DongChannel_AI_Operations_Hub.md (Phần B)"
prd_reference: "docs/PRD.md"
---

**Phiên bản:** 1.0
**Ngày:** 21/07/2026
**Sản phẩm:** `app.dongchannel.com`
**PRD nguồn:** [docs/PRD.md](./PRD.md)

---

## Tech stack đã chốt (bổ sung 21/07/2026)

- **Framework:** Next.js phiên bản stable mới nhất đã vá bảo mật (không dùng preview/canary), App Router
- **Language:** TypeScript strict mode
- **Database:** PostgreSQL (nghiệp vụ) + đọc Hermes SQLite `state.db` qua REST/SSE
- **ORM:** Drizzle ORM + Drizzle Kit (migrate)
- **Auth:** Auth.js (NextAuth v5) — Google OAuth + email allowlist
- **UI:** Tailwind CSS + shadcn/ui
- **Hermes integration:** REST API + SSE (backend-only)
- **Container:** Docker Compose
- **Reverse proxy:** Nginx

### Nguyên tắc kiến trúc bắt buộc

1. Đây là dashboard nghiệp vụ **độc lập** kết nối với Hermes Agent.
2. **Không** thay thế hoặc chỉnh sửa trực tiếp SQLite `state.db` của Hermes.
3. Hermes là source of truth cho `sessions`, `messages`, `tool calls` và `agent runs`.
4. PostgreSQL là source of truth cho `missions`, `offers`, `videos`, `decisions`, `approvals`, `KPI` và `learning playbook`.
5. Mọi record nghiệp vụ phải liên kết với: `profile_id`, `hermes_session_id` và `hermes_message_id` nếu có.
6. Chỉ backend Next.js được phép gọi Hermes API.
7. Không expose `HERMES_API_KEY` / `API_SERVER_KEY` xuống browser (không `NEXT_PUBLIC_*` cho secret).
8. Giữ dashboard Hermes cũ làm khu vực quản trị kỹ thuật riêng.
9. Trước khi code, thực hiện Discovery Gate (`docs/dashboard-discovery.md`).
10. Chưa migration production hoặc sửa cấu hình Hermes cho đến khi chủ sản phẩm duyệt.

---

## 16. Giả định và Discovery Gate

### 16.1 Giả định thiết kế

- Hai Telegram bot đã hoạt động và map tới hai Hermes profile riêng: `aff` và `youtube`.
- Dashboard hiện tại đã có authentication, Hermes API/gateway connection và các trang quản trị.
- Session hiện tại là nguồn log chính; task/entity/memory là lớp nghiệp vụ bổ sung.
- Stack Hermes (backend/DB) là SQLite `state.db`; dashboard mới không đụng file này.

### 16.2 Discovery Gate — bắt buộc trước khi code

Claude Code phải tạo `docs/dashboard-discovery.md` gồm:

1. Cách Hermes hiện được chạy trên VPS (service name, port, docker network).
2. Route tree hiện tại của dashboard Hermes.
3. Component/layout/theme system của dashboard Hermes hiện có.
4. Authentication, session và RBAC hiện tại.
5. Hermes REST/SSE endpoints (base URL, auth header, list session/message, event stream).
6. Vị trí `state.db`, cách backup, schema SQLite.
7. Mapping profile ↔ Telegram bot ↔ channel/session (profile `aff` và `youtube`).
8. Cách session/message/tool-call đang được lưu.
9. Test framework, CI/CD, hosting và env vars.
10. Danh sách chức năng có nguy cơ regression khi cắm dashboard mới cạnh Hermes.

**Exit criteria:** có implementation plan theo file/module cụ thể; xác nhận "reuse / adapt / new" cho từng component. Không bắt đầu migration Postgres schema production trước khi hoàn tất gate và chủ sản phẩm duyệt.

## 17. Kiến trúc đề xuất

```text
Telegram Bots
      │
      ▼
Hermes Gateway (SQLite state.db — read-only từ dashboard mới)
      │ REST + SSE
      ▼
┌─────────────────────────────────────────────┐
│ Next.js App (backend-only Hermes calls)     │
│  ├─ HermesAdapter (REST + SSE client)       │
│  ├─ Ingestion projector → PostgreSQL        │
│  ├─ Business services (tasks/offers/…)      │
│  ├─ Auth (Google + email allowlist)         │
│  └─ SSE broadcast → browser                 │
└─────────────────────────────────────────────┘
      │
      ▼
PostgreSQL (nghiệp vụ — tasks, offers, videos, decisions, memory, audit)
      │
      ├─ FTS (V1)
      └─ pgvector (V1.1)

Nginx (app.dongchannel.com) ──► Next.js container port 3000
```

### Kiến trúc nguyên tắc

- Dùng **Strangler pattern**: app mới đứng riêng, dashboard Hermes cũ giữ nguyên ở subdomain/path riêng cho admin kỹ thuật.
- Tạo `HermesAdapter` (backend module) để cô lập khác biệt API/schema Hermes khỏi domain model.
- **Raw data (Hermes SQLite) và operational data (Postgres) tách hoàn toàn**; liên kết qua `hermes_session_id` / `hermes_message_id`.
- Monolith modular (Next.js App Router route groups + `lib/` modules); chưa cần microservice.
- Outbox pattern trong Postgres cho state change + notification/event quan trọng.

## 18. Module boundaries

| Module | Trách nhiệm | Vị trí đề xuất |
|---|---|---|
| Identity | User, role, auth, authorization | `lib/identity/`, `auth.ts` |
| Profiles | Bot profile và visibility | `lib/profiles/` |
| Ingestion | Nhận/upsert Hermes session, message, event | `lib/ingestion/`, `app/api/webhooks/hermes/` |
| Tasks | Task lifecycle, activity và review | `lib/tasks/` |
| AFF Domain | Market, offer, angle, affiliate result | `lib/aff/` |
| YouTube Domain | Niche, video, production, performance | `lib/youtube/` |
| Knowledge | Decision, memory proposal, approval, retrieval | `lib/knowledge/` |
| Search | Index/query hợp nhất | `lib/search/` |
| Notifications | Inbox và realtime updates | `lib/notifications/` |
| Admin | Link vào dashboard Hermes cũ, không proxy | `app/admin/` |
| Audit | Immutable event log cho hành động quan trọng | `lib/audit/` |
| Hermes Adapter | REST/SSE client, retry, redaction | `lib/hermes/` |

**Ràng buộc:** không có route handler nghiệp vụ nào gọi thẳng Hermes REST — luôn qua `lib/hermes/`. UI không giữ Hermes API key.

## 19. Data model logic

### 19.1 Core entities (PostgreSQL)

| Entity | Trường tối thiểu |
|---|---|
| `profiles` | id, slug, name, type, status, created_at |
| `hermes_sessions` | id, hermes_session_id (unique per profile), profile_id, channel, started_at, ended_at, raw_metadata_json |
| `hermes_messages` | id, hermes_message_id (unique per session), hermes_session_id, role, content, content_type, created_at, token_count |
| `tasks` | id, code, profile_id, source_hermes_session_id, source_hermes_message_id, title, type, status, priority, started_at, completed_at, review_status, created_at, updated_at |
| `task_activities` | id, task_id, external_event_id, event_type, step_name, status, payload_redacted, occurred_at |
| `sources` | id, url, title, publisher, accessed_at, content_hash, verification_status |
| `entity_sources` | entity_type, entity_id, source_id, field_path, claim_text |
| `decisions` | id, code, profile_id, task_id, subject_type, subject_id, decision, rationale, status, decided_by, decided_at, revisit_condition |
| `memory_entries` | id, profile_scope, category, title, content, status, confidence, source_task_id, approved_by, approved_at, supersedes_id, version, created_at |
| `notifications` | id, user_id, type, entity_type, entity_id, title, read_at, created_at |
| `audit_events` | id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, request_id, created_at |
| `users` | id, email, name, google_sub, role, created_at, last_login_at |
| `email_allowlist` | email (PK), role, added_by, added_at |

**Ghi chú:** `hermes_sessions` và `hermes_messages` là **projection cache** của Hermes SQLite, không phải master. Xoá được để rebuild từ Hermes REST.

### 19.2 AFF entities

| Entity | Trường chính |
|---|---|
| `markets` | name, summary, demand_score, longevity_score, competition_score, policy_risk_score, status |
| `offers` | market_id, name, website_url, network, commission_type, commission_value, cookie_days, payout_threshold, countries, status, confidence, last_verified_at |
| `offer_restrictions` | offer_id, traffic_source, allowed, brand_bidding, notes, verified_at |
| `angles` | offer_id, audience_id, pain_point, desire, big_idea, promise, mechanism, proof_required, status |
| `affiliate_results` | offer_id, angle_id, period_start, period_end, impressions, clicks, leads, sales, commission, cost, refunds, profit, currency |
| `scorecards` | entity_type, entity_id, schema_version, total_score, breakdown_json, calculated_at |

### 19.3 YouTube entities

| Entity | Trường chính |
|---|---|
| `niches` | name, audience_id, positioning, demand_score, monetization_score, copyright_risk_score, status |
| `content_pillars` | niche_id, name, description, priority |
| `videos` | niche_id, pillar_id, offer_id, angle_id, title, working_title, status, script, publish_url, published_at |
| `video_variants` | video_id, type(title/thumbnail/hook), content, rank, selected |
| `video_metrics` | video_id, captured_at, window, impressions, ctr, views, retention_30s, avg_percentage_viewed, subscribers, affiliate_clicks, sales, revenue |

### 19.4 Shared entities

`audiences`, `pain_points`, tags và relations nên dùng chung để AFF → YouTube không phải copy text. Quan hệ quan trọng:

- Market 1—N Offers.
- Niche 1—N Videos.
- Offer N—N Audiences qua targeting relation.
- Video N—1 Offer (nullable) và N—1 Angle (nullable).
- Task N—N Domain Entity qua `task_entities`.
- Entity N—N Source.
- Memory/Decision → source task/session.

### 19.5 Idempotency và uniqueness

- Unique `(profile_id, hermes_session_id)`.
- Unique `(hermes_session_id, hermes_message_id)`.
- Unique `external_event_id` khi upstream cung cấp; nếu không, tạo deterministic key từ session + type + timestamp bucket + payload hash.
- `task.code` dạng human-readable `AFF-0001`, `YT-0001`; database ID vẫn dùng UUID (Postgres `gen_random_uuid()`).

## 20. API contract đề xuất

Prefix: `/api/v1`. Tất cả route là Next.js Route Handler; chỉ chạy server-side; kiểm tra session Auth.js + role trước mọi handler nghiệp vụ.

### Dashboard và task

| Method | Endpoint | Mục đích |
|---|---|---|
| GET | `/api/v1/dashboard/summary` | KPI, inbox, active tasks, recent results |
| GET | `/api/v1/tasks` | List + filter + cursor pagination |
| GET | `/api/v1/tasks/{id}` | Detail tổng hợp |
| POST | `/api/v1/tasks/{id}/approve` | Approve task output |
| POST | `/api/v1/tasks/{id}/request-revision` | Ghi feedback và tạo revision action |
| POST | `/api/v1/tasks/{id}/reject` | Reject kèm lý do |
| POST | `/api/v1/tasks/{id}/retry` | Retry task lỗi, có idempotency key |
| GET | `/api/v1/tasks/{id}/activities` | Timeline; có thể stream/paginate |
| GET | `/api/v1/tasks/{id}/stream` | SSE stream cho task đang RUNNING (proxy từ Hermes SSE) |

### Domain

| Method | Endpoint | Mục đích |
|---|---|---|
| GET/POST | `/api/v1/aff/offers` | List/create offer |
| GET/PATCH | `/api/v1/aff/offers/{id}` | Detail/update/version |
| POST | `/api/v1/aff/offers/{id}/transition` | Chuyển pipeline có validation |
| POST | `/api/v1/aff/results` | Nhập test result |
| GET/POST | `/api/v1/youtube/videos` | List/create video |
| GET/PATCH | `/api/v1/youtube/videos/{id}` | Detail/update |
| POST | `/api/v1/youtube/videos/{id}/transition` | Chuyển production status |
| POST | `/api/v1/youtube/metrics` | Nhập/sync performance |

### Knowledge và search

| Method | Endpoint | Mục đích |
|---|---|---|
| GET | `/api/v1/memory?status=PROPOSED` | Queue chờ duyệt |
| POST | `/api/v1/memory/{id}/approve` | Approve hoặc approve-with-edits |
| POST | `/api/v1/memory/{id}/reject` | Reject proposal |
| POST | `/api/v1/memory/{id}/supersede` | Thay thế entry active |
| GET | `/api/v1/search?q=` | Unified search |
| GET | `/api/v1/notifications` | Inbox |
| POST | `/api/v1/notifications/{id}/read` | Mark read |

### Response envelope

```json
{
  "data": {},
  "meta": { "request_id": "...", "next_cursor": null },
  "error": null
}
```

Error dùng mã ổn định như `VALIDATION_ERROR`, `FORBIDDEN`, `INVALID_TRANSITION`, `UPSTREAM_UNAVAILABLE`, `CONFLICT`, không phụ thuộc message UI.

### Concurrency

- PATCH/approve dùng `version` hoặc `updated_at` để optimistic locking.
- Xung đột trả HTTP 409 và current representation.
- Mutation có nguy cơ retry từ UI dùng `Idempotency-Key`.

## 21. Event ingestion và realtime

### Canonical events

- `session.started`
- `message.received`
- `task.created`
- `agent.started`
- `agent.step`
- `tool.started`
- `tool.completed`
- `agent.completed`
- `agent.failed`
- `memory.proposed`

`HermesAdapter` map event thực tế của Hermes sang canonical event. Lưu raw reference/payload đã redact để debug.

### Xử lý event

1. Verify signature/auth nếu Hermes push webhook (nếu Hermes chỉ có SSE thì backend chủ động subscribe).
2. Validate schema và profile mapping.
3. Dedupe theo idempotency key.
4. Persist event trước khi project vào task/activity.
5. Commit operational update.
6. Publish realtime notification qua SSE (Next.js Route Handler streaming) tới browser.
7. Retry exponential backoff; lỗi cuối vào dead-letter state có UI cảnh báo.

**Ưu tiên SSE** cho progress event một chiều. Chỉ dùng WebSocket khi có yêu cầu two-way (không cần cho V1).

## 22. Search và retrieval

### V1

- PostgreSQL full-text (`tsvector`, `pg_trgm`).
- Index: title, message content, final output, entity name/summary, decision rationale và active memory.
- Permission/profile filter áp dụng ở query layer, không lọc sau khi trả dữ liệu.

### V1.1 semantic retrieval

- `pgvector` (đã sẵn trong Postgres — enable extension trong migration).
- Chunk có metadata: profile_scope, entity_type/id, source_task/session, approval_status, effective dates.
- Chỉ index memory `ACTIVE` vào collection dùng cho bot retrieval.
- Hybrid ranking: lexical + vector + recency + approved boost.
- Retrieval response phải kèm citation IDs; prompt builder không nạp toàn bộ chat.

## 23. Authorization matrix

| Hành động | OWNER | ADMIN | VIEWER | AGENT |
|---|:---:|:---:|:---:|:---:|
| Xem dashboard/task | ✓ | ✓ | ✓ | Theo scope |
| Approve decision/memory | ✓ | Tùy cấu hình | — | — |
| Sửa pipeline/result | ✓ | ✓ | — | Proposal only |
| Xem raw logs | ✓ | ✓ | — | — |
| Quản lý key/config | ✓ | ✓ | — | — |
| Tạo memory active | ✓ qua approve | Tùy cấu hình | — | — |
| Đề xuất memory | ✓ | ✓ | — | ✓ |

Backend bắt buộc enforce; ẩn nút frontend không phải authorization.

**Google login + email allowlist:** người dùng đăng nhập bằng Google; email phải nằm trong bảng `email_allowlist` mới được cấp session. Role gán theo bản ghi allowlist. Đăng nhập ngoài allowlist trả 403 và log audit.

**Chi tiết Auth.js v4:**

- `signIn` callback trả `false` → Auth.js v4 redirect `/login?error=AccessDenied` (PascalCase, cố định). UI map `AccessDenied` → "Tài khoản chưa được cấp quyền truy cập." (AC10 — không lộ email).
- `AUTH_EMAIL_ALLOWLIST` env chỉ bootstrap: email **đầu tiên** = OWNER, các email sau = VIEWER. Role thật quản lý qua bảng `email_allowlist` (DB = source of truth).
- Role được **sync mỗi lần login** — nếu admin đổi role trong `email_allowlist`, user đăng nhập lần sau sẽ nhận role mới (JWT refetch DB khi `trigger === "signIn"`).

## 24. Frontend design

### Route đề xuất

```text
/
/tasks
/tasks/:id
/aff/markets
/aff/offers
/aff/offers/:id
/aff/angles
/aff/results
/youtube/niches
/youtube/ideas
/youtube/production
/youtube/videos/:id
/youtube/performance
/memory
/memory/:id
/search
/admin           (index — link ngoài tới dashboard Hermes cũ)
/api/auth/*      (Auth.js routes)
/api/v1/*        (business routes)
```

### State strategy

- Server state: React Server Components + `next/cache`; client fetch dùng SWR/TanStack Query (chọn 1 khi cần).
- URL là nguồn sự thật cho filter/sort/page để bookmark được.
- Local state chỉ cho UI tạm thời như dialog, drawer.
- Optimistic UI chỉ dùng cho mark-read và thao tác dễ rollback; approve/transition chờ server xác nhận.

### Loading/error/empty

- Skeleton ở list/card, không spinner toàn trang kéo dài.
- Next.js `error.tsx` boundary theo route; lỗi một widget không làm sập Overview.
- Retry action rõ ràng, hiển thị request ID cho support.
- Empty state riêng theo filter empty và system empty.

## 25. Migration và backward compatibility

### M0 — Baseline

- Discovery Gate (`docs/dashboard-discovery.md`) hoàn tất và chủ sản phẩm duyệt.
- Snapshot Hermes REST endpoints và schema `state.db` hiện tại.
- Smoke test cho login Google, Hermes REST reachable, SSE reachable.
- Feature flag `new_ops_dashboard=true` mặc định.

### M1 — App shell + auth + Hermes reachability

- AppShell/navigation/profile switcher.
- Auth.js Google + email allowlist.
- `HermesAdapter` gọi được `GET /sessions` và mở SSE (chưa persist).
- `/admin` link ngoài tới dashboard Hermes cũ.

### M2 — Task projection

- Postgres schema `profiles`, `hermes_sessions`, `hermes_messages`, `tasks`, `task_activities`, `audit_events`.
- Drizzle migration + seed profile `aff` và `youtube`.
- Ingestion projector: pull Hermes sessions/messages → upsert projection → derive tasks.
- Backfill session lịch sử thành task `IMPORTED` hoặc `COMPLETED`; không giả định review state.

### M3 — Domain + approval

- Thêm offer/video/decision/memory schema.
- Extractor ban đầu có thể manual/structured JSON; failure không làm mất final answer.
- Triển khai approval và audit.
- Notification inbox (Postgres + SSE broadcast).

### M4 — Search + results + hardening

- Postgres FTS.
- Affiliate/video result forms.
- Performance, security, a11y và observability hardening.
- Nginx production config + Docker Compose deploy checklist.

Rollback:

- Có thể tắt feature flag và quay về dashboard Hermes cũ (chỉ cần đổi Nginx `server_name`).
- Migration additive trước; không drop/rename cột cũ trong V1.
- Backfill có checkpoint, dry-run, counts và rerun idempotent.

## 26. Testing strategy

### Unit tests

- State transition guards.
- Profile/session/task mapping.
- Score calculation/versioning.
- Memory approval/supersede rules.
- Event deduplication và redaction.
- Email allowlist gate.

### Integration tests

- Hermes REST fixture → session/message/task/activity.
- Task completion → notification.
- Approve memory → active retrieval index.
- Revision request → task state/action.
- Prune raw session không phá approved entity reference.
- Authorization cho admin/secret endpoints.

### E2E critical paths

1. Login Google → Overview.
2. Telegram event fixture → task appears (qua Hermes REST/SSE mock).
3. Open task → read final output → source session.
4. Approve decision nhưng memory vẫn pending.
5. Approve memory → xuất hiện ở Active.
6. AFF offer approved → link sang YouTube video.
7. Record video/affiliate result → learning proposal.
8. Search trả đúng task/entity/memory theo profile.
9. Admin link mở dashboard Hermes cũ.

### Visual và accessibility

- Screenshot test desktop 1440, laptop 1280, tablet 768, mobile 390 cho route chính.
- Axe/accessibility scan cho AppShell, task detail, form approval.
- Kiểm tra keyboard-only và contrast.

### Performance

- Seed tối thiểu 10k tasks, 100k messages, 5k entities.
- Load test list/search/dashboard aggregate.
- Test reconnect SSE và event burst.

## 27. Security checklist

- [ ] Không commit `.env`, token Telegram, `HERMES_API_KEY` hoặc cookie.
- [ ] Secret không xuất hiện trong API response/log/client bundle (kiểm tra Next.js bundle analyze).
- [ ] `NEXT_PUBLIC_*` chỉ dùng cho giá trị an toàn hiển thị browser.
- [ ] Auth.js session cookie `httpOnly`, `secure`, `sameSite=lax`.
- [ ] Google OAuth callback URL cấu hình đúng domain.
- [ ] Email allowlist enforce ở backend, không dựa vào frontend hide.
- [ ] Webhook Hermes (nếu có) verify signature hoặc shared secret; có replay protection.
- [ ] HTML/Markdown output của bot được sanitize.
- [ ] External link dùng `rel="noopener noreferrer"` và hiển thị domain.
- [ ] File upload kiểm tra MIME, size và access control.
- [ ] Destructive action có confirm + audit.
- [ ] Rate limiting và brute-force protection.
- [ ] Backup/restore test cho Postgres.
- [ ] Retention policy cho raw messages/log được cấu hình.
- [ ] Nginx TLS-only, HSTS, security headers (CSP, X-Frame-Options).

## 28. Observability và vận hành

Dashboard `/admin` cần có:

- Hermes REST reachability + `last_seen_at`.
- Event ingestion lag, last successful event.
- Failed events và retry count.
- Extraction errors.
- Drizzle migration version.
- Build/version SHA (env `NEXT_PUBLIC_APP_VERSION`).

Alert mức tối thiểu:

- Không nhận event từ bot đang active quá ngưỡng cấu hình.
- Ingestion error rate > 5% trong 5 phút.
- Queue/dead-letter tăng liên tục.
- Postgres hoặc Hermes upstream unavailable.

## 29. Implementation backlog cho Claude Code

| ID | Story | Ưu tiên | Phụ thuộc | Trạng thái |
|---|---|---|---|---|
| DC-000 | Discovery Gate (`docs/dashboard-discovery.md`) | P0 | — | ✅ PASSED 2026-07-21 |
| DC-001 | Auth: Google OAuth + email allowlist (allowlist V1 = `mdinh.dong86@gmail.com`) | P0 | DC-000 | ✅ Done — chờ E2E khi có Google creds + Postgres |
| DC-002 | AppShell + navigation mới | P0 | DC-001 | ✅ Done |
| DC-003 | Profile switcher toàn cục | P0 | DC-002 | ✅ Done |
| DC-004 | Trang `/admin` link ngoài tới Hermes cũ | P0 | DC-002 | ✅ Done |
| DC-005 | Dashboard summary API/UI | P0 | DC-002 | ✅ Done (shell + aggregator; counts=0 vì tasks/memory chờ DC-006/010) |
| DC-006 | Task projection từ Hermes REST/SSE | P0 | DC-000, DC-001 | — |
| DC-007 | Task list/filter/search cơ bản | P0 | DC-006 | — |
| DC-008 | Task detail + activity timeline (SSE proxy) | P0 | DC-006 | — |
| DC-009 | Review actions + audit | P0 | DC-008 | — |
| DC-010 | Memory proposal/approval | P0 | DC-009 | — |
| DC-011 | AFF offer pipeline | P1 | DC-006 | — |
| DC-012 | YouTube video pipeline | P1 | DC-006 | — |
| DC-013 | Unified search (Postgres FTS) | P1 | DC-007, DC-010 | — |
| DC-014 | Result forms | P1 | DC-011, DC-012 | — |
| DC-015 | Notifications/realtime (SSE broadcast) | P1 | DC-006 | — |
| DC-016 | Responsive/a11y/security hardening | P0 release gate | All P0 | — |
| DC-017 | Docker Compose + Nginx production deploy | P0 | DC-016 | — |

## 30. Acceptance test script cho chủ sản phẩm

1. Đăng nhập Google (email trong allowlist) và xác nhận chỉ thấy tối đa 6 mục điều hướng chính.
2. Chọn `Tất cả`, `AFF Bot`, `YouTube Bot`; dữ liệu thay đổi đúng và không mất route.
3. Gửi `MISSION AFF-TEST-001` qua Telegram.
4. Xác nhận task xuất hiện, đúng profile, prompt và timestamp.
5. Khi bot chạy, activity cập nhật qua SSE; tool/log mặc định thu gọn.
6. Khi xong, nhận notification và mở final answer.
7. Mở source session/message từ task (link sang dashboard Hermes cũ nếu cần chi tiết).
8. Request revision một lần, kiểm tra lịch sử được giữ.
9. Approve output; kiểm tra decision được tạo.
10. Kiểm tra memory proposal chưa active trước khi approve riêng.
11. Approve memory, mở session mới và kiểm tra bot tìm đúng entry kèm nguồn.
12. Tạo/duyệt một offer, liên kết nó với một video idea.
13. Nhập kết quả video/AFF, kiểm tra learning proposal.
14. Tìm lại mission bằng global search.
15. Mở `/admin`, xác nhận dashboard Hermes cũ vẫn truy cập và hoạt động.

## 31. Rủi ro và phương án xử lý

| Rủi ro | Tác động | Giảm thiểu |
|---|---|---|
| Hermes REST/SSE schema thay đổi | Mất đồng bộ | `HermesAdapter` + contract test + raw event retention |
| Tạo entity sai từ output tự do | Memory nhiễu | Proposal + human approval + confidence/source |
| Đụng nhầm `state.db` của Hermes | Corruption production | Nguyên tắc kiến trúc #2; read-only qua REST; code review chặn ORM SQLite |
| Search lộ dữ liệu profile/secret | Bảo mật | Query-level authorization + redaction |
| Dashboard trở nên phức tạp lần nữa | UX thất bại | Tối đa 6 nav, progressive disclosure, usability test |
| Quá nhiều scope V1 | Chậm ra sản phẩm | P0 trước; semantic/charts/automation để V1.1 |
| Google login lộ email allowlist | Priv leak | Không log email chi tiết; error message chung "Tài khoản chưa được cấp quyền" |

## 32. Quyết định thiết kế đã chốt

1. Dashboard dùng chung cho cả AFF và YouTube; profile là global filter.
2. Telegram vẫn là kênh giao việc chính trong V1.
3. Dark theme được giữ nhưng làm sạch và hiện đại hơn.
4. Toàn bộ chức năng Hermes hiện tại được giữ ở dashboard cũ, truy cập qua `/admin` link ngoài.
5. Memory bắt buộc phê duyệt thủ công trước khi active.
6. V1 ưu tiên Closed Loop hơn biểu đồ đẹp hoặc automation nâng cao.
7. Tech stack: Next.js stable + TS strict + Postgres + Drizzle + Auth.js (Google + allowlist) + Tailwind + shadcn/ui + Docker Compose + Nginx.
8. Postgres và Hermes SQLite tách hoàn toàn; chỉ liên kết qua ID.

---

## Phụ lục C — Prompt khởi động cho Claude Code

```text
Hãy đọc docs/PRD.md và docs/TDD.md, coi đây là source of truth cho redesign dashboard.

Trước khi sửa code:
1. Khảo sát VPS theo TDD mục 16.2 Discovery Gate.
2. Cập nhật docs/dashboard-discovery.md với thông tin thực tế.
3. Lập bảng mapping yêu cầu P0 → file/module trong app/ → thay đổi đề xuất → rủi ro.
4. Chạy baseline tests và ghi lại kết quả.
5. Đề xuất implementation plan theo M0–M4, chia nhỏ commit.

Ràng buộc bất di bất dịch (10 nguyên tắc kiến trúc ở đầu TDD):
- Không thay framework/DB/auth đã chốt nếu chưa chứng minh cần thiết.
- KHÔNG chạm state.db của Hermes; chỉ đọc qua REST/SSE.
- Không xóa dashboard Hermes cũ; link vào /admin.
- Dùng feature flag cho dashboard mới.
- Migration additive và có rollback.
- Không secret trong frontend/log/test fixture.
- Dừng lại xin xác nhận sau Discovery Gate và trước migration schema production đầu tiên.
```
