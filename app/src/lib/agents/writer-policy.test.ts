/**
 * P4-R05 — the Writer.
 *
 * `AC-02` is the requirement: every factual claim traces to the evidence pack.
 * It is checked on FIGURES rather than on citations, because a Writer told to
 * cite its sources can simply not — and a fabricated claim with a plausible
 * citation is what a citation-count check waves through.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DRAFT_REFUSALS,
  FIGURE_MIN,
  citedClaimKeys,
  extractFigures,
  validateDraft,
  type WriterInputs,
} from "./writer-policy";

const INPUTS: WriterInputs = {
  briefId: "brief-1",
  allowedSections: ["INTRO", "PRICING", "VERDICT"],
  pack: [
    { key: "price", state: "ESTABLISHED", answer: "$49 per month" },
    { key: "seats", state: "ESTABLISHED", answer: "25 seats included" },
    { key: "payout", state: "UNKNOWN", answer: null },
  ],
};

function draft(over: Record<string, unknown> = {}) {
  return {
    briefId: "brief-1",
    title: "Is the Pro plan worth it?",
    sections: [
      { section: "INTRO", text: "A short look at the paid tier.", citedClaims: [] },
      { section: "PRICING", text: "The Pro plan costs $49 per month.", citedClaims: ["price"] },
    ],
    acknowledgedUnknowns: [],
    ...over,
  };
}

// ─── AC-02: the check that carries the requirement ─────────────────

describe("AC-02 — every figure in the prose traces to evidence", () => {
  it("accepts a figure that matches a cited claim's answer", () => {
    assert.equal(validateDraft(draft(), INPUTS).ok, true);
  });

  it("refuses an INVENTED figure, and names it", () => {
    // The Writer has to invent it somewhere, and the moment it lands in prose
    // it has no matching evidence answer.
    const v = validateDraft(draft({ sections: [
      { section: "PRICING", text: "The Pro plan costs $99 per month.", citedClaims: ["price"] },
    ] }), INPUTS);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNEVIDENCED_FIGURE");
    assert.deepEqual(v.ok === false && v.figures, ["99"]);
  });

  it("refuses a figure whose evidence is cited by a DIFFERENT section", () => {
    // Evidence has to support the sentence it appears in. Cited-somewhere is
    // not cited-here.
    const v = validateDraft(draft({ sections: [
      { section: "PRICING", text: "Priced at $49.", citedClaims: ["price"] },
      { section: "VERDICT", text: "Worth it at $49.", citedClaims: [] },
    ] }), INPUTS);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNEVIDENCED_FIGURE");
  });

  it("a citation to a claim not in the pack is refused", () => {
    const v = validateDraft(draft({ sections: [
      { section: "INTRO", text: "Text.", citedClaims: ["nonexistent"] },
    ] }), INPUTS);
    assert.equal(v.ok === false && v.reason, "CITED_CLAIM_NOT_IN_PACK");
  });

  it("a plausible citation does not launder an invented figure", () => {
    // The failure a citation-count check waves through: cite something real,
    // write something else.
    const v = validateDraft(draft({ sections: [
      { section: "PRICING", text: "It costs $1,299 a year.", citedClaims: ["price", "seats"] },
    ] }), INPUTS);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNEVIDENCED_FIGURE");
  });

  it("figures are compared on the NUMBER, not the formatting", () => {
    const v = validateDraft(draft({ sections: [
      { section: "PRICING", text: "Forty-nine dollars — $49.00 exactly.", citedClaims: ["price"] },
    ] }), INPUTS);
    assert.equal(v.ok, true);
  });

  it("citedClaimKeys reports what the draft rests on", () => {
    const v = validateDraft(draft(), INPUTS);
    assert.deepEqual(v.ok === true && citedClaimKeys(v.draft), ["price"]);
  });
});

// ─── AC-04: UNKNOWN never becomes a number ─────────────────────────

describe("AC-04 — an UNKNOWN claim is never asserted", () => {
  it("an UNKNOWN cannot be CITED as support", () => {
    // Acknowledging says "we do not know". Citing says "this is why". The
    // difference is the whole criterion.
    const v = validateDraft(draft({ sections: [
      { section: "PRICING", text: "Payout terms apply.", citedClaims: ["payout"] },
    ] }), INPUTS);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "CITED_CLAIM_IS_UNKNOWN");
  });

  it("THE canonical test: an UNKNOWN payout produces NO figure", () => {
    // An UNKNOWN claim has no answer, so no figure can ever match it. AC-04 is
    // not a separate mechanism -- it falls out of AC-02's rule.
    const v = validateDraft(draft({ sections: [
      { section: "PRICING", text: "The payout threshold is $50.", citedClaims: ["payout"] },
    ] }), INPUTS);
    assert.equal(v.ok, false);
  });

  it("a MALFORMED UNKNOWN carrying an answer is still not evidence", () => {
    // Found by mutation: dropping the `state === "ESTABLISHED"` filter killed
    // no test, because every UNKNOWN in the fixture had `answer: null` and the
    // null check did the work on its own.
    //
    // P4-R04 refuses an UNKNOWN carrying an answer, so this input should never
    // arrive. The Writer must not DEPEND on that: an upstream guard is not a
    // reason for a downstream one to be absent, and the pack could equally
    // arrive from a future producer.
    const malformed: WriterInputs = {
      ...INPUTS,
      pack: [{ key: "payout", state: "UNKNOWN", answer: "$50 threshold" }],
    };
    const v = validateDraft(draft({ sections: [
      { section: "PRICING", text: "The threshold is $50.", citedClaims: [] },
    ] }), malformed);
    assert.equal(v.ok, false, "an UNKNOWN's stray answer was accepted as evidence");
    assert.equal(v.ok === false && v.reason, "UNEVIDENCED_FIGURE");
  });

  it("an UNKNOWN may be ACKNOWLEDGED, and the draft passes", () => {
    const v = validateDraft(draft({
      sections: [{ section: "PRICING", text: "The payout threshold is not published.", citedClaims: [] }],
      acknowledgedUnknowns: ["payout"],
    }), INPUTS);
    assert.equal(v.ok, true);
    assert.deepEqual(v.ok === true && v.draft.acknowledgedUnknowns, ["payout"]);
  });

  it("acknowledging an ESTABLISHED claim as unknown is refused", () => {
    // Understating what the system knows is a different lie, and still a lie.
    const v = validateDraft(draft({ acknowledgedUnknowns: ["price"] }), INPUTS);
    assert.equal(v.ok === false && v.reason, "ACKNOWLEDGED_CLAIM_IS_ESTABLISHED");
  });

  it("acknowledging something not in the pack is refused", () => {
    const v = validateDraft(draft({ acknowledgedUnknowns: ["nope"] }), INPUTS);
    assert.equal(v.ok === false && v.reason, "ACKNOWLEDGED_UNKNOWN_NOT_IN_PACK");
  });
});

// ─── AC-03 / AC-05 ─────────────────────────────────────────────────

describe("AC-03/AC-05 — drafting is not verifying, consenting or publishing", () => {
  it("refuses any privileged field, and names which boundary was crossed", () => {
    for (const f of [
      "verified", "dcVerified", "dc_verified", "verificationStatus",
      "approved", "approval", "approvedBy",
      "publish", "publishIntent", "publishAt", "status",
    ]) {
      const v = validateDraft(draft({ [f]: true }), INPUTS);
      assert.equal(v.ok, false, `accepted a draft carrying \`${f}\``);
      assert.equal(v.ok === false && v.reason, "DRAFT_CARRIES_PRIVILEGED_FIELD");
      assert.equal(v.ok === false && v.detail, f);
    }
  });

  it("the accepted draft carries no privileged field at all", () => {
    const v = validateDraft(draft(), INPUTS);
    assert.equal(v.ok, true);
    if (v.ok) {
      for (const f of ["verified", "approved", "publish", "status"]) {
        assert.equal(f in v.draft, false);
      }
      assert.deepEqual(Object.keys(v.draft).sort(),
        ["acknowledgedUnknowns", "briefId", "sections", "title"]);
    }
  });

  it("an undeclared field is refused rather than ignored", () => {
    assert.equal(validateDraft(draft({ extra: 1 }), INPUTS).ok, false);
  });
});

// ─── AC-01 ─────────────────────────────────────────────────────────

describe("AC-01 — the brief and the pack, and nothing else", () => {
  it("a draft for a different brief is refused", () => {
    const v = validateDraft(draft({ briefId: "brief-2" }), INPUTS);
    assert.equal(v.ok === false && v.reason, "WRONG_BRIEF");
  });

  it("a section the brief did not ask for is refused", () => {
    // A Writer adding a section is writing to a plan nobody approved.
    const v = validateDraft(draft({ sections: [
      { section: "SPONSORED", text: "Buy now.", citedClaims: [] },
    ] }), INPUTS);
    assert.equal(v.ok === false && v.reason, "SECTION_NOT_IN_BRIEF");
  });

  it("duplicate sections and empty sections are refused", () => {
    assert.equal(validateDraft(draft({ sections: [
      { section: "INTRO", text: "a", citedClaims: [] },
      { section: "INTRO", text: "b", citedClaims: [] },
    ] }), INPUTS).ok, false);
    assert.equal(validateDraft(draft({ sections: [
      { section: "INTRO", text: "   ", citedClaims: [] },
    ] }), INPUTS).ok, false);
  });
});

// ─── The figure extractor ──────────────────────────────────────────

describe("what counts as a figure", () => {
  it("currency, percentages and large numbers count", () => {
    assert.deepEqual(extractFigures("It is $49 a month"), ["49"]);
    assert.deepEqual(extractFigures("Up to 18% commission"), ["18"]);
    assert.deepEqual(extractFigures("Around 25 seats"), ["25"]);
    assert.deepEqual(extractFigures("$1,299.00"), ["1299"]);
  });

  it("small bare numbers are prose, not claims", () => {
    // "the three plans" is not data. Treating it as one would make the rule so
    // noisy it would be turned off.
    assert.deepEqual(extractFigures("There are 3 plans and 2 ways in"), []);
    assert.ok(FIGURE_MIN > 2);
  });

  it("but a small number WITH a currency or percent sign is a claim", () => {
    assert.deepEqual(extractFigures("Just $5"), ["5"]);
    assert.deepEqual(extractFigures("Only 3%"), ["3"]);
  });

  it("prose with no numbers yields nothing", () => {
    assert.deepEqual(extractFigures("A thorough look at the paid tier."), []);
  });
});

// ─── AC-08: CONTROL ────────────────────────────────────────────────

describe("AC-08 — CONTROL: the rule is not one that rejects everything", () => {
  it("a well-evidenced draft PASSES", () => {
    const v = validateDraft({
      briefId: "brief-1",
      title: "The Pro plan, assessed",
      sections: [
        { section: "INTRO", text: "A look at the paid tier.", citedClaims: [] },
        { section: "PRICING", text: "It costs $49 per month and includes 25 seats.",
          citedClaims: ["price", "seats"] },
        { section: "VERDICT", text: "Reasonable for a small team.", citedClaims: [] },
      ],
      acknowledgedUnknowns: ["payout"],
    }, INPUTS);
    assert.equal(v.ok, true);
    assert.deepEqual(v.ok === true && [...citedClaimKeys(v.draft)].sort(), ["price", "seats"]);
  });

  it("a draft with no figures at all passes without citing anything", () => {
    // Not every piece is numeric. Requiring citations for prose that makes no
    // measurable claim would make an opinion piece unwritable.
    const v = validateDraft(draft({ sections: [
      { section: "VERDICT", text: "Worth a look if you value simplicity.", citedClaims: [] },
    ] }), INPUTS);
    assert.equal(v.ok, true);
  });

  it("every refusal reason is reachable and none is ad-hoc", () => {
    const seen = new Set<string>();
    const cases: unknown[] = [
      "nope",
      draft({ briefId: "other" }),
      draft({ extra: 1 }),
      draft({ title: "" }),
      draft({ sections: [] }),
      draft({ sections: [{ section: "NOPE", text: "t", citedClaims: [] }] }),
      draft({ sections: [
        { section: "INTRO", text: "a", citedClaims: [] },
        { section: "INTRO", text: "b", citedClaims: [] }] }),
      draft({ sections: [{ section: "INTRO", text: " ", citedClaims: [] }] }),
      draft({ sections: [{ section: "INTRO", text: "t", citedClaims: ["ghost"] }] }),
      draft({ sections: [{ section: "INTRO", text: "t", citedClaims: ["payout"] }] }),
      draft({ sections: [{ section: "PRICING", text: "$999", citedClaims: ["price"] }] }),
      draft({ acknowledgedUnknowns: ["ghost"] }),
      draft({ acknowledgedUnknowns: ["price"] }),
      draft({ approved: true }),
    ];
    for (const c of cases) {
      const v = validateDraft(c, INPUTS);
      if (!v.ok) {
        assert.ok((DRAFT_REFUSALS as readonly string[]).includes(v.reason), `${v.reason} is ad-hoc`);
        seen.add(v.reason);
      }
    }
    assert.ok(seen.size >= 13, `only ${seen.size} refusal reasons were reachable`);
  });
});
