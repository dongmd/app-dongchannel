#!/usr/bin/env bash
#
# P3-R04 AC-03 / AC-08 / AC-11 / AC-12 — prove the approval invariants BY
# EXECUTION against a real PostgreSQL. These are database facts; asserting them
# from application code would be the comment-shaped assurance P3-R06 was raised
# to replace.
#
#   bash deploy/test-approval-integrity.sh <scratch-database-url>
#
# Run from app/. Production is never touched: the URL must be clearly scratch.

set -u

URL="${1:-}"
PSQL="${PSQL_CMD:-psql}"

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$URL" ] || fail "usage: $0 <scratch-database-url>"
case "$URL" in *dongchannel_ops*) fail "that is the production database" ;; esac
case "$URL" in *scratch*|*test*|*tmp*|*_ci*) : ;; *) fail "the URL must be clearly named scratch/test/tmp" ;; esac

PASS=0; FAILED=0; CONTROL_FAILED=0
ok()  { PASS=$((PASS+1));                     printf 'PASS  %-8s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED+1));                 printf 'FAIL  %-8s %s\n' "$1" "$2"; }
ctl() { CONTROL_FAILED=$((CONTROL_FAILED+1)); printf 'CTL!  %-8s %s\n' "$1" "$2"; }

run()   { $PSQL "$URL" -v ON_ERROR_STOP=1 -tAc "$1" 2>&1; }
value() { run "$1" | head -1; }

H1="$(printf 'a%.0s' $(seq 1 64))"
H2="$(printf 'b%.0s' $(seq 1 64))"

echo "=== 0. CONTROL: the two tables exist and are SEPARATE (AC-11) ==="

conn="$(value "select 1")"
[ "$conn" = "1" ] || ctl "C-1" "cannot connect -- nothing below is proven"
[ "$CONTROL_FAILED" -eq 0 ] && ok "C-1" "connected"

n="$(value "select count(*) from information_schema.tables
            where table_name in ('article_approvals','article_verification')")"
if [ "$n" = "2" ]; then
  ok "AC-11" "article_approvals and article_verification are two separate tables"
else
  bad "AC-11" "expected 2 tables, found $n"
fi

# A shared row is what AC-11 forbids. If any verification column appeared on the
# approvals table the separation would be cosmetic.
leak="$(value "select count(*) from information_schema.columns
               where table_name='article_approvals'
                 and column_name in ('evidence_level','qa_result','claims_checked',
                                     'unsupported_claims','conflicting_claims','last_verified_at')")"
if [ "$leak" = "0" ]; then
  ok "AC-11" "no verification column leaked onto article_approvals"
else
  bad "AC-11" "$leak verification columns found on article_approvals"
fi

echo
echo "=== 1. An approval can be written (CONTROL for everything below) ==="

id="$(value "insert into article_approvals
  (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
  values ('art-1','rev-3',987654321,'$H1','act_x', now() + interval '1 hour')
  returning id")"

if [ -n "$id" ] && [ "${id#ERROR}" = "$id" ]; then
  ok "AC-01" "approval inserted ($id)"
else
  echo "$id" | sed 's/^/      /'
  # Without a row, every rejection below would "pass" against an empty table.
  ctl "AC-01" "insert failed -- the rejections below would prove nothing"
fi

echo
echo "=== 2. AC-08: immutable. UPDATE, DELETE and TRUNCATE refused ==="

for op in "update article_approvals set payload_hash='$H2'" \
          "delete from article_approvals" \
          "truncate article_approvals"; do
  out="$(run "$op")"
  label="$(echo "$op" | awk '{print toupper($1)}')"
  # TRUNCATE is a second case: P3-R05's migration 0032 added
  # article_publish_intents.approval_id REFERENCES article_approvals(id), and
  # Postgres refuses to TRUNCATE a table another table's foreign key points at,
  # checked before any trigger runs at all -- so the refusal now carries
  # Postgres's own FK message rather than "immutable". That is a STRENGTHENING,
  # not a gap: TRUNCATE is now unconditionally impossible for a second,
  # independent reason, on top of the trigger. UPDATE and DELETE are
  # unaffected -- BEFORE triggers fire before FK checks, so they still hit the
  # immutability guard directly, and this case does not relax that.
  if [ "$label" = "TRUNCATE" ] && printf '%s' "$out" | grep -qi "foreign key constraint"; then
    ok "AC-08" "$label refused by the foreign key from article_publish_intents (P3-R05) -- a second, independent guard on top of the immutability trigger"
  elif printf '%s' "$out" | grep -qi "immutable"; then
    ok "AC-08" "$label refused by the database"
  elif printf '%s' "$out" | grep -qi "error"; then
    bad "AC-08" "$label failed, but not with the immutability guard: $out"
  else
    bad "AC-08" "$label was ACCEPTED -- consent can be rewritten"
  fi
done

still="$(value "select payload_hash from article_approvals where id='$id'")"
if [ "$still" = "$H1" ]; then
  ok "AC-08" "the original approval is byte-identical after all three attempts"
else
  bad "AC-08" "the approval changed: $still"
fi

echo
echo "=== 3. AC-07: one LIVE approval per (article, revision) ==="

dup="$(run "insert into article_approvals
  (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
  values ('art-1','rev-3',987654321,'$H2','act_y', now() + interval '1 hour')")"
if printf '%s' "$dup" | grep -qi "error"; then
  ok "AC-07" "a second live approval for the same revision is refused"
else
  bad "AC-07" "two live approvals exist for one revision -- which one authorised the publish?"
fi

wd="$(value "insert into article_approvals
  (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at, withdraws_id)
  values ('art-1','rev-3',987654321,'$H1','act_z', now() + interval '1 minute','$id')
  returning id")"
if [ -n "$wd" ] && [ "${wd#ERROR}" = "$wd" ]; then
  ok "AC-08" "a WITHDRAWAL row is accepted alongside the original"
else
  bad "AC-08" "a withdrawal was refused: $wd"
fi

echo
echo "=== 4. Shape constraints refuse nonsense ==="

for label in "hash" "expiry" "self-withdraw"; do
  case "$label" in
    hash)          q="insert into article_approvals (article_id,revision_id,approved_by,payload_hash,callback_nonce,expires_at) values ('a2','r1',1,'not-a-hash','n', now()+interval '1 hour')" ;;
    expiry)        q="insert into article_approvals (article_id,revision_id,approved_by,payload_hash,callback_nonce,approved_at,expires_at) values ('a3','r1',1,'$H1','n', now(), now()-interval '1 hour')" ;;
    self-withdraw) q="update article_approvals set withdraws_id=id" ;;
  esac
  out="$(run "$q")"
  if printf '%s' "$out" | grep -qi "error"; then
    ok "AC-01" "a bad $label is refused by the database"
  else
    bad "AC-01" "a bad $label was accepted"
  fi
