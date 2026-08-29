#!/usr/bin/env bash
#
# P3-R08 AC-02 — "code is written only where a criterion demonstrates a real gap;
# a surface classified EXISTING_AND_CONFORMING is not modified."
#
#   bash deploy/check-r08-scope.sh [baseline] [head]
#
# The criterion is about THIS requirement's own change set, so it is provable
# now rather than at phase close: take the diff, map every changed source file
# to the surface that owns it, and refuse any file belonging to a surface the
# register calls conforming.
#
# Run from app/.

set -u

fail() { echo "FAIL: $*" >&2; exit 1; }

BASELINE="${1:-22f546b}"   # the deployed commit the inventory was taken against, kept for the banner only

# P3-R08's OWN change set: the UNION of files touched by commits carrying this
# requirement's id, not a BASELINE..HEAD range.
#
# A range diff was tried first and failed a second way. `BASELINE` is the
# original pre-P3 deployed commit -- ancient by the time other P3 requirements
# started landing. Diffing BASELINE..(last P3-R08 commit) includes every commit
# that happened to land BETWEEN those two points regardless of which
# requirement it belonged to: P3-R05 and P3-R01 both committed in the middle of
# this same working session, before P3-R08's own AC-06 fix, and a range diff
# swept both of them in as if P3-R08 had touched their files. 50 violations,
# none real.
#
# Per-commit collection does not have that failure mode: each commit's own
# diff-tree is scoped to exactly what that commit changed, and unioning several
# such sets is still exact regardless of what else was committed in between.
#
# Explicit skip list rather than a HEAD-relative range, for two reasons already
# proven to matter: a commit that only edits this script must not extend the
# requirement's own scope by being maintained (the previous bug), and a commit
# whose only change was removing a stray zero-byte file the SAME guard had
# already caught must not re-report a defect that was already fixed.
COMMITS="$(git log --format='%H %s' | grep '(P3-R08)' | cut -d' ' -f1)"
[ -n "$COMMITS" ] || fail "no commit carries (P3-R08)"

RAW=""
for c in $COMMITS; do
	f="$(git diff-tree --no-commit-id --name-only -r "$c" -- . | sed 's|^app/||')"
	RAW="$RAW
$f"
done
RAW="$(printf '%s\n' "$RAW" | sed '/^$/d' | sort -u)"

# A file added by one (P3-R08) commit and removed by a later one -- app/0, the
# stray zero-byte file this very guard caught the first time -- shows up in the
# union by name even though nothing about it remains. Filtering to what still
# exists at HEAD is what stops that from being re-reported forever: the file
# this guard already caught and the follow-up commit already fixed would
# otherwise VIOLATION on every run from now on, which trains the reader to
# ignore the guard exactly the way an earlier comment in this file warned about
# for the range-diff version.
CHANGED=""
for f in $RAW; do
	git cat-file -e "HEAD:app/$f" 2>/dev/null && CHANGED="$CHANGED
$f"
done
CHANGED="$(printf '%s\n' "$CHANGED" | sed '/^$/d' | sort -u)"

git rev-parse --verify "$BASELINE" >/dev/null 2>&1 || fail "no such baseline: $BASELINE"

# Files owned by surfaces the register classifies EXISTING_AND_CONFORMING.
# Touching any of them is what AC-02 forbids.
CONFORMING_FILES="
src/components/layout/nav-items.ts
src/components/layout/sidebar.tsx
src/components/layout/app-shell.tsx
src/components/layout/header-search.tsx
src/components/layout/notifications-bell.tsx
src/components/layout/profile-switcher.tsx
src/components/layout/header-status-indicator.tsx
src/app/(dashboard)/admin/page.tsx
"

# Files a named criterion licenses this requirement to change.
# summary.ts + kpi-grid.tsx  -> Overview, EXISTING_NEEDS_REMEDIATION, AC-09
# global-header.tsx          -> Global header, EXISTING_NEEDS_REMEDIATION, AC-06
#
# The register is what licenses each one: a surface it calls
# EXISTING_NEEDS_REMEDIATION is a surface this requirement is supposed to touch.
# `global-header.tsx` is deliberately absent from CONFORMING_FILES for the same
# reason -- it was the one header file the inventory found wanting.
LICENSED_FILES="
src/lib/dashboard/summary.ts
src/components/dashboard/kpi-grid.tsx
src/components/layout/global-header.tsx
"

if [ -z "$CHANGED" ]; then
	fail "the union of (P3-R08) commits touched nothing -- nothing was checked, so nothing is proven"
fi

echo "=== files touched by $(printf '%s\n' "$COMMITS" | wc -l) commit(s) carrying (P3-R08) ==="
printf '%s\n' "$COMMITS" | sed 's/^/  commit /'
printf '%s\n' "$CHANGED" | sed 's/^/  /'
echo

violations=0
licensed=0

for f in $CHANGED; do
	case "$f" in
		*/opshub/*|package.json|deploy/check-r08-scope.sh) continue ;;   # register, gate, wiring, this harness
	esac

	if printf '%s\n' $CONFORMING_FILES | grep -qxF "$f"; then
		echo "VIOLATION  $f belongs to a surface the register calls EXISTING_AND_CONFORMING"
		violations=$((violations + 1))
	elif printf '%s\n' $LICENSED_FILES | grep -qxF "$f"; then
		echo "licensed   $f -- Overview, EXISTING_NEEDS_REMEDIATION, fails AC-09"
		licensed=$((licensed + 1))
	else
		echo "VIOLATION  $f maps to no surface at all -- an unexplained change"
		violations=$((violations + 1))
	fi
done

echo

# CONTROL: a run that licensed nothing proves nothing. If the remediation files
# are absent from the diff, either the remediation was not made or the baseline
# is wrong -- both mean this check passed for the wrong reason.
if [ "$licensed" -eq 0 ]; then
	echo "CONTROL FAILED: no licensed change was seen in the diff."
	echo "VERDICT=VOID"
	exit 1
fi

echo "licensed changes: $licensed   violations: $violations"

if [ "$violations" -gt 0 ]; then
	echo "VERDICT=FAIL -- AC-02 is not met"
	exit 1
fi

echo "VERDICT=PASS -- no conforming surface was modified"
