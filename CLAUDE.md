# DongChannel AI Operations Hub

Dashboard vận hành **AFF Research Bot** và **YouTube Global Bot**. Kết nối với Hermes Agent qua REST/SSE, deploy tại `https://app.dongchannel.com`.

> QUAN TRỌNG: KHÔNG dùng cú pháp `@file` trong file này. Chỉ ghi đường dẫn để AI tự đọc khi cần, tránh auto-load tốn context.

## Tài liệu dự án (đọc khi cần, không phải mỗi lần)

- **PRD (yêu cầu sản phẩm):** `docs/PRD.md`
- **TDD (thiết kế kỹ thuật):** `docs/TDD.md` — 10 nguyên tắc kiến trúc bất di ở đầu file
- **Discovery Gate (khảo sát VPS/Hermes):** `docs/dashboard-discovery.md` — đã PASSED SSH verify 2026-07-21, chờ chủ sản phẩm confirm 7 blocker
- **PRD/TDD gốc (backup, không sửa):** `docs/PRD_TDD_DongChannel_AI_Operations_Hub.md`
- **Hermes stack snapshot cũ (KHÔNG phản ánh VPS thật):** `hermes-or-openclaw/` — chỉ dùng tham khảo lịch sử
- **Source app:** `app/` — Next.js 15 + TS + Postgres + Drizzle + Auth.js + Tailwind + shadcn/ui
- **Deploy playbook (draft, chưa apply):** `app/deploy/README.md`

## Hạ tầng thật đã verify (2026-07-21)

- **VPS:** `vocapro` = `180.93.1.148` (SSH alias sẵn), Ubuntu 24.04, 4 vCPU / 3.9GB RAM
- **Reverse proxy:** Nginx quản bởi CloudPanel 6.0.8 (`clpctl` CLI) — **KHÔNG dùng Caddy/manual nginx**
- **PostgreSQL 16** đã có trên host — không cần container Postgres
- **Hermes:** v0.18.2, `network_mode: host`, bind `127.0.0.1:9119`, basic auth `admin`
- **Profile slug:** `aff` + `yt` (KHÔNG phải `youtube`)
- **Domain plan (chờ chủ sản phẩm chốt):** `app.dongchannel.com` = dashboard mới, `hermes.dongchannel.com` = Hermes cũ (link từ `/admin`)
- **Deploy strategy:** CloudPanel Node.js site (systemd), **không container hoá Next.js** để tiết kiệm RAM

## 10 nguyên tắc kiến trúc bất di (từ TDD)

1. Dashboard nghiệp vụ **độc lập** với Hermes Agent.
2. **KHÔNG** thay thế hoặc chỉnh sửa trực tiếp SQLite `state.db` của Hermes.
3. Hermes là source of truth cho `sessions`, `messages`, `tool calls`, `agent runs`.
4. PostgreSQL là source of truth cho `missions`, `offers`, `videos`, `decisions`, `approvals`, `KPI`, `learning playbook`.
5. Mọi record nghiệp vụ phải liên kết `profile_id` + `hermes_session_id` + `hermes_message_id` (nếu có).
6. **Chỉ backend Next.js** được phép gọi Hermes API. Client browser không bao giờ.
7. `HERMES_API_KEY` / `API_SERVER_KEY` không được xuất hiện trong browser bundle (không `NEXT_PUBLIC_*` cho secret).
8. Giữ dashboard Hermes cũ ở khu vực quản trị (`/admin` link ngoài) — không xoá, không proxy.
9. **Discovery Gate bắt buộc** trước khi code business logic. Update `docs/dashboard-discovery.md` với dữ liệu VPS thật.
10. **Chưa migration production hoặc sửa cấu hình Hermes** cho đến khi chủ sản phẩm duyệt.

## Nguyên tắc khi implement

