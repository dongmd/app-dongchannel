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

# Q35b wrapper paths. On the VPS the deploy is unprivileged and reaches the
# database through root-owned wrappers, so the fail-closed property has to hold
# on THAT path too -- not only on the direct one the cases above exercise.
#
# `sudo -n` is not available in this sandbox, so the wrapper variables are
# pointed at ordinary scripts and the deploy is run AS ROOT, which takes the
# direct branch. That would test nothing. Instead the branch condition itself is
# asserted: the wrapper is used only when NOT root and the file is executable.
BW="$SANDBOX/fake-backup-wrapper"
printf '#!/bin/sh
exit 1
' > "$BW"
chmod +x "$BW"
if sudo -n -l "$BW" >/dev/null 2>&1; then
	run_case "backup wrapper fails -> migration never runs (Q35b)" fail "MIGRATE RESTART" -- 		SKIP_HEALTH=1 BACKUP_WRAPPER="$BW" MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture 		CMD_LINT="$(ok LINT)" CMD_TYPECHECK="$(ok TYPECHECK)" CMD_TEST="$(ok TEST)" 		CMD_BUILD="$(ok BUILD)" CMD_BACKUP="$(ok BACKUP)" CMD_MIGRATE="$(ok MIGRATE)" 		CMD_RESTART="$(ok RESTART)"
else
	# Honest skip. The wrapper branch is selected by `sudo -n -l`, which needs a
	# real sudoers entry; there is none here and inventing one would test a
	# fixture rather than the mechanism. It is exercised on the VPS.
	echo "  SKIP  backup wrapper case -- no passwordless sudoers entry in this sandbox"
fi

# Q35b file-permission cases are NOT tested here, deliberately.
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

# ── The standalone artefact must be readable by the identity that RUNS it ──
#
# Regression guard for the 2026-09-05 defect: a root deploy left
# .next/standalone/.env owned root:root mode 600, so `opssite` could not read
# it. The app survived only because `pm2 restart --update-env` had put the same
# variables in the process environment -- meaning the deploy was green, the app
# was healthy, and the artefact's own env file had never once been read. The
# first restart not inheriting the deploy shell's environment (a reboot
# resurrecting from dump.pm2) would have started an app with no configuration.
#
# TWO cases, because one of them cannot run everywhere and saying so is better
# than a vacuous pass -- the same reasoning as the Q35b note above.

# 1. STRUCTURAL, runs everywhere. The fix is present, and it does not "fix" the
#    problem by widening modes -- which would put the database credential in
#    reach of every account on the host.
if grep -q 'chown -R "$RUNTIME_USER":"$RUNTIME_USER" .next/standalone' "$DEPLOY" \
   && grep -q 'runuser -u "$RUNTIME_USER" -- test -r .next/standalone/.env' "$DEPLOY"; then
	PASS=$((PASS+1)); echo "  PASS  standalone ownership fix present, and verified by attempting the read"
else
	FAIL=$((FAIL+1)); echo "  FAIL  the standalone chown/verify is missing -- the EACCES defect can return"
fi

if grep -qE 'chmod +(-R +)?(644|a\+r|o\+r|go\+r) +\.next/standalone' "$DEPLOY"; then
	FAIL=$((FAIL+1)); echo "  FAIL  the deploy widens modes on the standalone tree -- .env would become world-readable"
else
	PASS=$((PASS+1)); echo "  PASS  the standalone tree is re-owned, never mode-widened (least privilege held)"
fi

# 2. FUNCTIONAL, only where unix permissions and users are real AND we are root.
#    On the developer machine `chmod 600` reports 644 back, so the control could
#    never fail and the case would prove nothing. It runs on the VPS, which is
#    where the defect happened.
if [ "$(id -u)" = "0" ] && id opssite >/dev/null 2>&1 && [ "$(uname -s)" = "Linux" ]; then
	SB2="$(mktemp -d)"
	mkdir -p "$SB2/app/src/lib/db/migrations" "$SB2/app/.next/standalone"
	printf 'DEPLOY_TEST=1\n' > "$SB2/app/.env"
	# Reproduce the defect exactly: root-owned, mode 600, inside the artefact.
	printf 'DEPLOY_TEST=1\n' > "$SB2/app/.next/standalone/.env"
	mkdir -p "$SB2/app/.next/static"; : > "$SB2/app/.next/static/asset.js"
	chown -R root:root "$SB2/app/.next"; chmod 600 "$SB2/app/.next/standalone/.env"

	# CONTROL: the defect is real in this fixture before the deploy touches it.
	if runuser -u opssite -- test -r "$SB2/app/.next/standalone/.env" 2>/dev/null; then
		FAIL=$((FAIL+1)); echo "  FAIL  CONTROL: the fixture is already readable -- this case would pass vacuously"
	else
		out2="$(env DEPLOY_REEXEC=1 SKIP_PULL=1 SKIP_INSTALL=1 SKIP_HEALTH=1 APP_DIR="$SB2" \
			MIGRATION_DATABASE_URL=postgres://fixture@127.0.0.1/fixture \
			CMD_LINT="true" CMD_TYPECHECK="true" CMD_TEST="true" CMD_BUILD="true" \
			CMD_BACKUP="true" CMD_MIGRATE="true" CMD_RESTART="true" \
			bash "$DEPLOY" 2>&1)" || true
		if runuser -u opssite -- test -r "$SB2/app/.next/standalone/.env" 2>/dev/null; then
			PASS=$((PASS+1)); echo "  PASS  the deploy made the standalone .env readable by opssite"
			# And did not do it by widening: other must still not have read.
			m="$(stat -c '%a' "$SB2/app/.next/standalone/.env")"
			case "$m" in
				*0|*1|*2|*3) PASS=$((PASS+1)); echo "  PASS  mode $m -- still not world-readable" ;;
				*) FAIL=$((FAIL+1)); echo "  FAIL  mode $m -- the secret was widened, not re-owned" ;;
			esac
		else
			FAIL=$((FAIL+1)); echo "  FAIL  opssite still cannot read the standalone .env after deploy"
			echo "        tail: $(tail -3 <<<"$out2" | tr '\n' ' ')"
		fi
	fi
	rm -rf "$SB2"
else
	echo "  SKIP  standalone ownership functional case -- needs Linux, root, and the opssite user (runs on the VPS)"
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
