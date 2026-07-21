---
title: "PRD — DongChannel AI Operations Hub"
subtitle: "Dashboard vận hành AFF Research Bot & YouTube Global Bot"
date: "Phiên bản 1.0 • 21/07/2026"
source: "Tách từ PRD_TDD_DongChannel_AI_Operations_Hub.md (Phần A)"
---

**Phiên bản:** 1.0
**Ngày:** 21/07/2026
**Sản phẩm:** `app.dongchannel.com`
**Đối tượng triển khai:** Claude Code
**Phạm vi:** Thiết kế lại dashboard Hermes Agent cho hai profile `aff` và `youtube`, giữ nguyên khả năng vận hành bot qua Telegram.

> **Tuyên bố sản phẩm:** Đây không còn là một "Hermes admin panel" dùng hằng ngày. Nó phải trở thành trung tâm điều hành giúp một người biến nghiên cứu AFF và YouTube thành quyết định, nội dung, thử nghiệm và doanh thu. Các công cụ kỹ thuật của Hermes vẫn được giữ, nhưng chuyển vào khu vực Quản trị.

---

## 0. Cách Claude Code sử dụng tài liệu này

1. Đọc toàn bộ tài liệu trước khi sửa code.
2. Thực hiện **Discovery Gate** ở `docs/TDD.md` mục 16, lập bản đồ stack, route, API, database và component hiện tại.
3. Không thay framework, cơ chế xác thực, database hay Hermes core khi chưa có lý do được ghi lại.
4. Triển khai theo milestone M0 → M4. Mỗi milestone phải chạy test và được nghiệm thu trước khi sang milestone kế tiếp.
5. Nếu code hiện tại khác giả định trong TDD, ưu tiên giữ hành vi đang hoạt động; cập nhật implementation plan, không tự ý phá tương thích.
6. Không xóa các màn hình kỹ thuật hiện có. Chuyển chúng vào `/admin` hoặc nhóm "Quản trị hệ thống".
7. Mọi dữ liệu mới phải liên kết ngược về `profile_id`, `session_id` và message/source gốc nếu có.

---

## 1. Bối cảnh và vấn đề

Dashboard hiện tại kế thừa cấu trúc quản trị Hermes, với nhiều mục ngang cấp: Chat, Sessions, Files, Models, Logs, Cron, Skills, Plugins, MCP, Channels, Webhooks, Pairing, Profiles, Config, Keys, System. Giao diện phù hợp cho kỹ thuật viên cấu hình agent nhưng gây quá tải cho người dùng vận hành kinh doanh hằng ngày.

Các vấn đề quan sát từ màn hình hiện tại:

- Thanh bên có quá nhiều lựa chọn và không phản ánh luồng kiếm tiền.
- Chức năng nghiệp vụ và chức năng hạ tầng đứng cùng cấp.
- Profile đang chọn được nhắc lại ở nhiều nơi nhưng vai trò chưa rõ.
- Trang Sessions ưu tiên số liệu kỹ thuật và thao tác "import/prune", trong khi nhu cầu chính là tìm nhiệm vụ, kết quả, quyết định và việc tiếp theo.
- Không có một màn hình trả lời nhanh: hôm nay cần làm gì, bot đang làm gì, kết quả nào chờ duyệt, dự án nào đang có tín hiệu.
- Hội thoại, offer, video, quyết định, KPI và bài học chưa được thể hiện như các đối tượng nghiệp vụ liên kết với nhau.
- Trạng thái rỗng chiếm phần lớn màn hình nhưng không hướng dẫn hành động phù hợp.

![Giao diện Hermes dashboard hiện tại — trang Sessions của profile AFF](upload/image.png)

*Hình 1. Giao diện hiện tại dùng làm baseline phân tích; các công cụ kỹ thuật vẫn được bảo toàn trong khu vực Quản trị.*

## 2. Tầm nhìn sản phẩm

Xây dựng **DongChannel AI Operations Hub** — dashboard chung cho hai bot:

- **AFF Research Bot:** tìm thị trường, offer, audience, pain point, angle và phân tích kết quả test.
- **YouTube Global Bot:** tìm niche, lên content, theo dõi production và phân tích hiệu suất video.

Telegram tiếp tục là kênh giao việc chính. Dashboard là nơi:

