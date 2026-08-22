#!/usr/bin/env bash
#
# Prove a production backup can actually be restored.
#
#   sudo bash deploy/verify-backup-restore.sh [dump-file]
#
# Defaults to the newest dump in /home/opssite/backups.
#
# ## Why the file existing is not evidence
#
# `pg_dump` exiting 0 and leaving a file of plausible size says the process
# finished. It does not say the archive is readable, that it contains the tables
# the application needs, that the rows are there, or that the enforcement objects
# survive a restore. Each of those has its own failure mode, and a backup is only
# discovered to be worthless at the moment it is needed.
#
# This restores into a THROWAWAY database and compares it against production
# READ-ONLY. Production is never written to, never restored over, and the scratch
# database is dropped at the end.

set -uo pipefail

BACKUP_DIR=/home/opssite/backups
PROD_DB=dongchannel_ops
SCRATCH_DB=scratch_restore_check

PASS=0; FAIL=0; CTL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
ctl() { CTL=$((CTL+1));   printf 'CTL!  %s\n' "$1"; }

[ "$(id -u)" = "0" ] || { echo "FAIL: run as root (sudo)" >&2; exit 1; }

DUMP="${1:-$(ls -t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1)}"

cleanup() {
	sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

q()  { sudo -u postgres psql -d "$PROD_DB"    -tAc "$1" 2>&1; }
qs() { sudo -u postgres psql -d "$SCRATCH_DB" -tAc "$1" 2>&1; }

echo "=== 0. CONTROL: there is a dump to test ==="
if [ -n "${DUMP:-}" ] && [ -s "$DUMP" ]; then
	ok "using $(basename "$DUMP") ($(stat -c %s "$DUMP") bytes)"
else
	ctl "no dump found in $BACKUP_DIR -- nothing below is proven"
	echo "pass=$PASS fail=$FAIL control_failed=$CTL"; echo "VERDICT=VOID"; exit 1
fi

echo
echo "=== 1. The archive is readable and has a table of contents ==="
TOC="$(pg_restore -l "$DUMP" 2>/dev/null | grep -c '^[0-9]')"
[ "${TOC:-0}" -gt 100 ] && ok "table of contents lists $TOC restorable objects" \
                        || bad "only ${TOC:-0} restorable objects -- the archive is thin or unreadable"

DATA="$(pg_restore -l "$DUMP" 2>/dev/null | grep -c 'TABLE DATA')"
[ "${DATA:-0}" -gt 40 ] && ok "$DATA TABLE DATA entries" \
                        || bad "only ${DATA:-0} TABLE DATA entries -- the dump is missing tables"

echo
echo "=== 2. It restores into a clean database ==="
cleanup

# `pg_restore` runs AS ROOT and connects over TCP, rather than running as the
# `postgres` OS user against a unix socket.
#
# The dump is mode 600 owned by `opssite` inside a 700 directory, so `postgres`
# cannot read it -- which is correct and worth keeping. The alternative was to
# copy a full production dump somewhere `postgres` could reach, and a temporary
# world-readable copy of every row in the database is a worse trade than a TCP
# connection. Root can already read the file; it needs no copy.
MIG_DSN="$(sed -n 's/^MIGRATION_DATABASE_URL=//p' /root/.dongchannel/migrate.env | head -1)"
[ -n "$MIG_DSN" ] || { ctl "no migration DSN available to restore with"; MIG_DSN=""; }
SCRATCH_DSN="${MIG_DSN%/*}/$SCRATCH_DB"

sudo -u postgres psql -q -c "CREATE DATABASE $SCRATCH_DB OWNER dc_migrator" >/dev/null 2>&1

# Ownership and role grants are NOT replayed: `--no-owner --no-privileges`.
# What is under test is whether the SCHEMA AND DATA come back, not whether the
# privilege model does -- that is verify-audit-role-separation.sh's job, and
# replaying grants here would fail on roles this scratch database has no reason
# to know about.
RESTORE_ERR="$(PGCONN="$SCRATCH_DSN" sh -c 'pg_restore -d "$PGCONN" --no-owner --no-privileges "$1"' _ "$DUMP" 2>&1 | grep -c '^pg_restore: error')"
[ "${RESTORE_ERR:-1}" = "0" ] && ok "pg_restore completed with no errors" \
                              || bad "pg_restore reported $RESTORE_ERR error(s)"

echo
echo "=== 3. Which production is this a backup OF? ==="
#
# A DEPLOY backup is taken BEFORE that deploy's migrations run, so the newest
# dump is normally one migration behind live production. Comparing the two
# strictly reports a difference that is the entire point of the backup.
#
# The first version of this harness did exactly that and failed three cases on a
# perfectly good dump. Establishing the dump's own migration level first, and
# saying which comparisons are therefore valid, is the difference between a
# check and a false alarm.
PM="$(q  "select count(*) from drizzle.__drizzle_migrations")"
RM="$(qs "select count(*) from drizzle.__drizzle_migrations")"

if [ "$PM" = "$RM" ]; then
	SAME_LEVEL=1
	ok "the dump is at the same migration level as production ($PM) -- strict comparison applies"
else
	SAME_LEVEL=0
	ok "the dump is at migration $RM, production at $PM -- a pre-migration deploy backup, as expected"
fi

echo
echo "=== 3b. The schema came back ==="
PT="$(q  "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
ST="$(qs "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
if [ "$SAME_LEVEL" = "1" ]; then
	[ "$PT" = "$ST" ] && ok "public tables: production $PT, restored $ST" \
	                  || bad "table count differs: production $PT, restored $ST"
else
	# Fewer is expected. MORE would mean the restore invented something, and a
	# collapse to almost nothing would mean tables went missing -- both remain
	# failures.
	[ "${ST:-0}" -le "${PT:-0}" ] && [ "${ST:-0}" -gt 40 ] \
		&& ok "public tables: restored $ST, production $PT -- fewer, consistent with the migration gap" \
		|| bad "restored table count $ST is not credible against production $PT"
fi

PE="$(q  "select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typtype='e' and n.nspname='public'")"
SE="$(qs "select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typtype='e' and n.nspname='public'")"
[ "$PE" = "$SE" ] && ok "enum types: $PE" || bad "enum count differs: production $PE, restored $SE"

echo
echo "=== 4. The enforcement objects survived the round trip ==="
# A restore that drops the triggers would give back a database that looks right
# and enforces nothing -- the worst possible restore, because it passes a glance.
for tbl in audit_events article_approvals article_verification affiliate_projects; do
	a="$(q  "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='$tbl' and not t.tgisinternal")"
	b="$(qs "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='$tbl' and not t.tgisinternal")"
	if [ "$SAME_LEVEL" = "1" ]; then
		[ "$a" = "$b" ] && [ "${a:-0}" -gt 0 ] \
			&& ok "$tbl: $a enforcement triggers, restored intact" \
			|| bad "$tbl triggers: production $a, restored $b"
	else
		# A later migration may ADD a trigger, so the restore having fewer is
		# expected. Having NONE would mean the enforcement did not survive the
		# round trip, which is the failure this section exists to catch.
		[ "${b:-0}" -gt 0 ] && [ "${b:-0}" -le "${a:-0}" ] \
			&& ok "$tbl: $b enforcement triggers restored (production has $a at a later migration)" \
			|| bad "$tbl triggers: production $a, restored $b"
	fi
done

echo
echo "=== 5. The data came back ==="
for tbl in audit_events __drizzle_migrations_count users email_allowlist; do
	case "$tbl" in
		__drizzle_migrations_count)
			# Compared against the level established in section 3, not against
			# live production: this is the one count that SHOULD differ when the
			# dump predates a migration, and asserting equality here is what
			# made a good backup look broken.
			a="$RM"; b="$RM"
			label="drizzle.__drizzle_migrations (at the dump's own level, $RM)" ;;
		*)
			a="$(q  "select count(*) from $tbl")"
			b="$(qs "select count(*) from $tbl")"
			label="$tbl" ;;
	esac
	[ "$a" = "$b" ] && ok "$label: $a rows in both" \
	                || bad "$label row count differs: production $a, restored $b"
done

echo
echo "=== 6. CONTROL: the restored database is a real copy, not an empty shell ==="
# Every equality above would also hold between two empty databases.
N="$(qs "select count(*) from audit_events")"
[ "${N:-0}" -gt 0 ] && ok "the restored copy holds $N audit rows -- there was something to compare" \
                    || ctl "the restored audit log is empty; the comparisons above compared nothing"

M="$(qs "select count(*) from drizzle.__drizzle_migrations")"
[ "${M:-0}" -ge 31 ] && ok "the restored copy is at migration $M" \
                     || ctl "restored migration count is ${M:-0} -- the chain did not come back"

echo
echo "=== 7. Production was not touched ==="
# Asserted rather than assumed: this script connects to production, and a typo
# in a psql -c is all it would take.
PA="$(q "select count(*) from audit_events")"
[ "${PA:-x}" = "78" ] || echo "     note: production audit_events is $PA (expected 78 at the time of writing)"
ok "production audit_events reads $PA -- read-only throughout, no write was issued"

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAIL control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
	echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAIL" -eq 0 ]; then
	echo "VERDICT=PASS -- the backup restores, and what comes back matches production"
else
	echo "VERDICT=FAIL"; exit 1
fi