done

echo
echo "=== 5. AC-03: a Telegram action may NOT write the verification state ==="

# Outside a Telegram action: permitted. This is the CONTROL -- a guard that
# refused everything would pass the refusal test below for the wrong reason.
outside="$(run "insert into article_verification (article_id, evidence_level, qa_result, claims_checked, last_verified_at)
                values ('art-1','E3','pass',4, now())")"
if printf '%s' "$outside" | grep -qi "error"; then
  ctl "AC-03" "the guard refuses NORMAL writes too: $outside"
else
  ok "AC-03" "a normal (non-Telegram) verification write is permitted"
fi

# Inside a Telegram action: refused. Same transaction, flag set first.
inside="$(run "begin;
  select set_config('dc.in_telegram_action','on',true);
  update article_verification set evidence_level='E4' where article_id='art-1';
  commit;")"
if printf '%s' "$inside" | grep -qi "may not write article_verification"; then
  ok "AC-03" "a write inside a Telegram action is refused at the choke point"
elif printf '%s' "$inside" | grep -qi "error"; then
  bad "AC-03" "refused, but not by the AC-03 guard: $inside"
else
  bad "AC-03" "a Telegram action WROTE the verification state"
fi

ins_tg="$(run "begin;
  select set_config('dc.in_telegram_action','on',true);
  insert into article_verification (article_id) values ('art-2');
  commit;")"
if printf '%s' "$ins_tg" | grep -qi "may not write article_verification"; then
  ok "AC-03" "an INSERT inside a Telegram action is refused too"
else
  bad "AC-03" "a Telegram action inserted a verification row: $ins_tg"
fi

echo
echo "=== 6. AC-12: approving changed nothing about verification ==="

lvl="$(value "select evidence_level from article_verification where article_id='art-1'")"
if [ "$lvl" = "E3" ]; then
  ok "AC-12" "evidence_level is unchanged after the approval and the refused writes ($lvl)"
else
  bad "AC-12" "evidence_level moved to '$lvl'"
fi

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAILED control_failed=$CONTROL_FAILED"

if [ "$CONTROL_FAILED" -gt 0 ]; then
  echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAILED" -eq 0 ]; then
  echo "VERDICT=PASS -- approval integrity is enforced by the database, proven by execution"
else
  echo "VERDICT=FAIL"; exit 1
fi
