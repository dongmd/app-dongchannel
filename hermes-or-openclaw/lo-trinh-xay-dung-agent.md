# Lộ trình xây dựng hệ thống Agent — Research Aff Global + Kênh YouTube quốc tế

**Nền tảng:** Hermes Agent · 1 VPS Ubuntu · 1 tên miền · Telegram · OpenRouter
**Ngân sách:** dưới $50/tháng cho API model
**Lập:** 20/07/2026

---

## Đọc phần này trước

Ba điều tôi phát hiện khi research, có thể trái kỳ vọng của bạn. Biết trước sẽ đỡ mất thời gian.

**1. Không có sẵn tích hợp YouTube, Google Analytics, Search Console hay SEO tool nào.**
Tôi đã rà toàn bộ docs và catalog MCP của Hermes. Những gì được tài liệu hóa: GitHub, Linear, Filesystem, Playwright, Stripe, Google Drive, n8n. 
**Không có** YouTube, GA, GSC, Ahrefs, Semrush, Google Sheets, RSS. Bạn sẽ phải tự viết script gọi YouTube Data API v3 và cho agent chạy qua tool terminal. 
Đây là việc làm được, nhưng là *bạn xây*, không phải *cắm vào là chạy*.

**2. Agent không tự nhắn tin cho bạn được.**
Không tồn tại tool `send_message` hay `notify` nào cho agent gọi. 
Mọi tin nhắn chủ động đều đi qua **gateway**: cron job có `deliver: telegram`, hoặc đăng ký nhận thông báo Kanban. 
Bạn không thể bảo "nhắn tao lúc 9h" — bạn phải tạo cron job.

**3. Model tôi đề xuất ở tài liệu trước cần sửa.**
`gemini-3-flash-preview` giá **$1.50 / $9.00** mỗi triệu token (vào/ra). 
`gemini-2.5-flash` giá **$0.30 / $2.50** — rẻ hơn 5 lần đầu vào, 3.6 lần đầu ra. 
Với ngân sách $50, dùng **2.5 Flash** làm ngựa thồ. Chênh lệch chất lượng không đáng để trả gấp 5 lần cho việc tóm tắt trang web.

---

## Phần 1 — Kiến trúc tổng thể

### 1.1 Hai agent riêng, không phải một

Hermes có khái niệm **profile**: mỗi profile là một thư mục home riêng, có `config.yaml`, `.env`, `SOUL.md`, memory, session, skill, cron job riêng.

Tách làm hai:

| Profile | Việc | Model chính |
|---|---|---|
| `aff` | Quét network, đánh giá offer, phân tích đối thủ aff | Gemini 2.5 Flash |
| `yt` | Nghiên cứu niche, keyword, phân tích kênh đối thủ, ý tưởng nội dung | Gemini 2.5 Flash |

Lý do tách, không phải để cho gọn:

- **Memory không lẫn nhau.** Ngân sách memory rất chặt (2.200 ký tự cho `MEMORY.md`). Nếu nhét cả tiêu chí aff lẫn tiêu chí YouTube vào một chỗ, cả hai đều bị cắt xén.
- **Skill không lẫn nhau.** Skill nạp vào system prompt; agent aff không cần biết cách phân tích thumbnail.
- **Chi phí tách bạch.** Dashboard Analytics cho bạn thấy từng profile tốn bao nhiêu.

```bash
hermes profile create aff --description "Nghiên cứu offer affiliate global: quét network, đánh giá payout/EPC, phân tích lander đối thủ."
hermes profile create yt  --description "Nghiên cứu kênh YouTube thị trường US/EU: niche, keyword, phân tích kênh đối thủ, ý tưởng nội dung."
```

> ⚠️ Docs nói rõ: *"Profiles are not sandboxes... A profile does not stop it from accessing folders outside the profile directory."* 
Tách profile là để tổ chức công việc, **không phải** để cách ly bảo mật. Cách ly vẫn dựa vào Docker như tài liệu cài đặt.

**Lưu ý bot token:** hai profile không dùng chung một bot token Telegram được — gateway thứ hai sẽ bị chặn. 
Hoặc tạo hai bot riêng, hoặc chỉ chạy gateway cho một profile và dùng Kanban để điều phối việc của profile kia.

### 1.2 Kanban làm xương sống

Đây là tính năng tôi nghĩ bạn sẽ dùng nhiều nhất mà chưa biết nó tồn tại.