- **Trước khi code một User Story:** đọc story đó trong PRD (mục 9 FR-*) và phần kỹ thuật liên quan trong TDD (mục 17-24).
- Implement đầy đủ theo từng tiêu chí Acceptance Criteria (`AC01`, `AC02`…).
- Tham chiếu TDD cho mọi quyết định kỹ thuật: tech stack (đã chốt), DB schema (mục 19), API design (mục 20), event model (mục 21).
- Hỏi trước khi làm nếu có gì chưa rõ trong PRD hoặc TDD.
- **Không tự đổi tech stack** đã chốt trong TDD (Next.js stable + TS strict + Postgres + Drizzle + Auth.js v4 + Tailwind + shadcn/ui + Docker Compose + Nginx).
- **Không tự phá invariants**: nếu code hiện có xung đột với 10 nguyên tắc, dừng và báo lại thay vì im lặng workaround.

## Quy tắc code trong `app/`

- TypeScript strict, `noUncheckedIndexedAccess` bật.
- Server-only code phải `import "server-only"` (đã dùng ở `lib/hermes/*`, `lib/db/*`).
- Route handler `/api/v1/*` phải verify session Auth.js trước mọi logic nghiệp vụ.
- Query DB phải scope theo `profile_id` khi có (BR01 — mục 11 PRD).
- Response envelope: `{ data, meta: { request_id, next_cursor }, error }` (mục 20 TDD).
- Error dùng mã ổn định (`VALIDATION_ERROR`, `FORBIDDEN`, `INVALID_TRANSITION`, `UPSTREAM_UNAVAILABLE`, `CONFLICT`).
- Mutation có nguy cơ retry dùng `Idempotency-Key`.
- SQL migration **additive only** trong V1 — không drop/rename cột cũ.
- Không log content bot output/prompt/token; log `request_id`, `profile_id`, `task_id`, `session_id` (mục 12 PRD).

## Vòng lặp build (`/vibe:build`)

Mỗi story trong backlog `docs/TDD.md` mục 29 (DC-000 … DC-017):

1. Đọc story trong PRD (FR-*) + phần kỹ thuật liên quan trong TDD.
2. Code — bám nguyên tắc bất di + AC.
3. `pnpm typecheck && pnpm lint`.
4. Test (unit + integration khi có).
5. Code review — agent `vibe:code-reviewer`.
6. Security review — `/security-review`.
7. Commit & Push.
8. Update trạng thái story trong `docs/TDD.md` mục 29.

## Vòng chạy hiện tại

- ✅ M0.0 Scaffold — Next.js 15 + TS + Tailwind + Drizzle + Auth.js v4 setup, typecheck sạch.
- ⏳ **DC-000 Discovery Gate** — chờ chủ sản phẩm cấp VPS access. **Không code business logic trước khi qua gate.**
- ◻ DC-001 → DC-017 — chờ.

## Milestones (từ TDD mục 25)

- **M0** — Baseline: Discovery Gate + smoke test + feature flag.
- **M1** — App shell + auth (Google + allowlist) + Hermes reachability.
- **M2** — Task projection từ Hermes REST/SSE.
- **M3** — Domain (AFF/YouTube) + decision/memory + approval + audit.
- **M4** — Search + result forms + Docker/Nginx production deploy + hardening.

Mỗi milestone phải chạy test và được nghiệm thu trước khi sang milestone kế tiếp.

## Câu lệnh vibe kit dùng thường

- `/vibe:build DC-XXX` — implement 1 story
- `/vibe:build` — pick story tiếp theo theo ưu tiên
- `/vibe:ship` — deploy production (chờ M4)
- Agent `vibe:code-reviewer`, `vibe:tdd-reviewer`, `vibe:prd-reviewer` — review khi cần

## Cấm

- Không commit `.env`, `hermes-or-openclaw/config.txt`, hoặc bất kỳ secret nào.
- Không mount hay đọc trực tiếp `/opt/data/state.db` của Hermes.
- Không đổi tech stack đã chốt mà không thảo luận.
- Không tạo file `.md` mới trong `docs/` nếu không được yêu cầu (dùng file có sẵn).
- Không skip Discovery Gate.
