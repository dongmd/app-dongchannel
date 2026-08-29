#!/usr/bin/env bash
# Ghost story-id resurrection guard.
#
# The defect class, recorded canonically as DC-011B and absorbed into
# `P4-R11 AC-07`: shipped production copy tells a user a capability "will arrive
# in follow-up story DC-011b" -- and that story id exists in no register at all.
# The user is given a commitment that nothing in the project is tracking.
#
# The owner's instruction when absorbing DC-011b was to add a regression check
# so a future reference cannot resurrect a ghost id. This is that check.
#
# WHAT COUNTS, AND WHAT DOES NOT
# ------------------------------
# A story id in a code COMMENT is attribution or an internal note. `audit.ts`
# says "Created under `DC-001`" and `nav-items.ts` says "reserved cho
# notification count (DC-015)". Neither promises a user anything, and a guard
# that flagged them would flag 45 references, be silenced within a week, and
# protect nothing.
#
# A story id in RENDERED COPY is a promise. That is the defect, and that is what
# this scans for: non-comment content in the .tsx files that render pages.
#
# THE SHORTHAND TRAP
# ------------------
# The dashboard footer reads "tasks/memory sẽ có ở DC-006/010". A plain
# /DC-[0-9]{3}/ finds DC-006, misses DC-010, and reports "one promise here"
# with total confidence. That is not hypothetical -- the P4 pre-flight audit
# made exactly this mistake and undercounted the defect. The scan below expands
# the `/010` continuation form.
#
# The continuation carries the FULL three-digit number (`006` then `/010`), not a
# two-digit suffix after a shared `DC-0`. Writing it the second way parses
# "DC-006/010" into DC-006 and DC-001 -- a real id, silently wrong. The first
# version of this guard did that, and its own failure output is what caught it.
#
# Exit 0 = every promise in rendered copy has a canonical disposition.
# Exit 1 = a new ghost id appeared, or the scan itself broke.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Ids with a canonical disposition in docs/v2/status.yml. DC-011b is REGISTERED
# (register entry DC-011B, ABSORBED_BY:P4-R11/AC-07); the rest were ghosts,
# absorbed into the same criterion on 2026-08-29. DC-015 is listed because it is
# a KNOWN promise under OWNER_DECISION_REQUIRED -- known is not the same as
# resolved, and AC-07 is what discharges these, not this file.
KNOWN="DC-006 DC-010 DC-011b DC-011c DC-012b DC-014 DC-015"

SCAN_ROOTS="src/app src/components"

scan() {
  # $1 = root. Strips block and line comments, then extracts promised ids,
  # expanding the "DC-006/010" continuation shorthand.
  find "$1" -name '*.tsx' -type f 2>/dev/null | while read -r f; do
    perl -0777 -pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g' "$f" \
      | perl -ne 'while (/DC-(\d{3}[a-z]?)((?:\/\d{3}[a-z]?)+)?/g) {
                    print "DC-$1\n";
                    my $rest = $2 // "";
                    while ($rest =~ /\/(\d{3}[a-z]?)/g) { print "DC-$1\n"; }
                  }' \
      | sed "s|^|$f |"
  done
}

FOUND=""
FILES=0
for root in $SCAN_ROOTS; do
  if [ ! -d "$root" ]; then
    echo "FAIL: scan root $root does not exist -- the guard is measuring nothing"
    exit 1
  fi
  n=$(find "$root" -name '*.tsx' -type f 2>/dev/null | wc -l)
  FILES=$((FILES + n))
  FOUND="$FOUND
$(scan "$root")"
done

# ---- Fail closed. A guard that finds nothing because its scan broke reports
# ---- exactly the same "all clear" as a guard that finds nothing because the
# ---- code is clean, and the two must never be confusable.
if [ "$FILES" -lt 20 ]; then
  echo "FAIL: only $FILES .tsx files scanned -- expected the Ops Hub's full page tree."
  echo "      The scan is broken, not the codebase clean."
  exit 1
fi

IDS=$(echo "$FOUND" | grep -oE 'DC-[0-9]{3}[a-z]?' | sort -u)
if [ -z "$IDS" ]; then
  echo "FAIL: $FILES files scanned and NOT ONE story id found."
  echo "      DC-011b is known to be present in src/app/(dashboard)/aff/markets/page.tsx."
  echo "      A zero result means the comment-stripping or the pattern is broken."
  exit 1
fi

# ---- CONTROL: the known promise must be found. If the scan can no longer see
# ---- the very reference this guard was written for, its silence means nothing.
if ! echo "$IDS" | grep -q '^DC-011b$'; then
  echo "FAIL: CONTROL -- DC-011b was not found in rendered copy."
  echo "      Either it was resolved (then update KNOWN and this control), or the scan broke."
  exit 1
fi

GHOSTS=""
for id in $IDS; do
  case " $KNOWN " in
    *" $id "*) ;;
    *) GHOSTS="$GHOSTS $id" ;;
  esac
done

echo "Scanned $FILES .tsx files under: $SCAN_ROOTS"
echo "Promised ids in rendered copy: $(echo "$IDS" | tr '\n' ' ')"

if [ -n "$GHOSTS" ]; then
  echo
  echo "FAIL: a story id was promised to a user in rendered copy with no canonical disposition:"
  for id in $GHOSTS; do
    echo "  $id"
    echo "$FOUND" | grep -F "$id" | awk '{print "      " $1}' | sort -u
  done
  echo
  echo "  This is the DC-011B defect class. Resolve it by ONE of:"
  echo "    - give the id a disposition in docs/v2/status.yml and add it to KNOWN here, or"
  echo "    - remove the promise from the copy."
  echo "  Adding it to KNOWN alone is the failure mode this guard exists to prevent."
  exit 1
fi

echo "PASS: every promised id has a canonical disposition (P4-R11 AC-07)."
