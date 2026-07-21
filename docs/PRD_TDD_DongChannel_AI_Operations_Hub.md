---
title: "PRD & TDD — DongChannel AI Operations Hub"
subtitle: "Dashboard vận hành AFF Research Bot & YouTube Global Bot"
date: "Phiên bản 1.0 • 21/07/2026"
---

**Phiên bản:** 1.0  
**Ngày:** 21/07/2026  
**Sản phẩm:** `app.dongchannel.com`  
**Đối tượng triển khai:** Claude Code  
**Phạm vi:** Thiết kế lại dashboard Hermes Agent cho hai profile `aff` và `youtube`, giữ nguyên khả năng vận hành bot qua Telegram.

> **Tuyên bố sản phẩm:** Đây không còn là một “Hermes admin panel” dùng hằng ngày. Nó phải trở thành trung tâm điều hành giúp một người biến nghiên cứu AFF và YouTube thành quyết định, nội dung, thử nghiệm và doanh thu. Các công cụ kỹ thuật của Hermes vẫn được giữ, nhưng chuyển vào khu vực Quản trị.

---

## 0. Cách Claude Code sử dụng tài liệu này

1. Đọc toàn bộ tài liệu trước khi sửa code.
2. Thực hiện **Discovery Gate** ở mục 16, lập bản đồ stack, route, API, database và component hiện tại.
3. Không thay framework, cơ chế xác thực, database hay Hermes core khi chưa có lý do được ghi lại.
4. Triển khai theo milestone M0 → M4. Mỗi milestone phải chạy test và được nghiệm thu trước khi sang milestone kế tiếp.
5. Nếu code hiện tại khác giả định trong TDD, ưu tiên giữ hành vi đang hoạt động; cập nhật implementation plan, không tự ý phá tương thích.
6. Không xóa các màn hình kỹ thuật hiện có. Chuyển chúng vào `/admin` hoặc nhóm “Quản trị hệ thống”.
7. Mọi dữ liệu mới phải liên kết ngược về `profile_id`, `session_id` và message/source gốc nếu có.

---

# PHẦN A — PRODUCT REQUIREMENTS DOCUMENT (PRD)

## 1. Bối cảnh và vấn đề

Dashboard hiện tại kế thừa cấu trúc quản trị Hermes, với nhiều mục ngang cấp: Chat, Sessions, Files, Models, Logs, Cron, Skills, Plugins, MCP, Channels, Webhooks, Pairing, Profiles, Config, Keys, System. Giao diện phù hợp cho kỹ thuật viên cấu hình agent nhưng gây quá tải cho người dùng vận hành kinh doanh hằng ngày.

Các vấn đề quan sát từ màn hình hiện tại:

- Thanh bên có quá nhiều lựa chọn và không phản ánh luồng kiếm tiền.
- Chức năng nghiệp vụ và chức năng hạ tầng đứng cùng cấp.
- Profile đang chọn được nhắc lại ở nhiều nơi nhưng vai trò chưa rõ.
- Trang Sessions ưu tiên số liệu kỹ thuật và thao tác “import/prune”, trong khi nhu cầu chính là tìm nhiệm vụ, kết quả, quyết định và việc tiếp theo.
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

**Số “learning loop” hoàn chỉnh mỗi tháng:** Research → Decision → Execute → Result → Learning được duyệt.

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

**Mục đích:** trả lời “Hôm nay tôi cần làm gì?”

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
- BR10: trạng thái hiển thị phải map rõ từ trạng thái Hermes; không suy đoán “running” chỉ vì session chưa đóng.

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
- Mật độ thông tin “comfortable” mặc định, có thể thêm compact mode sau.

### Component bắt buộc

- `AppShell`, `Sidebar`, `GlobalHeader`, `ProfileSwitcher`.
- `KpiCard`, `TaskCard`, `EntityCard`, `StatusBadge`, `ConfidenceBadge`.
- `FilterBar`, `SavedViewMenu`, `GlobalSearchDialog`.
- `ActivityTimeline`, `SourceList`, `ApprovalBar`, `EmptyState`.
- `DataTable` có sort, filter, pagination và responsive strategy.
- `ConfirmDialog` cho destructive action.

### Nội dung vi mô

