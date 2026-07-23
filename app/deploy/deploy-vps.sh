#!/bin/bash
# DC-017 deploy script — chạy TRÊN VPS vocapro (không phải local Windows).
# Sequence: clone/pull → install → migrate → build standalone → restart systemd
#
# Usage (chạy trên VPS):
#   cd /home/opssite/htdocs/app.dongchannel.com
#   bash deploy-vps.sh
#
# Prereqs (đã setup xong bởi Step 2-3 trước):
#   - CloudPanel Node.js site `app.dongchannel.com` với siteUser=opssite, port 3000
#   - /home/opssite/.env đã tạo với đủ env vars production
#   - Postgres user `opsdash` + DB `dongchannel_ops` đã có

set -euo pipefail

APP_DIR="/home/opssite/htdocs/app.dongchannel.com"
REPO_URL="https://github.com/dongmd/app-dongchannel.git"
BRANCH="main"

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
echo "→ drizzle migrate"
set -o allexport; source .env; set +o allexport
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
