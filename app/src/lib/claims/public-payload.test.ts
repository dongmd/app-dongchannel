import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { claims } from "../db/schema/evidence.ts";
import { toPublicClaim, type ClassifiedClaim } from "./visibility.ts";

// Drift guard for the public projection.
//
// `toPublicClaim` uses an explicit allowlist, so a new column cannot leak by
// accident. But nothing stops someone adding a column and never thinking about
// it -- and "we never decided" is how a negotiated rate ends up in a payload.
//
// Every column on `claims` must appear in exactly one of these two lists. Add a
// column and this test fails until you say which. That is the point: the
// failure is the prompt to make a decision.

const PUBLIC_COLUMNS = new Set(["claimKey", "claimText", "normalizedValue", "verificationStatus"]);

const NEVER_PUBLIC_COLUMNS = new Set([
  "id",
  "entityType",
  "entityId",
  // Classification is internal by definition -- telling the world a rate is
  // CONFIDENTIAL is itself a disclosure.
  "visibility",
  "sourceAccess",
  "visibilityOverrideBy",
  "visibilityOverrideAt",
  "visibilityOverrideReason",
  // Verification provenance: who checked and when is internal accountability.
  "verifiedAt",
  "verifiedBy",
  "expiresAt",
  // Operational.
  "agentRunId",
  "notes",
  "metadata",
  "createdAt",
  "updatedAt",
]);

describe("public claim payload drift guard", () => {
  test("every claims column is explicitly classified public or not", () => {
    const columns = Object.keys(getTableColumns(claims));
    const unclassified = columns.filter(
      (c) => !PUBLIC_COLUMNS.has(c) && !NEVER_PUBLIC_COLUMNS.has(c),
    );

    assert.deepEqual(
      unclassified,
      [],
      `Unclassified column(s) on 'claims': ${unclassified.join(", ")}. ` +
        "Add each to PUBLIC_COLUMNS or NEVER_PUBLIC_COLUMNS in this test, " +
        "and to toPublicClaim if it really is public.",
    );
  });

  test("the two lists together cover the table and do not overlap", () => {
    const columns = new Set(Object.keys(getTableColumns(claims)));
    for (const c of PUBLIC_COLUMNS) {
      assert.ok(columns.has(c), `PUBLIC_COLUMNS lists '${c}', which is not a claims column`);
      assert.ok(!NEVER_PUBLIC_COLUMNS.has(c), `'${c}' is in both lists`);
    }
  });

  test("toPublicClaim emits exactly the public set and nothing else", () => {
    const claim: ClassifiedClaim = {
      id: "c1",
      claimKey: "payout_value",
      claimText: "80 USD CPA",
      normalizedValue: { v: 80 },
      verificationStatus: "VERIFIED",
      visibility: "PUBLIC",
      sourceAccess: "PUBLIC_WEB",
      sourceId: "s1",
    };

    const emitted = new Set(Object.keys(toPublicClaim(claim)));
    assert.deepEqual([...emitted].sort(), [...PUBLIC_COLUMNS].sort());

    for (const forbidden of NEVER_PUBLIC_COLUMNS) {
      assert.equal(emitted.has(forbidden), false, `'${forbidden}' reached the public payload`);
    }
  });
});