- Dùng tiếng Việt cho luồng nghiệp vụ; giữ thuật ngữ kỹ thuật phổ biến khi cần.
- Thay “No sessions yet” bằng “Chưa có nhiệm vụ nào — hãy gửi yêu cầu cho AFF Bot trên Telegram”.
- Thay “Prune old sessions” bằng “Dọn dữ liệu phiên cũ” và đưa vào Quản trị.
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

# PHẦN B — TECHNICAL DESIGN DOCUMENT (TDD)

## 16. Giả định và Discovery Gate

### 16.1 Giả định thiết kế

- Hai Telegram bot đã hoạt động và map tới hai Hermes profile riêng: `aff` và `youtube`.
- Dashboard hiện tại đã có authentication, Hermes API/gateway connection và các trang quản trị.
- Stack frontend/backend/database chưa được xác minh trong tài liệu này.
- Session hiện tại là nguồn log chính; task/entity/memory là lớp nghiệp vụ bổ sung.

### 16.2 Discovery Gate — bắt buộc trước khi code

Claude Code phải tạo `docs/dashboard-discovery.md` gồm:

1. Framework, runtime, package manager và version.
2. Route tree hiện tại.
3. Component/layout/theme system.
4. Authentication, session và RBAC hiện tại.
5. Hermes API/event/websocket endpoints đang dùng.
6. Database, ORM, migration strategy và bảng hiện tại.
7. Mapping profile ↔ Telegram bot ↔ channel/session.
8. Cách session/message/tool-call đang được lưu.
9. Test framework, CI/CD, hosting và env vars.
10. Danh sách chức năng có nguy cơ regression.

**Exit criteria:** có implementation plan theo file/module cụ thể; xác nhận “reuse / adapt / new” cho từng component. Không bắt đầu migration phá schema trước khi hoàn tất gate.

## 17. Kiến trúc đề xuất

```text
Telegram Bots
      │
      ▼
Hermes Gateway / Existing API
      │ events + sessions
      ▼
Ingestion Adapter ──► Operational Service ──► PostgreSQL
      │                       │                    │
      │                       ├─ Approval/Memory   ├─ FTS / pgvector later
      │                       ├─ Search            └─ Audit/Event outbox
      │                       └─ Notification
      ▼
Realtime SSE/WebSocket
      │
      ▼
Dashboard Web App
```

### Kiến trúc nguyên tắc

- Dùng **Strangler pattern**: app shell mới bọc/route tới trang admin cũ; migrate từng module.
- Tạo `HermesAdapter` để cô lập khác biệt API/schema Hermes khỏi domain model.
- Raw data và operational data tách logic nhưng có khóa liên kết.
- Nếu codebase hiện tại là monolith, giữ monolith dạng modular; chưa cần microservice.
- Dùng outbox hoặc transaction tương đương cho state change + notification/event quan trọng.

## 18. Module boundaries

| Module | Trách nhiệm |
|---|---|
| Identity | User, role, auth, authorization |
| Profiles | Bot profile và visibility |
| Ingestion | Nhận/upsert Hermes session, message, event |
| Tasks | Task lifecycle, activity và review |
| AFF Domain | Market, offer, angle, affiliate result |
| YouTube Domain | Niche, video, production, performance |
| Knowledge | Decision, memory proposal, approval, retrieval |
| Search | Index/query hợp nhất |
| Notifications | Inbox và realtime updates |
| Admin | Proxy/wrapper các chức năng Hermes hiện tại |
| Audit | Immutable event log cho hành động quan trọng |

Không để UI gọi thẳng nhiều endpoint Hermes ở các module nghiệp vụ; đi qua backend/adapter để ổn định contract.

## 19. Data model logic

### 19.1 Core entities

| Entity | Trường tối thiểu |
|---|---|
| `profiles` | id, slug, name, type, status, created_at |
| `sessions` | id, external_id, profile_id, channel, started_at, ended_at, raw_metadata |
| `messages` | id, external_id, session_id, role, content, content_type, created_at, token_count |
| `tasks` | id, code, profile_id, source_session_id, source_message_id, title, type, status, priority, started_at, completed_at, review_status, created_at, updated_at |
| `task_activities` | id, task_id, external_event_id, event_type, step_name, status, payload_redacted, occurred_at |
| `sources` | id, url, title, publisher, accessed_at, content_hash, verification_status |
| `entity_sources` | entity_type, entity_id, source_id, field_path, claim_text |
| `decisions` | id, code, profile_id, task_id, subject_type, subject_id, decision, rationale, status, decided_by, decided_at, revisit_condition |
| `memory_entries` | id, profile_scope, category, title, content, status, confidence, source_task_id, approved_by, approved_at, supersedes_id, version, created_at |
| `notifications` | id, user_id, type, entity_type, entity_id, title, read_at, created_at |
| `audit_events` | id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, request_id, created_at |

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

