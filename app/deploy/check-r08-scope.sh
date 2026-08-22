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

BASELINE="${1:-22f546b}"   # the deployed commit the inventory was taken against

# The default head is P3-R08's OWN change set, not HEAD.
#
# AC-02 is a claim about what THIS requirement changed. Defaulting to HEAD made
# the guard report FAIL the moment any LATER requirement landed -- P3-R01, R06,
# R03 and R04 each touch files no R08 criterion licenses, correctly so. A guard
# that fails on correct work gets ignored, which is worse than no guard.
#
# Located by asking git for the LAST commit carrying this requirement's id,
# rather than by hard-coding a hash: a hash would go stale on any rebase and
# become a fixture asserting against a commit that no longer exists. If no such
# commit is found the lookup yields nothing and the guard fails closed below.
#
# The LAST one, not the first. R08's first commit carried a stray zero-byte file
# `app/0`; this guard is what caught it, and the follow-up commit removed it.
# Ending the range at the first commit would re-report a defect already fixed,
# which trains the reader to ignore the guard.
# And the last one that changed something this guard actually EVALUATES. Commits
# that only edit this script carry the id too -- including the one that fixed the
# defaulting -- and ending the range on one of those would sweep in every later
# requirement all over again, which is the exact bug being fixed. A check that
# extends its own scope by being maintained is not a check.
if [ "${2:-}" = "" ]; then
	HEAD_REF=""
	for c in $(git log --format='%H %s' | grep '(P3-R08)' | cut -d' ' -f1); do
		if git diff-tree --no-commit-id --name-only -r "$c" \
			| grep -qv 'deploy/check-r08-scope\.sh$'; then
			HEAD_REF="$c"; break
		fi
	done
	[ -n "$HEAD_REF" ] || fail "no (P3-R08) commit changes anything this guard evaluates"
else
	HEAD_REF="$2"
fi

git rev-parse --verify "$BASELINE" >/dev/null 2>&1 || fail "no such baseline: $BASELINE"
git rev-parse --verify "$HEAD_REF" >/dev/null 2>&1 || fail "no such head: $HEAD_REF"

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
