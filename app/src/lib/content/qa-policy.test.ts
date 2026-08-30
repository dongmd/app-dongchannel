/**
 * P4-R07 — the mode-dependent QA gate.
 *
 * `G-57` in one sentence: one bar for a news item and a pricing review is
 * either too strict to ship news or too loose to protect commercial claims.
 * `AC-05` turns that into a test, and it is the test this module exists for.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_FLOOR,
  MODE_POLICY_VERSION,
  CONTENT_MODES,
  evidenceRank,
  resolveModePolicy,
} from "./content-mode-policy";
import {
  QA_FAILURES,
  STRICTEST_POLICY,
  type DraftUnderReview,
  depthSatisfies,
  evaluateQaPolicy,
  explainQaVerdict,
  publishGatePasses,
} from "./qa-policy";

/** A draft whose claims all sit at E2: the floor, and NEWS's requirement. */
function draftAtE2(mode: string): DraftUnderReview {
  return {
    articleId: "art-1",
    mode,
    qaDepthCompleted: "FULL",
    claims: [
      { key: "price", evidenceLevel: "E2" },
      { key: "availability", evidenceLevel: "E2" },
    ],
  };
}

// ─── AC-05: the canonical test ─────────────────────────────────────

describe("AC-05 — the same draft passes as NEWS and fails as COMMERCIAL", () => {
  it("passes as NEWS", () => {
    const v = evaluateQaPolicy(draftAtE2("NEWS"));
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.requiredEvidence, "E2");
  });

  it("fails as COMMERCIAL — same draft object, only the mode differs", () => {
    // Constructed from the same shape so the ONLY difference is the mode. A
    // test that built two different drafts would prove nothing about the mode.
    const news = draftAtE2("NEWS");
    const commercial = { ...news, mode: "COMMERCIAL" };

    assert.deepEqual(news.claims, commercial.claims);
    assert.equal(news.qaDepthCompleted, commercial.qaDepthCompleted);

    const v = evaluateQaPolicy(commercial);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "CLAIM_EVIDENCE_BELOW_POLICY");
    assert.equal(v.ok === false && v.requiredEvidence, "E3");
  });

  it("the reason names the mode AND the shortfall", () => {
    // Half the criterion. "QA failed" would block the publish and tell the
    // owner nothing they could act on.
    const msg = explainQaVerdict(evaluateQaPolicy({ ...draftAtE2("NEWS"), mode: "COMMERCIAL" }));
    assert.match(msg, /COMMERCIAL/);
    assert.match(msg, /E3/);
    assert.match(msg, /price|availability/);
  });

  it("the refusal names claim KEYS and never claim text", () => {
    const v = evaluateQaPolicy({
      articleId: "a",
      mode: "COMMERCIAL",
      qaDepthCompleted: "FULL",
      claims: [{ key: "price", evidenceLevel: "E2" }],
    });
    const msg = explainQaVerdict(v);
    assert.match(msg, /price/);
    // A key identifies the claim without pushing draft content through
    // Telegram. There is no claim text in the input type at all, and the
    // message must not acquire one.
    assert.equal(msg.length < 300, true);
  });
});

// ─── AC-01 / AC-02 ─────────────────────────────────────────────────

describe("AC-01/AC-02 — table-keyed and versioned", () => {
  it("every content mode resolves to a policy — adding a mode is a data change", () => {
    for (const m of CONTENT_MODES) {
      const p = resolveModePolicy(m);
      assert.ok(p.minEvidenceLevel, `${m} has no evidence requirement`);
      assert.ok(p.qaDepth, `${m} has no QA depth`);
    }
  });

  it("the verdict carries the policy version it was decided under", () => {
    const v = evaluateQaPolicy(draftAtE2("NEWS"));
    assert.equal(v.policyVersion, MODE_POLICY_VERSION);
  });

  it("a supplied version travels into the verdict, pass or fail", () => {
    // A decision made under old rules must never be silently compared against
    // new ones -- so the version must survive BOTH outcomes, not just success.
    const pass = evaluateQaPolicy(draftAtE2("NEWS"), undefined, "v9-test");
    const fail = evaluateQaPolicy({ ...draftAtE2("NEWS"), mode: "COMMERCIAL" }, undefined, "v9-test");
    assert.equal(pass.policyVersion, "v9-test");
    assert.equal(fail.policyVersion, "v9-test");
  });
});

