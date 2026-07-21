# DongChannel AI Operations Hub

Dashboard vận hành AFF Research Bot & YouTube Global Bot. Kết nối với Hermes Agent qua REST/SSE, giữ dashboard Hermes cũ ở khu vực quản trị.

**Domain production:** `https://app.dongchannel.com`

**Tài liệu nguồn:**

- [../docs/PRD.md](../docs/PRD.md) — yêu cầu sản phẩm
- [../docs/TDD.md](../docs/TDD.md) — thiết kế kỹ thuật (10 nguyên tắc kiến trúc bất di ở đầu)
- [../docs/dashboard-discovery.md](../docs/dashboard-discovery.md) — Discovery Gate (chờ VPS)

## Tech stack

- Next.js 15 (App Router) — stable, output `standalone`
- TypeScript strict
- PostgreSQL 16 + Drizzle ORM (nghiệp vụ)
- Hermes SQLite `state.db` — **read-only qua REST/SSE**, không mount, không sửa
- Auth.js (NextAuth v4) — Google OAuth + email allowlist
- Tailwind CSS + shadcn/ui
- Docker Compose + Nginx reverse proxy

## Yêu cầu môi trường

- Node.js ≥ 20.11
- pnpm 9 (hoặc npm 10 — có lockfile riêng)
- PostgreSQL 16 (dev local: `docker run -d --name pg-dev -e POSTGRES_PASSWORD=ops -e POSTGRES_USER=ops -e POSTGRES_DB=dongchannel_ops -p 5432:5432 postgres:16-alpine`; prod: đã có trên VPS)
- SSH tunnel tới Hermes trên VPS: `ssh -N -L 9119:127.0.0.1:9119 vocapro &` (để dev local reach Hermes API)

## Bắt đầu

```bash
cd app
pnpm install                       # hoặc npm install
cp .env.example .env.local         # điền các biến (KHÔNG commit)

# Postgres phải chạy trước khi run migrate/dev
pnpm db:generate                   # sinh migration từ schema (khi có bảng)
pnpm db:migrate                    # apply lên DB

pnpm dev                           # http://localhost:3000
```

## Scripts

| Lệnh | Mục đích |
|---|---|
| `pnpm dev` | Next.js dev server (localhost:3000) |
| `pnpm build` | Production build |
| `pnpm start` | Chạy production build |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm lint` | ESLint |
| `pnpm db:generate` | Sinh migration từ Drizzle schema |
| `pnpm db:migrate` | Apply migration |
| `pnpm db:studio` | Mở Drizzle Studio (DB browser) |

## Cấu trúc

```
app/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (dashboard)/        # Route group cho các trang có sidebar
│   │   ├── admin/              # Link ngoài tới Hermes dashboard cũ
│   │   ├── login/              # Google sign-in
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/  # NextAuth handler
│   │   │   ├── health/         # Health check
│   │   │   └── v1/             # Business API (mỗi story thêm route)
│   │   ├── layout.tsx
│   │   ├── page.tsx            # Overview
│   │   └── globals.css
│   ├── components/ui/          # shadcn/ui components (thêm dần)
│   ├── lib/
│   │   ├── auth/               # Auth.js options + allowlist
│   │   ├── db/                 # Drizzle client + schema
│   │   │   ├── schema/         # Mỗi module 1 file: identity, profiles, tasks, hermes, aff, youtube, knowledge, audit
│   │   │   └── migrations/
│   │   ├── hermes/             # Backend-only Hermes REST/SSE client
│   │   └── utils.ts
│   └── middleware.ts           # Auth guard
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── nginx/app.dongchannel.com.conf
│   └── README.md
├── scripts/
├── .env.example
├── drizzle.config.ts
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

## Nguyên tắc bất di (từ TDD)

1. Dashboard nghiệp vụ **độc lập** với Hermes.
2. **KHÔNG** đụng `state.db` của Hermes.
3. Hermes = source of truth cho sessions/messages/tool-calls/agent runs.
4. Postgres = source of truth cho missions/offers/videos/decisions/memory.
5. Mọi record nghiệp vụ liên kết `profile_id` + `hermes_session_id` + `hermes_message_id` (nếu có).
6. **Chỉ backend Next.js** gọi Hermes API.
7. `HERMES_API_KEY` không xuất hiện trong browser bundle.
8. Dashboard Hermes cũ ở khu vực quản trị riêng (`/admin` link ngoài).
9. Discovery Gate bắt buộc trước khi code business logic.
10. Chưa migration production hoặc sửa Hermes config đến khi chủ sản phẩm duyệt.

## Vòng lặp build

Mỗi story trong backlog TDD (`DC-001` … `DC-017`) chạy qua `/vibe:build`:

1. Đọc story trong PRD + phần TDD liên quan.
2. Code theo "Done khi".
3. `pnpm typecheck && pnpm lint`.
4. Test.
5. Code review (agent `vibe:code-reviewer`).
6. Security review (`/security-review`).
7. Commit.

## Trạng thái hiện tại

Scaffold M0.0 xong. Chờ Discovery Gate (`docs/dashboard-discovery.md`) hoàn tất trước khi bắt đầu DC-001.
