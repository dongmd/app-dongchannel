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

APP_DIR="${APP_DIR:-/home/opssite/htdocs/app.dongchannel.com}"
REPO_URL="https://github.com/dongmd/app-dongchannel.git"
BRANCH="main"

# The app runs under PM2 (pm2-opssite.service), not a CloudPanel systemd unit,
# and it listens on 3010. Both were wrong in the original script -- see the
# notes at each step.
PM2_APP_NAME="${PM2_APP_NAME:-dongchannel-app}"
APP_PORT="${APP_PORT:-3010}"
PUBLIC_URL="${PUBLIC_URL:-https://app.dongchannel.com}"

# Every externally-visible step runs through a variable. Defaults are the real
# commands; the guard regression suite (deploy/test-deploy-guards.sh) overrides
# them with fakes so it can prove that a failing gate really does stop the
# pipeline before any database mutation -- without deploying anything.
CMD_LINT="${CMD_LINT:-pnpm lint}"
CMD_TYPECHECK="${CMD_TYPECHECK:-pnpm typecheck}"
CMD_TEST="${CMD_TEST:-pnpm test}"
CMD_BUILD="${CMD_BUILD:-NEXT_STANDALONE=1 NODE_ENV=production pnpm build}"
CMD_BACKUP="${CMD_BACKUP:-dump_database}"
BACKUP_DIR="${BACKUP_DIR:-/home/opssite/backups}"
CMD_MIGRATE="${CMD_MIGRATE:-pnpm db:migrate}"
CMD_SEED="${CMD_SEED:-pnpm db:seed}"
CMD_RESTART="${CMD_RESTART:-pm2 restart $PM2_APP_NAME --update-env}"
SKIP_PULL="${SKIP_PULL:-0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

fail() {
  echo "!! DEPLOY FAILED: $*" >&2
  exit 1
}

# pg_dump as the site user, using the app's own DATABASE_URL.
#
# The site user cannot sudo, and /var/backups is root-owned, so the previous
# `sudo -u postgres pg_dump` could never have worked from here.
#
# The connection URI is NOT passed as an argument: argv is world-readable via
# ps on a shared host, and the URI carries the password. The parts are exported
# as PG* variables instead, which are readable only by this user.
dump_database() {
  local target="$1"

  # The backup is taken with the SCHEMA OWNER's credential, not the runtime's.
  #
  # `pg_dump` can only dump what its role can read, and it fails loudly rather
  # than dumping less -- which is how this surfaced: after Q35 separated the
  # roles, `opsdash` lost USAGE on the `drizzle` schema and the dump refused.
  #
  # The uncomfortable part is what it revealed about BEFORE. The runtime role
  # happened to own every table, so the dump was complete by accident rather
  # than by design. A backup scoped to whatever the application can see is a
  # backup that would silently shrink the first time a table was owned
  # elsewhere, and nobody would notice until a restore.
  local src="${MIGRATION_DATABASE_URL:-${DATABASE_URL:-}}"
  [ -n "$src" ] || { echo "neither MIGRATION_DATABASE_URL nor DATABASE_URL is set" >&2; return 1; }

  local rest cred hostpart
  rest="${src#*://}"
  cred="${rest%%@*}"
  hostpart="${rest#*@}"

  PGUSER="${cred%%:*}"
  PGPASSWORD="${cred#*:}"
  PGDATABASE="${hostpart#*/}"
  PGDATABASE="${PGDATABASE%%\?*}"
  local hostport="${hostpart%%/*}"
  PGHOST="${hostport%%:*}"
  PGPORT="${hostport#*:}"
  [ "$PGPORT" = "$PGHOST" ] && PGPORT=5432
  export PGUSER PGPASSWORD PGDATABASE PGHOST PGPORT

  mkdir -p "$(dirname "$target")" && chmod 700 "$(dirname "$target")"
  pg_dump -Fc -f "$target"
  local rc=$?
  unset PGPASSWORD
  [ $rc -eq 0 ] && chmod 600 "$target"
  return $rc
}

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

# ─── 0. Re-exec from a stable copy ──────────────────────────────
# Step 1 does `git reset --hard`, which rewrites this very file while bash is
# still reading it. Bash reads scripts lazily by byte offset, so after the file
# changes underneath it the remaining commands come from the new file at the
# old offset -- which is how a fixed script kept running its own old logic.
# Re-exec once from a copy outside the working tree.
if [ "${DEPLOY_REEXEC:-0}" != "1" ]; then
  __copy="$(mktemp /tmp/deploy-vps.XXXXXX.sh)"
  cp "$0" "$__copy"
  DEPLOY_REEXEC=1 exec bash "$__copy" "$@"
fi

# ─── 1. Pull latest code ────────────────────────────────────────
if [ "$SKIP_PULL" = "1" ]; then
  echo "→ skip pull (SKIP_PULL=1)"
elif [ -d .git ]; then
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
if [ "$SKIP_INSTALL" = "1" ]; then
  echo "→ skip install (SKIP_INSTALL=1)"
