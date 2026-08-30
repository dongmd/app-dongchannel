#!/usr/bin/env bash
#
# M-17 regression check — the Hermes cron path, verified as the ticker sees it.
#
# The defect this exists for: `jobs.json` written by `docker exec` as root is
# created correctly, is mode 600, is in the right place, and stalls the
# profile's entire cron ticker. Nothing reports it. The job stays `scheduled`,
# which is a truthful description of a job that will never run, and the
# heartbeat keeps advancing because it records that the ticker is ALIVE, not
# that it accomplished anything.
#
# So every check below is made **as the consumer** (uid 10000, inside the
# container), never as root. A root `test -r` succeeds on a file the ticker
# cannot open, which is precisely how the original defect passed unnoticed.
#
# Usage:  bash cron-health.sh            # check
#         bash cron-health.sh --selftest # prove the check can FAIL
#
# Exit 0 = healthy. Exit 1 = something a person needs to look at.

set -uo pipefail

CONTAINER="${HERMES_CONTAINER:-hermes}"
HERMES_UID="${HERMES_UID:-10000}"
PROFILES="${HERMES_PROFILES:-aff yt}"
JOB_NAME="${OPS_ALERT_JOB:-ops-hub-alerts}"
HEARTBEAT_MAX_AGE=180   # the ticker beats about once a minute

fails=0
ok()   { printf '  [ ok ] %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; fails=$((fails + 1)); }

# Run a command INSIDE the container as the Hermes user.
as_ticker() { docker exec -u "$HERMES_UID" "$CONTAINER" "$@"; }

echo "Hermes cron health (checked as uid $HERMES_UID, the user that runs the ticker)"
echo

for P in $PROFILES; do
  echo "profile: $P"
  HOME_IN="/opt/data/profiles/$P"

  # 1. Storage is where an image update cannot reach it.
  #    /opt/hermes is image content; /opt/data is the mounted volume. A job
  #    stored in the former survives until the next `docker pull` and then
  #    vanishes with the job still listed and still firing.
  if as_ticker test -d "$HOME_IN/cron" 2>/dev/null; then
    ok "cron store is on the mounted volume ($HOME_IN/cron)"
  else
    bad "$HOME_IN/cron is not present to the ticker"
    continue
  fi

  # 2. THE M-17 CHECK. Readable by the ticker, not merely readable.
  if as_ticker test -r "$HOME_IN/cron/jobs.json" 2>/dev/null; then
    ok "jobs.json is readable BY THE TICKER"
  else
    bad "jobs.json exists but the ticker cannot read it -- this is M-17. \
Check ownership: it must be uid $HERMES_UID, not root."
  fi

  # Everything the ticker must also write.
  for f in cron cron/output scripts; do
    if as_ticker test -w "$HOME_IN/$f" 2>/dev/null; then
      ok "$f is writable by the ticker"
    else
      bad "$f is not writable by the ticker"
    fi
  done

  # 3. The heartbeat is advancing AND the ticker is completing passes.
  #    Both, deliberately: a live ticker that completes nothing looks identical
  #    to a healthy one if you only read the heartbeat. That divergence is what
  #    exposed M-17.
  now="$(date +%s)"
  for hb in ticker_heartbeat ticker_last_success; do
    v="$(as_ticker cat "$HOME_IN/cron/$hb" 2>/dev/null | tr -d '[:space:]')"
    if [ -z "$v" ]; then
      bad "$hb is missing or empty"
      continue
    fi
    age=$(( now - ${v%%.*} ))
    if [ "$age" -le "$HEARTBEAT_MAX_AGE" ]; then
      ok "$hb is ${age}s old"
    else
      bad "$hb is ${age}s old (limit ${HEARTBEAT_MAX_AGE}s)"
    fi
  done

  # 4. The alert job itself: present, enabled, and its LAST DELIVERY was clean.
  #    `last_status` is deliberately not the signal -- it reports `ok` even when
  #    Telegram refused the message, proven by a control on 2026-08-30.
  out="$(as_ticker /opt/hermes/.venv/bin/python -c "
import sys, json
sys.path.insert(0, '/opt/hermes')
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from cron import jobs as cron_jobs
home = '$HOME_IN'
t = set_hermes_home_override(home)
try:
    with cron_jobs.use_cron_store(home):
        m = [j for j in cron_jobs.list_jobs() if j.get('name') == '$JOB_NAME']
finally:
    reset_hermes_home_override(t)
if not m:
    print('MISSING'); raise SystemExit
j = m[0]
print(json.dumps({
    'enabled': bool(j.get('enabled')),
    'delivery_error': j.get('last_delivery_error'),
    'last_run_at': j.get('last_run_at'),
}))
" 2>/dev/null)"

  case "$out" in
    MISSING|"") bad "cron job '$JOB_NAME' is not present in this profile" ;;
    *)
      if printf '%s' "$out" | grep -q '"enabled": true'; then
        ok "cron job '$JOB_NAME' exists and is enabled"
      else
        bad "cron job '$JOB_NAME' exists but is DISABLED"
      fi
      if printf '%s' "$out" | grep -q '"delivery_error": null'; then
        ok "last delivery carried no error"
      else
        # Never echo the field: a delivery error can quote the target.
        bad "the last delivery recorded an error -- inspect last_delivery_error on the host"
      fi
      ;;
  esac
  echo
done

# ── The control ───────────────────────────────────────────────────
#
# A check that cannot fail proves nothing. --selftest breaks exactly the
# condition M-17 broke -- ownership of jobs.json -- confirms this script
# NOTICES, and puts it back. It touches one file, restores it in a trap, and
# never disables anything.
if [ "${1:-}" = "--selftest" ]; then
  echo "SELFTEST: making jobs.json unreadable to the ticker, as root did in M-17"
  P="${SELFTEST_PROFILE:-aff}"
  F="/opt/hermes-data/profiles/$P/cron/jobs.json"
  orig="$(stat -c '%u:%g' "$F")"
  restore() { chown "$orig" "$F"; echo "  restored ownership to $orig"; }
  trap restore EXIT

  chown 0:0 "$F"
  if as_ticker test -r "/opt/data/profiles/$P/cron/jobs.json" 2>/dev/null; then
    echo "  [FAIL] the ticker could still read it -- this control proves nothing"
    exit 1
  fi
  echo "  [ ok ] the ticker cannot read it, so the check above would have caught this"
  exit 0
fi

echo "---"
if [ "$fails" -eq 0 ]; then
  echo "OK: cron storage is readable and writable by the ticker, the ticker is"
  echo "    completing passes, and the alert job is enabled with a clean delivery."
  exit 0
fi
echo "FAIL: $fails check(s) failed."
exit 1