// ─── AC-03 ─────────────────────────────────────────────────────────

describe("AC-03 — no configuration means DEFAULTS, and defaults are strict", () => {
  it("an empty override set gives the defaults", () => {
    assert.deepEqual(evaluateQaPolicy(draftAtE2("NEWS"), {}), evaluateQaPolicy(draftAtE2("NEWS")));
  });

  it("an UNRECOGNISED mode is judged at the strictest bar, not waved through", () => {
    const v = evaluateQaPolicy({ ...draftAtE2("NEWS"), mode: "PODCAST" });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_CONTENT_MODE");
    assert.equal(v.ok === false && v.requiredEvidence, STRICTEST_POLICY.minEvidenceLevel);
    assert.equal(v.ok === false && v.requiredDepth, "FULL");
  });

  it("the strictest policy is DERIVED, so tightening a mode cannot leave it behind", () => {
    // Written down instead of derived, this number would silently stop being
    // the maximum the first time COMMERCIAL was raised to E4.
    for (const m of CONTENT_MODES) {
      const p = resolveModePolicy(m);
      assert.ok(
        evidenceRank(STRICTEST_POLICY.minEvidenceLevel) >= evidenceRank(p.minEvidenceLevel),
        `${m} requires more evidence than STRICTEST_POLICY`,
      );
      assert.ok(STRICTEST_POLICY.ttlDays <= p.ttlDays);
      assert.ok(STRICTEST_POLICY.slaHours <= p.slaHours);
    }
  });

  it("configuration cannot lower a mode below the evidence floor", () => {
    // P2-R05's clamp, re-asserted through this gate: the one setting that could
    // reintroduce unverified claims is the one setting configuration cannot reach.
    const v = evaluateQaPolicy(
      { ...draftAtE2("NEWS"), claims: [{ key: "x", evidenceLevel: "E0" }] },
      { NEWS: { minEvidenceLevel: "E0" } },
    );
    assert.equal(v.ok, false);
    assert.equal(v.requiredEvidence, EVIDENCE_FLOOR);
  });

  it("configuration CAN raise a mode above its default", () => {
    const v = evaluateQaPolicy(draftAtE2("NEWS"), { NEWS: { minEvidenceLevel: "E4" } });
    assert.equal(v.ok, false);
    assert.equal(v.requiredEvidence, "E4");
  });
});

// ─── AC-04 ─────────────────────────────────────────────────────────

describe("AC-04 — a failure blocks, and is never a downgrade", () => {
  it("QA that never ran is a block, not a pass with a note", () => {
    const v = evaluateQaPolicy({ ...draftAtE2("NEWS"), qaDepthCompleted: null });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "QA_NOT_RUN");
  });

  it("QA run at insufficient depth is a block", () => {
    const v = evaluateQaPolicy({ ...draftAtE2("COMMERCIAL"), qaDepthCompleted: "EXPEDITED" });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "QA_DEPTH_INSUFFICIENT");
  });

  it("there is no warn, no severity, and no score to downgrade", () => {
    // The failure the criterion names is an article shipped with a note nobody
    // reads. A boolean with a reason cannot be downgraded; a score can.
    const v = evaluateQaPolicy({ ...draftAtE2("NEWS"), mode: "COMMERCIAL" });
    assert.equal("severity" in v, false);
    assert.equal("score" in v, false);
    assert.equal("warning" in v, false);
    assert.equal(typeof v.ok, "boolean");
  });

  it("an UNASSESSED claim is reported as unassessed, not as thin evidence", () => {
    // Reporting BELOW_POLICY here would send someone to find better sources for
    // a claim that was never checked at all. Different gap, different fix.
    const v = evaluateQaPolicy({
      articleId: "a",
      mode: "NEWS",
      qaDepthCompleted: "FULL",
      claims: [{ key: "price", evidenceLevel: null }, { key: "spec", evidenceLevel: "E0" }],
    });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "CLAIM_EVIDENCE_UNKNOWN");
    assert.deepEqual(v.ok === false && v.offendingClaims.map((c) => c.key), ["price"]);
  });

  it("every failure reason is in the closed set and produces a legible message", () => {
    const seen = new Set<string>();
    const cases: DraftUnderReview[] = [
      { ...draftAtE2("NEWS"), mode: "PODCAST" },
      { ...draftAtE2("NEWS"), qaDepthCompleted: null },
      { ...draftAtE2("COMMERCIAL"), qaDepthCompleted: "EXPEDITED" },
      { ...draftAtE2("NEWS"), claims: [{ key: "k", evidenceLevel: null }] },
      { ...draftAtE2("COMMERCIAL") },
    ];
    for (const c of cases) {
      const v = evaluateQaPolicy(c);
      assert.equal(v.ok, false);
      if (!v.ok) {
        assert.ok((QA_FAILURES as readonly string[]).includes(v.reason), `${v.reason} is ad-hoc`);
        seen.add(v.reason);
        const msg = explainQaVerdict(v);
        assert.ok(msg.length > 20, `${v.reason} produced a message too thin to act on`);
      }
    }
    assert.deepEqual([...seen].sort(), [...QA_FAILURES].sort());
  });
});

