#!/usr/bin/env bash
#
# Production verification for P3-R06 (immutable audit) and P3-R04 (approval
# records), run against the real database under the REAL RUNTIME ROLE.
#
#   sudo bash verify-production-p3.sh
#
# ## Everything runs inside transactions that ROLL BACK
#
# Not for convenience — for correctness. `audit_events` and `article_approvals`
# are append-only by design, so a committed synthetic row could never be
# removed. An immutable consent log should not permanently carry a row
# recording consent nobody gave, and a canonical audit log should not carry an
# event that never happened. Rolling back proves every constraint fires while
# leaving the production record exactly as it was.
#
# Constraint violations, trigger refusals and permission denials all raise
# inside the transaction, so nothing here is weakened by the rollback.
#
# Row counts and enforcement objects are captured BEFORE and AFTER, and a
# control proves the runtime can still do its real work — otherwise every
# refusal below would also be produced by a role locked out entirely.

set -uo pipefail

DB=dongchannel_ops
RUNTIME=opsdash

PASS=0; FAIL=0; CTL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %-8s %s\n' "$1" "$2"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %-8s %s\n' "$1" "$2"; }
ctl() { CTL=$((CTL+1));   printf 'CTL!  %-8s %s\n' "$1" "$2"; }

q() { sudo -u postgres psql -d "$DB" -tAc "$1" 2>&1; }

# One statement as the runtime role, rolled back.
rt() {
  sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
SET ROLE ${RUNTIME};
$1;
ROLLBACK;
SQL
}

# A whole script as the runtime role, rolled back.
rt_script() {
  sudo -u postgres psql -d "$DB" 2>&1 <<SQL
BEGIN;
SET ROLE ${RUNTIME};
$1
ROLLBACK;
SQL
}

H1="$(printf 'a%.0s' $(seq 1 64))"
H2="$(printf 'b%.0s' $(seq 1 64))"

echo "=== 0. BEFORE: the production record, captured ==="
AUD_BEFORE="$(q "select count(*) from audit_events")"
APP_BEFORE="$(q "select count(*) from article_approvals")"
TRG_BEFORE="$(q "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname in ('audit_events','article_approvals','article_verification') and not t.tgisinternal")"
echo "  audit_events rows      : $AUD_BEFORE"
echo "  article_approvals rows : $APP_BEFORE"
echo "  enforcement triggers   : $TRG_BEFORE"
[ "${TRG_BEFORE:-0}" -ge 8 ] && ok "C-1" "enforcement present before any test" \
                             || ctl "C-1" "expected >=8 triggers, found ${TRG_BEFORE:-0} -- nothing below is proven"

echo
echo "=== 1. P3-R06 — a valid audit INSERT works ==="
out="$(rt "INSERT INTO audit_events (actor_type, action, result) VALUES ('system','telegram.command','OK')")"
echo "$out" | grep -qi "error" && bad "R06" "the runtime cannot write an audit row: $(echo "$out" | head -1)" \
                              || ok "R06" "INSERT accepted under the runtime role"

echo
echo "=== 2. P3-R06 — history cannot be rewritten ==="
for stmt in "UPDATE audit_events SET result='TAMPERED'" \
            "DELETE FROM audit_events" \
            "TRUNCATE audit_events"; do
  label="$(echo "$stmt" | awk '{print $1}')"
  out="$(rt "$stmt")"
  echo "$out" | grep -qi "permission denied\|append-only" \
    && ok "R06" "$label refused" \
    || bad "R06" "$label was NOT refused: $(echo "$out" | head -1)"
done

echo
echo "=== 3. P3-R06 — a refused write leaves NO audit evidence behind ==="
# AC: a failed path must not create false evidence. The refused statements above
# must not have appended anything.
AUD_MID="$(q "select count(*) from audit_events")"
[ "$AUD_MID" = "$AUD_BEFORE" ] && ok "R06" "row count unchanged after the refusals ($AUD_MID)" \
                               || bad "R06" "row count moved $AUD_BEFORE -> $AUD_MID"

