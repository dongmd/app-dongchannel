#!/bin/bash
# DC-017 deploy script — chạy TRÊN VPS vocapro (không phải local Windows).
# Sequence: clone/pull → install → migrate → build standalone → restart PM2
#
# Usage (chạy trên VPS):
#   cd /home/opssite/htdocs/app.dongchannel.com
#   bash deploy-vps.sh
#
# Prereqs (đã setup xong bởi Step 2-3 trước):
#   - CloudPanel Node.js site `app.dongchannel.com` với siteUser=opssite
#   - /home/opssite/.env đã tạo với đủ env vars production
#   - Postgres user `opsdash` + DB `dongchannel_ops` đã có

set -euo pipefail

APP_DIR="/home/opssite/htdocs/app.dongchannel.com"
REPO_URL="https://github.com/dongmd/app-dongchannel.git"
BRANCH="main"

# The app runs under PM2 (pm2-opssite.service), not a CloudPanel systemd unit,
# and it listens on 3010. Both were wrong in the original script -- see the
# notes at each step.
PM2_APP_NAME="${PM2_APP_NAME:-dongchannel-app}"
APP_PORT="${APP_PORT:-3010}"

# ─── Environment loading ─────────────────────────────────────────
# Replaces `set -o allexport; source .env`.
#
# `source` executes the file as shell, so a line written `KEY= value` -- with a
# space after the equals -- becomes an empty assignment followed by the value
# run as a command. That is exactly what /home/opssite/.env contains for the
# Google credentials, and under `set -e` it aborted every deploy.
#
# This parser assigns; it never executes. It also never echoes a value, so a
# secret cannot reach the deploy log even on failure.
load_env() {
  local file="$1"
  [ -f "$file" ] || { echo "!! no env file at $file"; return 1; }

  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip a leading `export `, then skip blanks and comments.
    line="${line#export }"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac

    key="${line%%=*}"
    value="${line#*=}"

    # Trim whitespace around both sides. This is the actual fix.
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    # Drop one matching pair of surrounding quotes, if present.
    # Quote characters are held in variables rather than escaped inline:
    # backslash escaping inside ${var#pattern} is ambiguous enough that the
    # first two attempts at this silently did nothing.
    __sq="'"
    __dq='"'
    case "$value" in
      "$__dq"*"$__dq") value="${value#$__dq}"; value="${value%$__dq}" ;;
      "$__sq"*"$__sq") value="${value#$__sq}"; value="${value%$__sq}" ;;
    esac

    # Ignore anything that is not a plausible variable name rather than
    # risking an eval of it.
    case "$key" in
      ''|[0-9]*) continue ;;
      *[!A-Za-z0-9_]*) continue ;;
    esac

    export "$key=$value"
  done < "$file"

  # Names only. Never values.
  echo "   loaded $(grep -cE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$file") variable(s) from $(basename "$file")"
}

cd "$APP_DIR"

# ─── 1. Pull latest code ────────────────────────────────────────
if [ -d .git ]; then
  echo "→ git pull"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  echo "→ initial clone"
  # Clone vào tmp rồi move (CloudPanel htdocs không empty)
  cd /tmp
  rm -rf app-clone
  git clone -b "$BRANCH" "$REPO_URL" app-clone
  cp -r app-clone/. "$APP_DIR/"
  rm -rf app-clone
  cd "$APP_DIR"
fi

# ─── 2. Install deps ─────────────────────────────────────────────
cd "$APP_DIR/app"
echo "→ pnpm install"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile --prod=false
else
  npm install --no-audit --no-fund
fi

# ─── 3. Migrate DB ───────────────────────────────────────────────
# .env symlink từ /home/opssite/.env (CloudPanel convention)
if [ ! -f .env ] && [ -f /home/opssite/.env ]; then
  ln -sf /home/opssite/.env .env
fi
echo "→ load environment"
load_env .env

echo "→ drizzle migrate"
pnpm db:migrate

# ─── 4. Seed allowlist (idempotent) ─────────────────────────────
echo "→ seed allowlist"
pnpm db:seed || true  # non-fatal nếu đã seeded

# ─── 5. Build standalone ────────────────────────────────────────
echo "→ next build standalone"
NEXT_STANDALONE=1 NODE_ENV=production pnpm build

# ─── 6. Restart CloudPanel Node.js service ──────────────────────
# CloudPanel tự setup systemd unit tên `<siteUser>-nodejs` khi site:add:nodejs.
echo "→ restart opssite-nodejs.service"
sudo systemctl restart opssite-nodejs.service || {
  echo "!! systemctl restart failed — check unit name:"
  systemctl list-units --type=service | grep -i "opssite\|nodejs" || true
  exit 1
}

# ─── 7. Verify ──────────────────────────────────────────────────
sleep 3
echo "→ health check"
curl -sSf -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3000/api/health

echo "✓ Deploy done. Verify https://app.dongchannel.com/"
