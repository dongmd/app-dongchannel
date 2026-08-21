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

BASELINE="${1:-22f546b}"   # the deployed commit the inventory was taken against
HEAD_REF="${2:-HEAD}"

fail() { echo "FAIL: $*" >&2; exit 1; }

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
LICENSED_FILES="
src/lib/dashboard/summary.ts
src/components/dashboard/kpi-grid.tsx
"

CHANGED="$(git diff --name-only "$BASELINE".."$HEAD_REF" -- . | sed 's|^app/||')"

if [ -z "$CHANGED" ]; then
	fail "the diff is empty -- nothing was checked, so nothing is proven"
fi

echo "=== changed files, $BASELINE..$HEAD_REF ==="
printf '%s\n' "$CHANGED" | sed 's/^/  /'
echo

violations=0
licensed=0

for f in $CHANGED; do
	case "$f" in
		*/opshub/*|package.json) continue ;;   # the register, the gate, and its wiring
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
