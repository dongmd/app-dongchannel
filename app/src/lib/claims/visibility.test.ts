import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  canPublish,
  selectPublishable,
  assertPublishable,
  toPublicClaim,
  canIngest,
  describeRawPayload,
  type ClassifiedClaim,
} from "./visibility.ts";

function claim(over: Partial<ClassifiedClaim> = {}): ClassifiedClaim {
  return {
    id: "c1",
    claimKey: "payout_value",
    claimText: "80 USD CPA",
    visibility: "PUBLIC",
    sourceAccess: "PUBLIC_WEB",
    sourceId: "s1",
    ...over,
  };
}

describe("canPublish", () => {
  test("a merchant's own published rate is publishable", () => {
    assert.equal(canPublish(claim()).allowed, true);
  });

  test("INTERNAL and CONFIDENTIAL never publish", () => {
    assert.equal(canPublish(claim({ visibility: "INTERNAL" })).reason, "NOT_PUBLIC");
    assert.equal(canPublish(claim({ visibility: "CONFIDENTIAL" })).reason, "NOT_PUBLIC");
  });

  test("a negotiated rate cannot publish without a named owner override", () => {
    // The case the requirement exists for: a rate obtained from a logged-in
    // dashboard or a private negotiation.
    for (const sourceAccess of ["AUTHENTICATED", "FIRST_PARTY"] as const) {
      const d = canPublish(claim({ sourceAccess }));
      assert.equal(d.allowed, false);
      assert.equal(d.reason, "RESTRICTED_SOURCE_WITHOUT_OVERRIDE");
    }
  });

  test("an owner override releases it, an empty one does not", () => {
    assert.equal(
      canPublish(claim({ sourceAccess: "FIRST_PARTY", visibilityOverrideBy: "owner@x" })).allowed,
      true,
    );
    assert.equal(
      canPublish(claim({ sourceAccess: "FIRST_PARTY", visibilityOverrideBy: "" })).allowed,
      false,
    );
  });

  test("expired means not publishable, however public", () => {
    const past = new Date("2020-01-01");
    assert.equal(canPublish(claim({ expiresAt: past })).reason, "EXPIRED");
    // Still current is fine.
    const future = new Date(Date.now() + 86_400_000);
    assert.equal(canPublish(claim({ expiresAt: future })).allowed, true);
  });

  test("a claim with no provenance cannot publish", () => {
    const d = canPublish(claim({ sourceId: null, evidenceCount: 0 }));
    assert.equal(d.reason, "NO_PROVENANCE");
  });

  test("evidence alone satisfies provenance", () => {
    assert.equal(canPublish(claim({ sourceId: null, evidenceCount: 2 })).allowed, true);
  });
});

describe("selectPublishable", () => {
  test("a confidential rate is unreachable through the WordPress-bound path", () => {
    const rows = [
      claim({ id: "public", visibility: "PUBLIC", sourceAccess: "PUBLIC_WEB" }),
      claim({ id: "negotiated", visibility: "CONFIDENTIAL", sourceAccess: "FIRST_PARTY" }),
      claim({ id: "internal", visibility: "INTERNAL", sourceAccess: "AUTHENTICATED" }),
    ];
    const out = selectPublishable(rows).map((r) => r.id);
    assert.deepEqual(out, ["public"]);
  });
});

describe("assertPublishable / toPublicClaim", () => {
  test("throws rather than silently dropping", () => {
    assert.throws(() => assertPublishable(claim({ visibility: "CONFIDENTIAL" })), /not publishable/);
  });

  test("the public projection carries no classification or provenance fields", () => {
    const out = toPublicClaim(claim({ verificationStatus: "VERIFIED" }));
    assert.deepEqual(Object.keys(out).sort(), [
      "claimKey",
      "claimText",
      "normalizedValue",
      "verificationStatus",
    ]);
    // Built field by field, so a column added to the row later cannot leak.
    assert.equal("sourceAccess" in out, false);
    assert.equal("visibility" in out, false);
    assert.equal("sourceId" in out, false);
  });
});

describe("canIngest", () => {
  test("a disabled source does not ingest just because the connector exists", () => {
    const d = canIngest({ id: "s", key: "impact", isEnabled: false, requiresAuth: true });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "SOURCE_DISABLED");
  });

  test("an auth-requiring source with no config is refused", () => {
    const d = canIngest({ id: "s", key: "impact", isEnabled: true, requiresAuth: true });
    assert.equal(d.reason, "AUTH_REQUIRED_WITHOUT_CONFIG");
  });

  test("enabled and configured is allowed", () => {
    assert.equal(
      canIngest({
        id: "s",
        key: "impact",
        isEnabled: true,
        requiresAuth: true,
        configRef: "IMPACT_TOKEN",
      }).allowed,
      true,
    );
  });
});

describe("describeRawPayload", () => {
  test("describes shape without revealing content", () => {
    const payload = { accountId: "acct_secret", rate: 80, token: "tok_live_abc" };
    const out = describeRawPayload(payload);
    assert.equal(out, "object(3 keys)");
    assert.ok(!out.includes("acct_secret"));
    assert.ok(!out.includes("tok_live_abc"));
  });

  test("handles arrays, null and primitives", () => {
    assert.equal(describeRawPayload([1, 2, 3]), "array(3)");
    assert.equal(describeRawPayload(null), "none");
    assert.equal(describeRawPayload("x"), "string");
  });
});
