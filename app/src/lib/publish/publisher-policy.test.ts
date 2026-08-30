/**
 * P4-R08 — the Publisher's three gates.
 *
 * `AC-04` is the one this project has already broken. `P0-R01` was approval
 * being read as verification, and invented facts going out. Most of this file
 * is about making that impossible rather than discouraged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PUBLISH_KEY_ENV,
  PUBLISH_REFUSALS,
  PREVIEW_KEY_ENV,
  consumeIntentPatch,
  decidePublish,
  keysAreDistinct,
  type ApprovalState,
  type ArticleState,
  type PublishIntent,
} from "./publisher-policy";

const NOW = new Date("2026-08-30T12:00:00Z");
const HASH = "sha256:abc";

const INTENT: PublishIntent = {
  id: "int-1", articleId: "a1", revisionId: "r1", contentHash: HASH, state: "OPEN",
};
const APPROVAL: ApprovalState = {
  approvalId: "ap-1", articleId: "a1", revisionId: "r1", withdrawn: false,
};
const ARTICLE: ArticleState = {
  articleId: "a1", revisionId: "r1", contentHash: HASH, contentMode: "COMMERCIAL",
  wpPostId: null, wpModifiedGmt: null,
  lastPublishedHash: null, lastPublishedModifiedGmt: null,
};
const QA_PASS = { passed: true, reason: null };
const VERIFIED = { allClaimsMeetBar: true, unsourcedClaimCount: 0 };

// ─── AC-04: the central non-negotiable ─────────────────────────────

describe("AC-04 — dc_verified comes from VERIFICATION, never from the approval", () => {
  it("an approved article with sourced claims publishes VERIFIED", () => {
    const d = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, VERIFIED);
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.plan.dcVerified, true);
    assert.equal(d.ok === true && d.plan.unverifiedNotice, null);
  });

  it("an APPROVED article with UNSOURCED claims publishes UNVERIFIED", () => {
    // P0-R01, in one test. The owner approved it; nobody sourced it; it goes
    // out carrying that fact.
    const d = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, {
      allClaimsMeetBar: true, unsourcedClaimCount: 2,
    });
    assert.equal(d.ok, true, "an unverified article must still PUBLISH, not be blocked");
    assert.equal(d.ok === true && d.plan.dcVerified, false);
    assert.ok(d.ok === true && d.plan.unverifiedNotice);
  });

  it("an unverified article is excluded from schema and noindexed", () => {
    // A schema block is a machine-readable assertion of correctness, and
    // indexing an unverified page invites it to be cited as one.
    const d = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, {
      allClaimsMeetBar: false, unsourcedClaimCount: 0,
    });
    assert.equal(d.ok === true && d.plan.excludeFromSchema, true);
    assert.equal(d.ok === true && d.plan.noindex, true);
  });

  it("a verified article is indexed and carries no notice", () => {
    const d = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, VERIFIED);
    assert.equal(d.ok === true && d.plan.excludeFromSchema, false);
    assert.equal(d.ok === true && d.plan.noindex, false);
  });

  it("the approval CANNOT influence dcVerified — same approval, both outcomes", () => {
    // The strongest form of the criterion: hold the approval constant and vary
    // only the verification state. If approval fed dcVerified at all, these two
    // would agree.
    const a = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, VERIFIED);
    const b = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS,
      { allClaimsMeetBar: false, unsourcedClaimCount: 3 });
    assert.equal(a.ok === true && a.plan.dcVerified, true);
    assert.equal(b.ok === true && b.plan.dcVerified, false);
  });

  it("and varying the APPROVAL does not change dcVerified", () => {
    // The same test from the other side.
    const withApproval = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, VERIFIED);
    const otherApprover = decidePublish(
      INTENT, { ...APPROVAL, approvalId: "ap-999" }, ARTICLE, QA_PASS, VERIFIED);
    assert.equal(
      withApproval.ok === true && withApproval.plan.dcVerified,
      otherApprover.ok === true && otherApprover.plan.dcVerified,
    );
  });
});

// ─── AC-10: each gate reachable in isolation ───────────────────────

describe("AC-10 — each gate refuses for its OWN distinct reason", () => {
  it("gate 1: a withdrawn approval", () => {
    const d = decidePublish(INTENT, { ...APPROVAL, withdrawn: true }, ARTICLE, QA_PASS, VERIFIED);
    assert.equal(d.ok === false && d.reason, "APPROVAL_WITHDRAWN");
  });

  it("gate 1: no approval at all", () => {
    assert.equal(
      (decidePublish(INTENT, null, ARTICLE, QA_PASS, VERIFIED) as { reason: string }).reason,
      "APPROVAL_MISSING");
  });

  it("gate 1: an approval for a DIFFERENT revision", () => {
    const d = decidePublish(INTENT, { ...APPROVAL, revisionId: "r2" }, ARTICLE, QA_PASS, VERIFIED);
    assert.equal(d.ok === false && d.reason, "APPROVAL_FOR_ANOTHER_REVISION");
  });

  it("gate 2: the content hash moved", () => {
    const d = decidePublish(INTENT, APPROVAL, { ...ARTICLE, contentHash: "sha256:zzz" },
      QA_PASS, VERIFIED);
    assert.equal(d.ok === false && d.reason, "CONTENT_HASH_MOVED");
  });

  it("gate 3: mode QA failed, and the reason travels", () => {
    const d = decidePublish(INTENT, APPROVAL, ARTICLE,
      { passed: false, reason: "CLAIM_BELOW_MODE_POLICY" }, VERIFIED);
    assert.equal(d.ok === false && d.reason, "QA_GATE_FAILED");
    assert.equal(d.ok === false && d.detail, "CLAIM_BELOW_MODE_POLICY");
  });

  it("CONTROL — a fully eligible intent PUBLISHES", () => {
    // Without this, every refusal above is met by a publisher that refuses
    // everything, and G-50's automated publish would never happen.
    assert.equal(decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, VERIFIED).ok, true);
  });

  it("every refusal reason is reachable and none is ad-hoc", () => {
    const seen = new Set<string>();
    const cases: [PublishIntent, ApprovalState | null, ArticleState, { passed: boolean; reason: string | null }][] = [
      [{ ...INTENT, state: "CONSUMED" }, APPROVAL, ARTICLE, QA_PASS],
      [INTENT, null, ARTICLE, QA_PASS],
      [INTENT, { ...APPROVAL, withdrawn: true }, ARTICLE, QA_PASS],
      [INTENT, { ...APPROVAL, revisionId: "r9" }, ARTICLE, QA_PASS],
      [INTENT, APPROVAL, { ...ARTICLE, contentHash: "x" }, QA_PASS],
      [INTENT, APPROVAL, { ...ARTICLE, revisionId: "r9" }, QA_PASS],
      [INTENT, APPROVAL, ARTICLE, { passed: false, reason: "r" }],
      [INTENT, APPROVAL, { ...ARTICLE, wpPostId: 7, wpModifiedGmt: "B",
        lastPublishedModifiedGmt: "A" }, QA_PASS],
    ];
    for (const [i, ap, ar, qa] of cases) {
      const d = decidePublish(i, ap, ar, qa, VERIFIED);
      if (!d.ok) {
        assert.ok((PUBLISH_REFUSALS as readonly string[]).includes(d.reason), `${d.reason} is ad-hoc`);
        seen.add(d.reason);
      }
    }
    assert.deepEqual([...seen].sort(), [...PUBLISH_REFUSALS].sort());
  });
});

// ─── AC-01 / AC-03 ─────────────────────────────────────────────────

describe("AC-01/AC-03 — only OPEN intents, and only the approved revision", () => {
  it("a non-OPEN intent is refused, whatever its state", () => {
    for (const s of ["CONSUMED", "CANCELLED", "EXPIRED", ""]) {
      const d = decidePublish({ ...INTENT, state: s }, APPROVAL, ARTICLE, QA_PASS, VERIFIED);
      assert.equal(d.ok, false, `state ${s} was treated as eligible`);
      assert.equal(d.ok === false && d.reason, "INTENT_NOT_OPEN");
    }
  });

  it("an intent whose revision the article has moved past is refused", () => {
    const d = decidePublish(INTENT, APPROVAL, { ...ARTICLE, revisionId: "r2" }, QA_PASS, VERIFIED);
    assert.equal(d.ok === false && d.reason, "INTENT_REVISION_MISMATCH");
  });

  it("the plan publishes the intent's revision and no other", () => {
    const d = decidePublish(INTENT, APPROVAL, ARTICLE, QA_PASS, VERIFIED);
    assert.equal(d.ok === true && d.plan.revisionId, INTENT.revisionId);
    assert.equal(d.ok === true && d.plan.contentHash, INTENT.contentHash);
  });
});

// ─── AC-08 ─────────────────────────────────────────────────────────

describe("AC-08 — a human's edits are never overwritten", () => {
  it("a changed post_modified stops the publish", () => {
    const d = decidePublish(INTENT, APPROVAL, {
      ...ARTICLE, wpPostId: 7, wpModifiedGmt: "2026-08-30T11:00:00", lastPublishedModifiedGmt: "2026-08-29T10:00:00",
    }, QA_PASS, VERIFIED);
    assert.equal(d.ok === false && d.reason, "HUMAN_EDIT_CONFLICT");
  });

  it("an unchanged post_modified allows it", () => {
    const d = decidePublish(INTENT, APPROVAL, {
      ...ARTICLE, wpPostId: 7, wpModifiedGmt: "SAME", lastPublishedModifiedGmt: "SAME",
    }, QA_PASS, VERIFIED);
    assert.equal(d.ok, true);
  });

  it("a first publish has nothing to conflict with", () => {
    const d = decidePublish(INTENT, APPROVAL,
      { ...ARTICLE, wpPostId: null, lastPublishedModifiedGmt: null }, QA_PASS, VERIFIED);
    assert.equal(d.ok, true);
  });

  it("the conflict is checked BEFORE QA", () => {
    // A human edit is a fact about the world that no amount of QA changes.
    // Reporting a QA failure would send the wrong person to fix the wrong thing.
    const d = decidePublish(INTENT, APPROVAL, {
      ...ARTICLE, wpPostId: 7, wpModifiedGmt: "B", lastPublishedModifiedGmt: "A",
    }, { passed: false, reason: "also failing" }, VERIFIED);
    assert.equal(d.ok === false && d.reason, "HUMAN_EDIT_CONFLICT");
  });
});

// ─── AC-05 / AC-07 ─────────────────────────────────────────────────

describe("AC-05/AC-07 — consumption and the signing key", () => {
  it("consuming sets state and resolved_at TOGETHER", () => {
    const p = consumeIntentPatch(NOW);
    assert.equal(p.state, "CONSUMED");
    assert.equal(p.resolvedAt, NOW);
    assert.deepEqual(Object.keys(p).sort(), ["resolvedAt", "state"]);
  });

  it("the publish key is a DIFFERENT variable from the preview key", () => {
    // One key doing two jobs means rotating it for one reason silently breaks
    // the other -- and the two have different lifetimes.
    assert.notEqual(PUBLISH_KEY_ENV, PREVIEW_KEY_ENV);
  });

  it("two identical key values are reported as not distinct", () => {
    assert.equal(keysAreDistinct("same", "same"), false);
    assert.equal(keysAreDistinct("a", "b"), true);
    // An absent key is not a SHARED key -- reporting it as one would send
    // someone to fix a collision that does not exist.
    assert.equal(keysAreDistinct(null, "b"), true);
  });
});
