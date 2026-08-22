#!/bin/bash
# Regression suite for the deploy pipeline's guards (TD-18).
#
# It proves the properties by *observation*: every step of deploy-vps.sh is
# overridden with a fake that appends its name to a trace file, so each
# assertion is "did this step actually run" rather than "does the script look
# right".
#
#   1. build fails               → migration never runs
#   2. lint/typecheck/test fail  → migration never runs
#   3. migration fails           → PM2 is not restarted
#   4. health fails              → non-zero exit and no "Deploy done"
#
# The CONTROL case is not optional. Without it, every case below could be
# passing because the script died on its first line -- and a suite that passes
# for the wrong reason is worse than no suite. That is exactly what the first
# version of this file did: seven green checks, empty traces, nothing executed.
#
# Nothing here touches the real database, app or repository: SKIP_PULL and
# SKIP_INSTALL are set, APP_DIR points at a sandbox, and every mutating command
# is a fake.
#
#   bash deploy/test-deploy-guards.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$SCRIPT_DIR/deploy-vps.sh"
PASS=0
FAIL=0

# The deploy script cds into $APP_DIR/app, mirroring the repo layout.
SANDBOX="$(mktemp -d)"
mkdir -p "$SANDBOX/app/src/lib/db/migrations"
printf 'DEPLOY_TEST=1\n' > "$SANDBOX/app/.env"
trap 'rm -rf "$SANDBOX"' EXIT

# Fakes. Each records that it ran; `false` makes the step fail.
ok()  { echo "echo $1 >> \$TRACE"; }
bad() { echo "echo $1 >> \$TRACE; false"; }

run_case() {
  # run_case <name> <ok|fail> "<steps that must NOT run>" -- <env assignments...>
  local name="$1"; shift
  local expect="$1"; shift
  local forbidden="$1"; shift
  shift # the literal --

  TRACE="$(mktemp)"
  export TRACE

  local out rc
  out="$(env DEPLOY_REEXEC=1 SKIP_PULL=1 SKIP_INSTALL=1 APP_DIR="$SANDBOX" "$@" bash "$DEPLOY" 2>&1)"
  rc=$?

  local good=1
  local why=""

  if [ "$expect" = "fail" ]; then
    [ "$rc" -eq 0 ] && { good=0; why="$why expected non-zero exit;"; }
    grep -q "Deploy done" <<<"$out" && { good=0; why="$why printed 'Deploy done' on a failed deploy;"; }
  else
    [ "$rc" -ne 0 ] && { good=0; why="$why expected success, got exit $rc;"; }
    grep -q "Deploy done" <<<"$out" || { good=0; why="$why expected 'Deploy done';"; }
  fi

  local step
  for step in $forbidden; do
    grep -qx "$step" "$TRACE" 2>/dev/null && { good=0; why="$why '$step' ran but must not have;"; }
  done

  if [ "$good" = "1" ]; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name -- $why"
    echo "        trace: $(tr '\n' ' ' < "$TRACE")"
    echo "        tail:  $(tail -2 <<<"$out" | tr '\n' ' ')"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$TRACE"
}

echo "Deploy guard regression suite"
echo

run_case "CONTROL: all gates green → whole pipeline runs" ok "" -- \
  SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

run_case "build fails → no backup, no migration, no restart" fail "BACKUP MIGRATE RESTART" -- \
  SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(bad BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

run_case "lint fails → migration never runs" fail "BACKUP MIGRATE RESTART" -- \
  SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
  CMD_LINT="$(bad LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

run_case "typecheck fails → migration never runs" fail "BACKUP MIGRATE RESTART" -- \
  SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(bad TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

run_case "tests fail → migration never runs" fail "BACKUP MIGRATE RESTART" -- \
  SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(bad TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

run_case "backup fails → migration never runs" fail "MIGRATE RESTART" -- \
  SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(bad BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

run_case "no MIGRATION_DATABASE_URL → migration never runs (Q35)" fail "MIGRATE RESTART" -- \
  SKIP_HEALTH=1 \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

run_case "migration fails → PM2 not restarted" fail "RESTART" -- \
  SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(bad MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

# Q35 again, from the other side. The credential being PRESENT is not enough --
# it must not be present in the file the running application loads. Post-
# deployment verification found it in `.env`, which the Next standalone server
# reads at runtime, so the app process could have read the DSN whose whole
# purpose is to be unavailable to it. Separation enforced in the database and
# undone by a file read is not separation.
printf 'DEPLOY_TEST=1
MIGRATION_DATABASE_URL=postgres://leak@127.0.0.1/leak
' > "$SANDBOX/app/.env"
run_case "MIGRATION_DATABASE_URL inside .env -> refuse to deploy (Q35)" fail "BUILD MIGRATE RESTART" --   SKIP_HEALTH=1   CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)"   CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)"   CMD_RESTART="$(ok RESTART)"
# CONTROL: restore the clean fixture, or every later case inherits the leak and
# fails for a reason that has nothing to do with what it is testing.
printf 'DEPLOY_TEST=1
' > "$SANDBOX/app/.env"

# Q35b is NOT tested here, deliberately.
#
# This harness runs on the developer machine, where the filesystem does not
# implement unix permissions: `chmod 600` followed by `stat -c %a` reports 644.
# A case asserting "a world-readable secret is refused" passes there because
# EVERY file is world-readable, and its 600 control cannot pass at all. That is
# a vacuous case dressed as coverage, which is worse than no case.
#
# The Q35b guard is exercised by deploy/test-secret-isolation.sh, on the VPS,
# where permissions and unix users are real and the authoritative branch --
# attempting the read AS the runtime user -- can actually run.

# The credential must not survive as far as the restart. `pm2 --update-env`
# copies the deploy shell's environment into the application process, and that
# is how it got there: measured in /proc/<pid>/environ on the running app.
# CMD_RESTART records the environment it was called with, so the assertion is on
# what the restart would actually have propagated, not on a variable this
# harness set itself.
RESTART_ENV="$SANDBOX/restart-env.txt"
run_case "migrator DSN is gone before pm2 --update-env (Q35)" ok "" --   SKIP_HEALTH=1 MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture   CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)"   CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)"   CMD_RESTART="printf '%s' \"\${MIGRATION_DATABASE_URL:-ABSENT}\" > $RESTART_ENV; echo RESTART"
if [ "$(cat "$RESTART_ENV" 2>/dev/null)" = "ABSENT" ]; then
  PASS=$((PASS+1)); echo "  PASS  restart saw MIGRATION_DATABASE_URL as ABSENT"
else
  FAIL=$((FAIL+1)); echo "  FAIL  restart still saw the migrator DSN -- pm2 --update-env would leak it"
fi

# Health checks run for real here, against a closed port.
run_case "health fails → failure exit, no 'Deploy done'" fail "" -- \
  APP_PORT=9 PUBLIC_URL="http://127.0.0.1:9" \
  CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" \
  CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" \
  CMD_RESTART="$(ok RESTART)"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
