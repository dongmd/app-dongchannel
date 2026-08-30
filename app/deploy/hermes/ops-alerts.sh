#!/usr/bin/env bash
#
# P4-R09 AC-05 — the collector.
#
# Runs as a Hermes cron job with `no_agent=true`, which means THIS SCRIPT IS
# THE JOB: whatever it writes to stdout is delivered verbatim to the profile's
# Telegram channel, through the sender Hermes already owns. Nothing here holds
# a bot token, and nothing here talks to Telegram.
#
#   Ops Hub queues  →  this script collects  →  Hermes' existing sender  →  owner
#
# It lives on the persistent volume, under the profile's own scripts/ directory
# (Hermes refuses any script outside it). That is deliberate: /opt/hermes is
# image content and a change there would vanish on the next image update,
# silently, with the cron job still listed and still firing.
#
# ── Silence is the normal case ────────────────────────────────────────
#
# Hermes skips whitespace-only output, so an empty queue sends nothing. That is
# what makes a 5-minute schedule tolerable: the owner hears from it only when
# something is wrong.
#
# ── But a channel that fails silently is the thing we are guarding against ──
#
# If this script printed nothing on error, a broken token or a down Ops Hub
# would look exactly like a quiet afternoon, and P4-R09's whole point is that a
# failed publish does not pass unnoticed. So consecutive failures are counted,
# and the owner is told ONCE when the count crosses the threshold — not every
# five minutes, which is how a person learns to ignore a channel.

set -uo pipefail

# Resolve the profile from where this script sits, not from the environment.
# The cron runner's env is not ours to assume, and a wrong profile here would
# deliver AFF alerts into the YouTube assistant's chat.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_HOME="$(dirname "$SCRIPT_DIR")"
PROFILE="$(basename "$PROFILE_HOME")"

TOKEN_FILE="$PROFILE_HOME/.opsalert.token"
STATE_FILE="$PROFILE_HOME/cron/.opsalert.consecutive-failures"
ENDPOINT="${OPS_HUB_URL:-https://app.dongchannel.com}/api/v1/outbound/alerts"

# How many consecutive failures before the owner is told the channel is down.
# 6 × 5 minutes = half an hour, which is longer than a deploy and shorter than
# a working day.
FAIL_ALERT_AFTER=6

read_fails()  { cat "$STATE_FILE" 2>/dev/null || echo 0; }
write_fails() { printf '%s' "$1" > "$STATE_FILE" 2>/dev/null || true; }

fail_quietly() {
  # $1 = a short reason, for the threshold message only.
  local n
  n=$(( $(read_fails) + 1 ))
  write_fails "$n"
  if [ "$n" -eq "$FAIL_ALERT_AFTER" ]; then
    # Exactly once, at the crossing. Not before, not again after.
    printf '⚠️ Ops Hub alert channel (%s) has been unreachable for %d consecutive checks.\n' \
      "$PROFILE" "$n"
    printf 'Reason: %s\n' "$1"
    printf 'Publish failures are still recorded in the Ops Hub — they are just not reaching Telegram.\n'
  fi
  exit 0
}

if [ ! -r "$TOKEN_FILE" ]; then
  fail_quietly "the service token file is missing or unreadable"
fi

# --fail-with-body would print the error body; we never want an upstream body
# on stdout, because stdout is a Telegram message. Status and body are captured
# separately instead.
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

STATUS="$(
  curl -sS --max-time 20 \
    -o "$BODY_FILE" -w '%{http_code}' \
    -H "x-dc-service-token: $(cat "$TOKEN_FILE")" \
    "$ENDPOINT?profile=$PROFILE" 2>/dev/null
)" || fail_quietly "could not reach the Ops Hub"

case "$STATUS" in
  200) ;;
  401) fail_quietly "the Ops Hub rejected the service token (401)" ;;
  ""|000) fail_quietly "no response from the Ops Hub" ;;
  *)   fail_quietly "the Ops Hub answered HTTP $STATUS" ;;
esac

# Reached the Ops Hub and it answered. The channel works, whatever the queue
# held -- so the failure streak ends here, including the empty-queue case.
write_fails 0

# Verbatim. The endpoint returns exactly the text the owner should read, and
# anything added here would be added to every alert forever.
cat "$BODY_FILE"