- Unique `(profile_id, external_session_id)`.
- Unique `(session_id, external_message_id)`.
- Unique `external_event_id` khi upstream cung cấp; nếu không, tạo deterministic key từ session + type + timestamp bucket + payload hash.
- `task.code` dạng human-readable `AFF-0001`, `YT-0001`; database ID vẫn dùng UUID/ULID.

## 20. API contract đề xuất

Prefix: `/api/v1`. Có thể đổi theo convention hiện tại nhưng phải giữ semantics.

### Dashboard và task

| Method | Endpoint | Mục đích |
|---|---|---|
| GET | `/dashboard/summary` | KPI, inbox, active tasks, recent results |
| GET | `/tasks` | List + filter + cursor pagination |
| GET | `/tasks/{id}` | Detail tổng hợp |
| POST | `/tasks/{id}/approve` | Approve task output |
| POST | `/tasks/{id}/request-revision` | Ghi feedback và tạo revision action |
| POST | `/tasks/{id}/reject` | Reject kèm lý do |
| POST | `/tasks/{id}/retry` | Retry task lỗi, có idempotency key |
| GET | `/tasks/{id}/activities` | Timeline; có thể stream/paginate |

### Domain

| Method | Endpoint | Mục đích |
|---|---|---|
| GET/POST | `/aff/offers` | List/create offer |
| GET/PATCH | `/aff/offers/{id}` | Detail/update/version |
| POST | `/aff/offers/{id}/transition` | Chuyển pipeline có validation |
| POST | `/aff/results` | Nhập test result |
| GET/POST | `/youtube/videos` | List/create video |
| GET/PATCH | `/youtube/videos/{id}` | Detail/update |
| POST | `/youtube/videos/{id}/transition` | Chuyển production status |
| POST | `/youtube/metrics` | Nhập/sync performance |

### Knowledge và search

| Method | Endpoint | Mục đích |
|---|---|---|
| GET | `/memory?status=PROPOSED` | Queue chờ duyệt |
| POST | `/memory/{id}/approve` | Approve hoặc approve-with-edits |
| POST | `/memory/{id}/reject` | Reject proposal |
| POST | `/memory/{id}/supersede` | Thay thế entry active |
| GET | `/search?q=` | Unified search |
| GET | `/notifications` | Inbox |
| POST | `/notifications/{id}/read` | Mark read |

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

Adapter map event thực tế của Hermes sang canonical event. Lưu raw reference/payload đã redact để debug.

### Xử lý event

1. Verify signature/auth nếu webhook.
2. Validate schema và profile mapping.
3. Dedupe theo idempotency key.
4. Persist event trước khi project vào task/activity.
5. Commit operational update.
6. Publish realtime notification qua SSE/WebSocket.
7. Retry exponential backoff; lỗi cuối vào dead-letter state có UI cảnh báo.

SSE là lựa chọn đơn giản cho one-way progress; nếu codebase đã có WebSocket ổn định thì reuse.

## 22. Search và retrieval

### V1

- PostgreSQL full-text hoặc search engine hiện có.
- Index title, message content, final output, entity name/summary, decision rationale và active memory.
- Permission/profile filter được áp dụng ở query layer, không lọc sau khi trả dữ liệu.

### V1.1 semantic retrieval

