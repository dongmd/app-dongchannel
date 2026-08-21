#!/usr/bin/env bash
#
# Build a PRODUCTION-LIKE BASELINE for the migration-chain gate.
#
# Production has migrations 0000..0016 applied and nothing after. This
# reconstructs exactly that state in a scratch database, from the canonical
# migration fixture — **no production data is copied, and production is never
# touched.** A schema-only baseline is all the gate needs: the question is
# whether 0017..latest can apply on top of what production actually has, and
# that is a question about schema.
#
#   bash deploy/build-baseline.sh <scratch-url> <through-migration-index>
#
# It works by pointing drizzle-kit at a TEMPORARY copy of the migrations folder
# whose journal has been truncated. The real migrations folder is never
# modified — an earlier draft moved files aside and restored them afterwards,
# which is one interrupted run away from leaving the repository in a state
# nobody would think to check.

set -u

SCRATCH_URL="${1:-}"
THROUGH="${2:-16}"

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$SCRATCH_URL" ] || fail "usage: $0 <scratch-database-url> [through-index]"
case "$SCRATCH_URL" in
  *dongchannel_ops*) fail "that is the production database. Use a scratch database." ;;
esac
case "$SCRATCH_URL" in
  *scratch*|*test*|*tmp*|*_ci*) : ;;
  *) fail "the scratch URL must be clearly named scratch/test/tmp -- refusing to guess" ;;
esac

SRC="src/lib/db/migrations"
[ -d "$SRC" ] || fail "run from app/ -- $SRC not found"

TMP="$(mktemp -d)"
CONF="$TMP/drizzle.baseline.config.ts"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/migrations/meta"
cp "$SRC"/meta/*_snapshot.json "$TMP/migrations/meta/" 2>/dev/null || true

# Copy only the migrations up to and including $THROUGH.
kept=0
for f in "$SRC"/[0-9][0-9][0-9][0-9]_*.sql; do
  idx="$(basename "$f" | cut -c1-4)"
  if [ "$((10#$idx))" -le "$((10#$THROUGH))" ]; then
    cp "$f" "$TMP/migrations/"
    kept=$((kept + 1))
  fi
done
[ "$kept" -gt 0 ] || fail "no migrations at or below index $THROUGH"

# Truncate the journal to match, so drizzle applies exactly those.
python - "$SRC/meta/_journal.json" "$TMP/migrations/meta/_journal.json" "$THROUGH" <<'PY'
import json, sys
src, dst, through = sys.argv[1], sys.argv[2], int(sys.argv[3])
j = json.load(open(src, encoding="utf-8"))
j["entries"] = [e for e in j["entries"] if int(e["tag"][:4]) <= through]
json.dump(j, open(dst, "w", encoding="utf-8"), indent=2)
print(f"baseline journal: {len(j['entries'])} entries, through {j['entries'][-1]['tag']}")
PY

cat > "$CONF" <<EOF
import type { Config } from "drizzle-kit";
export default {
  schema: "$(pwd)/src/lib/db/schema/index.ts",
  out: "$TMP/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
EOF

echo "applying baseline: migrations 0000..$(printf '%04d' "$((10#$THROUGH))") ($kept files)"
# Output is NOT suppressed. Hiding it cost a diagnostic cycle on the first run:
# the harness announced "production's own history is broken" while the real
# cause sat in the output it had just thrown away.
if ! DATABASE_URL="$SCRATCH_URL" npx drizzle-kit migrate --config "$CONF"; then
  fail "the baseline did not apply -- the cause is in the output above"
fi

echo "PASS: baseline built ($kept migrations). The real migrations folder was not touched."
