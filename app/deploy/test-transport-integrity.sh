#!/usr/bin/env bash
#
# P3-R01 AC-07 / AC-08 — prove the transport BY EXECUTION.
#
#   bash deploy/test-transport-integrity.sh <scratch-database-url>
#
# Runs the REAL route handler against a real database and reads the audit log
# back. A unit test proves the record is well formed; only this proves the row
# lands — which is the half that fails silently, because a swallowed write leaves
# a working endpoint and an empty log.

set -u

URL="${1:-}"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$URL" ] || fail "usage: $0 <scratch-database-url>"
case "$URL" in *dongchannel_ops*) fail "that is production. Use a scratch database." ;; esac
case "$URL" in *scratch*|*test*|*tmp*|*_ci*) : ;; *) fail "scratch URL must be clearly named" ;; esac

PASS=0; FAILED=0; CTL=0
ok()  { PASS=$((PASS+1));     printf 'PASS  %-8s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED+1)); printf 'FAIL  %-8s %s\n' "$1" "$2"; }
ctl() { CTL=$((CTL+1));       printf 'CTL!  %-8s %s\n' "$1" "$2"; }

cd "$(dirname "$0")/.."
PROBE="$(DATABASE_URL="$URL" npx --yes tsx deploy/r01-transport-probe.ts 2>/dev/null | tail -1)"

j() { printf '%s' "$PROBE" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

echo "=== 0. CONTROL: the probe ran the real route ==="
if printf '%s' "$PROBE" | head -c1 | grep -q '{'; then
	ok "" "the route was invoked against the scratch database"
else
	ctl "" "the probe produced no JSON: $(printf '%s' "$PROBE" | head -c 200)"
	echo; echo "pass=$PASS fail=$FAILED control_failed=$CTL"; echo "VERDICT=VOID"; exit 1
fi

echo
echo "=== 1. AC-07: unconfigured means shut ==="
# The activation gate, exercised rather than described: with no secret in the
# environment -- production's state -- a well-formed request from the real owner
# is still refused.
[ "$(j "['unconfiguredRows']['action']")" = "telegram.transport.refuse" ] \
	&& ok "AC-07" "with no secret configured, even the owner's own request is refused" \
	|| bad "AC-07" "unconfigured request produced $(j "['unconfiguredRows']")"

echo
echo "=== 2. AC-07: a wrong secret is refused ==="
[ "$(j "['badSecretRows']['action']")" = "telegram.transport.refuse" ] \
	&& ok "AC-07" "a forged verification header is refused" \
	|| bad "AC-07" "bad-secret request produced $(j "['badSecretRows']")"

echo
echo "=== 3. AC-08: every refusal is recorded ==="
for k in unconfiguredWrote badSecretWrote; do
	n="$(j "['$k']")"
	[ "$n" = "1" ] && ok "AC-08" "$k: exactly one audit row" \
	               || bad "AC-08" "$k wrote $n audit rows, expected 1"
done

echo
echo "=== 4. AC-08: transport and gateway are DISTINCT events ==="
# A verified request from a stranger is two facts: Telegram sent it, and the
# sender may not act. Collapsing them would make an attack on the endpoint
# indistinguishable from a misconfigured allowlist.
rows="$(j "['strangerRows']")"
if printf '%s' "$rows" | grep -q "telegram.transport.accept" && printf '%s' "$rows" | grep -q "telegram.gateway.deny"; then
	ok "AC-08" "a stranger produces transport.accept AND gateway.deny"
else
	bad "AC-08" "stranger rows were $rows"
fi
[ "$(j "['strangerWrote']")" = "2" ] && ok "AC-08" "two rows, one per layer" \
                                     || bad "AC-08" "stranger wrote $(j "['strangerWrote']") rows"

echo
echo "=== 5. CONTROL: the allowlisted owner is ALLOWED, and also recorded ==="
# Without this, every refusal above would be equally explained by a route that
# refuses everything -- which would pass the security cases and ship a dead bot.
rows="$(j "['ownerRows']")"
if printf '%s' "$rows" | grep -q "telegram.gateway.allow"; then
	ok "AC-08" "the owner's request is allowed and recorded"
else
	ctl "AC-08" "the owner was not allowed; the route refuses everything: $rows"
fi

echo
echo "=== 6. AC-07: a refused request has NO side effects ==="
for k in approvals intents; do
	n="$(j "['$k']")"
	[ "$n" = "0" ] && ok "AC-07" "$k: nothing was created by any request" \
	               || bad "AC-07" "$k holds $n rows after the probe"
done

echo
echo "=== 7. The endpoint never tells a caller which guess was wrong ==="
# Telegram retries an error response, so a 4xx on a forged request would turn a
# refusal into a retry loop against ourselves -- and a 401 would confirm to an
# attacker that the endpoint exists and their secret was wrong.
for k in unconfiguredStatus badSecretStatus strangerStatus ownerStatus; do
	s="$(j "['$k']")"
	[ "$s" = "200" ] && ok "AC-07" "$k answers 200 -- refusals are recorded, not advertised" \
	                 || bad "AC-07" "$k answered $s"
done

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAILED control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
	echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAILED" -eq 0 ]; then
	echo "VERDICT=PASS -- only Telegram gets through, and every decision is recorded"
else
	echo "VERDICT=FAIL"; exit 1
fi