1. Theo dõi nhiệm vụ và hoạt động bot.
2. Đọc lại output có cấu trúc.
3. Phê duyệt hoặc yêu cầu sửa.
4. Quản lý pipeline AFF và YouTube.
5. Nhập kết quả thực tế.
6. Duyệt kiến thức trước khi đưa vào memory.
7. Tra cứu lại bằng từ khóa, bộ lọc và liên kết nguồn.

## 3. Mục tiêu và chỉ số thành công

### 3.1 Mục tiêu V1

- Giảm số mục điều hướng chính từ hơn 15 xuống tối đa 6.
- Người dùng nhìn thấy việc cần xử lý trong vòng 5 giây sau khi đăng nhập.
- Từ một task có thể mở tới session/message gốc trong tối đa 2 thao tác.
- Mọi kết luận được lưu vào memory đều phải có trạng thái phê duyệt.
- AFF và YouTube có pipeline riêng nhưng chia sẻ được audience, offer và kết quả đã duyệt.
- Giữ nguyên luồng Telegram → Hermes và các chức năng quản trị đang chạy.

### 3.2 KPI sản phẩm

| KPI | Mục tiêu V1 | Cách đo |
|---|---:|---|
| Thời gian tìm một output cũ | ≤ 30 giây | Usability test với 5 tình huống |
| Task có nguồn truy vết | ≥ 95% | `source_session_id` hoặc `source_message_id` không rỗng |
| Memory được duyệt trước khi active | 100% | Audit trạng thái memory |
| Nhiệm vụ Telegram xuất hiện trên dashboard | ≥ 99% | Đối soát webhook/session |
| Lỗi đồng bộ có cảnh báo | 100% | Error event tạo notification |
| Người dùng hoàn thành daily review | ≤ 10 phút | Đo từ mở Overview đến xử lý hết inbox |

### 3.3 North-star metric

**Số "learning loop" hoàn chỉnh mỗi tháng:** Research → Decision → Execute → Result → Learning được duyệt.

## 4. Ngoài phạm vi V1

- Không thay Telegram bằng chat web.
- Không xây CRM affiliate hoàn chỉnh hoặc phần mềm quản lý tài chính kế toán.
- Không tự động đăng video YouTube hoặc tự chạy quảng cáo.
- Không cho bot tự động scale ngân sách, mua dịch vụ hay gửi dữ liệu ra ngoài.
- Không sửa Hermes core nếu có thể tích hợp qua adapter/API/event hiện có.
- Không xây hệ thống nhiều tổ chức phức tạp; V1 tối ưu cho một chủ tài khoản và có nền tảng để mở rộng.

## 5. Người dùng và job-to-be-done

### 5.1 Primary persona — Owner/Operator

- Vận hành một mình, cần giao việc nhanh qua Telegram.
- Không muốn đọc log kỹ thuật trừ khi có lỗi.
- Cần biết bot đã tìm được gì, nên quyết định gì và bước tiếp theo là gì.
- Cần tra cứu lý do đã chọn/bỏ một niche, offer hoặc angle.

### 5.2 Secondary persona — System Admin

- Quản lý profile, model, key, skill, MCP, channel, webhook, cron và log.
- Truy cập không thường xuyên.
- Cần giữ đầy đủ tính năng Hermes nhưng không chiếm không gian vận hành chính.

## 6. Nguyên tắc UX

1. **Business first:** hiển thị công việc và kết quả trước cấu hình kỹ thuật.
2. **One screen, one decision:** mỗi màn hình có một nhiệm vụ chính và một CTA chính.
3. **Progressive disclosure:** tool call, token, raw JSON và stack trace mặc định thu gọn.
4. **Source before memory:** mọi knowledge phải truy được nguồn và có người duyệt.
5. **Status bằng chữ + màu:** không dùng màu là tín hiệu duy nhất.
6. **Empty state phải tạo hành động:** giải thích vì sao rỗng và đưa nút giao nhiệm vụ/mở Telegram.
7. **Hai bot, một hệ điều hành:** tách profile nhưng dùng chung hệ thống task, search, decision và result.

## 7. Kiến trúc thông tin mới

### 7.1 Điều hướng chính

| Mục | Mục đích | Thành phần chính |
|---|---|---|
| Tổng quan | Daily command center | KPI, inbox, active tasks, cảnh báo, next actions |
| Công việc | Tất cả nhiệm vụ từ Telegram/web | List/board, task detail, session timeline |
| AFF Research | Điều hành market/offer/test | Markets, offers, angles, affiliate results |
| YouTube | Điều hành niche/video/performance | Niches, content backlog, production, metrics |
| Trí nhớ | Duyệt và tra cứu knowledge | User Profile, Decisions, Playbooks, pending review |
| Quản trị | Hermes/system tools | Sessions thô, files, models, logs, cron, skills, plugins, MCP, channels, webhooks, pairing, profiles, config, keys, system |