> *"Hermes Kanban is a durable task board, shared across all your Hermes profiles... 
Every task is a row in `~/.hermes/kanban.db`; every handoff is a row anyone can read and write; every worker is a full OS process with its own identity."*

Khác biệt so với subagent, docs tóm gọn: *"`delegate_task` is a function call; Kanban is a work queue where every handoff is a row any profile (or human) can see and edit."*

Cụ thể với bạn: bạn ném vào board "nghiên cứu vertical X", nó tự tách thành các task con giao cho từng profile, 
chạy song song, và **bạn nhìn thấy toàn bộ tiến trình trên dashboard**. Task nào xong, Telegram báo.

Cột trạng thái: `triage → todo → ready → running → blocked → done → archived`

Khởi tạo:

```bash
hermes kanban init
hermes kanban boards create aff-global --name "Aff Global" --icon 💰 --switch
hermes kanban boards create youtube --name "YouTube" --icon 📹
```

Hai lệnh đáng giá nhất:

```bash
hermes kanban specify <id>      # ý tưởng một dòng → spec đầy đủ, chuyển triage → todo
hermes kanban decompose <id>    # → đồ thị task con, tự giao cho profile phù hợp
```

`decompose` dựa vào **mô tả profile** để quyết định giao việc cho ai — đây là lý do phải đặt `--description` tử tế khi tạo profile ở mục 1.1.

Cấu hình chống đốt tiền:

```yaml
kanban:
  dispatch_in_gateway: true
  dispatch_interval_seconds: 60
  max_in_progress: 2                # trần toàn board
  max_in_progress_per_profile: 1
  auto_decompose: true
  auto_decompose_per_tick: 1        # mặc định 3 — hạ xuống 1 với ngân sách $50
  failure_limit: 2
  dispatch_stale_timeout_seconds: 14400
```

> `auto_decompose_per_tick` mặc định là 3. Docs ghi rõ mục đích: *"prevents burst-spending the aux LLM"*. Với ngân sách của bạn, hạ xuống 1.

Nhận thông báo về Telegram:

```bash
hermes kanban notify-subscribe t_abcd --platform telegram --chat-id <chat_id>
```

Khi bạn tạo task bằng `/kanban create` ngay trong Telegram, chat đó **tự động** được đăng ký nhận thông báo.

### 1.3 Cron làm nhịp tim

Cron do gateway chạy, tick mỗi 60 giây. Đây là cách duy nhất để agent chủ động gửi tin cho bạn.

Điểm mạnh nhất là **`context_from`** — nối các job thành pipeline, job sau nhận output job trước:

```python
# Job 1 — thu thập thô (model rẻ)
cronjob(action="create",
    prompt="Quét 10 offer mới nhất trong vertical [X]. Lưu vào ~/.hermes/data/aff/raw-{date}.md gồm: tên offer, network, payout, GEO, traffic type được phép.",
    schedule="0 6 * * *",
    enabled_toolsets=["web", "file"],
    name="Aff Collector")

# Job 2 — chấm điểm, nhận output Job 1
cronjob(action="create",
    prompt="Đọc file raw mới nhất. Chấm mỗi offer 1–10 theo tiêu chí trong MEMORY.md. Xuất top 5 ra ~/.hermes/data/aff/ranked-{date}.md.",
    schedule="15 6 * * *",
    context_from="<job1_id>",
    enabled_toolsets=["file"],
    name="Aff Triage")

# Job 3 — giao hàng về Telegram
cronjob(action="create",
    prompt="Đọc file ranked mới nhất. Viết bản tóm tắt ngắn: 5 offer đáng chú ý, mỗi cái 2 dòng lý do.",
    schedule="30 6 * * *",
    context_from="<job2_id>",
    deliver="telegram",
    enabled_toolsets=["file"],
    name="Aff Brief")
```

**`enabled_toolsets` là đòn bẩy chi phí bị bỏ quên.** 
Docs nói thẳng: *"carrying `browser`, `delegation` into every tiny 'fetch news' job bloats the tool-schema prompt on every LLM call."* 
Job chỉ đọc file thì đừng nạp `browser`. Schema tool đi kèm **mọi** lượt gọi LLM trong job đó.

Hai cơ chế tiết kiệm nữa:

