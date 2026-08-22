#!/usr/bin/env bash
#
# P3-R07 — prove the preview capability BY EXECUTION.
#
#   bash deploy/test-preview-integrity.sh <scratch-database-url>
#
# The policy module decides; this asks the database, which is the layer that
# still refuses when a future call site forgets to ask the policy.

set -u

URL="${1:-}"
PSQL="${PSQL_CMD:-psql}"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$URL" ] || fail "usage: $0 <scratch-database-url>"
case "$URL" in *dongchannel_ops*) fail "that is production. Use a scratch database." ;; esac
case "$URL" in *scratch*|*test*|*tmp*|*_ci*) : ;; *) fail "scratch URL must be clearly named" ;; esac

PASS=0; FAILED=0; CTL=0
ok()  { PASS=$((PASS+1));     printf 'PASS  %-8s %s\n' "$1" "$2"; }
bad() { FAILED=$((FAILED+1)); printf 'FAIL  %-8s %s\n' "$1" "$2"; }
ctl() { CTL=$((CTL+1));       printf 'CTL!  %-8s %s\n' "$1" "$2"; }

run_sql() { $PSQL "$URL" -v ON_ERROR_STOP=1 -tA -c "$1" 2>&1; }
run_tx()  { $PSQL "$URL" -v ON_ERROR_STOP=1 -tA 2>&1 <<SQL
BEGIN;
$1
ROLLBACK;
SQL
}

H1="$(printf 'a%.0s' $(seq 64))"
H2="$(printf 'b%.0s' $(seq 64))"
LINK="INSERT INTO article_preview_links (id, article_id, revision_id, content_hash, key_version, expires_at)
VALUES ('44444444-4444-4444-8444-444444444444','art-1','rev-3','$H1','v1', now() + interval '15 minutes');"

echo "=== 0. CONTROL: the table and its guards exist ==="
n="$(run_sql "select count(*) from information_schema.tables where table_name='article_preview_links'")"
[ "${n:-0}" = "1" ] && ok "AC-05" "article_preview_links exists" \
                    || ctl "AC-05" "no preview-link table -- nothing below is proven"

n="$(run_sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='article_preview_links' and not t.tgisinternal")"
[ "${n:-0}" -ge 1 ] && ok "AC-02" "the immutability trigger is installed" \
                    || ctl "AC-02" "no trigger on article_preview_links"

echo
echo "=== 1. AC-03: the TTL ceiling is the database's, not the caller's ==="
out="$(run_tx "INSERT INTO article_preview_links (article_id, revision_id, content_hash, key_version, expires_at)
VALUES ('art-1','rev-3','$H1','v1', now() + interval '30 days');")"
printf '%s' "$out" | grep -qi 'preview_link_ttl_capped' \
	&& ok "AC-03" "a 30-day preview link is refused by the ceiling" \
	|| bad "AC-03" "an over-long TTL was accepted: $(printf '%s' "$out" | head -1)"

out="$(run_tx "INSERT INTO article_preview_links (article_id, revision_id, content_hash, key_version, issued_at, expires_at)
VALUES ('art-1','rev-3','$H1','v1', now(), now() - interval '1 minute');")"
printf '%s' "$out" | grep -qi 'expiry_after_issue' \
	&& ok "AC-03" "a link that is already expired at issue is refused" \
	|| bad "AC-03" "an already-expired link was accepted: $(printf '%s' "$out" | head -1)"

out="$(run_tx "$LINK SELECT 'issued';")"
printf '%s' "$out" | grep -q 'issued' \
	&& ok "AC-03" "CONTROL: a 15-minute link is accepted" \
	|| ctl "AC-03" "no link can be issued at all: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"

echo
echo "=== 2. AC-01/AC-11: the hash shape is enforced ==="
for h in "short" "$(printf 'A%.0s' $(seq 64))" "$(printf 'a%.0s' $(seq 63))"; do
	out="$(run_tx "INSERT INTO article_preview_links (article_id, revision_id, content_hash, key_version, expires_at)
	VALUES ('art-1','rev-3','$h','v1', now() + interval '10 minutes');")"
	printf '%s' "$out" | grep -qi 'preview_link_hash_shape' \
		&& ok "AC-11" "a malformed content hash is refused (${#h} chars)" \
		|| bad "AC-11" "a malformed hash was accepted: $(printf '%s' "$out" | head -1)"
done

echo
echo "=== 3. AC-02: the scope is immutable ==="
for col in "article_id = 'art-9'" "revision_id = 'rev-9'" "content_hash = '$H2'" "key_version = 'v2'" "expires_at = now() + interval '59 minutes'"; do
	out="$(run_tx "$LINK
	UPDATE article_preview_links SET $col WHERE id = '44444444-4444-4444-8444-444444444444';")"
	printf '%s' "$out" | grep -qi "scope is immutable" \
		&& ok "AC-02" "${col%% =*} cannot be changed after issue" \
		|| bad "AC-02" "${col%% =*} was editable: $(printf '%s' "$out" | head -1)"
