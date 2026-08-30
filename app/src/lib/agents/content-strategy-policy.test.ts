/**
 * P4-R03 — the Content Strategy capability.
 *
 * One criterion carries the requirement: **a brief is not a draft**. A brief
 * that drifted into prose would make the Writer redundant and put article text
 * into a stage with no QA gate behind it. Most of this file is about that.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CONTENT_MODES } from "../content/content-mode-policy";
import {
  ANGLE_MAX_CHARS,
  BRIEF_REFUSALS,
  BRIEF_SECTIONS,
  PROSE_FIELDS,
  QUESTION_MAX_CHARS,
  type BriefInputs,
  validateBrief,
} from "./content-strategy-policy";

const INPUTS: BriefInputs = {
  requiredEvidenceLevel: "E3",
  policyVersion: "v0-2026-08-20",
  evidenceShortfall: false,
  opportunityScore: 82,
  knownModes: [...CONTENT_MODES],
};

function brief(over: Record<string, unknown> = {}) {
  return {
    opportunityId: "opp-1",
    contentMode: "COMMERCIAL",
    angle: "Whether the paid tier is worth it for a solo operator.",
    targetSections: ["INTRO", "PRICING", "VERDICT"],
    requiredClaims: [
      { key: "price", question: "What does the paid tier cost per month?" },
      { key: "limits", question: "Which limits apply on the free tier?" },
    ],
    ...over,
  };
}

// ─── AC-04: the requirement, in one section ────────────────────────

describe("AC-04 — a brief is not a draft", () => {
  it("accepts a well-formed brief", () => {
    assert.equal(validateBrief(brief(), INPUTS).ok, true);
  });

  it("refuses any field that could carry body copy", () => {
    // The type has no such field; this catches an output smuggling one in.
    for (const f of PROSE_FIELDS) {
      const v = validateBrief(brief({ [f]: "Once upon a time..." }), INPUTS);
      assert.equal(v.ok, false, `accepted a brief carrying \`${f}\``);
      assert.equal(v.ok === false && v.reason, "BRIEF_CONTAINS_PROSE");
      assert.equal(v.ok === false && v.detail, f);
    }
  });

  it("caps the angle, so 'be thorough' cannot turn it into an article", () => {
    const ok = validateBrief(brief({ angle: "x".repeat(ANGLE_MAX_CHARS) }), INPUTS);
    assert.equal(ok.ok, true);
    const tooLong = validateBrief(brief({ angle: "x".repeat(ANGLE_MAX_CHARS + 1) }), INPUTS);
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.ok === false && tooLong.reason, "ANGLE_TOO_LONG");
  });

  it("the accepted brief carries NO prose field of any kind", () => {
    const v = validateBrief(brief(), INPUTS);
    assert.equal(v.ok, true);
    if (v.ok) {
      for (const f of PROSE_FIELDS) {
        assert.equal(f in v.brief, false, `the brief has a \`${f}\` field`);
      }
    }
  });

  it("a required claim must be a QUESTION, not an assertion", () => {
    // "The price is $49" is a fact the strategist has no evidence for, and a
    // Writer handed it would treat it as given.
    const v = validateBrief(
      brief({ requiredClaims: [{ key: "price", question: "The price is $49 per month." }] }),
      INPUTS,
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "CLAIM_IS_AN_ASSERTION");
  });

  it("accepts questions in either language the project uses", () => {
    for (const q of [
      "What does it cost?",
      "How many seats are included?",
      "Giá gói trả phí là bao nhiêu?",
      "Có giới hạn nào ở gói miễn phí?",
    ]) {
      const v = validateBrief(brief({ requiredClaims: [{ key: "k", question: q }] }), INPUTS);
      assert.equal(v.ok, true, `refused a legitimate question: ${q}`);
    }
  });

  it("caps question length too", () => {
    const v = validateBrief(
      brief({ requiredClaims: [{ key: "k", question: "What " + "x".repeat(QUESTION_MAX_CHARS) + "?" }] }),
      INPUTS,
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "QUESTION_TOO_LONG");
  });
});

// ─── AC-01 / AC-02 ─────────────────────────────────────────────────

describe("AC-01/AC-02 — it reads P2 and extends nothing", () => {
  it("the P2-R03 score is carried through UNCHANGED", () => {
    const v = validateBrief(brief(), { ...INPUTS, opportunityScore: 82 });
    assert.equal(v.ok === true && v.brief.opportunityScore, 82);
  });

  it("an unscored opportunity stays unscored — never zero", () => {
    const v = validateBrief(brief(), { ...INPUTS, opportunityScore: null });
    assert.equal(v.ok === true && v.brief.opportunityScore, null);
    assert.notEqual(v.ok === true && v.brief.opportunityScore, 0);
  });

  it("nothing in the brief output can influence the score", () => {
    // The score arrives in `inputs` and leaves untouched. A brief claiming a
    // different score is ignored, not honoured.
    const v = validateBrief(brief({ opportunityScore: 99 }), { ...INPUTS, opportunityScore: 82 });
    assert.equal(v.ok, false); // undeclared field is not silently dropped either
  });

  it("every brief names exactly one mode, from P2's vocabulary", () => {
    for (const m of CONTENT_MODES) {
      assert.equal(validateBrief(brief({ contentMode: m }), INPUTS).ok, true, `${m} refused`);
    }
    const invented = validateBrief(brief({ contentMode: "SPONSORED" }), INPUTS);
    assert.equal(invented.ok, false);
    assert.equal(invented.ok === false && invented.reason, "UNKNOWN_CONTENT_MODE");
  });

  it("a brief with no mode is refused", () => {
    assert.equal(validateBrief(brief({ contentMode: "" }), INPUTS).ok, false);
  });
});

// ─── AC-03 / AC-07 ─────────────────────────────────────────────────

describe("AC-03/AC-07 — the evidence bar is read, and cannot be lowered here", () => {
  it("the required level comes from P4-R07 and is restated in the brief", () => {
    const v = validateBrief(brief(), { ...INPUTS, requiredEvidenceLevel: "E4" });
    assert.equal(v.ok === true && v.brief.requiredEvidenceLevel, "E4");
    assert.equal(v.ok === true && v.brief.policyVersion, INPUTS.policyVersion);
  });

  it("a brief CANNOT lower the bar — the output value is ignored", () => {
    // AC-07 asks for a test that the downgrade path does not exist. It does
    // not: `requiredEvidenceLevel` is copied from inputs and nothing in
    // validateBrief can alter it. An output naming its own level is refused
    // outright as an undeclared field.
    const v = validateBrief(brief({ requiredEvidenceLevel: "E0" }), INPUTS);
    assert.equal(v.ok, false);
  });

  it("CONTROL — a shortfall is STATED, and the brief is still produced", () => {
    // The failure this criterion names: an unmeetable bar quietly lowered, or
    // the brief refused so the gap never surfaces. Neither happens.
    const v = validateBrief(brief(), {
      ...INPUTS, requiredEvidenceLevel: "E4", evidenceShortfall: true,
    });
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.brief.evidenceShortfall, true);
    assert.equal(v.ok === true && v.brief.requiredEvidenceLevel, "E4");
  });

  it("no shortfall is reported when there is none", () => {
    const v = validateBrief(brief(), INPUTS);
    assert.equal(v.ok === true && v.brief.evidenceShortfall, false);
  });
});

// ─── Structure ─────────────────────────────────────────────────────

describe("the target structure is a closed set", () => {
  it("every declared section is accepted", () => {
    const v = validateBrief(brief({ targetSections: [...BRIEF_SECTIONS] }), INPUTS);
    assert.equal(v.ok, true);
  });

  it("an invented section is refused", () => {
    const v = validateBrief(brief({ targetSections: ["INTRO", "SPONSORED_BLOCK"] }), INPUTS);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_SECTION");
  });

  it("a brief with no sections is refused", () => {
    assert.equal(validateBrief(brief({ targetSections: [] }), INPUTS).ok, false);
  });

  it("duplicate sections and duplicate claim keys are refused", () => {
    assert.equal(validateBrief(brief({ targetSections: ["INTRO", "INTRO"] }), INPUTS).ok, false);
    const dup = validateBrief(
      brief({ requiredClaims: [
        { key: "price", question: "What is the price?" },
        { key: "price", question: "How much does it cost?" },
      ] }),
      INPUTS,
    );
    assert.equal(dup.ok, false);
    assert.equal(dup.ok === false && dup.reason, "DUPLICATE_CLAIM_KEY");
  });
});

// ─── CONTROL ───────────────────────────────────────────────────────

describe("CONTROL — the validator is not a blanket refusal", () => {
  it("a brief with no required claims is still valid", () => {
    // Not every piece makes checkable factual claims. Refusing here would make
    // the strategist unable to brief an opinion piece.
    const v = validateBrief(brief({ requiredClaims: [] }), INPUTS);
    assert.equal(v.ok, true);
  });

  it("every refusal reason is reachable and none is ad-hoc", () => {
    const seen = new Set<string>();
    const cases: unknown[] = [
      "not an object",
      brief({ opportunityId: "" }),
      brief({ contentMode: "" }),
      brief({ contentMode: "NOPE" }),
      brief({ angle: "" }),
      brief({ angle: "x".repeat(ANGLE_MAX_CHARS + 1) }),
      brief({ targetSections: [] }),
      brief({ targetSections: ["NOPE"] }),
      brief({ targetSections: ["INTRO", "INTRO"] }),
      brief({ requiredClaims: [{ key: "k", question: "It costs money." }] }),
      brief({ requiredClaims: [{ key: "k", question: "What " + "x".repeat(300) + "?" }] }),
      brief({ requiredClaims: [{ key: "k", question: "What?" }, { key: "k", question: "Why?" }] }),
      brief({ body: "prose" }),
    ];
    for (const c of cases) {
      const v = validateBrief(c, INPUTS);
      if (!v.ok) {
        assert.ok((BRIEF_REFUSALS as readonly string[]).includes(v.reason), `${v.reason} is ad-hoc`);
        seen.add(v.reason);
      }
    }
    assert.ok(seen.size >= 11, `only ${seen.size} refusal reasons were reachable`);
  });
});