elif command -v pnpm >/dev/null 2>&1; then
  echo "→ pnpm install"
  pnpm install --frozen-lockfile --prod=false
else
  echo "→ npm install"
  npm install --no-audit --no-fund
fi

# ─── 3. Load environment ────────────────────────────────────────
# Not a mutation. The build needs it, so it happens before the gates.
if [ ! -f .env ] && [ -f /home/opssite/.env ]; then
  ln -sf /home/opssite/.env .env
fi
echo "→ load environment"
load_env .env || fail "could not load .env"

# The migration credential is loaded SEPARATELY and never from .env.
#
# Post-deployment verification found `MIGRATION_DATABASE_URL` sitting in
# `/home/opssite/.env`, which the Next standalone server reads AT RUNTIME --
# proven by measurement, not assumed: `DATABASE_URL` is absent from the running
# process's exec environment (`/proc/<pid>/environ`) and the application reaches
# the database anyway, so it can only be loading that file itself. Anything the
# app loads from that file lands in `process.env`, so the app process could read
# the migrator DSN and issue the DDL that Q35 exists to deny it. A credential
# separation the application can undo by reading a file is not a separation.
#
# `.env.migrate` is never symlinked into the app directory and never copied into
# the build output, so it cannot be loaded by the runtime.
ENV_SOURCE="$(readlink -f .env 2>/dev/null || echo .env)"
if grep -q '^MIGRATION_DATABASE_URL=' "$ENV_SOURCE" 2>/dev/null; then
  fail "MIGRATION_DATABASE_URL is in $ENV_SOURCE, which the running application loads.
       Move it to \$MIGRATION_ENV_FILE (default /home/opssite/.env.migrate, mode 600).
       Leaving it there would let the app process read the credential that Q35 exists
       to keep away from it -- role separation enforced in the database and undone by
       a file read."
fi

MIGRATION_ENV_FILE="${MIGRATION_ENV_FILE:-/home/opssite/.env.migrate}"
if [ -f "$MIGRATION_ENV_FILE" ]; then
  load_env "$MIGRATION_ENV_FILE" || fail "could not load $MIGRATION_ENV_FILE"
fi

# ─── 4. QUALITY GATES — nothing may touch the database above this line ──
#
# TD-18. The previous order migrated first and built second, so a compile
# error left the database ahead of the running application. Everything that
# can fail on its own now fails *before* the first mutation.
echo "→ gate 1/4: lint"
eval "$CMD_LINT" || fail "lint failed -- database untouched"

echo "→ gate 2/4: typecheck"
eval "$CMD_TYPECHECK" || fail "typecheck failed -- database untouched"

echo "→ gate 3/4: test"
eval "$CMD_TEST" || fail "tests failed -- database untouched"

echo "→ gate 4/4: production build"
eval "$CMD_BUILD" || fail "build failed -- database untouched"

# ─── 4b. Standalone needs its own copy of the static assets ─────
#
# `next build` with output:standalone emits a self-contained server at
# .next/standalone/server.js and PM2 runs it with that directory as cwd. The
# server resolves /_next/static from <cwd>/.next/static -- which the build does
# NOT populate. Next's own docs say to copy it, and nothing here was doing so.
#
# The failure is quiet and total: every /_next/static/* request 404s, so the
# HTML still returns 200 and /api/health still passes while the app renders as
# unstyled markup, and any client-rendered page -- including the login screen --
# comes back blank. Found on 2026-08-20, after a deploy regenerated
# .next/standalone and removed a copy someone had made by hand.
#
# Verified by asset, not by exit code: a copy that silently produced zero files
# would leave the site just as broken.
# The condition is the presence of standalone output, not the build command.
# CMD_BUILD is overridable and the guard suite stubs it, so keying on "did a
# standalone build happen" is the only honest test -- and it keeps the copy
# mandatory exactly when it matters.
if [ -d .next/standalone ]; then
	echo "→ copy static assets into the standalone tree"

	[ -d .next/static ] || fail "standalone build produced no .next/static -- the server would 404 every asset"

	rm -rf .next/standalone/.next/static
	mkdir -p .next/standalone/.next
	cp -r .next/static .next/standalone/.next/static || fail "could not copy .next/static into standalone"

	__built="$(find .next/static -type f | wc -l)"
	__copied="$(find .next/standalone/.next/static -type f | wc -l)"

	if [ "$__copied" -ne "$__built" ] || [ "$__built" -eq 0 ]; then
		fail "static copy mismatch: built=$__built copied=$__copied"
	fi

	echo "   $__copied static files in place"

	# `public/` is optional -- this app has none today, but a future one would
	# be served from the same cwd and would fail the same way.
	if [ -d public ]; then
		rm -rf .next/standalone/public
		cp -r public .next/standalone/public || fail "could not copy public/ into standalone"
		echo "   public/ copied"
	fi
else
	echo "→ no standalone output; skipping the static copy"
fi


echo "✓ all gates passed"

# ═══ Everything below may change state ═══════════════════════════