- `pgvector` nếu dùng PostgreSQL.
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
/admin/*
```

### State strategy

- Server state: dùng query/cache library hiện có; không thêm thư viện mới nếu codebase đã có giải pháp.
- URL là nguồn sự thật cho filter/sort/page để bookmark được.
- Local state chỉ cho UI tạm thời như dialog, drawer.
- Optimistic UI chỉ dùng cho mark-read và thao tác dễ rollback; approve/transition chờ server xác nhận.

### Loading/error/empty

- Skeleton ở list/card, không spinner toàn trang kéo dài.
- Error boundary theo route; lỗi một widget không làm sập Overview.
- Retry action rõ ràng, hiển thị request ID cho support.
- Empty state riêng theo filter empty và system empty.

## 25. Migration và backward compatibility

### M0 — Baseline

- Snapshot route/API/schema hiện tại.
- Thêm regression/smoke test cho login, profile switching, Telegram session capture, admin pages.
- Feature flag `new_ops_dashboard`.

### M1 — New shell, no data migration

- AppShell/navigation/profile switcher mới.
- Route các trang kỹ thuật cũ vào `/admin`.
- Overview ban đầu đọc aggregate từ dữ liệu hiện có.

### M2 — Task projection

- Thêm bảng task/activity và ingestion adapter.
- Backfill session lịch sử thành task ở trạng thái `IMPORTED` hoặc `COMPLETED`; không giả định review state.
- Dual-read hoặc projection theo feature flag.

### M3 — Domain + approval

- Thêm offer/video/decision/memory.
- Extractor ban đầu có thể manual/structured JSON; failure không làm mất final answer.
- Triển khai approval và audit.

### M4 — Search + results + hardening

- Unified search.
- Affiliate/video result forms.
- Performance, security, a11y và observability hardening.

Rollback:

- Có thể tắt feature flag và quay về admin/session UI cũ.
- Migration additive trước; không drop/rename cột cũ trong V1.
- Backfill có checkpoint, dry-run, counts và rerun idempotent.

## 26. Testing strategy

### Unit tests

- State transition guards.
- Profile/session/task mapping.
- Score calculation/versioning.
- Memory approval/supersede rules.
- Event deduplication và redaction.

### Integration tests

- Hermes event → session/message/task/activity.
- Task completion → notification.
- Approve memory → active retrieval index.
- Revision request → task state/action.
- Prune raw session không phá approved entity reference.
- Authorization cho admin/secret endpoints.

### E2E critical paths

1. Login → Overview.
2. Telegram event fixture → task appears.
3. Open task → read final output → source session.
4. Approve decision nhưng memory vẫn pending.
5. Approve memory → xuất hiện ở Active.
6. AFF offer approved → link sang YouTube video.
7. Record video/affiliate result → learning proposal.
8. Search trả đúng task/entity/memory theo profile.
9. Admin pages cũ vẫn truy cập và hoạt động.

### Visual và accessibility

- Screenshot test desktop 1440, laptop 1280, tablet 768, mobile 390 cho route chính.
- Axe/accessibility scan cho AppShell, task detail, form approval.
- Kiểm tra keyboard-only và contrast.

### Performance

- Seed tối thiểu 10k tasks, 100k messages, 5k entities.
- Load test list/search/dashboard aggregate.
- Test reconnect realtime và event burst.

## 27. Security checklist

- [ ] Không commit `.env`, token Telegram, API key hoặc cookie.
- [ ] Secret không xuất hiện trong API response/log/client bundle.
- [ ] Webhook verify signature hoặc shared secret; có replay protection.
- [ ] HTML/Markdown output của bot được sanitize.
- [ ] External link dùng safe attributes và hiển thị domain.
- [ ] File upload kiểm tra MIME, size và access control.
- [ ] Destructive action có confirm + audit.
- [ ] Rate limiting và brute-force protection.
- [ ] Backup/restore test cho operational DB.
- [ ] Retention policy cho raw messages/log được cấu hình.

## 28. Observability và vận hành

Dashboard quản trị cần có:

- Gateway connection status và `last_seen_at`.
- Event ingestion lag, last successful event.
- Failed events và retry count.
- Extraction errors.
- Database migration version.
- Build/version SHA.

Alert mức tối thiểu:

- Không nhận event từ bot đang active quá ngưỡng cấu hình.
- Ingestion error rate > 5% trong 5 phút.
- Queue/dead-letter tăng liên tục.
- Database hoặc Hermes upstream unavailable.

## 29. Implementation backlog cho Claude Code

| ID | Story | Ưu tiên | Phụ thuộc |
|---|---|---|---|
| DC-001 | Discovery + regression baseline | P0 | — |
| DC-002 | AppShell và nav mới | P0 | DC-001 |
| DC-003 | Profile switcher toàn cục | P0 | DC-001 |
| DC-004 | Chuyển trang cũ vào Admin | P0 | DC-002 |
| DC-005 | Dashboard summary API/UI | P0 | DC-002 |
| DC-006 | Task projection từ sessions | P0 | DC-001 |
| DC-007 | Task list/filter/search cơ bản | P0 | DC-006 |
| DC-008 | Task detail + activity timeline | P0 | DC-006 |
| DC-009 | Review actions + audit | P0 | DC-008 |
| DC-010 | Memory proposal/approval | P0 | DC-009 |
| DC-011 | AFF offer pipeline | P1 | DC-006 |
| DC-012 | YouTube video pipeline | P1 | DC-006 |
| DC-013 | Unified search | P1 | DC-007, DC-010 |
| DC-014 | Result forms | P1 | DC-011, DC-012 |
| DC-015 | Notifications/realtime | P1 | DC-006 |
| DC-016 | Responsive/a11y/security hardening | P0 release gate | All P0 |

## 30. Acceptance test script cho chủ sản phẩm

1. Đăng nhập và xác nhận chỉ thấy tối đa 6 mục điều hướng chính.
2. Chọn `Tất cả`, `AFF Bot`, `YouTube Bot`; dữ liệu thay đổi đúng và không mất route.
3. Gửi `MISSION AFF-TEST-001` qua Telegram.
4. Xác nhận task xuất hiện, đúng profile, prompt và timestamp.
5. Khi bot chạy, activity cập nhật; tool/log mặc định thu gọn.
6. Khi xong, nhận notification và mở final answer.
7. Mở source session/message từ task.
8. Request revision một lần, kiểm tra lịch sử được giữ.
9. Approve output; kiểm tra decision được tạo.
10. Kiểm tra memory proposal chưa active trước khi approve riêng.
11. Approve memory, mở session mới và kiểm tra bot tìm đúng entry kèm nguồn.
12. Tạo/duyệt một offer, liên kết nó với một video idea.
13. Nhập kết quả video/AFF, kiểm tra learning proposal.
14. Tìm lại mission bằng global search.
15. Mở Quản trị, xác nhận Sessions/Models/Logs/Skills/Config cũ vẫn hoạt động.

## 31. Rủi ro và phương án xử lý

| Rủi ro | Tác động | Giảm thiểu |
|---|---|---|
| Hermes schema/event thay đổi | Mất đồng bộ | Adapter + contract test + raw event retention |
| Tạo entity sai từ output tự do | Memory nhiễu | Proposal + human approval + confidence/source |
| Migration làm mất chức năng admin | Vận hành bot bị gián đoạn | Strangler + feature flag + smoke test |
| Search lộ dữ liệu profile/secret | Bảo mật | Query-level authorization + redaction |
| Dashboard trở nên phức tạp lần nữa | UX thất bại | Tối đa 6 nav, progressive disclosure, usability test |
| Quá nhiều scope V1 | Chậm ra sản phẩm | P0 trước; semantic/charts/automation để V1.1 |

## 32. Quyết định thiết kế cần chủ sản phẩm xác nhận

Tài liệu này mặc định các lựa chọn sau để Claude Code có thể bắt đầu:

1. Dashboard dùng chung cho cả AFF và YouTube; profile là global filter.
2. Telegram vẫn là kênh giao việc chính trong V1.
3. Dark theme được giữ nhưng làm sạch và hiện đại hơn.
4. Toàn bộ chức năng Hermes hiện tại được giữ trong Quản trị.
5. Memory bắt buộc phê duyệt thủ công trước khi active.
6. V1 ưu tiên Closed Loop hơn biểu đồ đẹp hoặc automation nâng cao.

Nếu không có phản hồi khác, sáu lựa chọn này được xem là baseline đã chấp thuận cho implementation planning.

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

## Phụ lục C — Prompt khởi động cho Claude Code

```text
Hãy đọc file docs/PRD_TDD_DongChannel_AI_Operations_Hub.md và coi đây là source of truth cho redesign dashboard.

Trước khi sửa code:
1. Khảo sát repository theo mục 16.2 Discovery Gate.
2. Tạo docs/dashboard-discovery.md.
3. Lập bảng mapping yêu cầu P0 → file/module hiện tại → thay đổi đề xuất → rủi ro.
4. Chạy baseline tests và ghi lại kết quả.
5. Đề xuất implementation plan theo M0–M4, chia nhỏ commit.

Ràng buộc:
- Không thay framework/database/auth nếu chưa chứng minh cần thiết.
- Không xóa chức năng Hermes hiện có; chuyển chúng vào /admin.
- Dùng feature flag cho dashboard mới.
- Migration phải additive và có rollback.
- Không được đưa secret vào frontend, log hoặc test fixture.
- Dừng lại xin xác nhận sau Discovery Gate và trước migration schema đầu tiên.
```