- **`--no-agent`** — chạy script thuần, **0 đồng token**. Dùng cho việc lấy dữ liệu YouTube API, kiểm tra uptime, đọc RSS.
- **`wakeAgent` gate** — script tiền xử lý trả `{"wakeAgent": false}` ở dòng stdout cuối để bỏ qua lượt đó mà không gọi LLM. Ví dụ: chỉ đánh thức agent khi API trả về video mới.

Đây chính là cách sống được với $50/tháng: **để script làm việc thu thập, chỉ gọi LLM khi có gì đó đáng suy nghĩ.**

Một bảo hiểm quan trọng: job không ghim model sẽ chụp lại model mặc định lúc tạo. 
Nếu sau này bạn đổi model mặc định, job **fail closed** — bỏ qua lượt chạy, không gọi API, gửi cảnh báo. Đây là chống bất ngờ hóa đơn, không phải lỗi.

### 1.4 Sơ đồ

```
                    ┌─────────────────────────┐
   Telegram  ◄──────┤   Hermes Gateway        │
   (bạn)            │   (tick 60s)            │
                    └────┬───────────────┬────┘
                         │               │
                    ┌────▼────┐     ┌────▼─────┐
                    │  Cron   │     │  Kanban  │
                    │ pipeline│     │  board   │
                    └────┬────┘     └────┬─────┘
                         │               │
              ┌──────────┴───────┬───────┴──────────┐
              │                  │                  │
        ┌─────▼─────┐      ┌─────▼─────┐     ┌──────▼──────┐
        │ profile   │      │ profile   │     │  script      │
        │   aff     │      │   yt      │     │ --no-agent   │
        │ Flash 2.5 │      │ Flash 2.5 │     │  (0 token)   │
        └───────────┘      └───────────┘     └──────────────┘
              │                  │
              └────────┬─────────┘
                       │  (hằng tuần, Sonnet 4.6)
                 ┌─────▼──────┐
                 │ Tổng hợp   │──► Telegram + file
                 └────────────┘
```

---

## Phần 2 — Lộ trình 8 tuần

### Tuần 1–2: Nền móng

**Mục tiêu:** agent chạy được, nói chuyện được qua Telegram, chưa cần thông minh.

- [ ] Dựng VPS + Docker theo `huong-dan-cai-dat-hermes-vps.md`
- [ ] Trỏ domain về VPS, dựng Caddy + HTTPS (mục 3 dưới đây)
- [ ] Tạo profile `aff` và `yt` với `--description` rõ ràng
- [ ] Nối Telegram, đặt `/sethome` trong chat bạn muốn nhận báo cáo
- [ ] `hermes kanban init` + tạo 2 board
- [ ] Bật `write_approval: true` cho cả memory và skills
- [ ] Nạp tiêu chí vào memory từng profile

Nội dung memory cho profile `aff` (nhớ: chỉ 2.200 ký tự, viết cô đọng):

```
GEO ưu tiên: US, CA, UK, AU, DE
Payout tối thiểu: $30 CPA hoặc $1.5 EPC
Vertical: [điền của bạn]
Traffic: SEO + YouTube organic. KHÔNG chạy paid.
Loại bỏ: offer yêu cầu call center, offer có cap dưới 50/ngày
Network đã loại: [cập nhật dần]
```

**Chưa làm gì ở giai đoạn này:** đừng viết skill, đừng dựng cron. Hãy dùng tay 2 tuần để hiểu agent làm tốt gì và dở gì. Skill viết sớm dựa trên giả định sai sẽ phải bỏ.

### Tuần 3–4: Tự động hóa thu thập

**Mục tiêu:** dữ liệu tự chảy về mà chưa cần agent phân tích sâu.

- [ ] Đăng ký khóa web search (xem 2.1)
- [ ] Viết script YouTube Data API (xem 2.2), chạy bằng cron `--no-agent`
- [ ] Dựng pipeline cron 3 tầng cho aff (mục 1.3)
- [ ] Dựng pipeline tương tự cho yt
- [ ] Theo dõi trang Analytics trên dashboard mỗi ngày — bạn cần biết con số thật trước khi mở rộng

#### 2.1 Web search backend

Hermes hỗ trợ 8 backend. Với ngân sách $50, thứ tự ưu tiên:

| Backend | Biến môi trường | Search | Extract | Ghi chú |
|---|---|---|---|---|
| **DuckDuckGo** | *(không cần key)* | ✔ | — | Miễn phí. Bắt đầu ở đây. |
| **Brave** | `BRAVE_SEARCH_API_KEY` | ✔ | — | Có gói free tier |
| **Firecrawl** | `FIRECRAWL_API_KEY` | ✔ | ✔ | Mặc định. Extract tốt, tốn tiền. |
| **Tavily** | `TAVILY_API_KEY` | ✔ | ✔ | Thiết kế cho agent |
| **SearXNG** | `SEARXNG_URL` | ✔ | — | Tự host — miễn phí vĩnh viễn, tốn công |

```yaml
web:
  backend: ddgs      # bắt đầu miễn phí, nâng cấp khi thấy chất lượng không đủ
```

> **Gợi ý cho người tiết kiệm:** SearXNG tự host trên chính VPS này. Tốn một buổi cấu hình, sau đó search không giới hạn và không tốn đồng nào. 
Với workflow quét hàng ngày, đây là khoản đầu tư hoàn vốn trong tháng đầu.

#### 2.2 YouTube — phải tự xây

Không có MCP. Nhưng YouTube Data API v3 **miễn phí** và đủ dùng:

- 10.000 đơn vị quota/ngày, reset lúc 0h giờ Thái Bình Dương
- `search.list` = 100 đơn vị · `videos.list` = 1 đơn vị · `channels.list` = 1 đơn vị
- **Ràng buộc thật nằm ở đây:** có một pool riêng giới hạn **100 lần gọi `search.list`/ngày**, độc lập với 10.000 đơn vị. Còn 9.000 đơn vị vẫn bị chặn nếu đã gọi search 100 lần.
- Không có gói trả tiền để mua thêm. Hết quota thì phải xin Google thủ công.

Chiến lược đúng: **dùng `search.list` rất tiết kiệm** (chỉ để khám phá kênh/từ khóa mới), rồi dùng `videos.list` và `channels.list` (1 đơn vị) để lấy chi tiết hàng loạt — 50 ID mỗi lần gọi.

Đặt script tại `~/.hermes/scripts/` (bắt buộc — cron `--script` chỉ đọc thư mục này):

```bash
hermes cron create "0 5 * * *" \
  --no-agent \
  --script yt-fetch.sh \
  --name "YT data fetch"
```

Script ghi ra file, agent đọc file ở job sau. **Không tốn một token nào cho khâu lấy dữ liệu.**

### Tuần 5–6: Vòng lặp học

**Mục tiêu:** agent bắt đầu tự viết quy trình.

- [ ] Sau mỗi phiên nghiên cứu tốt, bảo agent: *"Viết lại quy trình vừa rồi thành skill"*
- [ ] Duyệt kỹ qua `/skills pending` → `/skills diff <id>` → `/skills approve <id>`
- [ ] Rà `/memory pending` hàng tuần
- [ ] Bắt đầu dùng Kanban cho việc nhiều bước

**Bộ skill khởi đầu nên có** — đừng viết sẵn hết, để agent tự đề xuất rồi bạn sửa:

*Profile `aff`:*
- `danh-gia-offer` — quy trình chấm một offer theo tiêu chí trong memory
- `mo-lander` — phân tích cấu trúc landing page đối thủ: hook, angle, CTA, social proof
- `check-geo-compliance` — rà quy định quảng cáo theo GEO

*Profile `yt`:*
- `phan-tich-kenh` — mổ một kênh đối thủ: tần suất đăng, độ dài video, mẫu tiêu đề, chủ đề ăn khách
- `nghien-cuu-keyword` — tìm từ khóa có volume mà cạnh tranh yếu
- `y-tuong-noi-dung` — từ dữ liệu keyword sinh outline video

> **Cảnh báo về cloaking.** Lander aff thường trả nội dung khác nhau cho bot và người thật. 
Skill `mo-lander` cần có bước kiểm tra chéo — ví dụ so nội dung agent thấy với ảnh chụp màn hình từ browser tool. 
Nếu bỏ qua, agent sẽ tự tin phân tích một trang safe page và bạn xây chiến lược trên dữ liệu sai.

### Tuần 7–8: Tinh chỉnh và mở rộng

- [ ] Xem lại Analytics: model nào tốn nhất, có đáng không
- [ ] Điều chỉnh khe auxiliary dựa trên số liệu thật
- [ ] Bật `max_spawn_depth: 2` nếu ngân sách còn dư
- [ ] Dựng landing page trên domain (nếu đã chọn được vertical)
- [ ] Thiết lập nhịp báo cáo tuần bằng Sonnet 4.6