### 7.2 Profile switcher

- Vị trí: header hoặc đầu sidebar.
- Giá trị: `Tất cả`, `AFF Bot`, `YouTube Bot`.
- Profile là bộ lọc xuyên suốt, không phải một trang riêng trong luồng nghiệp vụ.
- Khi chuyển profile, giữ nguyên module hiện tại nếu module có dữ liệu tương ứng.
- `Tất cả` là mặc định ở Tổng quan và Công việc.

### 7.3 Global header

- Global search.
- Nút `+ Tạo nhiệm vụ` (V1 có thể mở Telegram/deep link hoặc form đơn giản nếu backend hỗ trợ).
- Notification inbox.
- Trạng thái Gateway dạng compact: `Hoạt động`, `Gián đoạn`, `Mất kết nối`.
- User menu và link vào Quản trị.

## 8. Wireframe khái niệm

### 8.1 Desktop — Tổng quan

```text
┌ Sidebar ─────────┬──────────────────────────────────────────────────────┐
│ Logo             │ Tổng quan       [Tất cả ▼]  [Tìm kiếm…]  [+ Task]   │
│ Tổng quan        ├──────────────────────────────────────────────────────┤
│ Công việc   (3)  │ Chờ anh xử lý: 3   Đang chạy: 2   Cảnh báo: 1       │
│ AFF Research     ├───────────────────────────┬──────────────────────────┤
│ YouTube          │ Việc cần quyết định       │ Bot đang hoạt động       │
│ Trí nhớ     (2)  │ • Duyệt offer A           │ AFF-014 Researching 62%  │
│                  │ • Sửa niche B             │ YT-008 Writing script    │
│ ───────────────  ├───────────────────────────┴──────────────────────────┤
│ Quản trị         │ Pipeline nhanh / Kết quả gần đây / Cảnh báo          │
└──────────────────┴──────────────────────────────────────────────────────┘
```

### 8.2 Task detail

```text
┌ AFF-014 · Research 5 email marketing offers        [Request revision] ┐
│ Status: Waiting review · Profile: AFF · 18 phút · 24,820 tokens       │
├──────────────────────────────┬─────────────────────────────────────────┤
│ Kết quả                      │ Timeline                                │
│ Executive summary            │ User message                           │
│ Structured findings          │ Agent steps (collapsed)                │
│ Sources                      │ Tool calls (collapsed)                 │
│ Decision requested           │ Final output                           │
│ [Approve] [Reject]           │ Error/retry events                     │
├──────────────────────────────┴─────────────────────────────────────────┤
│ Related: Offer A · Decision D-021 · Session S-... · Memory proposal   │
└────────────────────────────────────────────────────────────────────────┘
```

## 9. Yêu cầu chức năng theo màn hình

### FR-01 — Tổng quan

**Mục đích:** trả lời "Hôm nay tôi cần làm gì?"

Thành phần:

- KPI compact: Chờ duyệt, Đang chạy, Lỗi/cảnh báo, Published/Test đang active.
- `Decision Inbox`: output hoặc memory proposal chờ xử lý, sắp theo ưu tiên và thời gian.
- `Active Tasks`: task đang queued/running với bước hiện tại và thời gian chạy.
- `Recent Results`: kết quả AFF/YouTube mới nhất.
- `Next Best Actions`: tối đa 5 hành động có lý do; V1 có thể rule-based.
- `System Health`: chỉ hiện khi có vấn đề; trạng thái bình thường nằm ở header.

Acceptance criteria:

- AC01: mở trang hiển thị dữ liệu của cả hai profile theo mặc định.
- AC02: click item mở đúng task/record nguồn.
- AC03: trạng thái loading, empty, error có hướng dẫn rõ.
- AC04: card kỹ thuật token/cost không chiếm vị trí ưu tiên; nằm trong khu vực phụ.

### FR-02 — Công việc

**Mục đích:** quản lý nhiệm vụ thay vì quản lý session thô.

Chế độ hiển thị:

- List là mặc định; Board là tùy chọn.
- Bộ lọc: profile, loại task, trạng thái, thời gian, tag, có lỗi, chờ duyệt.
- Search theo task title, nội dung message, output, entity và source.
- Saved views: `Chờ tôi`, `Đang chạy`, `Có lỗi`, `Đã hoàn thành tuần này`.

