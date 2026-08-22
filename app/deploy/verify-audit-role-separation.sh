#!/usr/bin/env bash
#
# Q35 / AUDIT-ROLE-SEPARATION — prove the invariant holds UNDER THE ACTUAL
# RUNTIME ROLE, on the real database.
#
#   sudo bash verify-audit-role-separation.sh
#
# Every destructive attempt runs inside a transaction that is ROLLED BACK, and
# the enforcement objects are counted before and afterwards. Nothing is proven
# by an absence of change: the refusals are asserted on the raised error, and a
# control confirms the runtime can still do the work it legitimately needs.
#
# `SET ROLE` is how the runtime's authority is exercised without its password.
# Dropping to a non-superuser role drops superuser powers with it, so the
# permission checks below are the real ones.

set -uo pipefail

DB=dongchannel_ops
RUNTIME=opsdash
OWNER=dc_migrator

PASS=0; FAIL=0; CTL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
ctl() { CTL=$((CTL+1));   printf 'CTL!  %s\n' "$1"; }

q() { sudo -u postgres psql -d "$DB" -tAc "$1" 2>&1; }

# Run one statement as the runtime role, inside a rolled-back transaction.
as_runtime() {
  sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
SET ROLE ${RUNTIME};
$1;
ROLLBACK;
SQL
}

echo "=== 0. CONTROL: the enforcement exists BEFORE any test ==="
TRG_BEFORE="$(q "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='audit_events' and not t.tgisinternal")"
if [ "${TRG_BEFORE:-0}" -ge 3 ]; then
  ok "audit_events carries $TRG_BEFORE append-only triggers"
else
  ctl "expected >=3 append-only triggers, found ${TRG_BEFORE:-0} -- nothing below is proven"
fi

echo
echo "=== 1. Ownership is separated ==="
OWN="$(q "select pg_get_userbyid(relowner) from pg_class where relname='audit_events'")"
[ "$OWN" = "$OWNER" ] && ok "audit_events is owned by $OWNER, not the runtime" \
                      || bad "audit_events is owned by '$OWN' (expected $OWNER)"

CNT="$(q "select count(*) from pg_tables where schemaname='public' and tableowner='${RUNTIME}'")"
[ "$CNT" = "0" ] && ok "the runtime role owns 0 tables in public" \
                 || bad "the runtime role still owns $CNT tables"

echo
echo "=== 2. No escalation path ==="
MEM="$(q "select count(*) from pg_auth_members am join pg_roles m on m.oid=am.member join pg_roles r on r.oid=am.roleid where m.rolname='${RUNTIME}'")"
[ "$MEM" = "0" ] && ok "the runtime role is a member of no role -- no SET ROLE escalation" \
                 || bad "the runtime role has $MEM role memberships"

SUP="$(q "select rolsuper::text || '/' || rolcreaterole::text || '/' || rolcreatedb::text from pg_roles where rolname='${RUNTIME}'")"
[ "$SUP" = "false/false/false" ] && ok "runtime role: not superuser, no createrole, no createdb" \
                                 || bad "runtime role attributes are $SUP"

CRE="$(q "select has_schema_privilege('${RUNTIME}','public','CREATE')::text")"
[ "$CRE" = "false" ] && ok "the runtime role cannot CREATE in schema public" \
                     || bad "the runtime role still has CREATE on schema public"

echo
echo "=== 3. The runtime CANNOT disable the enforcement ==="

out="$(as_runtime "DROP TRIGGER dc_audit_events_no_update ON audit_events")"
echo "$out" | grep -qi "must be owner\|permission denied" \
  && ok "DROP TRIGGER refused" || bad "DROP TRIGGER was not refused: $(echo "$out" | head -1)"

out="$(as_runtime "ALTER TABLE audit_events DISABLE TRIGGER dc_audit_events_no_update")"
echo "$out" | grep -qi "must be owner\|permission denied" \
  && ok "DISABLE TRIGGER refused" || bad "DISABLE TRIGGER was not refused: $(echo "$out" | head -1)"

out="$(as_runtime "CREATE OR REPLACE FUNCTION dc_audit_events_append_only() RETURNS TRIGGER AS \$f\$ BEGIN RETURN NEW; END \$f\$ LANGUAGE plpgsql")"
echo "$out" | grep -qi "must be owner\|permission denied" \
  && ok "replacing the enforcement function refused" || bad "the function could be replaced: $(echo "$out" | head -1)"

out="$(as_runtime "ALTER TABLE audit_events DROP COLUMN result")"
echo "$out" | grep -qi "must be owner\|permission denied" \
  && ok "invariant-removing ALTER TABLE refused" || bad "ALTER TABLE was not refused: $(echo "$out" | head -1)"

out="$(as_runtime "ALTER TABLE audit_events OWNER TO ${RUNTIME}")"
echo "$out" | grep -qi "must be owner\|permission denied" \
  && ok "ownership change refused" || bad "ownership could be taken: $(echo "$out" | head -1)"

out="$(as_runtime "DROP TABLE audit_events")"
echo "$out" | grep -qi "must be owner\|permission denied" \
  && ok "DROP TABLE refused" || bad "DROP TABLE was not refused: $(echo "$out" | head -1)"

echo
echo "=== 4. The runtime cannot rewrite history either ==="

out="$(as_runtime "UPDATE audit_events SET result='TAMPERED'")"
echo "$out" | grep -qi "permission denied\|append-only" \
  && ok "UPDATE refused" || bad "UPDATE was not refused: $(echo "$out" | head -1)"

out="$(as_runtime "DELETE FROM audit_events")"
echo "$out" | grep -qi "permission denied\|append-only" \
  && ok "DELETE refused" || bad "DELETE was not refused: $(echo "$out" | head -1)"

out="$(as_runtime "TRUNCATE audit_events")"
echo "$out" | grep -qi "permission denied\|append-only" \
  && ok "TRUNCATE refused" || bad "TRUNCATE was not refused: $(echo "$out" | head -1)"

echo
echo "=== 5. CONTROL: the runtime can still do its job ==="
# Without this, every refusal above would also be produced by a role that had
# been locked out of the database entirely.
out="$(as_runtime "INSERT INTO audit_events (actor_type, action, result) VALUES ('system','telegram.command','OK')")"
echo "$out" | grep -qi "error" \
  && ctl "the runtime can no longer INSERT an audit row -- the app is broken: $(echo "$out" | head -1)" \
  || ok "the runtime can still INSERT an audit row"

out="$(as_runtime "SELECT count(*) FROM audit_events")"
echo "$out" | grep -qi "permission denied" \
  && ctl "the runtime can no longer read the audit log (AC-10)" \
  || ok "the runtime can still read the audit log"

out="$(as_runtime "UPDATE tasks SET updated_at = updated_at WHERE false")"
echo "$out" | grep -qi "permission denied" \
  && ctl "the runtime lost DML on an ordinary application table -- over-restricted" \
  || ok "the runtime retains DML on ordinary application tables"

echo
echo "=== 6. The enforcement survived every attempt ==="
TRG_AFTER="$(q "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='audit_events' and not t.tgisinternal")"
[ "$TRG_AFTER" = "$TRG_BEFORE" ] && ok "triggers before=$TRG_BEFORE after=$TRG_AFTER -- unchanged" \
                                 || bad "trigger count changed: $TRG_BEFORE -> $TRG_AFTER"

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAIL control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
  echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAIL" -eq 0 ]; then
  echo "VERDICT=PASS -- the runtime role cannot disable or bypass append-only enforcement"
else
  echo "VERDICT=FAIL"; exit 1
fi