---

## Phần 3 — Dashboard

### 3.1 Dashboard có sẵn — 17 trang

Bạn không cần tự dựng dashboard. Hermes có sẵn, và nó đầy đủ hơn bạn nghĩ. Những trang đáng quan tâm nhất với bạn:

| Trang | Vì sao quan trọng với bạn |
|---|---|
| **Analytics** | ⭐ Trang bạn sẽ mở nhiều nhất. Tổng token vào/ra, **tỷ lệ cache hit**, chi phí ước tính, biểu đồ cột theo ngày, bảng chi tiết từng ngày, và **phân tách chi phí theo từng model**. Chọn khoảng 7/30/90 ngày. |
| **Kanban** | Bảng công việc trực quan, kéo thả, lane theo profile, cập nhật realtime qua WebSocket, nút ⚗ Decompose / ✨ Specify. |
| **Cron** | Danh sách job, lịch, trạng thái, lần chạy tiếp theo, Pause/Resume/Trigger now. Gộp chung mọi profile. |
| **Sessions** | Tìm kiếm toàn văn (FTS5) mọi phiên đã chạy. Hữu ích khi cần tìm lại "hôm trước agent nói gì về offer X". |
| **Status** | Trang chủ. Gateway sống hay chết, 20 phiên gần nhất kèm token đã dùng. |
| **Profiles** | Quản lý cả hai agent, đổi model, sửa mô tả và SOUL.md. |
| **Logs** | Lọc theo mức độ và thành phần, tail trực tiếp mỗi 5 giây. |
| **System** | Tài nguyên VPS, cập nhật, backup/restore, security audit. |

Còn: Chat (TUI nhúng ngay trong trình duyệt), Config (form sửa 150+ trường), API Keys, Skills, MCP, Webhooks, Pairing, Channels.

**Giới hạn cần biết:** Analytics chỉ **hiển thị** chi phí. Không có hạn mức chi tiêu, không có cảnh báo vượt ngân sách, không có chặn tự động. Muốn không vỡ ngân sách, bạn phải tự nhìn — hoặc dựng cron job ở mục 3.3.

### 3.2 Đưa dashboard lên domain

Đây là chỗ dùng tên miền của bạn. Ví dụ `dashboard.doanhnghiepmotnguoi.com`.

**Cách an toàn nhất theo docs: dùng OAuth Nous Portal.** Docs nói rõ đây là provider duy nhất phù hợp để mở ra internet:

> *"Because every login is verified against Nous Portal and protected by your Nous account, the Nous provider is the one suitable for exposing a dashboard to the public internet."*

Còn username/password thì:

> *"Use this on trusted networks only — not the public internet... it is not suitable for exposing a dashboard directly to the public internet."*

Ba lựa chọn, xếp theo mức an toàn:

| Cách | An toàn | Tiện | Khi nào chọn |
|---|---|---|---|
| **SSH tunnel** (không dùng domain) | Cao nhất | Thấp — phải mở terminal | Nếu bạn chỉ truy cập từ 1–2 máy |
| **Tailscale** | Cao | Trung bình — cần cài app | Nếu muốn xem từ điện thoại mà không mở port |
| **Domain + Caddy + OAuth Nous** | Khá | Cao nhất | Nếu muốn mở trình duyệt bất kỳ là vào được |

Tôi đưa cấu hình đầy đủ cho phương án 3 trong file `docker-compose-full.yml` và `Caddyfile` đi kèm.

Điểm mấu chốt: **không publish port 9119 ra host.** Caddy nói chuyện với Hermes qua mạng nội bộ Docker. Chỉ 80/443 mở ra internet.

Đăng ký OAuth client:

```bash
docker exec -it hermes hermes dashboard register \
  --redirect-uri https://dashboard.doanhnghiepmotnguoi.com/auth/callback
```

Lệnh này ghi `HERMES_DASHBOARD_OAUTH_CLIENT_ID` vào `~/.hermes/.env`.