Task lifecycle:

`CAPTURED → QUEUED → RUNNING → WAITING_REVIEW → APPROVED / REVISION_REQUESTED / REJECTED → COMPLETED`

Trạng thái hệ thống phụ: `FAILED`, `CANCELLED`, `SYNC_DELAYED`.

Task detail phải có:

- Mục tiêu, prompt gốc và metadata.
- Final answer được ưu tiên đọc.
- Structured output nếu extractor đã tạo.
- Sources/citations.
- Timeline message và agent activity.
- Tool calls/log kỹ thuật thu gọn mặc định.
- Approve, Request revision, Reject, Retry (nếu lỗi).
- Liên kết tới entity, decision, memory proposal và session gốc.

### FR-03 — AFF Research

Các tab:

1. `Markets`
2. `Offers`
3. `Angles`
4. `Tests & Results`

#### Offer pipeline

`NEW → RESEARCHING → WATCHLIST → APPROVED_FOR_TEST → TESTING → ITERATE / SCALE / STOP`

Offer card/detail:

- Tên, website, network, market, audience.
- Commission type/value, cookie, payout threshold.
- Traffic source và brand bidding restriction.
- Refund/chargeback risk, policy risk, reputation.
- Score tổng và score theo tiêu chí.
- Confidence: `Verified`, `Partially verified`, `Unverified`.
- Sources và `last_verified_at` cho dữ liệu dễ thay đổi.
- Angles, tasks, decisions và test results liên quan.

Hành động chính: `Giao research`, `Đưa vào watchlist`, `Duyệt test`, `Ghi kết quả`, `Stop`.

### FR-04 — YouTube

Các tab:

1. `Niches`
2. `Ideas`
3. `Production`
4. `Performance`

Video pipeline:

`IDEA → VALIDATING → APPROVED → SCRIPTING → PRODUCING → SCHEDULED → PUBLISHED → REVIEWED`

Video detail:

- Target audience, pain point, promise, pillar.
- Titles, thumbnail concepts, hook, outline, script.
- Affiliate offer/angle liên quan.
- Copyright/reused-content risk.
- Publish URL/date.
- Impressions, CTR, views, retention 30s, average percentage viewed, subscribers, clicks, sales, revenue.
- Review và learning được đề xuất.

### FR-05 — Trí nhớ

Các tab:

- `Chờ duyệt`
- `User Profile`
- `Decision Log`
- `AFF Playbook`
- `YouTube Playbook`

Memory lifecycle:

`PROPOSED → APPROVED → ACTIVE → SUPERSEDED / REJECTED / ARCHIVED`

Quy tắc:

- Bot chỉ được tạo proposal, không tự đưa vào `ACTIVE`.
- Proposal hiển thị nội dung, loại memory, lý do, confidence và nguồn.
- Approve bắt buộc lưu `approved_by`, `approved_at`.
- Khi sửa, giữ bản đề xuất và bản đã sửa trong audit history.
- Entry mới mâu thuẫn entry active phải cảnh báo và yêu cầu supersede rõ ràng.
- Bot retrieval mặc định chỉ đọc `ACTIVE`, trừ khi prompt yêu cầu xem proposal.

### FR-06 — Global Search

Tìm kiếm hợp nhất trên:

- Task, session và message.
- Offer, market, niche, video.
- Decision và memory.
- Source URL/title.

Kết quả nhóm theo loại, có highlight và filter profile/date/status. V1 phải có full-text search; semantic search là V1.1 nếu chưa có vector store.

### FR-07 — Notification Inbox

Loại thông báo:

- Task hoàn thành và chờ duyệt.
- Task lỗi hoặc đồng bộ trễ.
- Memory proposal mới.
- Offer data quá hạn xác minh.
- Metric vượt/ngã threshold (V1.1).

Cho phép mark read, mở entity và lọc unread.

### FR-08 — Quản trị hệ thống

Giữ các chức năng hiện có, gom nhóm:

| Nhóm | Chức năng Hermes hiện tại |
|---|---|
| Agents | Profiles, Models, Skills, Plugins, MCP |
| Integrations | Channels, Webhooks, Pairing |
| Automation | Cron |
| Data & Diagnostics | Raw Sessions, Files, Logs |
| Security & Settings | Config, Keys, System |

Yêu cầu:

- Chỉ role `ADMIN` được xem Keys và thay đổi cấu hình nhạy cảm.
- Nút `Restart Gateway`, `Prune sessions`, rotate/delete key phải có confirmation.
- Prune không được xóa task/entity/memory đã được duyệt; nếu có dependency phải block hoặc chuyển archive.

## 10. Quy trình nghiệp vụ chính

### 10.1 Telegram → Task → Review

1. Người dùng gửi prompt vào một Telegram bot.
2. Hệ thống nhận event/session và gán đúng profile.
3. Tạo hoặc cập nhật task, lưu message gốc.
4. Agent chạy; progress event cập nhật activity.
5. Final answer được lưu; extractor tạo entity/memory proposal nếu có.
6. Task chuyển `WAITING_REVIEW`; notification được tạo.
7. Người dùng Approve, Request revision hoặc Reject.
8. Chỉ dữ liệu được duyệt mới chuyển thành decision/memory active hoặc pipeline action.

### 10.2 AFF → YouTube handoff

1. AFF Bot đề xuất market/audience/offer.
2. Người dùng duyệt decision.
3. Shared entity được đánh dấu `approved` và có visibility `SHARED`.
4. YouTube Bot truy xuất đúng entity đã duyệt để nghiên cứu niche/content.
5. Video liên kết với offer/angle nguồn.
6. Performance và affiliate result quay lại làm dữ liệu cho cả hai playbook.

### 10.3 Result → Learning

1. Người dùng nhập kết quả affiliate hoặc video.
2. Bot phân tích bottleneck và đề xuất learning.
3. Learning nằm ở `PROPOSED`.
4. Người dùng duyệt/sửa/từ chối.
5. Entry `ACTIVE` được bot dùng ở nhiệm vụ sau.

## 11. Business rules

- BR01: `profile_id` là bắt buộc cho task/session; entity shared vẫn phải có `created_by_profile_id`.
- BR02: không được kích hoạt memory nếu không có ít nhất một nguồn hoặc ghi rõ `manual_entry=true`.
- BR03: dữ liệu commission, cookie, policy và payout phải có `last_verified_at` và source.
- BR04: score không được lưu chỉ dưới dạng một số tổng; phải lưu score breakdown/version.
- BR05: `Approve` output không đồng nghĩa approve tất cả memory proposal; hai hành động tách biệt.
- BR06: raw log là immutable; correction tạo record/version mới.
- BR07: mọi thay đổi trạng thái quan trọng phải có audit event.
- BR08: bot không được đọc secret/key qua retrieval.
- BR09: xóa mềm mặc định cho task/entity/memory; raw session prune tuân theo retention policy.
- BR10: trạng thái hiển thị phải map rõ từ trạng thái Hermes; không suy đoán "running" chỉ vì session chưa đóng.

## 12. Yêu cầu phi chức năng

### Hiệu năng

- LCP trang Overview p75 ≤ 2.5 giây trên desktop mạng thông thường.
- API list p95 ≤ 800 ms với 10.000 tasks/messages (không tính upstream Hermes).
- Search p95 ≤ 1.5 giây.
- Progress event xuất hiện trên UI trong ≤ 3 giây từ khi backend nhận event.

### Độ tin cậy

- Event ingestion idempotent; retry không tạo task/message trùng.
- Mất kết nối realtime phải fallback polling.
- Có dead-letter/retry visibility cho event lỗi.

### Bảo mật

- Authentication bắt buộc cho toàn bộ app.
- RBAC tối thiểu: `OWNER`, `ADMIN`, `VIEWER` (V1 có thể chỉ OWNER nhưng schema phải sẵn sàng).
- Secret mã hóa at rest, không trả về frontend sau khi lưu.
- Redact token/key khỏi log, error và export.
- CSRF/XSS/SQL injection được kiểm soát theo framework.
- Rate limit login, destructive actions và webhook endpoints.

### Accessibility và responsive

- Mục tiêu WCAG 2.1 AA cho luồng chính.
- Keyboard navigation, focus visible, label cho form/icon.
- Không dùng màu đơn độc để diễn đạt trạng thái.
- Desktop ≥ 1280 px là ưu tiên; tablet 768–1279 px hoạt động đầy đủ; mobile hỗ trợ review, search và xem task, không bắt buộc admin sâu.

### Quan sát hệ thống

- Structured logs có `request_id`, `profile_id`, `task_id`, `session_id` khi có.
- Metrics: ingestion success/error, event lag, API latency, task duration, extraction failure.
- Health endpoint tách app health, database health và Hermes gateway health.

