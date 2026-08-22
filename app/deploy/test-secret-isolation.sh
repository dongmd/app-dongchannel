#!/usr/bin/env bash
#
# Q35b — prove the migration credential is out of reach of the RUNTIME OS
# IDENTITY, on the real machine.
#
#   sudo bash deploy/test-secret-isolation.sh
#
# This harness exists because the equivalent cases CANNOT run on the developer
# machine: there, `chmod 600` followed by `stat -c %a` reports 644, so every
# file is world-readable and a "world-readable file is refused" case passes
# vacuously while its 600 control cannot pass at all.
#
# Everything here is read-only with respect to production. No credential value
# is printed, and the checks assert on the OUTCOME OF AN ATTEMPT rather than on
# mode bits, which are only a proxy: mode misses ACLs, group membership, a
# permissive parent directory and a bind mount.

set -uo pipefail

RUNTIME_USER="${RUNTIME_USER:-opssite}"
SECRET_FILE="${SECRET_FILE:-/root/.dongchannel/migrate.env}"
OLD_SECRET_FILE=/home/opssite/.env.migrate
PM2_APP="${PM2_APP:-dongchannel-app}"
DB=dongchannel_ops

PASS=0; FAIL=0; CTL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
ctl() { CTL=$((CTL+1));   printf 'CTL!  %s\n' "$1"; }

[ "$(id -u)" = "0" ] || { echo "FAIL: run as root (sudo)" >&2; exit 1; }

echo "=== 0. CONTROL: the things under test actually exist ==="
if [ -f "$SECRET_FILE" ]; then
	ok "the migration secret file exists at $SECRET_FILE"
else
	ctl "no file at $SECRET_FILE -- every 'cannot read' below would pass for the wrong reason"
fi
if id "$RUNTIME_USER" >/dev/null 2>&1; then
	ok "the runtime user $RUNTIME_USER exists"
else
	ctl "no such user $RUNTIME_USER -- runuser would fail regardless of permissions"
fi

echo
echo "=== 1. The runtime identity cannot read the secret at rest ==="

if runuser -u "$RUNTIME_USER" -- test -r "$SECRET_FILE" 2>/dev/null; then
	bad "$RUNTIME_USER CAN read $SECRET_FILE"
else
	ok "$RUNTIME_USER cannot read $SECRET_FILE"
fi

# `test -r` answers the access() question. Actually attempting the read closes
# the gap between "the kernel says no" and "the bytes did not arrive".
out="$(runuser -u "$RUNTIME_USER" -- cat "$SECRET_FILE" 2>&1)"
if printf '%s' "$out" | grep -qi 'permission denied\|no such file'; then
	ok "reading it as $RUNTIME_USER is refused by the kernel"
else
	bad "reading it as $RUNTIME_USER produced $(printf '%s' "$out" | wc -c) bytes"
fi

if runuser -u "$RUNTIME_USER" -- test -x "$(dirname "$SECRET_FILE")" 2>/dev/null; then
	bad "$RUNTIME_USER can traverse $(dirname "$SECRET_FILE")"
else
	ok "$RUNTIME_USER cannot even traverse the containing directory"
fi

echo
echo "=== 2. CONTROL: root CAN read it, and it carries the key ==="
# Without this, a deleted or empty file would satisfy every check above while
# leaving the deploy unable to migrate at all.
if [ -s "$SECRET_FILE" ] && grep -q '^MIGRATION_DATABASE_URL=' "$SECRET_FILE"; then
	ok "root reads it and it contains MIGRATION_DATABASE_URL (value not shown)"
else
	ctl "the secret file is empty or lacks the key -- the deploy could not migrate"
fi

echo
echo "=== 3. No copy remains anywhere the runtime identity can reach ==="
if [ -e "$OLD_SECRET_FILE" ]; then
	bad "$OLD_SECRET_FILE still exists"
else
	ok "the old runtime-owned secret file is gone"
fi

hits="$(runuser -u "$RUNTIME_USER" -- grep -rl 'MIGRATION_DATABASE_URL=' \
	/home/opssite 2>/dev/null | grep -v '/deploy/' | head -5)"
if [ -n "$hits" ]; then
	bad "the runtime identity can still read the key here: $(printf '%s' "$hits" | tr '\n' ' ')"
else
	ok "no file under /home/opssite readable by $RUNTIME_USER assigns the key"
fi

echo
echo "=== 4. The running application does not hold it ==="
# PM2 is per-user: run as root it reads /root/.pm2 and reports nothing about this
# app, which is what VOIDed this group on the first run.
PID="$(runuser -u "$RUNTIME_USER" -- pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
    for p in json.load(sys.stdin):
        if p.get('name')=='${PM2_APP}': print(p['pid']); break
except Exception: pass" 2>/dev/null)"
# Identified through PM2 rather than pgrep. A previous run of this check used
# \`pgrep -f\` and matched a root-owned process belonging to a DIFFERENT
# application on this host, which produced a confident and inverted answer.
if [ -n "${PID:-}" ] && [ -r "/proc/$PID/environ" ]; then
	ok "identified the app process via PM2: pid $PID, user $(ps -o user= -p "$PID" | tr -d ' ')"
	n="$(tr '\0' '\n' < "/proc/$PID/environ" | grep -c '^MIGRATION_DATABASE_URL=')"
	[ "$n" = "0" ] && ok "MIGRATION_DATABASE_URL is absent from the app process environment" \
	               || bad "the app process still carries MIGRATION_DATABASE_URL"
	# CONTROL: the app must still have the credential it legitimately needs, or
	# "absent" above would also be true of a process that has no environment.
	d="$(tr '\0' '\n' < "/proc/$PID/environ" | grep -c '^DATABASE_URL=')"
	[ "$d" = "1" ] && ok "the app still has its own DATABASE_URL" \
	               || ctl "the app has no DATABASE_URL -- it cannot be working"
else
	ctl "could not identify the running $PM2_APP process -- nothing in this group is proven"
fi

echo
echo "=== 5. The database roles are still separated ==="
q() { sudo -u postgres psql -d "$DB" -tAc "$1" 2>&1; }
OWN="$(q "select pg_get_userbyid(relowner) from pg_class where relname='audit_events'")"
[ "$OWN" = "dc_migrator" ] && ok "audit_events is owned by dc_migrator" \
                           || bad "audit_events is owned by '$OWN'"
CRE="$(q "select has_schema_privilege('opsdash','public','CREATE')::text")"
[ "$CRE" = "false" ] && ok "the runtime DB role has no CREATE on schema public" \
                     || bad "the runtime DB role has CREATE on schema public"

echo
echo "=== 6. The rotated credential is the one that works ==="
# The old value sat in files the runtime could read, so it was rotated. This
# proves the rotation took: the file's DSN authenticates, which a stale value
# would not. The DSN is passed through the environment, never on argv, because
# argv is world-readable through ps.
MIG="$(sed -n 's/^MIGRATION_DATABASE_URL=//p' "$SECRET_FILE" | head -1)"
if [ -n "$MIG" ]; then
	if PGCONN="$MIG" sh -c 'psql "$PGCONN" -tAc "select 1"' >/dev/null 2>&1; then
		ok "the stored credential authenticates as dc_migrator"
	else
		bad "the stored credential does not authenticate -- the deploy could not migrate"
	fi
else
	ctl "no DSN parsed out of the secret file"
fi
unset MIG

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAIL control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
	echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAIL" -eq 0 ]; then
	echo "VERDICT=PASS -- the runtime OS identity cannot obtain the migration credential"
else
	echo "VERDICT=FAIL"; exit 1
fi