# ─── 5. Fresh backup ────────────────────────────────────────────
echo "→ backup database"
__stamp="$(date -u +%Y%m%d-%H%M%S)"
__dump="$BACKUP_DIR/dongchannel_ops-deploy-${__stamp}.dump"
eval "$CMD_BACKUP \"$__dump\"" || fail "backup failed -- refusing to migrate without one"
echo "   $__dump"

# ─── 6. Pending migrations ──────────────────────────────────────
# Printed before applying so the deploy log records what was about to run.
echo "→ pending migrations"
ls -1 src/lib/db/migrations/*.sql 2>/dev/null | tail -3 | sed 's/^/   /' || true

# ─── 7. Migrate ─────────────────────────────────────────────────
#
# Migrations run as the SCHEMA OWNER, not as the runtime role.
#
# Q35 / AUDIT-ROLE-SEPARATION separated the two: `opsdash` no longer owns the
# tables and has no CREATE on the schema, so it can no longer disable the
# append-only enforcement -- and equally, can no longer run a migration. The DDL
# authority lives in `dc_migrator`, whose DSN is `MIGRATION_DATABASE_URL` in
# `.env`.
#
# If that variable is absent the deploy FAILS rather than falling back to
# DATABASE_URL. A fallback would mean a machine where the roles were never
# separated silently migrates as the runtime role, which is the exact state the
# gate exists to end -- and it would do so while reporting success.
echo "→ drizzle migrate"
if [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
  fail "MIGRATION_DATABASE_URL is not set -- refusing to migrate as the runtime role (Q35)"
fi
DATABASE_URL="$MIGRATION_DATABASE_URL" eval "$CMD_MIGRATE" \
  || fail "migration failed -- app NOT restarted, still serving the previous version"

# The migrator DSN dies with the migration. Nothing after this line needs it,
# and step 9 restarts PM2 with `--update-env`, which copies THIS SHELL'S
# environment into the application process. Measured on the running app: the
# variable was present in /proc/<pid>/environ, so the app held the credential
# for the role whose DDL authority Q35 exists to deny it -- separation enforced
# in the database and handed back through an inherited variable.
unset MIGRATION_DATABASE_URL

# ─── 8. Seed (bootstrap only, opt-in) ───────────────────────────
if [ "${DEPLOY_RUN_SEED:-0}" = "1" ]; then
  echo "→ seed allowlist (DEPLOY_RUN_SEED=1)"
  eval "$CMD_SEED" || fail "seed failed"
else
  echo "→ skip seed (set DEPLOY_RUN_SEED=1 to bootstrap the allowlist)"
fi

# ─── 9. Restart on the artifact that just passed every gate ─────
#
# A guard, not a comment. `unset` above is easy to lose to a later edit, and its
# absence would be invisible: the deploy would succeed, the app would work, and
# the only symptom would be a credential sitting in a process environment nobody
# looks at.
if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
  fail "MIGRATION_DATABASE_URL is still set at restart -- pm2 --update-env would copy
       the migrator credential into the application process (Q35)"
fi
echo "→ restart PM2 app: $PM2_APP_NAME"
eval "$CMD_RESTART" || {
  echo "!! pm2 restart failed. Known processes:" >&2
  pm2 list || true
  fail "restart failed"
}

# ─── 10. Verify ─────────────────────────────────────────────────
sleep 3

if [ "${SKIP_HEALTH:-0}" = "1" ]; then
  # Guard-suite control path only. Never set in a real deploy.
  echo "→ skip health checks (SKIP_HEALTH=1)"
  __root="skipped"
else
echo "→ health check on 127.0.0.1:$APP_PORT"
# Port 3000 belongs to a different application on this host, so the port is
# explicit and the body is asserted rather than the status code trusted.
__local="$(curl -sS --max-time 15 "http://127.0.0.1:$APP_PORT/api/health" || true)"
case "$__local" in
  *'"status":"ok"'*) echo "   local health ok" ;;
  *) echo "   response: $__local" >&2; fail "local health check did not return status ok" ;;
esac

echo "→ external health check"
__ext="$(curl -sS --max-time 20 "$PUBLIC_URL/api/health" || true)"
case "$__ext" in
  *'"status":"ok"'*) echo "   external health ok" ;;
  *) echo "   response: $__ext" >&2; fail "external health check did not return status ok" ;;
esac

echo "→ root response"
__root="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL" || true)"
case "$__root" in
  2*|3*) echo "   root $__root" ;;
  *) fail "root returned $__root" ;;
esac
fi

# ─── 11. Deploy evidence ────────────────────────────────────────
echo "→ deploy evidence"
{
  echo "deployed_at   $(date -u +%FT%TZ)"
  echo "commit        $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "backup        $__dump"
  echo "local_health  ok"
  echo "external      ok"
  echo "root          $__root"
} | tee -a "$APP_DIR/deploy-evidence.log" | sed 's/^/   /'

echo "✓ Deploy done. Verify $PUBLIC_URL"
