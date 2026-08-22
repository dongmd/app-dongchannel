#!/usr/bin/env bash
#
# P3-R05 — prove the two-step gate BY EXECUTION.
#
#   bash deploy/test-two-step-integrity.sh <scratch-database-url>
#
# The policy module refuses to act on step 1. This asks the database, which is
# the layer that still refuses when a future call site forgets to ask the policy.
#
# Refusals are asserted ON THE RAISED ERROR, never on an absence of change: a
# statement that changed nothing is equally consistent with a write that was
# silently dropped and with a connection that never opened.

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
ok()  { PASS=$((PASS+1));     printf 'PASS  %-8s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED+1)); printf 'FAIL  %-8s %s\n' "$1" "$2"; }
ctl() { CTL=$((CTL+1));       printf 'CTL!  %-8s %s\n' "$1" "$2"; }

run_sql() { $PSQL "$URL" -v ON_ERROR_STOP=1 -tA -c "$1" 2>&1; }
run_tx()  { $PSQL "$URL" -v ON_ERROR_STOP=1 -tA 2>&1 <<SQL
BEGIN;
$1
ROLLBACK;
SQL
}

ACT1="act_$(printf 'a%.0s' $(seq 32))"
ACT2="act_$(printf 'b%.0s' $(seq 32))"

echo "=== 0. CONTROL: the objects under test exist ==="
n="$(run_sql "select count(*) from information_schema.tables where table_name='telegram_pending_actions'")"
[ "${n:-0}" = "1" ] && ok "AC-01" "telegram_pending_actions exists" \
                    || ctl "AC-01" "no pending-action table -- nothing below is proven"

n="$(run_sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='article_approvals' and not t.tgisinternal")"
[ "${n:-0}" -ge 4 ] && ok "AC-03" "article_approvals carries $n triggers (3 from P3-R04 + the two-step gate)" \
                    || ctl "AC-03" "expected >=4 triggers on article_approvals, found ${n:-0}"

# One pending action, still PENDING. Reused inside each transaction.
PENDING="
INSERT INTO telegram_pending_actions
  (id, issued_to, article_id, revision_id, destination, payload_hash, expires_at)
VALUES ('$ACT1', 4242, 'art-1', 'rev-7', 'dongchannel.com', 'h-abc', now() + interval '10 minutes');
"

echo
echo "=== 1. AC-01/AC-09: step 1 alone cannot produce an approval ==="
out="$(run_tx "$PENDING
SET LOCAL dc.in_telegram_action = 'on';
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-7','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');")"
if printf '%s' "$out" | grep -qi 'needs a confirmed two-step action'; then
	ok "AC-01" "with the action still PENDING, the approval is REFUSED"
else
	bad "AC-01" "step 1 alone created an approval: $(printf '%s' "$out" | head -1)"
fi

echo
echo "=== 2. AC-03: after Confirm, the same approval is permitted ==="
out="$(run_tx "$PENDING
SET LOCAL dc.in_telegram_action = 'on';
UPDATE telegram_pending_actions SET confirmed_at = now() WHERE id = '$ACT1';
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-7','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');
SELECT 'approved';")"
if printf '%s' "$out" | grep -q 'approved'; then
	ok "AC-03" "a confirmed action authorises exactly this approval"
else
	ctl "AC-03" "confirmation does not permit the approval -- the gate blocks everything: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"
fi

echo
echo "=== 3. AC-06: an edit between the two presses is refused ==="
# Confirmed for rev-7; the approval names rev-8. This is the edit-in-the-window
# case, and it is structural: there is no confirmed row for rev-8 to match.
out="$(run_tx "$PENDING
SET LOCAL dc.in_telegram_action = 'on';
UPDATE telegram_pending_actions SET confirmed_at = now() WHERE id = '$ACT1';
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-8','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');")"
if printf '%s' "$out" | grep -qi 'needs a confirmed two-step action'; then
	ok "AC-06" "a confirmation for rev-7 does not authorise rev-8"
else
	bad "AC-06" "an approval was created for a revision nobody confirmed: $(printf '%s' "$out" | head -1)"
fi

echo
echo "=== 4. AC-05: a confirmation for one article does not authorise another ==="
out="$(run_tx "$PENDING
SET LOCAL dc.in_telegram_action = 'on';
UPDATE telegram_pending_actions SET confirmed_at = now() WHERE id = '$ACT1';
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-2','rev-7','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');")"
if printf '%s' "$out" | grep -qi 'needs a confirmed two-step action'; then
	ok "AC-05" "a confirmation for art-1 does not authorise art-2"
else
	bad "AC-05" "a confirm token authorised a different article: $(printf '%s' "$out" | head -1)"
fi

echo
echo "=== 5. AC-04: a cancelled action authorises nothing ==="
out="$(run_tx "$PENDING
SET LOCAL dc.in_telegram_action = 'on';
UPDATE telegram_pending_actions SET cancelled_at = now() WHERE id = '$ACT1';
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-7','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');")"
if printf '%s' "$out" | grep -qi 'needs a confirmed two-step action'; then
	ok "AC-04" "a cancelled action leaves no authority behind"
else
	bad "AC-04" "a cancelled action still authorised an approval: $(printf '%s' "$out" | head -1)"