> ⚠️ **Cảnh báo nghiêm trọng từ docs:** middleware xác thực của dashboard **bỏ qua `/api/plugins/`** — các route plugin (gồm cả Kanban REST) không có xác thực, 
vì dashboard vốn thiết kế để bind localhost. Điều này có nghĩa: nếu bạn mở dashboard ra mạng, **API Kanban truy cập được mà không cần đăng nhập**. 
Đây là lý do phải để Caddy đứng trước và không publish 9119.

Nếu muốn chặt hơn nữa, chặn đường dẫn đó ngay tại Caddy:

```caddyfile
dashboard.doanhnghiepmotnguoi.com {
    @plugins path /api/plugins/*
    respond @plugins 403

    reverse_proxy hermes:9119 {
        flush_interval -1
    }
}
```

Đánh đổi: làm vậy thì panel Kanban trên dashboard sẽ hỏng. Chỉ chặn nếu bạn dùng Kanban qua CLI và Telegram là chính.

### 3.3 Dashboard cảnh báo chi phí — tự dựng

Hermes không có cảnh báo ngân sách. Nhưng có REST endpoint:

```
GET /api/analytics/usage?days=30
```

Dựng một cron job `--no-agent` gọi endpoint này, so với ngưỡng, chỉ báo khi vượt:

```bash
hermes cron create "0 8 * * *" \
  --no-agent \
  --script check-budget.sh \
  --deliver telegram \
  --name "Budget watchdog"
```

Script trả stdout rỗng khi mọi thứ ổn → không có tin nhắn. Chỉ khi vượt ngưỡng mới in ra và bạn nhận được cảnh báo. Tốn 0 token.

Đây là mẫu đáng nhân rộng: **cảnh báo theo ngoại lệ, không phải báo cáo định kỳ.** Báo cáo hàng ngày sẽ bị bạn lướt qua sau hai tuần; cảnh báo chỉ đến khi có chuyện thì bạn sẽ đọc.

---

## Phần 4 — Bài toán chi phí

### 4.1 Giá thực tế (tháng 7/2026, qua OpenRouter)

| Model | Vào ($/1M) | Ra ($/1M) |
|---|---|---|
| Gemini 2.5 Flash | 0,30 | 2,50 |
| Gemini 3.5 Flash | 1,50 | 9,00 |
| Claude Sonnet 4.6 | 3,00 | 15,00 |
| Claude Opus 4.8 | 5,00 | 25,00 |

OpenRouter thu **phí 5,5% khi nạp credit**, không cộng thêm vào giá token. Nạp $50 thì dùng được khoảng **$47,4**.

### 4.2 Cái bẫy khiến ước tính của mọi người sai

Người mới luôn tính: "20 trang × 15K token = 300K token = $0,09. Rẻ quá."

Sai ở chỗ: agent chạy **vòng lặp**. Mỗi lần gọi tool, **toàn bộ hội thoại từ đầu** được gửi lại. Một phiên 25 lượt với context trung bình 60K token không tốn 60K — nó tốn khoảng **1,5 triệu** token đầu vào.

Tính lại cho đúng:

| Hoạt động | Model | Token vào/phiên | Chi phí/phiên |
|---|---|---|---|
| Quét aff hằng ngày | Flash 2.5 | ~1,5M | ~$0,53 |
| Quét YouTube hằng ngày | Flash 2.5 | ~1,2M | ~$0,42 |
| Tổng hợp hằng tuần | Sonnet 4.6 | ~1,0M | ~$3,30 |

**Ước tính tháng:**

```
Quét hằng ngày:    ($0,53 + $0,42) × 30  ≈  $28,50
Tổng hợp hằng tuần:      $3,30 × 4        ≈  $13,20
                                          ─────────
                                    Tổng ≈  $41,70
                            + phí nạp 5,5% ≈  $44,00
```

Vừa khít $50 — không có chỗ cho sai sót. Đó là lý do phần dưới quan trọng.

### 4.3 Bốn đòn bẩy, xếp theo hiệu quả

**1. Prompt caching — lớn nhất, và bị bỏ quên nhiều nhất.**
Cache prefix giảm **75–90%** giá token đầu vào. Nhưng cache gắn với model đang phục vụ, nên **mọi lần đổi model giữa phiên đều xóa cache**. Docs cảnh báo:

> *"the next message re-reads the entire conversation at full input-token price instead of the cached (~75–90% discounted) rate. On a long session this one-time re-read can dwarf the per-token difference between the two models."*

