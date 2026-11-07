#!/bin/bash
# Gate BEFORE any model call: is the aff-trial OpenRouter key really a separate key with a hard 2 USD total limit,
# and is it the key Hermes actually uses for this profile? Prints only masked data; never prints a key. No model call is made
# (GET /api/v1/key is a metadata endpoint; `hermes status` is local).
set -uo pipefail
ENVF=/opt/hermes-data/profiles/aff-trial/.env
K=$(sudo sed -n 's/^OPENROUTER_API_KEY=//p' "$ENVF" | tr -d "\"' \r")
[ -n "$K" ] || { echo "FAIL: no OPENROUTER_API_KEY in aff-trial/.env yet"; exit 1; }
SHARED=$(sudo sed -n 's/^OPENROUTER_API_KEY=//p' /opt/hermes-data/.env | tr -d "\"' \r")
echo "trial key suffix : ...${K: -4}"
echo "shared key suffix: ...${SHARED: -4}  (the key all other profiles use)"
if [ "$K" = "$SHARED" ]; then echo "FAIL: the aff-trial key is IDENTICAL to the shared key — a 2 USD limit cannot be claimed"; exit 2; fi
RESP=$(curl -s -m 20 https://openrouter.ai/api/v1/key -H "Authorization: Bearer $K")
KEYINFO="$RESP" python3 - <<'PY'
import json, os, sys
raw = os.environ.get("KEYINFO", "")
try:
    d = json.loads(raw)["data"]
except Exception:
    print("FAIL: OpenRouter did not return key metadata (invalid key or network):", raw[:160]); sys.exit(3)
lim, rem, use = d.get("limit"), d.get("limit_remaining"), d.get("usage")
checks = [
    ("key is a metered key with a limit set", lim is not None),
    ("limit == 2 USD (approved ceiling)", lim is not None and float(lim) == 2.0),
    ("limit does NOT reset (a periodic reset would exceed a TOTAL cap)", d.get("limit_reset") in (None, "", "null")),
    ("not a free-tier key", d.get("is_free_tier") is False),
    ("usage so far", use is not None),
]
print("label (masked by OpenRouter):", d.get("label"))
print("limit:", lim, "| limit_remaining:", rem, "| usage:", use, "| limit_reset:", d.get("limit_reset"), "| is_free_tier:", d.get("is_free_tier"), "| expires_at:", d.get("expires_at"))
bad = [n for n, ok in checks if not ok]
for n, ok in checks: print(("PASS" if ok else "FAIL"), "-", n)
sys.exit(0 if not bad else 4)
PY
RC=$?
echo "--- which key does Hermes really use for aff-trial? (local status, no model call)"
HS=$(docker exec hermes hermes -p aff-trial status 2>&1 | grep -E "^\s*OpenRouter" | head -1)
echo "$HS"
if echo "$HS" | grep -q "${K: -4}"; then echo "PASS - Hermes uses the trial key (suffix matches)"; else echo "FAIL - Hermes does NOT show the trial key suffix (…${K: -4}); it may be using the shared key"; RC=5; fi
exit $RC