fi

echo
echo "=== 6. AC-03/AC-04: an outcome is final ==="
out="$(run_tx "$PENDING
UPDATE telegram_pending_actions SET cancelled_at = now() WHERE id = '$ACT1';
UPDATE telegram_pending_actions SET cancelled_at = NULL, confirmed_at = now() WHERE id = '$ACT1';")"
printf '%s' "$out" | grep -qi 'cancelled pending action is final' \
	&& ok "AC-04" "a cancelled action cannot be re-opened as confirmed" \
	|| bad "AC-04" "a cancellation was reversed: $(printf '%s' "$out" | head -1)"

out="$(run_tx "$PENDING
UPDATE telegram_pending_actions SET confirmed_at = now() WHERE id = '$ACT1';
UPDATE telegram_pending_actions SET confirmed_at = now() + interval '1 minute' WHERE id = '$ACT1';")"
printf '%s' "$out" | grep -qi 'confirmed pending action is final' \
	&& ok "AC-03" "a confirmation cannot be re-issued for a second act" \
	|| bad "AC-03" "a confirmed action was confirmed again: $(printf '%s' "$out" | head -1)"

echo
echo "=== 7. AC-06: what consent was given TO cannot be edited afterwards ==="
for col in "revision_id = 'rev-9'" "payload_hash = 'h-other'" "article_id = 'art-9'" "expires_at = now() + interval '99 days'"; do
	out="$(run_tx "$PENDING
UPDATE telegram_pending_actions SET $col WHERE id = '$ACT1';")"
	printf '%s' "$out" | grep -qi 'subject of a pending action is immutable' \
		&& ok "AC-06" "${col%% =*} cannot be changed after the summary" \
		|| bad "AC-06" "${col%% =*} was editable: $(printf '%s' "$out" | head -1)"
done

echo
echo "=== 8. Constraints on the record itself ==="
out="$(run_tx "INSERT INTO telegram_pending_actions
  (id, issued_to, article_id, revision_id, destination, payload_hash, expires_at)
VALUES ('approve:art-1', 4242, 'a', 'r', 'd', 'h', now() + interval '1 hour');")"
printf '%s' "$out" | grep -qi 'pending_action_id_shape' \
	&& ok "AC-05" "an id that is not P3-R03's format is refused" \
	|| bad "AC-05" "a non-opaque id was accepted: $(printf '%s' "$out" | head -1)"

out="$(run_tx "$PENDING
UPDATE telegram_pending_actions SET confirmed_at = now(), cancelled_at = now() WHERE id = '$ACT1';")"
printf '%s' "$out" | grep -qiE 'single_outcome|is final' \
	&& ok "AC-04" "confirmed and cancelled cannot both be recorded" \
	|| bad "AC-04" "a row recorded both outcomes: $(printf '%s' "$out" | head -1)"

out="$(run_tx "INSERT INTO telegram_pending_actions
  (id, issued_to, article_id, revision_id, destination, payload_hash, issued_at, expires_at)
VALUES ('$ACT2', 4242, 'a', 'r', 'd', 'h', now(), now() - interval '1 hour');")"
printf '%s' "$out" | grep -qi 'expiry_after_issue' \
	&& ok "AC-07" "a confirm window that has already closed is refused" \
	|| bad "AC-07" "an already-expired window was accepted: $(printf '%s' "$out" | head -1)"

echo
echo "=== 9. CONTROL: a NON-Telegram approval is unaffected ==="
# Without this, every refusal above would be equally explained by a gate that
# blocks all approvals -- which would break the Ops Hub while this suite
# reported success.
out="$(run_tx "INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-7','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');
SELECT 'approved';")"
printf '%s' "$out" | grep -q 'approved' \
	&& ok "AC-03" "an approval outside a Telegram action still works -- the gate is scoped" \
	|| ctl "AC-03" "approvals are blocked for everyone: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"

echo
echo "=== 10. CONTROL: the flag is what decides ==="
# Identical statements, differing only by the flag, must get opposite answers.
a="$(run_tx "$PENDING
SET LOCAL dc.in_telegram_action = 'on';
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-7','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');")"
b="$(run_tx "$PENDING
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-7','4242','$(printf 'f%.0s' $(seq 64))','n1', now() + interval '1 hour');
SELECT 'inserted';")"
if printf '%s' "$a" | grep -qi 'needs a confirmed two-step action' && printf '%s' "$b" | grep -q 'inserted'; then
	ok "AC-03" "same statements, opposite answers, decided by the flag"
else
	bad "AC-03" "the flag is not what decides: flagged=$(printf '%s' "$a" | head -1) unflagged=$(printf '%s' "$b" | head -1)"
fi

echo
echo "=== 11. Nothing was left behind ==="
for t in telegram_pending_actions article_approvals; do
	n="$(run_sql "select count(*) from $t")"
	[ "${n:-x}" = "0" ] && ok "" "$t is empty -- every case rolled back" \
	                    || bad "" "$t holds $n rows after the run"
done

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAILED control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
	echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAILED" -eq 0 ]; then
	echo "VERDICT=PASS -- step 1 does not act, and only a matching confirmation does"
else
	echo "VERDICT=FAIL"; exit 1
fi