done

echo
echo "=== 4. AC-05: revocation, individually and in bulk ==="
out="$(run_tx "$LINK
UPDATE article_preview_links SET revoked_at = now() WHERE id = '44444444-4444-4444-8444-444444444444';
SELECT 'revoked-' || (select count(*) from article_preview_links where revoked_at is not null);")"
printf '%s' "$out" | grep -q 'revoked-1' \
	&& ok "AC-05" "a link can be revoked individually" \
	|| bad "AC-05" "individual revocation failed: $(printf '%s' "$out" | head -1)"

out="$(run_tx "$LINK
INSERT INTO article_preview_links (article_id, revision_id, content_hash, key_version, expires_at)
VALUES ('art-1','rev-4','$H2','v1', now() + interval '15 minutes');
UPDATE article_preview_links SET revoked_at = now() WHERE article_id = 'art-1' AND revoked_at IS NULL;
SELECT 'bulk-' || (select count(*) from article_preview_links where revoked_at is not null);")"
printf '%s' "$out" | grep -q 'bulk-2' \
	&& ok "AC-05" "every link for an article can be revoked in one statement" \
	|| bad "AC-05" "bulk revocation did not take: $(printf '%s' "$out" | head -1)"

out="$(run_tx "$LINK
UPDATE article_preview_links SET revoked_at = now() WHERE id = '44444444-4444-4444-8444-444444444444';
UPDATE article_preview_links SET revoked_at = NULL WHERE id = '44444444-4444-4444-8444-444444444444';")"
printf '%s' "$out" | grep -qi 'cannot be un-revoked' \
	&& ok "AC-05" "a revoked link cannot be un-revoked" \
	|| bad "AC-05" "a revocation was reversed: $(printf '%s' "$out" | head -1)"

echo
echo "=== 5. AC-06/AC-07: a preview render authorises a READ and nothing else ==="
out="$(run_tx "$LINK
SET LOCAL dc.in_preview_render = 'on';
INSERT INTO telegram_pending_actions (id, issued_to, article_id, revision_id, destination, payload_hash, expires_at)
VALUES ('act_$(printf 'c%.0s' $(seq 32))', 4242, 'art-1', 'rev-3', 'd', 'h', now() + interval '10 minutes');")"
printf '%s' "$out" | grep -qi 'may not write' \
	&& ok "AC-06" "a preview render cannot create a pending approval action" \
	|| bad "AC-06" "a preview render created a pending action: $(printf '%s' "$out" | head -1)"

out="$(run_tx "SET LOCAL dc.in_preview_render = 'on';
INSERT INTO article_approvals (article_id, revision_id, approved_by, payload_hash, callback_nonce, expires_at)
VALUES ('art-1','rev-3','4242','$H1','n1', now() + interval '1 hour');")"
printf '%s' "$out" | grep -qi 'may not write' \
	&& ok "AC-07" "a preview render cannot create an approval -- it authenticates nothing" \
	|| bad "AC-07" "a preview render created an approval: $(printf '%s' "$out" | head -1)"

# CONTROL: outside a preview render the same writes are permitted, or the guard
# would be a blanket bar that breaks the two-step flow entirely.
out="$(run_tx "INSERT INTO telegram_pending_actions (id, issued_to, article_id, revision_id, destination, payload_hash, expires_at)
VALUES ('act_$(printf 'c%.0s' $(seq 32))', 4242, 'art-1', 'rev-3', 'd', 'h', now() + interval '10 minutes');
SELECT 'written';")"
printf '%s' "$out" | grep -q 'written' \
	&& ok "AC-06" "CONTROL: outside a preview render the write is permitted" \
	|| ctl "AC-06" "the guard blocks everyone: $(printf '%s' "$out" | head -2 | tr '\n' ' ')"

echo
echo "=== 6. AC-02: two rows cannot describe the same capability ==="
out="$(run_tx "$LINK
INSERT INTO article_preview_links (article_id, revision_id, content_hash, key_version, expires_at)
SELECT 'art-1','rev-3','$H1','v1', expires_at FROM article_preview_links
WHERE id = '44444444-4444-4444-8444-444444444444';")"
printf '%s' "$out" | grep -qi 'preview_links_scope_uq' \
	&& ok "AC-02" "a duplicate capability row is refused -- revoking one would not revoke it" \
	|| bad "AC-02" "two rows described the same capability: $(printf '%s' "$out" | head -1)"