echo
echo "=== 4. P3-R06 — the redaction CHECK holds in production ==="
out="$(rt "INSERT INTO audit_events (actor_type, action, result, telegram_ref) VALUES ('system','telegram.command','OK','8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1')")"
echo "$out" | grep -qi "error" && ok "R06" "a bot-token-shaped telegram_ref is refused by the CHECK" \
                              || bad "R06" "a token-shaped value was accepted into telegram_ref"

out="$(rt "INSERT INTO audit_events (actor_type, action, result, telegram_ref) VALUES ('system','telegram.command','OK','42:7')")"
echo "$out" | grep -qi "error" && ctl "R06" "the CHECK refuses valid ids too: $(echo "$out" | head -1)" \
                              || ok "R06" "a well-formed id reference is accepted"

echo
echo "=== 5. Auth telemetry is not mistaken for P3 evidence ==="
# The two domains share the table; the action vocabularies must not overlap.
OVERLAP="$(q "select count(*) from audit_events where action in ('login.success','login.denied','login.error','logout') and action like 'telegram.%'")"
[ "$OVERLAP" = "0" ] && ok "R06" "no row is claimed by both vocabularies" \
                     || bad "R06" "$OVERLAP rows are in both domains"

TELEM="$(q "select count(*) from audit_events where action like 'login.%' or action = 'logout'")"
P3ROWS="$(q "select count(*) from audit_events where action like 'telegram.%' or action like 'approval.%' or action like 'preview.%'")"
echo "  auth telemetry rows: $TELEM   P3 canonical rows: $P3ROWS   total: $AUD_BEFORE"
[ "${TELEM:-0}" -gt 0 ] && ok "R06" "auth telemetry exists and is separable by action prefix" \
                        || ctl "R06" "no telemetry rows at all -- the separation test has no subject"

echo
echo "=== 6. P3-R04 — a synthetic approval, created and constrained ==="
out="$(rt_script "
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('SYNTHETIC-VERIFY-P3R04','rev-1',1,'${H1}','act_synthetic', now() + interval '1 hour');
SELECT 'INSERTED';
")"
echo "$out" | grep -q "INSERTED" && ok "R04" "a synthetic approval can be created" \
                                || bad "R04" "approval insert failed: $(echo "$out" | grep -i error | head -1)"

echo
echo "=== 7. P3-R04 — core fields are immutable ==="
out="$(rt_script "
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('SYNTHETIC-VERIFY-P3R04','rev-1',1,'${H1}','act_synthetic', now() + interval '1 hour');
UPDATE article_approvals SET payload_hash = '${H2}' WHERE article_id = 'SYNTHETIC-VERIFY-P3R04';
")"
echo "$out" | grep -qi "immutable" && ok "R04" "direct mutation of an approval is refused" \
                                  || bad "R04" "an approval could be edited: $(echo "$out" | head -1)"

# The row must EXIST for the row trigger to fire. `article_approvals` is empty
# in production, and a DELETE matching zero rows raises nothing — the first
# version of this case asserted against an empty table and reported a failure
# that was really a vacuous test. Insert, then delete, inside one rolled-back
# transaction.
out="$(rt_script "
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('SYNTHETIC-VERIFY-P3R04','rev-del',1,'${H1}','act_d', now() + interval '1 hour');
DELETE FROM article_approvals WHERE article_id = 'SYNTHETIC-VERIFY-P3R04';
")"
echo "$out" | grep -qi "immutable\|permission denied" && ok "R04" "DELETE on approvals refused" \
                                                     || bad "R04" "approvals can be deleted: $(echo "$out" | head -1)"

echo
echo "=== 8. P3-R04 — one live approval per (article, revision) ==="
out="$(rt_script "
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('SYNTHETIC-VERIFY-P3R04','rev-1',1,'${H1}','act_a', now() + interval '1 hour');
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('SYNTHETIC-VERIFY-P3R04','rev-1',1,'${H2}','act_b', now() + interval '1 hour');
")"
echo "$out" | grep -qi "duplicate key\|unique" && ok "R04" "a second live approval for one revision is refused" \
                                               || bad "R04" "two live approvals coexist: $(echo "$out" | head -1)"

