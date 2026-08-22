#!/usr/bin/env bash
#
# P3-R02 AC-04b — prove BY EXECUTION that a Telegram action cannot put an
# affiliate project into an execution state.
#
#   bash deploy/test-command-integrity.sh <scratch-database-url>
#
# The command module refuses to. This asks the database, which is the layer that
# still refuses when a future call site forgets.
#
# Refusals are asserted ON THE RAISED ERROR, never on an absence of change.
# "Nothing happened" is equally true of a write that was silently dropped, a
# WHERE that matched no rows, and a connection that never opened.

set -u

URL="${1:-}"
PSQL="${PSQL_CMD:-psql}"

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$URL" ] || fail "usage: $0 <scratch-database-url>"
case "$URL" in
	*dongchannel_ops*) fail "that is the production database. Use a scratch database." ;;
esac
case "$URL" in
	*scratch*|*test*|*tmp*|*_ci*) : ;;
	*) fail "the scratch URL must be clearly named scratch/test/tmp -- refusing to guess" ;;
esac

PASS=0; FAILED=0; CTL=0
ok()  { PASS=$((PASS+1));   printf 'PASS  %-8s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED+1)); printf 'FAIL  %-8s %s\n' "$1" "$2"; }
ctl() { CTL=$((CTL+1));     printf 'CTL!  %-8s %s\n' "$1" "$2"; }

run_sql() { $PSQL "$URL" -v ON_ERROR_STOP=1 -tA -c "$1" 2>&1; }
run_tx()  { $PSQL "$URL" -v ON_ERROR_STOP=1 -tA 2>&1 <<SQL
BEGIN;
$1
ROLLBACK;
SQL
}

echo "=== 0. CONTROL: the enforcement exists before anything is claimed ==="
n="$(run_sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='affiliate_projects' and not t.tgisinternal")"
if [ "${n:-0}" -ge 2 ]; then
	ok "AC-04b" "affiliate_projects carries $n guard triggers"
else
	ctl "AC-04b" "expected >=2 guard triggers, found ${n:-0} -- nothing below is proven"
fi

# A project needs a programme, which needs a network and a merchant. Built once
# and reused, inside each transaction, so nothing survives the run.
FIXTURE="
INSERT INTO merchants (id, name) VALUES ('11111111-1111-1111-1111-111111111111','T') ON CONFLICT DO NOTHING;
INSERT INTO affiliate_networks (id, key, name) VALUES ('22222222-2222-2222-2222-222222222222','t-net','N') ON CONFLICT DO NOTHING;
INSERT INTO affiliate_programs (id, merchant_id, network_id, name)
  VALUES ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','P')
  ON CONFLICT DO NOTHING;
"

echo
echo "=== 1. A Telegram action may create a project in a non-execution state ==="
out="$(run_tx "$FIXTURE
SET LOCAL dc.in_telegram_action = 'on';
INSERT INTO affiliate_projects (program_id, name, status)
  VALUES ('33333333-3333-3333-3333-333333333333','from telegram','CANDIDATE');
SELECT 'created';")"
if printf '%s' "$out" | grep -q 'created'; then
	ok "AC-04" "a Telegram action CAN create a CANDIDATE project"
else
	ctl "AC-04" "creation is blocked outright -- Q33 allows it: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"
fi

echo
echo "=== 2. It may NOT create one in an execution state ==="
for s in READY_FOR_APPROVAL APPROVED_FOR_TEST CAMPAIGN_DRAFTED TESTING SCALE; do
	out="$(run_tx "$FIXTURE
SET LOCAL dc.in_telegram_action = 'on';
INSERT INTO affiliate_projects (program_id, name, status)
  VALUES ('33333333-3333-3333-3333-333333333333','x','$s');")"
	if printf '%s' "$out" | grep -qi 'Creation is not authorisation'; then
		ok "AC-04b" "INSERT as $s is refused"
	else
		bad "AC-04b" "INSERT as $s was NOT refused: $(printf '%s' "$out" | head -1)"
	fi
done

echo
echo "=== 3. Nor reach one by UPDATE afterwards ==="
# The two-statement path: insert legally, then escalate. INSERT-only enforcement
# would let this through while looking correct.
out="$(run_tx "$FIXTURE
SET LOCAL dc.in_telegram_action = 'on';
INSERT INTO affiliate_projects (id, program_id, name, status)
  VALUES ('44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333','x','CANDIDATE');
UPDATE affiliate_projects SET status = 'APPROVED_FOR_TEST' WHERE id = '44444444-4444-4444-4444-444444444444';")"
if printf '%s' "$out" | grep -qi 'Creation is not authorisation'; then
	ok "AC-04b" "escalating by UPDATE in the same transaction is refused"
else
	bad "AC-04b" "the insert-then-update path succeeded: $(printf '%s' "$out" | head -1)"
fi

echo
echo "=== 4. CONTROL: outside a Telegram action, approval is still possible ==="
# Without this, every refusal above would also be produced by a trigger that
# blocked the state unconditionally -- which would break the Ops Hub and every
# legitimate approval path, while this suite reported success.
out="$(run_tx "$FIXTURE
INSERT INTO affiliate_projects (id, program_id, name, status)
  VALUES ('55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333','y','CANDIDATE');
UPDATE affiliate_projects SET status = 'APPROVED_FOR_TEST' WHERE id = '55555555-5555-5555-5555-555555555555';
SELECT 'approved';")"
if printf '%s' "$out" | grep -q 'approved'; then
	ok "AC-04b" "a non-Telegram actor can still approve -- the guard is scoped, not blanket"
else
	ctl "AC-04b" "approval is blocked for everyone: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"
fi