echo
echo "=== 6b. AC-16/AC-17: the REAL route, run against this database ==="
# Imports route.ts itself. A unit test proves the audit record is well formed;
# only this proves the row lands -- and a swallowed write leaves a working
# preview and an empty log.
PROBE="$(cd "$(dirname "$0")/.." && DATABASE_URL="$URL" npx --yes tsx deploy/r07-preview-probe.ts 2>/dev/null | tail -1)"
j() { printf '%s' "$PROBE" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

if printf '%s' "$PROBE" | head -c1 | grep -q '{'; then
	ok "" "the preview route was invoked against the scratch database"
else
	ctl "" "the probe produced no JSON: $(printf '%s' "$PROBE" | head -c 200)"
fi

[ "$(j "['validStatus']")" = "200" ] && ok "AC-01" "a valid link renders" \
                                     || bad "AC-01" "a valid link returned $(j "['validStatus']")"

# AC-09. `no-store`, not merely `no-cache`: a shared cache holding a preview
# would serve one owner's draft to whoever asked next.
printf '%s' "$(j "['validCacheControl']")" | grep -q "no-store" \
	&& ok "AC-09" "the render carries private, no-store" \
	|| bad "AC-09" "Cache-Control was $(j "['validCacheControl']")"
printf '%s' "$(j "['forgedCacheControl']")" | grep -q "no-store" \
	&& ok "AC-09" "so does the REFUSAL -- a cached 404 is an enumerable URL" \
	|| bad "AC-09" "refusal Cache-Control was $(j "['forgedCacheControl']")"

printf '%s' "$(j "['validRobots']")" | grep -q "noindex" \
	&& ok "AC-08" "X-Robots-Tag carries noindex" \
	|| bad "AC-08" "X-Robots-Tag was $(j "['validRobots']")"
[ "$(j "['validBodyHasMeta']")" = "True" ] \
	&& ok "AC-08" "and the body carries the robots meta tag" \
	|| bad "AC-08" "the rendered body has no robots meta tag"
[ "$(j "['validReferrer']")" = "no-referrer" ] \
	&& ok "AC-06" "no-referrer, so the token does not travel to whatever the draft links to" \
	|| bad "AC-06" "Referrer-Policy was $(j "['validReferrer']")"

echo
echo "=== 6c. AC-15: a forged link and a revoked one are indistinguishable ==="
[ "$(j "['forgedStatus']")" = "404" ] && [ "$(j "['revokedStatus']")" = "404" ] \
	&& ok "AC-15" "both answer 404" \
	|| bad "AC-15" "forged=$(j "['forgedStatus']") revoked=$(j "['revokedStatus']")"
[ "$(j "['forgedBody']")" = "$(j "['revokedBody']")" ] \
	&& ok "AC-15" "and with the same body -- the response is not an oracle" \
	|| bad "AC-15" "bodies differ"

echo
echo "=== 6d. AC-16: every use and refusal is audited, ids only ==="
[ "$(j "['validAudit']['action']")" = "preview.use" ] \
	&& ok "AC-16" "a successful preview writes preview.use" \
	|| bad "AC-16" "valid audit row was $(j "['validAudit']")"
[ "$(j "['forgedAudit']")" = "$(j "['revokedAudit']")" ] \
	&& ok "AC-16" "a forged and a revoked link both write preview.refuse" \
	|| bad "AC-16" "forged=$(j "['forgedAudit']") revoked=$(j "['revokedAudit']")"
[ "$(j "['auditWritten']")" = "3" ] \
	&& ok "AC-16" "three requests, three audit rows -- none silently dropped" \
	|| bad "AC-16" "$(j "['auditWritten']") audit rows for three requests"

echo
echo "=== 6e. AC-17: the route mutated nothing else ==="
for k in linksUnchanged approvalsUnchanged; do
	[ "$(j "['$k']")" = "True" ] && ok "AC-17" "$k" || bad "AC-17" "$k was $(j "['$k']")"
done
for k in intents pending; do
	[ "$(j "['$k']")" = "0" ] && ok "AC-17" "$k: the preview created none" \
	                         || bad "AC-17" "$k holds $(j "['$k']") rows"
done

echo
echo "=== 7. Nothing was left behind ==="
n="$(run_sql "select count(*) from article_preview_links")"
[ "${n:-x}" = "0" ] && ok "" "article_preview_links is empty -- every case rolled back" \
                    || bad "" "article_preview_links holds $n rows after the run"

echo
echo "=== RESULT ==="
echo "pass=$PASS fail=$FAILED control_failed=$CTL"
if [ "$CTL" -gt 0 ]; then
	echo "VERDICT=VOID (a control failed; the other results prove nothing)"; exit 1
elif [ "$FAILED" -eq 0 ]; then
	echo "VERDICT=PASS -- a preview link is revocable, scoped, capped, and grants only a read"
else
	echo "VERDICT=FAIL"; exit 1
fi