**Quy tắc:** chọn model ở **đầu** phiên, hoặc mở phiên mới. Đừng `/model` giữa chừng. Riêng đòn bẩy này có thể kéo $41 xuống dưới $20.

**2. `--no-agent` và `wakeAgent` — đưa chi phí về 0 cho khâu thu thập.**
Mọi việc lấy dữ liệu có cấu trúc (YouTube API, RSS, kiểm tra giá, đếm số liệu) đều nên là script thuần. Chỉ đánh thức LLM khi có gì đáng suy nghĩ.

**3. `enabled_toolsets` — cắt phần thừa của mỗi lượt gọi.**
Schema tool đi kèm mọi lượt gọi LLM. Job đọc file không cần nạp `browser` và `delegation`.

**4. Đè khe auxiliary sang Flash 2.5.**
Đặc biệt `web_extract` và `compression` — hai khe chạy nhiều nhất trong workflow research.

### 4.4 Nếu vẫn vượt ngân sách

Theo thứ tự nên cắt:

1. Giảm tần suất quét: hằng ngày → 3 lần/tuần
2. Hạ `max_concurrent_children` từ 3 xuống 1
3. Tổng hợp hằng tuần dùng Flash 2.5 thay Sonnet, chỉ nâng lên Sonnet mỗi tháng một lần
4. Tự host SearXNG, bỏ Firecrawl
5. Rút ngắn `memory_char_limit` — memory đi vào **mọi** system prompt

Đừng cắt: `write_approval`, phanh chống vòng lặp, `child_timeout_seconds`. Đó là những thứ bảo vệ bạn khỏi hóa đơn bất ngờ, không phải nguồn gây tốn.

---

## Phần 5 — Rủi ro cần biết trước

| Rủi ro | Mức | Xử lý |
|---|---|---|
| **Prompt injection từ lander đối thủ** | Cao | Docker + `write_approval: true` + `approvals.deny`. Agent đọc chính xác loại nội dung mà kẻ tấn công nhắm vào. |
| **Cloaking làm sai lệch phân tích** | Cao | Kiểm tra chéo bằng screenshot. Vấn đề đặc thù của ngành aff. |
| **ToS network cấm scraping** | Trung bình–cao | Đọc kỹ ToS từng network. Rủi ro là mất tài khoản, không phải kỹ thuật. |
| **Vượt ngân sách âm thầm** | Trung bình | Cron watchdog ở mục 3.3. Dashboard không tự chặn. |
| **Quota YouTube API cạn** | Trung bình | 100 lần `search.list`/ngày là trần thật. Thiết kế script quanh `videos.list` (1 đơn vị). |
| **Agent học sai rồi cố định hóa** | Trung bình | Duyệt `/skills diff` trước khi approve. Đây là lý do bật `write_approval`. |
| **Dashboard lộ ra internet** | Cao nếu làm sai | Caddy + OAuth, không publish 9119. Nhớ lỗ hổng `/api/plugins/`. |

---

## Phần 6 — Việc cần làm ngay tuần này

1. Chốt tên miền, trỏ A record về IP VPS
2. Dựng VPS 4GB theo tài liệu cài đặt
3. Tạo 2 profile với mô tả rõ ràng
4. Nạp $20 vào OpenRouter (đừng nạp $50 ngay — chạy 2 tuần để biết con số thật)
5. Dùng tay 2 tuần. Ghi lại việc nào agent làm tốt, việc nào dở.

Bước 5 là bước hay bị bỏ qua nhất và tốn kém nhất khi bỏ qua. Tự động hóa một quy trình bạn chưa hiểu rõ chỉ tạo ra sai lầm nhanh hơn.

---

## Nguồn

- [Hermes Agent — Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [Hermes Agent — Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Hermes Agent — Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles)
- [Hermes Agent — Web Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard)
- [Hermes Agent — Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
- [Hermes Agent — Integrations](https://hermes-agent.nousresearch.com/docs/integrations/)
- [Hermes Agent — Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)
- [Hermes Agent — Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker)
- [Gemini 2.5 Flash — OpenRouter](https://openrouter.ai/google/gemini-2.5-flash)
- [OpenRouter Pricing 2026](https://costbench.com/software/llm-api-providers/openrouter/)
- [YouTube Data API — Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [YouTube API Quota Limits 2026](https://www.getphyllo.com/post/youtube-api-limits-how-to-calculate-api-usage-cost-and-fix-exceeded-api-quota)
- [Caddy — Reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
