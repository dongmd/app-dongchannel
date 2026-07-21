# Hướng dẫn cài đặt & cấu hình Hermes Agent trên VPS Ubuntu

**Dùng cho:** research dự án Affiliate global — quét network, phân tích offer, nghiên cứu đối thủ, lên kế hoạch quảng cáo
**Môi trường:** VPS Ubuntu 22.04/24.04 · Provider: OpenRouter · Giao diện: Telegram
**Cập nhật:** 20/07/2026 — dựa trên tài liệu chính thức tại hermes-agent.nousresearch.com/docs

> Mọi cú pháp YAML và lệnh shell trong tài liệu này đều trích từ docs chính thức, không suy đoán.
> Riêng **tên model** thay đổi liên tục — hãy kiểm tra lại ID model trên OpenRouter trước khi dán vào config.

---

## Mục lục

1. [Quyết định kiến trúc: chạy Docker, không chạy trực tiếp](#1-quyết-định-kiến-trúc)
2. [Chuẩn bị VPS](#2-chuẩn-bị-vps)
3. [Cài đặt Hermes](#3-cài-đặt-hermes)
4. [Cấu hình model & định tuyến chi phí](#4-cấu-hình-model--định-tuyến-chi-phí)
5. [Nối Telegram](#5-nối-telegram)
6. [Cấu hình cho workflow research Aff](#6-cấu-hình-cho-workflow-research-aff)
7. [Checklist bảo mật](#7-checklist-bảo-mật)
8. [Vận hành hằng ngày](#8-vận-hành-hằng-ngày)
9. [Những gì docs KHÔNG nói](#9-những-gì-docs-không-nói)

---

## 1. Quyết định kiến trúc

**Chạy Hermes trong Docker, không cài trực tiếp lên VPS.**

Lý do không phải là sở thích. Checklist triển khai production trong docs chính thức nêu rõ mục số 2: *"Use container backend — set `terminal.backend: docker`"*. Hermes chạy được shell command; trong workflow của bạn nó sẽ đọc lander đối thủ và trang review — chính xác loại nội dung mà kẻ tấn công cài chỉ thị vào (indirect prompt injection). Container là ranh giới an toàn thật sự.

Ngoài ra, image chính thức đã siết sẵn nhiều thứ mà bạn sẽ phải tự làm nếu cài trực tiếp:

- Chạy dưới user `hermes` (UID 10000), **từ chối chạy gateway bằng root** theo mặc định
- `HERMES_WRITE_SAFE_ROOT=/opt/data` — agent không ghi được ra ngoài thư mục dữ liệu
- Cây cài đặt `/opt/hermes` read-only với runtime user
- Sandbox terminal drop toàn bộ Linux capabilities, `no-new-privileges`, `--pids-limit 256`

Có hai lớp Docker khác nhau, đừng nhầm:

| Lớp | Là gì |
|---|---|
| **Container Hermes** | Toàn bộ agent chạy trong đây (`nousresearch/hermes-agent`) |
| **`terminal.backend: docker`** | Agent spawn container *con* riêng mỗi khi chạy lệnh shell |

Bạn nên bật cả hai.

---

## 2. Chuẩn bị VPS

### 2.1 Tài nguyên tối thiểu

Docs chỉ công bố yêu cầu cho container:

| Tài nguyên | Tối thiểu | Khuyến nghị |
|---|---|---|
| RAM | 1 GB | 2–4 GB |
| CPU | 1 core | 2 core |
| Disk (volume dữ liệu) | 500 MB | 2+ GB (tăng dần theo session/skill) |

> *"Browser automation (Playwright/Chromium) is the most memory-hungry feature. If you don't need browser tools, 1 GB is sufficient. With browser tools active, allocate at least 2 GB."*

**Với research aff bạn CHẮC CHẮN cần browser tools** (đọc lander, xem trang đối thủ). Cộng thêm việc `terminal.backend: docker` spawn container con, và bạn còn cần chỗ cho chính OS.

→ **Khuyến nghị thực tế: VPS 4 GB RAM / 2 vCPU / 40 GB SSD.** Đừng lấy gói 2 GB.

### 2.2 Cảnh báo quan trọng về console VPS

Docs cảnh báo trực tiếp:

> *"Some VPS providers (Hetzner Cloud, and several others) offer a browser-based console... These consoles transmit special characters incorrectly — `:` may arrive as `;`, `@` may be mis-rendered... which silently corrupts `docker run` arguments like `-v ~/.hermes:/opt/data`, `-e KEY=value`, and pasted API keys / tokens. **Connect over SSH instead**."*

**Luôn dùng SSH (`ssh root@<host>`), tuyệt đối không dùng web console của nhà cung cấp** để gõ các lệnh trong tài liệu này. Lỗi này im lặng — bạn sẽ không thấy báo lỗi, chỉ thấy mọi thứ hoạt động sai một cách khó hiểu.

### 2.3 Dựng nền

```bash
# Cập nhật hệ thống
apt update && apt upgrade -y

# Cài Docker
curl -fsSL https://get.docker.com | sh

# Tạo user không phải root để vận hành
adduser hermesops
usermod -aG docker hermesops

# Firewall: chỉ mở SSH ra ngoài
apt install -y ufw
ufw allow OpenSSH
ufw --force enable
```

**Không mở port 8642 hay 9119 ra internet.** Chúng ta sẽ truy cập dashboard qua SSH tunnel ở mục 7.

Từ đây trở đi, đăng nhập bằng `hermesops`, không dùng root.

---

## 3. Cài đặt Hermes

### 3.1 Chạy wizard setup lần đầu

```bash
mkdir -p ~/.hermes

docker run -it --rm \
  -v ~/.hermes:/opt/data \
  nousresearch/hermes-agent setup
```

Wizard cho 3 chế độ. Với trường hợp của bạn:

- **Quick Setup (Nous Portal)** — nhanh nhất nhưng khóa bạn vào Nous Portal, không dùng OpenRouter
- **Full Setup** ← **chọn cái này**, tự khai báo OpenRouter key
- **Blank Slate** — tắt mọi thứ trừ File Operations + Terminal. Không hợp: bạn cần web, browser, memory, delegation, skills

Khi được hỏi provider, chọn **OpenRouter** và dán API key.

### 3.2 Yêu cầu context tối thiểu

> *"Hermes Agent requires a model with at least 64,000 tokens of context."*

Mọi model chính bạn chọn phải có cửa sổ context ≥ 64K. Với research aff — nơi bạn nhồi nhiều trang web vào một session — thực tế nên chọn model 200K+ để đỡ phải nén context liên tục (mỗi lần nén là một lần tốn tiền).

### 3.3 Khởi chạy gateway

Chưa chạy vội — hãy cấu hình xong mục 4–7 rồi mới start. Lệnh khởi chạy chính thức:

```bash
docker run -d \
  --name hermes \
  --restart unless-stopped \
  --memory=4g --cpus=2 \
  --shm-size=1g \
  -v ~/.hermes:/opt/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  nousresearch/hermes-agent gateway run
```

Giải thích các cờ:

- `--shm-size=1g` — bắt buộc nếu dùng Playwright/Chromium, thiếu là browser crash
- `-v /var/run/docker.sock` — cần để agent spawn container con cho `terminal.backend: docker`
- **Không có `-p`** — không expose port nào ra ngoài. Đây là chủ ý.

> ⚠️ Mount `docker.sock` trao cho container quyền tương đương root trên host. Đây là đánh đổi có thật: bạn được sandbox cho *lệnh shell của agent*, nhưng chính container Hermes lại có quyền cao. Nếu bạn muốn tránh, dùng `terminal.backend: ssh` trỏ tới một VPS worker riêng thay vì mount socket (xem mục 7.5).

### 3.4 Cảnh báo về đồng thời

> *"Never run two Hermes gateway containers against the same data directory simultaneously — session files and memory stores are not designed for concurrent write access."*

Một container, một thư mục `~/.hermes`. Nếu muốn nhiều agent, dùng profile (`hermes -p <tên>`), không phải nhiều container.

---

## 4. Cấu hình model & định tuyến chi phí

Đây là phần tạo ra khác biệt lớn nhất về hóa đơn. File: `~/.hermes/config.yaml`.

### 4.1 Hai loại khe model

- **Main model** — thứ agent "suy nghĩ" bằng. Mọi tin nhắn, mọi vòng lặp tool-call.
- **Auxiliary models** — 11 khe việc phụ: nén context, vision, **tóm tắt trang web**, chấm điểm phê duyệt, định tuyến MCP, sinh tiêu đề session, tìm skill, và vài khe khác.

Mặc định mọi khe auxiliary là `auto` — tức là **dùng luôn main model**. Đây chính là chỗ tiền rò rỉ. Trong research aff, phần lớn token nằm ở đọc và tóm tắt trang web; để nó chạy bằng model cao cấp là lãng phí thuần túy.

### 4.2 Config chính

```yaml
# ~/.hermes/config.yaml

model:
  provider: openrouter
  default: anthropic/claude-opus-4.7   # ← kiểm tra ID hiện hành trên OpenRouter
  base_url: ''
  api_mode: chat_completions
```

### 4.3 Đè các khe auxiliary sang model rẻ

```yaml
auxiliary:
  # Tóm tắt trang web — khe quan trọng NHẤT với bạn.
  # Mỗi lander đối thủ, mỗi trang network đều đi qua đây.
  web_extract:
    provider: openrouter
    model: google/gemini-3-flash-preview
    base_url: ''
    api_key: ''
    timeout: 120
    extra_body: {}
    download_timeout: 30

  # Nén context — chạy liên tục trong session dài
  compression:
    provider: openrouter
    model: google/gemini-3-flash-preview
    base_url: ''
    api_key: ''
    timeout: 120
    extra_body: {}
    download_timeout: 30

  # Sinh tiêu đề session — docs nói thẳng: "Almost always" nên đè
  title_generation:
    provider: openrouter
    model: google/gemini-3-flash-preview
    base_url: ''
    api_key: ''
    timeout: 120
    extra_body: {}
    download_timeout: 30

  # Chấm điểm phê duyệt (cho approvals.mode: smart)
  # Docs: "Expensive models here are waste."
  approval:
    provider: openrouter
    model: google/gemini-3-flash-preview
    base_url: ''
    api_key: ''
    timeout: 120
    extra_body: {}
    download_timeout: 30

  # Đọc ảnh — screenshot lander, creative đối thủ
  vision:
    provider: openrouter
    model: google/gemini-2.5-flash
    base_url: ''
    api_key: ''
    timeout: 120
    extra_body: {}
    download_timeout: 30

  # Review nền sau mỗi session (vòng lặp tự học)
  # Docs: "Can run for minutes on reasoning models"
  background_review:
    provider: openrouter
    model: google/gemini-3-flash-preview
```

**Lối tắt:** trong dashboard, mỗi card model có dropdown **"Use as" → All auxiliary tasks** — gán một model rẻ cho cả 11 khe trong một cú click. Sau đó chỉ nâng riêng khe nào bạn thấy chất lượng không đủ.

### 4.4 Định tuyến subagent

Subagent là nơi quét song song nhiều network/offer. Chúng làm việc thu thập, không cần model đắt:

```yaml
delegation:
  max_iterations: 50
  max_concurrent_children: 3       # mặc định 3, sàn 1, không trần
  max_spawn_depth: 1               # 1 = phẳng. Nâng lên 2 nếu cần tầng orchestrator
  model: "google/gemini-3-flash-preview"
  provider: "openrouter"
  child_timeout_seconds: 1800      # trần cứng 30 phút, tránh treo đốt tiền
```

> ⚠️ Cảnh báo chi phí từ docs: *"With `max_spawn_depth: 3` and `max_concurrent_children: 3`, the tree can reach 3×3×3 = 27 concurrent leaf agents."*
> Giữ `max_spawn_depth: 1` cho tới khi bạn hiểu rõ chi phí thực tế của mình.

`child_timeout_seconds: 0` là mặc định (không timeout). **Hãy đặt giá trị cụ thể** — một subagent kẹt vòng lặp trên trang đối thủ có cloaking sẽ chạy vô hạn.

### 4.5 Provider routing — chỉ hoạt động với OpenRouter

Đây là lý do chọn OpenRouter:

```yaml
provider_routing:
  sort: "price"              # rẻ nhất trước. Hoặc "throughput" / "latency"
  only: []
  ignore: []
  order: []
  require_parameters: true   # chỉ dùng provider hỗ trợ đủ tham số
  data_collection: "deny"    # QUAN TRỌNG: cấm provider thu thập dữ liệu
```

**`data_collection: "deny"` nên bật.** Bạn đang xử lý dữ liệu nghiên cứu đối thủ và chiến lược quảng cáo của mình — không có lý do gì để nó nằm trong tập huấn luyện của một provider hạ nguồn nào đó.

### 4.6 Alias để chuyển model nhanh

```yaml
model_aliases:
  re:                              # model rẻ, cho việc quét
    model: google/gemini-3-flash-preview
    provider: openrouter
  manh:                            # model mạnh, cho việc tổng hợp
    model: anthropic/claude-opus-4.7
    provider: openrouter
```

Trong Telegram: `/model re` khi quét hàng loạt, `/model manh` khi cần bản phân tích cuối. Hoặc:

```
/model manh --once
```

→ nâng cấp đúng **một lượt** rồi tự động quay lại model cũ.

> **Bẫy chi phí:** chuyển model giữa session làm mất prompt cache. Lượt kế tiếp phải đọc lại toàn bộ hội thoại ở giá input đầy đủ, thay vì giá cache (giảm ~75–90%). Trong session dài, một lần `--once` có thể tốn hơn số tiền nó tiết kiệm. **Hãy chuyển model ở đầu session, hoặc mở session mới.**

---

## 5. Nối Telegram

### 5.1 Tạo bot

1. Mở Telegram, tìm **@BotFather**
2. Gửi `/newbot`
3. Đặt **display name** (tùy ý, ví dụ "Aff Research")
4. Đặt **username** — phải duy nhất và kết thúc bằng `bot` (ví dụ `aff_research_bot`)
5. BotFather trả về token dạng `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`

> Giữ token này bí mật. Nếu lộ, thu hồi ngay bằng `/revoke` trong BotFather.

### 5.2 Lấy user ID của bạn

Cần **ID số**, không phải username. Nhắn cho [@userinfobot](https://t.me/userinfobot) để lấy.

### 5.3 Đặt menu lệnh (tùy chọn)

BotFather → `/setcommands`:

```text
help - Show help information
new - Start a new conversation
sethome - Set this chat as the home channel
```

### 5.4 Cấu hình

Cách khuyến nghị — chạy wizard:

```bash
docker exec -it hermes hermes gateway setup
```

Chọn **Telegram**, nhập bot token và user ID.

Hoặc khai báo tay trong `~/.hermes/.env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_ALLOWED_USERS=123456789
```

### 5.5 Phân quyền chi tiết

```yaml
gateway:
  platforms:
    telegram:
      extra:
        # Toàn quyền (DM + group)
        allow_from:
          - "123456789"          # ID của bạn

        # Admin được chạy MỌI slash command
        allow_admin_from:
          - "123456789"

        # Người dùng thường chỉ được chạy các lệnh này
        # (/help và /whoami luôn được phép)
        user_allowed_commands:
          - status
          - model
          - history
```

> ⚠️ **Lỗi nesting rất dễ mắc.** Docs cảnh báo: *"Use `platforms.telegram.extra`, not `telegram.extra` — At the moment only the `platforms.<name>.extra` form is deep-merged into the platform config. Keys placed directly under a top-level `telegram.extra` block are **silently dropped**."*
>
> Đặt sai chỗ thì config bị bỏ qua **im lặng**, không báo lỗi. Nếu phân quyền của bạn "không có tác dụng", kiểm tra chỗ này đầu tiên.

### 5.6 Nếu dùng trong group

Privacy Mode bật mặc định — bot chỉ thấy lệnh `/`, reply trực tiếp, và tin nhắn service.

Tắt: @BotFather → `/mybots` → chọn bot → **Bot Settings → Group Privacy → Turn off**

> **Bắt buộc: xóa bot khỏi group rồi thêm lại** sau khi đổi setting này. Không làm bước này thì thay đổi không có hiệu lực.

---

## 6. Cấu hình cho workflow research Aff

### 6.1 Bật cổng phê duyệt cho memory và skills

Đây là **bắt buộc** với use case của bạn, không phải tùy chọn. Agent sẽ đọc nội dung do đối thủ kiểm soát; nếu nó bị prompt injection và ghi thẳng vào bộ nhớ dài hạn, bạn nhiễm độc vĩnh viễn mà không biết.

```yaml
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200      # ~800 token
  user_char_limit: 1375        # ~500 token
  write_approval: true         # ← BẬT

skills:
  write_approval: true         # ← BẬT
```

Duyệt định kỳ qua Telegram:

```text
/memory pending          # xem các ghi nhớ đang chờ (loại tự động có tag [auto])
/memory approve <id>     # duyệt một cái, hoặc 'all'
/memory reject <id>      # loại bỏ

/skills pending          # xem skill đang chờ
/skills diff <id>        # xem diff đầy đủ  ← LUÔN xem trước khi duyệt
/skills approve <id>
/skills reject <id>
```

Skill đang chờ nằm ở `~/.hermes/pending/skills/` và **sống sót qua restart**, nên không sợ mất khi bạn chưa kịp duyệt.

Ghi nhớ nằm ở `~/.hermes/memories/` — `MEMORY.md` (2.200 ký tự) và `USER.md` (1.375 ký tự). Đây là ngân sách rất chặt: hãy dùng cho **tiêu chí cố định** (GEO mục tiêu, sàn payout tối thiểu, vertical, nguồn traffic, network đã loại), không phải dữ liệu từng offer.

### 6.2 Chặn miền không muốn agent chạm

```yaml
security:
  website_blocklist:
    enabled: true
    domains:
      - "*.internal.company.com"
      # thêm miền bạn không muốn agent đụng vào
```

Được áp dụng xuyên suốt `web_search`, `web_extract`, `browser_navigate` và mọi tool nhận URL.

### 6.3 Giữ chặn IP nội bộ (SSRF)

```yaml
security:
  allow_private_urls: false    # đây là MẶC ĐỊNH — đừng đổi
```

Mặc định Hermes chặn `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, loopback, link-local `169.254.0.0/16` (gồm `169.254.169.254` — endpoint metadata của cloud), CGNAT, và `metadata.google.internal`.

> Docs gọi đây là *"a deliberate trust boundary... Public-facing gateways should leave it off."* Với một agent đọc trang web do người khác kiểm soát, bật `true` là mở đường cho việc trích xuất credential metadata của VPS. **Không đổi.**

### 6.4 Chặn cứng các lệnh nguy hiểm

```yaml
approvals:
  mode: smart              # smart | manual | off
  timeout: 60              # hết giờ → TỪ CHỐI (fail-closed)
  cron_mode: deny          # cron gặp lệnh nguy hiểm thì từ chối
  deny:
    - "curl * | *sh*"
    - "wget * | *sh*"
    - "*ssh-keygen*"
    - "*>> */.ssh/authorized_keys*"
    - "git push --force*"
```

> **Cú pháp YAML:** docs cảnh báo *"always quote patterns. A bare leading `*` is a YAML alias and fails to parse."* Luôn bọc pattern trong dấu nháy.

`approvals.deny` chạy **trước** `--yolo`, `/yolo`, và `approvals.mode: off` — tức là nó không bị vô hiệu hóa kể cả khi bạn lỡ tay bật yolo.

> ⚠️ **TUYỆT ĐỐI KHÔNG** đặt `approvals.mode: off` hay chạy `--yolo` trên gateway có kết nối internet. Docs nói rõ chỉ dùng trong "trusted environments (CI/CD, containers)".

Ngoài ra Hermes có blocklist cứng luôn bật, không config được và không có cờ override: `rm -rf /`, fork bomb, `mkfs.*` trên root đang mount, `dd if=/dev/zero of=/dev/sd*`, pipe URL không tin cậy vào `sh`.

### 6.5 Chặn vòng lặp tool đốt tiền

Mặc định là **tắt**. Với gateway chạy không người trông, nên bật:

```yaml
tool_loop_guardrails:
  hard_stop_enabled: true
  hard_stop_after:
    exact_failure: 5
    idempotent_no_progress: 5
```

Đây là phanh chống việc agent lặp vô hạn khi gặp trang có cloaking hoặc anti-bot — kịch bản rất thường gặp trong research aff.

### 6.6 Sandbox terminal

```yaml
terminal:
  backend: docker
  container_cpu: 1
  container_memory: 2048        # MB
  container_disk: 10240         # MB
  container_persistent: true
  docker_forward_env: []        # ← GIỮ RỖNG
```

> `docker_forward_env` rỗng là chủ ý. Docs cảnh báo: *"those variables are intentionally injected into the container... it also means code running in the container can read and exfiltrate them."* Đừng đẩy API key của bạn vào sandbox mà agent chạy code lạ trong đó.

`container_persistent: true` giữ filesystem qua các session (bind-mount từ `~/.hermes/sandboxes/docker/<task_id>/`). Đặt `false` nếu bạn muốn mọi thứ bị xóa sạch sau mỗi task — an toàn hơn nhưng mất context giữa các lần chạy.

---

## 7. Checklist bảo mật

### 7.1 Checklist chính thức từ docs

| # | Việc | Trạng thái trong hướng dẫn này |
|---|---|---|
| 1 | Đặt allowlist rõ ràng, không bao giờ `GATEWAY_ALLOW_ALL_USERS=true` | ✅ Mục 5.5 |
| 2 | Dùng container backend (`terminal.backend: docker`) | ✅ Mục 6.6 |
| 3 | Giới hạn tài nguyên CPU/RAM/disk | ✅ Mục 6.6 |
| 4 | Lưu secret trong `~/.hermes/.env` với quyền đúng | ⬜ Xem 7.2 |
| 5 | Bật DM pairing thay vì hardcode user ID | ⬜ Tùy chọn |
| 6 | Rà soát `command_allowlist` định kỳ | ⬜ Xem 8.3 |
| 7 | Đặt `terminal.cwd` — đừng để agent chạy từ thư mục nhạy cảm | ⚠️ Xem mục 9 |
| 8 | Chạy bằng user không phải root | ✅ Mục 2.3 |
| 9 | Theo dõi log tại `~/.hermes/logs/` | ⬜ Xem 8.1 |
| 10 | `hermes update` thường xuyên | ⬜ Xem 8.4 |

### 7.2 Khóa quyền file secret

```bash
chmod 600 ~/.hermes/.env
```

Secret (`OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`) nằm trong `~/.hermes/.env`. Cấu hình không nhạy cảm nằm trong `~/.hermes/config.yaml`. Đừng trộn lẫn — và đừng bao giờ commit `.env` lên git.

Hermes đã chặn cứng việc agent ghi vào `.env`, `.envrc`, `~/.ssh/`, `~/.aws/`, `~/.kube/`, `/etc/sudoers`, `~/.netrc` — bất kể cấu hình gì.

> **Nhưng lưu ý giới hạn thật, docs nói rõ:** *"Write guards apply to `write_file` and `patch` only. The `terminal` tool runs as the same OS user and can still `cat` or overwrite denied paths via shell commands... it does not sandbox a hostile or compromised agent."*
>
> Đây chính là lý do mục 1 khăng khăng bắt chạy trong container.

### 7.3 Dashboard: KHÔNG mở ra internet

Đây là phần nghiêm trọng nhất. Docs kể lại một sự cố có thật:

> *"An unauthenticated public dashboard was the entry point for the June 2026 MCP-config persistence campaign: internet scanners reached exposed dashboards (and OpenAI API servers) and drove the agent into planting an SSH-key backdoor."*

Cờ `HERMES_DASHBOARD_INSECURE` đã bị vô hiệu hóa vĩnh viễn sau vụ này. Hiện tại nếu bind ra ngoài loopback mà không có auth provider, dashboard **fail closed** — từ chối khởi động.

**Cách đúng: bind loopback + SSH tunnel.**

Chạy container với:

```bash
docker run -d \
  --name hermes \
  --restart unless-stopped \
  --memory=4g --cpus=2 \
  --shm-size=1g \
  -v ~/.hermes:/opt/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -p 127.0.0.1:9119:9119 \
  -e HERMES_DASHBOARD=1 \
  -e HERMES_DASHBOARD_HOST=127.0.0.1 \
  nousresearch/hermes-agent gateway run
```

Chú ý `-p 127.0.0.1:9119:9119` — chỉ bind loopback của **host**, không phải `0.0.0.0`.

Từ máy tính cá nhân của bạn:

```bash
ssh -L 9119:127.0.0.1:9119 hermesops@<ip-vps>
```

Rồi mở `http://localhost:9119` trên trình duyệt máy bạn.

**Đừng bật API server (port 8642) trừ khi bạn thật sự cần.** Docs cảnh báo thẳng: *"Opening any port on an internet facing machine is a security risk. You should not do it unless you understand the risks."*

### 7.4 Nếu chạy pairing trong Docker

Có một bug đã biết ([#10270](https://github.com/NousResearch/hermes-agent/issues/10270)): file phê duyệt do root tạo có quyền `0600 root:root` và **phê duyệt bị bỏ qua im lặng**. Luôn chạy với `-u hermes`:

```bash
docker exec -u hermes hermes hermes pairing approve telegram ABC12DEF
```

### 7.5 Phương án thay thế nếu không muốn mount docker.sock

Thay vì cho container Hermes quyền Docker trên host, trỏ terminal sang một VPS worker riêng:

```yaml
terminal:
  backend: ssh
```

```bash
# ~/.hermes/.env
TERMINAL_SSH_HOST=agent-worker.local
TERMINAL_SSH_USER=hermes
TERMINAL_SSH_KEY=~/.ssh/hermes_agent_key
```

Docs giải thích lý do đặt trong `.env`: *"so they aren't checked in or shared along with profile exports."*

Lưu ý đánh đổi: với backend `ssh` và `local`, kiểm tra lệnh nguy hiểm **vẫn chạy**; với backend `docker`/`modal`/`daytona` thì **bị bỏ qua** vì container được coi là ranh giới an toàn.

---

## 8. Vận hành hằng ngày

### 8.1 Lệnh cơ bản

```bash
# Trạng thái
docker exec hermes hermes status
docker exec hermes hermes gateway status

# Log
docker exec hermes hermes logs --follow
docker exec hermes hermes logs --level WARNING
docker logs -f hermes

# Chẩn đoán khi có sự cố
docker exec -it hermes hermes doctor

# Vòng đời gateway
docker exec hermes hermes gateway restart
```

Log ghi tại `~/.hermes/logs/`. Hãy xem định kỳ để phát hiện truy cập trái phép.

### 8.2 Bộ công cụ khôi phục

Khi có sự cố, docs đề xuất thứ tự này:

```
1. hermes doctor
2. hermes model
3. hermes setup
4. hermes sessions list
5. hermes --continue
6. hermes gateway status
```

### 8.3 Rà soát allowlist định kỳ

```bash
docker exec -it hermes hermes config edit
```

Mỗi lần bạn chọn "always" ở một prompt phê duyệt, pattern đó vào `command_allowlist` và **được duyệt im lặng mãi mãi**. Hãy rà soát hằng tháng và xóa những gì không còn cần.

### 8.4 Cập nhật

```bash
docker pull nousresearch/hermes-agent:latest
docker rm -f hermes
# chạy lại lệnh docker run ở mục 7.3
```

Dữ liệu nằm trong volume `~/.hermes`, không mất khi xóa container.

### 8.5 Nhịp làm việc đề xuất cho research aff

**Hằng ngày** — quét bằng model rẻ:
```
/model re
Quét 5 offer mới trong vertical [X] trên [network], lọc theo tiêu chí đã lưu
```

**Hằng tuần** — tổng hợp bằng model mạnh, session mới để giữ prompt cache:
```
/model manh
Tổng hợp các offer đã quét tuần này, xếp hạng theo tiềm năng, đề xuất angle quảng cáo
```

**Hằng tuần** — duyệt những gì agent muốn học:
```
/memory pending
/skills pending
/skills diff <id>
```

Đừng bỏ qua bước cuối. Đây vừa là lớp bảo vệ, vừa là cách bạn kiểm soát chất lượng vòng lặp tự học — nếu agent rút ra kết luận sai từ một trang bị cloaking, đây là chỗ bạn chặn nó trước khi nó thành quy trình cố định.

---

## 9. Những gì docs KHÔNG nói

Liệt kê thẳng để bạn không mất thời gian tìm:

| Vấn đề | Tình trạng |
|---|---|
| **Yêu cầu hệ thống cho cài trực tiếp** (RAM/disk/Python/Node trên host) | Không có. Chỉ có số liệu cho Docker. Thêm một lý do nữa để dùng Docker. |
| **`hermes service install` / unit systemd** | Không tồn tại trong docs. Trong container, supervision là s6. Ngoài container, bạn tự viết unit file. |
| **`terminal.cwd`** | Checklist production khuyên đặt, nhưng **không có ví dụ YAML hay giá trị mặc định nào** trong docs. |
| **Cấu hình TLS / reverse proxy** | Không có ví dụ. Docs chỉ khuyên bind loopback + SSH tunnel hoặc Tailscale. |
| **Hướng dẫn firewall (ufw/iptables)** | Không có. Phần mục 2.3 ở trên là khuyến nghị của tôi, không phải trích docs. |
| **Giới hạn egress mạng cho container** | Không có công thức. Docs nói "use an isolated backend or an egress-restricted environment" nhưng không chỉ cách dựng. |
| **Xác minh checksum/GPG cho `install.sh`** | Không có. Đây là lý do nữa nên dùng Docker image thay vì script curl. |

---

## Phụ lục: file config.yaml hoàn chỉnh

Xem file `config-aff-research.yaml` đi kèm — đã gộp toàn bộ các khối trên thành một file dán thẳng được.

---

## Nguồn

- [Hermes Agent — Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- [Hermes Agent — Configuring Models](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models)
- [Hermes Agent — Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- [Hermes Agent — Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker)
- [Hermes Agent — Telegram](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram)
- [Hermes Agent — Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/)
- [Hermes Agent — Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Hermes Agent — Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes Agent — Provider Routing](https://hermes-agent.nousresearch.com/docs/user-guide/features/provider-routing)