## 13. Thiết kế giao diện

### Visual direction

- Giữ dark theme nhưng tăng độ tương phản, khoảng trắng và hierarchy.
- Không bắt buộc giữ font monospace cho toàn hệ thống; chỉ dùng monospace cho ID, code và log.
- Accent: teal/green cho active/success; amber cho waiting; red cho error; blue cho info.
- Card border nhẹ; bỏ viền dày quanh mọi vùng.
- Mật độ thông tin "comfortable" mặc định, có thể thêm compact mode sau.

### Component bắt buộc

- `AppShell`, `Sidebar`, `GlobalHeader`, `ProfileSwitcher`.
- `KpiCard`, `TaskCard`, `EntityCard`, `StatusBadge`, `ConfidenceBadge`.
- `FilterBar`, `SavedViewMenu`, `GlobalSearchDialog`.
- `ActivityTimeline`, `SourceList`, `ApprovalBar`, `EmptyState`.
- `DataTable` có sort, filter, pagination và responsive strategy.
- `ConfirmDialog` cho destructive action.

### Nội dung vi mô

- Dùng tiếng Việt cho luồng nghiệp vụ; giữ thuật ngữ kỹ thuật phổ biến khi cần.
- Thay "No sessions yet" bằng "Chưa có nhiệm vụ nào — hãy gửi yêu cầu cho AFF Bot trên Telegram".
- Thay "Prune old sessions" bằng "Dọn dữ liệu phiên cũ" và đưa vào Quản trị.
- ID hiển thị dạng ngắn, có nút copy; title nghiệp vụ là nhãn chính.

## 14. Analytics events

| Event | Thuộc tính chính |
|---|---|
| `dashboard_viewed` | profile_filter, pending_count |
| `task_opened` | task_id, profile_id, source |
| `task_approved` | task_id, duration_to_review |
| `revision_requested` | task_id, reason_category |
| `memory_proposal_reviewed` | memory_id, decision |
| `entity_status_changed` | entity_type, from, to |
| `search_performed` | query_length, filters, result_count |
| `result_recorded` | result_type, linked_entity_id |

Không đưa prompt, output, key hoặc PII vào analytics bên thứ ba.

## 15. Release scope và Definition of Done

### Must have V1

- App shell và navigation mới.
- Overview.
- Task list/detail liên kết session/message.
- Profile switcher.
- AFF Offers và YouTube Videos ở mức pipeline cơ bản.
- Decision/Memory approval.
- Global full-text search.
- Admin regrouping giữ chức năng cũ.
- Audit log, auth guard và responsive cơ bản.

### Should have V1.1

- Semantic search/pgvector.
- Rule-based next best action.
- Saved views nâng cao.
- KPI charts và threshold alerts.
- Export report.

### Definition of Done toàn V1

Người dùng gửi một mission qua Telegram, nhìn thấy task trên dashboard, theo dõi trạng thái, đọc output, truy nguồn, duyệt decision/memory, chuyển entity trong pipeline, nhập kết quả thật và trong một session mới bot truy xuất đúng memory đã duyệt. Toàn bộ luồng có audit trail và không làm mất chức năng quản trị Hermes hiện tại.

---

## Phụ lục A — Mẫu structured output cho AFF task

```json
{
  "task_type": "affiliate_offer_research",
  "summary": "...",
  "offers": [
    {
      "name": "...",
      "website_url": "https://...",
      "network": "...",
      "commission": { "type": "recurring", "value": 30, "unit": "percent" },
      "cookie_days": 30,
      "confidence": "partially_verified",
      "sources": [{ "url": "https://...", "supports": ["commission", "cookie_days"] }],
      "scorecard": { "schema_version": 1, "total": 78, "breakdown": {} },
      "recommendation": "WATCHLIST"
    }
  ],
  "decision_requested": "Chọn tối đa 2 offer để nghiên cứu sâu",
  "memory_proposals": []
}
```

## Phụ lục B — Mẫu structured output cho YouTube task

```json
{
  "task_type": "youtube_video_brief",
  "summary": "...",
  "video": {
    "working_title": "...",
    "audience_id": "...",
    "pillar_id": "...",
    "offer_id": "...",
    "titles": ["..."],
    "thumbnail_concepts": ["..."],
    "hook": "...",
    "outline": ["..."],
    "copyright_risk": "low"
  },
  "decision_requested": "Duyệt video để chuyển sang SCRIPTING",
  "memory_proposals": []
}
```