// ─── AC-06 ─────────────────────────────────────────────────────────

describe("AC-06 — one policy, two readers", () => {
  it("the publish gate reads the SAME verdict the QA agent does", () => {
    // Not a re-implementation: `publishGatePasses` takes a verdict rather than
    // a draft, so it CANNOT apply a rule of its own. That is the criterion
    // enforced by the signature.
    const pass = evaluateQaPolicy(draftAtE2("NEWS"));
    const fail = evaluateQaPolicy({ ...draftAtE2("NEWS"), mode: "COMMERCIAL" });
    assert.equal(publishGatePasses(pass), true);
    assert.equal(publishGatePasses(fail), false);
  });

  it("the gate cannot pass something the policy blocked", () => {
    for (const mode of [...CONTENT_MODES, "PODCAST"]) {
      const v = evaluateQaPolicy({ ...draftAtE2("NEWS"), mode });
      assert.equal(publishGatePasses(v), v.ok, `${mode}: gate and policy disagreed`);
    }
  });
});

// ─── Depth ordering ────────────────────────────────────────────────

describe("QA depth is ordered, not a set of equals", () => {
  it("deeper satisfies shallower, and not the reverse", () => {
    assert.equal(depthSatisfies("FULL", "EXPEDITED"), true);
    assert.equal(depthSatisfies("FULL", "STANDARD"), true);
    assert.equal(depthSatisfies("STANDARD", "FULL"), false);
    assert.equal(depthSatisfies("EXPEDITED", "STANDARD"), false);
  });

  it("a depth satisfies itself", () => {
    assert.equal(depthSatisfies("STANDARD", "STANDARD"), true);
  });
});

// ─── AC-07: CONTROL ────────────────────────────────────────────────

describe("AC-07 — CONTROL: the guard is not a permanent block", () => {
  it("a satisfied mode passes", () => {
    // Without this, every assertion above is met by a gate that refuses
    // everything -- which would block the entire publishing pipeline and pass
    // its own test suite.
    const v = evaluateQaPolicy({
      articleId: "a",
      mode: "COMMERCIAL",
      qaDepthCompleted: "FULL",
      claims: [{ key: "price", evidenceLevel: "E3" }, { key: "spec", evidenceLevel: "E4" }],
    });
    assert.equal(v.ok, true);
    assert.equal(publishGatePasses(v), true);
    assert.match(explainQaVerdict(v), /đạt/);
  });

  it("EVERY mode has a draft that passes it", () => {
    // Stronger: not one lucky mode, all five. A policy where some mode is
    // unsatisfiable would be a permanent block hiding behind four that work.
    for (const mode of CONTENT_MODES) {
      const v = evaluateQaPolicy({
        articleId: "a",
        mode,
        qaDepthCompleted: "FULL",
        claims: [{ key: "k", evidenceLevel: "E4" }],
      });
      assert.equal(v.ok, true, `${mode} cannot be satisfied even at E4/FULL`);
    }
  });

  it("a draft with NO claims passes — nothing to fail on", () => {
    // Deliberate and worth stating: this gate judges the evidence behind
    // claims. A piece making no factual claims has no evidence shortfall. It is
    // P4-R06's job to decide whether a draft SHOULD have claims.
    const v = evaluateQaPolicy({
      articleId: "a", mode: "COMMERCIAL", qaDepthCompleted: "FULL", claims: [],
    });
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.claimsAssessed, 0);
  });
});
