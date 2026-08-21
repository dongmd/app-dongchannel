#!/usr/bin/env bash
#
# P3-R06 AC-02 / AC-03 — prove append-only BY EXECUTION against a real
# PostgreSQL. Never by reading a comment in application code, which is the
# assurance this requirement exists to replace.
#
#   bash deploy/test-audit-append-only.sh <scratch-database-url>
#
# Three cases, exactly as the owner stated them:
#
#     INSERT  a new event        →  SUCCEEDS
#     UPDATE  an existing event  →  REJECTED
#     DELETE  an existing event  →  REJECTED
#
# The two rejections are asserted ON THE RAISED ERROR, never on an absence of
# change. "Nothing changed" would also be true of a write that was silently
# ignored, of a `WHERE` that matched no rows, and of a connection that was
# never open -- three ways to pass while proving nothing.
#
# Run from app/. Production is never touched: the URL must be clearly scratch.

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

PASS=0
FAILED=0
CONTROL_FAILED=0

ok()  { PASS=$((PASS + 1));           printf 'PASS  %-8s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED + 1));       printf 'FAIL  %-8s %s\n' "$1" "$2"; }
ctl() { CONTROL_FAILED=$((CONTROL_FAILED + 1)); printf 'CTL!  %-8s %s\n' "$1" "$2"; }

# Run SQL, capturing stdout+stderr and the exit code. Errors are NEVER
# suppressed: a harness that hides the cause and reports a confident conclusion
# in its place has already cost this project three diagnostic cycles.
run_sql() {
	$PSQL "$URL" -v ON_ERROR_STOP=1 -tAc "$1" 2>&1
}

# `psql -tAc` prints the command tag ("INSERT 0 1") after a RETURNING value, so
# capturing the raw output gave a uuid with a second line glued to it and every
# later query failed on "invalid input syntax for type uuid". First line only.
run_sql_value() {
	run_sql "$1" | head -1
}

echo "=== 0. CONTROL: the connection works and the table is the real one ==="

conn="$(run_sql "select 1")" || { echo "$conn" | sed 's/^/      /'; ctl "C-1" "cannot connect -- nothing below is proven"; }
[ "$conn" = "1" ] || ctl "C-1" "unexpected reply from the database: $conn"
[ "$CONTROL_FAILED" -eq 0 ] && ok "C-1" "connected"

cols="$(run_sql "select count(*) from information_schema.columns
                 where table_name='audit_events' and column_name in ('result','telegram_ref')")"
if [ "$cols" = "2" ]; then
	ok "AC-04" "result and telegram_ref exist on audit_events"
else
	bad "AC-04" "expected both new columns, found $cols"
fi

trg="$(run_sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
                where c.relname='audit_events' and not t.tgisinternal")"
if [ "${trg:-0}" -ge 3 ]; then
	ok "AC-02" "append-only triggers present ($trg)"
else
	bad "AC-02" "expected 3 append-only triggers, found ${trg:-0}"
fi

echo
echo "=== 1. INSERT must SUCCEED ==="

ins="$(run_sql_value "insert into audit_events (actor_type, action, result)
                values ('system','telegram.command','OK') returning id")"
if [ -n "$ins" ] && [ "${ins#ERROR}" = "$ins" ]; then
	ok "AC-03" "INSERT succeeded ($ins)"
else
	echo "$ins" | sed 's/^/      /'
	# CONTROL, not a plain failure: with no row inserted, the two rejection
	# cases below would "pass" against an empty table -- an UPDATE that matches
	# nothing raises nothing.
	ctl "AC-03" "INSERT failed -- the rejection cases below would prove nothing"
fi

before_count="$(run_sql_value "select count(*) from audit_events")"

echo
echo "=== 2. UPDATE must be REJECTED, and the error must say so ==="

upd="$(run_sql "update audit_events set result='TAMPERED' where id='$ins'")"
if printf '%s' "$upd" | grep -qi "append-only"; then
	ok "AC-03" "UPDATE refused by the database"
elif printf '%s' "$upd" | grep -qi "error"; then
	bad "AC-03" "UPDATE failed, but not with the append-only guard: $upd"
else
	bad "AC-03" "UPDATE was ACCEPTED -- the log is editable"
fi

echo
echo "=== 3. DELETE must be REJECTED, and the error must say so ==="

del="$(run_sql "delete from audit_events where id='$ins'")"
if printf '%s' "$del" | grep -qi "append-only"; then
	ok "AC-03" "DELETE refused by the database"
elif printf '%s' "$del" | grep -qi "error"; then
	bad "AC-03" "DELETE failed, but not with the append-only guard: $del"
else
	bad "AC-03" "DELETE was ACCEPTED -- history can be erased"
fi

echo
echo "=== 4. TRUNCATE must be REJECTED ==="

# TRUNCATE bypasses FOR EACH ROW triggers entirely. Without a statement-level
# trigger it would empty the log while both row triggers sat there looking
# like protection.
tru="$(run_sql "truncate audit_events")"
if printf '%s' "$tru" | grep -qi "append-only"; then
	ok "AC-03" "TRUNCATE refused by the database"
else
	bad "AC-03" "TRUNCATE was not refused by the guard: ${tru:-<no error>}"
fi

echo
echo "=== 5. The row survived all three attempts ==="

after_count="$(run_sql_value "select count(*) from audit_events")"
still="$(run_sql_value "select result from audit_events where id='$ins'")"

if [ "$before_count" = "$after_count" ] && [ "$still" = "OK" ]; then
	ok "AC-03" "row intact: count $after_count, result still OK"
else
	bad "AC-03" "history changed: count $before_count -> $after_count, result '$still'"
fi

echo
echo "=== 6. AC-05: the database refuses a telegram_ref that is not ids ==="

tok="$(run_sql "insert into audit_events (actor_type, action, result, telegram_ref)
                values ('system','telegram.command','OK','8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1')")"
if printf '%s' "$tok" | grep -qi "error"; then
	ok "AC-05" "a bot-token-shaped reference is refused by the CHECK"
else
	bad "AC-05" "a bot-token-shaped value was accepted into telegram_ref"
fi

good="$(run_sql_value "insert into audit_events (actor_type, action, result, telegram_ref)
                 values ('system','telegram.command','OK','42:7') returning id")"
if [ -n "$good" ] && [ "${good#ERROR}" = "$good" ]; then
	ok "AC-05" "a well-formed id reference is accepted"
else
	# Without this the CHECK could be refusing everything and case 6 would still
	# report a pass.
	ctl "AC-05" "the CHECK refuses valid ids too: $good"
fi

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAILED control_failed=$CONTROL_FAILED"

if [ "$CONTROL_FAILED" -gt 0 ]; then
	echo "VERDICT=VOID (a control failed; the other results prove nothing)"
	exit 1
elif [ "$FAILED" -eq 0 ]; then
	echo "VERDICT=PASS -- append-only is enforced by the database, proven by execution"
else
	echo "VERDICT=FAIL"
	exit 1
fi