echo
echo "=== 5. CONTROL: the flag has to be what triggers it ==="
# If the guard fired regardless of the flag, case 4 would have failed. If it
# never fired, case 2 would have. This asserts the pairing directly: the same
# statement, differing only by the flag, gets opposite answers.
a="$(run_tx "$FIXTURE
SET LOCAL dc.in_telegram_action = 'on';
INSERT INTO affiliate_projects (program_id, name, status)
  VALUES ('33333333-3333-3333-3333-333333333333','z','TESTING');")"
b="$(run_tx "$FIXTURE
INSERT INTO affiliate_projects (program_id, name, status)
  VALUES ('33333333-3333-3333-3333-333333333333','z','TESTING');
SELECT 'inserted';")"
if printf '%s' "$a" | grep -qi 'Creation is not authorisation' && printf '%s' "$b" | grep -q 'inserted'; then
	ok "AC-04b" "identical statements differ only by the flag, and get opposite answers"
else
	bad "AC-04b" "the flag is not what decides: flagged=$(printf '%s' "$a" | head -1) unflagged=$(printf '%s' "$b" | head -1)"
fi

echo
echo "=== 6. AC-05: the P2 vocabulary the owner idea uses really exists ==="
for pair in "opportunity_origin_type:OWNER_SEED" "signal_origin_mode:OWNER_TELEGRAM"; do
	t="${pair%%:*}"; v="${pair#*:}"
	n="$(run_sql "select count(*) from pg_enum e join pg_type y on y.oid=e.enumtypid where y.typname='$t' and e.enumlabel='$v'")"
	[ "${n:-0}" = "1" ] && ok "AC-05" "$t has $v -- no new origin type was added" \
	                    || bad "AC-05" "$t does not contain $v"
done

echo
echo "=== 6b. The queries answer from the DATABASE -- AC-03, AC-03b, AC-07 ==="
# Runs the real command-queries module, not a re-implementation of it. A probe
# that rewrote the SQL would be comparing a query with a copy of itself.
PROBE="$(cd "$(dirname "$0")/.." && DATABASE_URL="$URL" npx --yes tsx deploy/r02-queries-probe.ts 2>&1 | tail -1)"

j() { printf '%s' "$PROBE" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

if printf '%s' "$PROBE" | head -c1 | grep -q '{'; then
	ok "" "the probe ran against the scratch database"
else
	ctl "" "the probe did not produce JSON: $(printf '%s' "$PROBE" | head -c 200)"
fi

# AC-03. Seeded so that insertion order is low, unscored, high -- a query with no
# ORDER BY returns exactly that and looks plausible. The stored score order is
# high, low, unscored, with the unscored one LAST because an opportunity nobody
# scored is not a low-scoring one.
order="$(j "['planTitles']")"
if [ "$order" = "['high', 'low', 'unscored']" ]; then
	ok "AC-03" "the plan comes back in stored-score order, not insertion order"
else
	bad "AC-03" "order was $order, expected ['high', 'low', 'unscored']"
fi

# The superseded score for `high` is 5, inserted a day earlier. If the query took
# any score rather than the latest, `high` would come back as 5 and sort last.
scores="$(j "['planScores']")"
if printf '%s' "$scores" | grep -q '90'; then
	ok "AC-03" "the LATEST score per opportunity is used, not a superseded one"
else
	bad "AC-03" "scores were $scores -- the superseded score won"
fi

rendered="$(j "['planRendered']")"
if printf '%s' "$rendered" | grep -q "unscored:UNKNOWN"; then
	ok "AC-06" "an unscored opportunity renders UNKNOWN, from a real null"
else
	bad "AC-06" "rendered as $rendered"
fi

# AC-03b. COMPLETED and CANCELLED are seeded and must not appear.
active="$(j "['activeTitles']")"
if [ "$active" = "['running']" ]; then
	ok "AC-03b" "only active jobs come back; COMPLETED and CANCELLED are excluded"
else
	bad "AC-03b" "active jobs were $active, expected ['running']"
fi

# AC-07. One FAILED task was seeded, so a 1 here is a number that was read.
failed="$(j "['statusCounts']['failedJobs']")"
if [ "$failed" = "1" ]; then
	ok "AC-07" "failed jobs = 1, counted from the seeded row"
else
	bad "AC-07" "failed jobs came back as $failed, expected 1"
fi

pending="$(j "['statusCounts']['pendingApprovals']")"
if [ "$pending" = "0" ]; then
	ok "AC-07" "pending approvals = 0, and 0 is a counted answer here"
else
	bad "AC-07" "pending approvals came back as $pending, expected 0"
fi

reach="$(j "['statusCounts']['databaseReachable']")"
[ "$reach" = "True" ] && ok "AC-07" "database reachable was probed, not assumed"                       || bad "AC-07" "databaseReachable came back as $reach"

# AC-02. A well-formed id matching nothing is a real absence read back, which is
# what turns a NOT_FOUND refusal into a fact rather than a guess.
missing="$(j "['missingProject']")"
[ "$missing" = "None" ] && ok "AC-02" "an unmatched id returns nothing -- NOT_FOUND is read, not assumed"                         || bad "AC-02" "expected no row, got $missing"

echo
echo "=== 7. Nothing was left behind ==="
n="$(run_sql "select count(*) from affiliate_projects")"
[ "${n:-x}" = "0" ] && ok "" "affiliate_projects is empty -- every case rolled back" \
                    || bad "" "affiliate_projects holds $n rows after the run"

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAILED control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
	echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAILED" -eq 0 ]; then
	echo "VERDICT=PASS -- creation is not authorisation, enforced by the database"
else
	echo "VERDICT=FAIL"; exit 1
fi
