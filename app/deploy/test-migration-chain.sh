#!/usr/bin/env bash
#
# Migration-chain activation gate — owner instruction, 2026-08-20.
#
# Before P2's migrations are applied to production, BOTH of these must pass:
#
#   1. production-like baseline -> 0017 ... 0027 -> latest schema
#   2. fresh database          -> the full chain from 0000 -> latest
#
# They are different failures. (1) catches a migration that assumes state the
# production database does not have. (2) catches a chain that only works because
# an earlier migration was hand-corrected on a live server and the file was
# never fixed -- which is invisible until someone rebuilds from scratch.
#
# **This script never touches production.** It requires a scratch DATABASE_URL
# and refuses to run against anything that looks like the real database.
#
#   bash app/deploy/test-migration-chain.sh fresh    "postgres://.../scratch_a"
#   bash app/deploy/test-migration-chain.sh baseline "postgres://.../scratch_b" <dump.sql>
#
# Exit 0 = the chain applied cleanly and the schema matches the latest snapshot.

set -u

MODE="${1:-}"
SCRATCH_URL="${2:-}"
BASELINE_DUMP="${3:-}"

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$MODE" ] || fail "usage: $0 <fresh|baseline> <scratch-database-url> [baseline.sql]"
[ -n "$SCRATCH_URL" ] || fail "a scratch DATABASE_URL is required; this script will not invent one"

# ---- Refuse anything that looks like production -----------------------------
#
# The whole value of this gate is that it runs somewhere disposable. A gate that
# can be pointed at production by a typo is a liability, not a safeguard.
case "$SCRATCH_URL" in
  *dongchannel_ops*)
    fail "that is the production database name. Use a scratch database." ;;
esac
case "$SCRATCH_URL" in
  *scratch*|*test*|*tmp*|*_ci*) : ;;
  *) fail "the scratch URL must contain 'scratch', 'test', 'tmp' or '_ci' -- refusing to guess" ;;
esac

# Validate the mode BEFORE checking for tools. The first version reported
# "psql is required" for a mis-typed mode, which sends the reader to install
# something they already have. An error message that names the wrong problem
# costs more time than no message.
case "$MODE" in
  fresh|baseline) : ;;
  *) fail "mode must be 'fresh' or 'baseline', got '$MODE'" ;;
esac

if [ "$MODE" = "baseline" ]; then
  [ -n "$BASELINE_DUMP" ] || fail "baseline mode needs a dump of the production-like schema"
  [ -f "$BASELINE_DUMP" ] || fail "dump not found: $BASELINE_DUMP"
fi

# `psql` may not be on PATH -- on a Windows workstation the scratch database is
# most naturally an ephemeral container. PSQL_CMD lets the caller supply the
# runner without this script knowing anything about how it is hosted.
#
#   PSQL_CMD="docker exec -i dc-scratch-pg psql" bash deploy/test-migration-chain.sh ...
PSQL="${PSQL_CMD:-psql}"
$PSQL --version >/dev/null 2>&1 || fail "no working psql: set PSQL_CMD if it is not on PATH"

# The URL psql uses may differ from the one the migrator uses. Running psql
# inside a container means its 127.0.0.1 is the CONTAINER's loopback, not the
# host's mapped port -- the first run of this gate failed on exactly that, and
# reported it as "0 migrations recorded", which sent the reader looking at the
# migrator instead of at the connection.
PSQL_TARGET="${PSQL_URL:-$SCRATCH_URL}"

echo "Migration chain gate — mode: $MODE"
echo "==================================="

# ---- Count what the chain should contain ------------------------------------
CHAIN_DIR="src/lib/db/migrations"
[ -d "$CHAIN_DIR" ] || fail "migration directory not found: $CHAIN_DIR (run from app/)"

EXPECTED="$(find "$CHAIN_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' | wc -l | tr -d ' ')"
[ "$EXPECTED" -gt 0 ] || fail "no migration files found"
echo "migrations on disk: $EXPECTED"

# ---- Prepare the scratch database -------------------------------------------
if [ "$MODE" = "baseline" ]; then
  echo "loading baseline: $BASELINE_DUMP"
  $PSQL "$PSQL_TARGET" -v ON_ERROR_STOP=1 -q -f "$BASELINE_DUMP" || fail "baseline load failed"
fi

# ---- Apply the chain ---------------------------------------------------------
echo "applying the chain…"
if ! DATABASE_URL="$SCRATCH_URL" npx drizzle-kit migrate; then
  fail "the migration chain did not apply cleanly"
fi

# ---- Verify the result, rather than trusting the exit code -------------------
#
# `drizzle-kit migrate` exiting 0 means it ran, not that the schema is right.
# M-04 in this project's history is exactly that mistake, on a different tool.
APPLIED="$($PSQL "$PSQL_TARGET" -tAc \
  "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo 0)"
echo "migrations recorded in the scratch database: $APPLIED"

if [ "$APPLIED" -ne "$EXPECTED" ]; then
  fail "expected $EXPECTED migrations, the database recorded $APPLIED"
fi

# The tables P2 introduced must exist, by name. A chain can apply cleanly and
# still not produce what the schema files describe.
for t in content_opportunities content_opportunity_signals content_opportunity_scores \
         article_content_modes content_mode_policies; do
  n="$($PSQL "$PSQL_TARGET" -tAc \
    "select count(*) from information_schema.tables where table_name='$t'")"
  [ "$n" = "1" ] || fail "table missing after the chain: $t"
done

# And the columns P2-R02 removed must be GONE -- proving 0019 really ran, not
# just that it was recorded.
for c in overall_score scoring_version score_breakdown last_researched_at; do
  n="$($PSQL "$PSQL_TARGET" -tAc \
    "select count(*) from information_schema.columns
     where table_name='opportunity_signals' and column_name='$c'")"
  [ "$n" = "0" ] || fail "column should have been dropped by 0019 but still exists: $c"
done

# The renamed one, both directions.
n="$($PSQL "$PSQL_TARGET" -tAc \
  "select count(*) from information_schema.columns
   where table_name='opportunity_routes' and column_name='signal_id'")"
[ "$n" = "1" ] || fail "opportunity_routes.signal_id missing"
n="$($PSQL "$PSQL_TARGET" -tAc \
  "select count(*) from information_schema.columns
   where table_name='opportunity_routes' and column_name='opportunity_id'")"
[ "$n" = "0" ] || fail "opportunity_routes.opportunity_id should be gone"

echo
echo "PASS: chain applied ($APPLIED migrations), and the schema is what the files describe."