echo
echo "=== 9. P3-R04 — a withdrawal is new historical evidence ==="
out="$(rt_script "
INSERT INTO article_approvals (id, article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('11111111-1111-1111-1111-111111111111','SYNTHETIC-VERIFY-P3R04','rev-1',1,'${H1}','act_a', now() + interval '1 hour');
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at, withdraws_id)
VALUES ('SYNTHETIC-VERIFY-P3R04','rev-1',1,'${H1}','act_w', now() + interval '1 minute','11111111-1111-1111-1111-111111111111');
SELECT 'WITHDRAWN=' || count(*) FROM article_approvals WHERE article_id='SYNTHETIC-VERIFY-P3R04';
")"
echo "$out" | grep -q "WITHDRAWN=2" && ok "R04" "the withdrawal is a NEW row; the original survives" \
                                   || bad "R04" "withdrawal did not produce two rows: $(echo "$out" | grep -i "error\|WITHDRAWN" | head -1)"

echo
echo "=== 10. P3-R04 — shape constraints from 0029 enforce in production ==="
out="$(rt "INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at) VALUES ('S','r',1,'not-a-hash','n', now() + interval '1 hour')")"
echo "$out" | grep -qi "error" && ok "R04" "a malformed payload_hash is refused" \
                              || bad "R04" "a malformed hash was accepted"

out="$(rt "INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, approved_at, expires_at) VALUES ('S','r',1,'${H1}','n', now(), now() - interval '1 hour')")"
echo "$out" | grep -qi "error" && ok "R04" "an expiry before the approval is refused" \
                              || bad "R04" "an approval expiring in the past was accepted"

echo
echo "=== 11. P3-R04 AC-03 — a Telegram action may not write verification state ==="
out="$(rt_script "
SELECT set_config('dc.in_telegram_action','on',true);
INSERT INTO article_verification (article_id) VALUES ('SYNTHETIC-VERIFY-P3R04');
")"
echo "$out" | grep -qi "may not write article_verification" && ok "R04" "the choke point refuses a Telegram-flagged write" \
                                                            || bad "R04" "a Telegram action wrote verification state: $(echo "$out" | head -1)"

# CONTROL: without the flag the same write is permitted, so the guard is not
# simply refusing everything.
out="$(rt_script "INSERT INTO article_verification (article_id) VALUES ('SYNTHETIC-VERIFY-P3R04'); SELECT 'WROTE';")"
echo "$out" | grep -q "WROTE" && ok "R04" "a normal (non-Telegram) verification write is permitted" \
                             || ctl "R04" "the guard refuses normal writes too: $(echo "$out" | head -1)"

echo
echo "=== 12. AFTER: production is exactly as it was ==="
AUD_AFTER="$(q "select count(*) from audit_events")"
APP_AFTER="$(q "select count(*) from article_approvals")"
TRG_AFTER="$(q "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname in ('audit_events','article_approvals','article_verification') and not t.tgisinternal")"

[ "$AUD_AFTER" = "$AUD_BEFORE" ] && ok "SAFE" "audit_events unchanged ($AUD_AFTER)" || bad "SAFE" "audit_events $AUD_BEFORE -> $AUD_AFTER"
[ "$APP_AFTER" = "$APP_BEFORE" ] && ok "SAFE" "article_approvals unchanged ($APP_AFTER)" || bad "SAFE" "article_approvals $APP_BEFORE -> $APP_AFTER"
[ "$TRG_AFTER" = "$TRG_BEFORE" ] && ok "SAFE" "enforcement triggers unchanged ($TRG_AFTER)" || bad "SAFE" "triggers $TRG_BEFORE -> $TRG_AFTER"

SYN="$(q "select count(*) from article_approvals where article_id like 'SYNTHETIC-%'")"
[ "$SYN" = "0" ] && ok "SAFE" "no synthetic row persisted -- nothing to clean up" \
                 || bad "SAFE" "$SYN synthetic approval rows persisted into an immutable table"

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAIL control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
  echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAIL" -eq 0 ]; then
  echo "VERDICT=PASS -- P3-R06 and P3-R04 enforce on production, and production is unchanged"
else
  echo "VERDICT=FAIL"; exit 1
fi
