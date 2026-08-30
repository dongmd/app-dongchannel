/**
 * P4-R04 — the Evidence Research Agent.
 *
 * Two rules here are not about shape and carry the requirement:
 * a confidential source must not become a public claim, and an
 * `AffiliateProject` must never be created where a candidate belongs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS_CLASSES,
  EVIDENCE_REFUSALS,
  VISIBILITY_FOR_ACCESS,
  isEmptyPack,
  planEvidenceWrites,
  strictestAccess,
  validateEvidencePack,
  type EvidenceSource,
} from "./evidence-research-policy";

const NOW = new Date("2026-08-30T12:00:00Z");
const CHECKED = new Date("2026-08-30T11:00:00Z");

const PUB: EvidenceSource = {
  url: "https://vendor.example/pricing", publisher: "Vendor",
  excerpt: "Pro plan is $49 per month.", accessClass: "PUBLIC_WEB",
};
const PORTAL: EvidenceSource = {
  url: "https://portal.example/rates", publisher: "Network",
  excerpt: "Negotiated rate: 18%.", accessClass: "FIRST_PARTY",
};

function pack(over: Record<string, unknown> = {}) {
  return {
    briefId: "brief-1",
    claims: [{
      key: "price", question: "What does the Pro plan cost?", state: "ESTABLISHED",
      answer: "$49/month", sources: [PUB], checkedAt: CHECKED,
    }],
    candidates: [],
    ...over,
  };
}

// ─── AC-01 ─────────────────────────────────────────────────────────

describe("AC-01 — a claim with no evidence is not recordable", () => {
  it("accepts a claim with at least one complete source", () => {
    assert.equal(validateEvidencePack(pack(), NOW).ok, true);
  });

  it("refuses an ESTABLISHED claim with no sources at all", () => {
    const v = validateEvidencePack(pack({ claims: [{
      key: "price", question: "q", state: "ESTABLISHED", answer: "$49", sources: [], checkedAt: CHECKED,
    }] }), NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "ESTABLISHED_WITHOUT_SOURCE");
  });

  it("refuses a source with no excerpt or a non-absolute URL", () => {
    for (const bad of [{ ...PUB, excerpt: "" }, { ...PUB, url: "the vendor site" }]) {
      const v = validateEvidencePack(pack({ claims: [{
        key: "price", question: "q", state: "ESTABLISHED", answer: "$49",
        sources: [bad], checkedAt: CHECKED,
      }] }), NOW);
      assert.equal(v.ok, false);
    }
  });

  it("refuses an ESTABLISHED claim with no answer", () => {
    const v = validateEvidencePack(pack({ claims: [{
      key: "price", question: "q", state: "ESTABLISHED", answer: "", sources: [PUB], checkedAt: CHECKED,
    }] }), NOW);
    assert.equal(v.ok === false && v.reason, "ESTABLISHED_WITHOUT_ANSWER");
  });

  it("refuses a claim checked in the future", () => {
    const v = validateEvidencePack(pack({ claims: [{
      key: "price", question: "q", state: "ESTABLISHED", answer: "$49",
      sources: [PUB], checkedAt: new Date(NOW.getTime() + 1000),
    }] }), NOW);
    assert.equal(v.ok === false && v.reason, "CHECKED_AT_IN_THE_FUTURE");
  });
});

// ─── AC-02: the rule that publishes a negotiated rate if it fails ──

describe("AC-02 — no agent may promote a confidential fact", () => {
  it("every access class maps to a visibility, and PUBLIC_WEB is not PUBLIC", () => {
    // Reading something on the open web makes it QUOTABLE, not CLEARED. That
    // decision is editorial and this is not the editor.
    assert.equal(VISIBILITY_FOR_ACCESS.PUBLIC_WEB, "INTERNAL");
    assert.equal(VISIBILITY_FOR_ACCESS.AUTHENTICATED, "CONFIDENTIAL");
    assert.equal(VISIBILITY_FOR_ACCESS.FIRST_PARTY, "CONFIDENTIAL");
    for (const a of ACCESS_CLASSES) {
      assert.notEqual(VISIBILITY_FOR_ACCESS[a], "PUBLIC");
    }
  });

  it("a claim rests on its STRICTEST source, not its most convenient", () => {
    // The laundering path: corroborate a partner figure with any open-web
    // mention and call the result public.
    assert.equal(strictestAccess([PUB, PORTAL]), "FIRST_PARTY");
    assert.equal(strictestAccess([PORTAL, PUB]), "FIRST_PARTY");
    assert.equal(strictestAccess([PUB]), "PUBLIC_WEB");
  });

  it("a partner-portal claim persists as CONFIDENTIAL even with a public source too", () => {
    const v = validateEvidencePack(pack({ claims: [{
      key: "rate", question: "q", state: "ESTABLISHED", answer: "18%",
      sources: [PUB, PORTAL], checkedAt: CHECKED,
    }] }), NOW);
    assert.equal(v.ok, true);
    const rows = planEvidenceWrites(v.ok === true ? v.pack : (undefined as never));
    assert.equal(rows[0]!.visibility, "CONFIDENTIAL");
    assert.equal(rows[0]!.sourceAccess, "FIRST_PARTY");
  });

  it("an agent naming a visibility is REFUSED, not overruled", () => {
    const top = validateEvidencePack(pack({ visibility: "PUBLIC" }), NOW);
    assert.equal(top.ok, false);
    assert.equal(top.ok === false && top.reason, "AGENT_SET_VISIBILITY");

    const perSource = validateEvidencePack(pack({ claims: [{
      key: "rate", question: "q", state: "ESTABLISHED", answer: "18%",
      sources: [{ ...PORTAL, visibility: "PUBLIC" }], checkedAt: CHECKED,
    }] }), NOW);
    assert.equal(perSource.ok, false);
    assert.equal(perSource.ok === false && perSource.reason, "AGENT_SET_VISIBILITY");
  });

  it("a source claiming an INVENTED access class is refused", () => {
    // Found by mutation: weakening `isAccessClass` to `typeof v === "string"`
    // killed no test, because the only case tested was a MISSING class.
    // `accessClass: "PUBLIC"` is the dangerous one -- it reads like an answer
    // and is not in the vocabulary.
    for (const bogus of ["PUBLIC", "OPEN", "public_web", "", "INTERNAL"]) {
      const v = validateEvidencePack(pack({ claims: [{
        key: "price", question: "q", state: "ESTABLISHED", answer: "$49",
        sources: [{ ...PUB, accessClass: bogus }], checkedAt: CHECKED,
      }] }), NOW);
      assert.equal(v.ok, false, `accepted accessClass ${JSON.stringify(bogus)}`);
      assert.equal(v.ok === false && v.reason, "UNKNOWN_ACCESS_CLASS");
    }
  });

  it("a source with no access class is refused", () => {
    const v = validateEvidencePack(pack({ claims: [{
      key: "price", question: "q", state: "ESTABLISHED", answer: "$49",
      sources: [{ url: PUB.url, publisher: null, excerpt: PUB.excerpt }], checkedAt: CHECKED,
    }] }), NOW);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_ACCESS_CLASS");
  });

  it("no plan row is ever PUBLIC", () => {
    for (const a of ACCESS_CLASSES) {
      const v = validateEvidencePack(pack({ claims: [{
        key: "k", question: "q", state: "ESTABLISHED", answer: "x",
        sources: [{ ...PUB, accessClass: a }], checkedAt: CHECKED,
      }] }), NOW);
      const rows = planEvidenceWrites(v.ok === true ? v.pack : (undefined as never));
      assert.notEqual(rows[0]!.visibility, "PUBLIC", `${a} produced a PUBLIC claim`);
    }
  });

  it("no plan row is ever VERIFIED — researched is not verified", () => {
    const v = validateEvidencePack(pack(), NOW);
    const rows = planEvidenceWrites(v.ok === true ? v.pack : (undefined as never));
    assert.ok(rows.every((r) => r.verificationStatus !== ("VERIFIED" as never)));
  });
});

// ─── AC-03 ─────────────────────────────────────────────────────────

describe("AC-03 — UNKNOWN is not false", () => {
  const unknownPack = pack({ claims: [
    { key: "payout", question: "q", state: "UNKNOWN", reason: "not published", checkedAt: CHECKED },
  ] });

  it("accepts an UNKNOWN with a reason", () => {
    assert.equal(validateEvidencePack(unknownPack, NOW).ok, true);
  });

  it("refuses an UNKNOWN with no reason", () => {
    const v = validateEvidencePack(pack({ claims: [
      { key: "payout", question: "q", state: "UNKNOWN", checkedAt: CHECKED },
    ] }), NOW);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_WITHOUT_REASON");
  });

  it("refuses an UNKNOWN carrying an answer", () => {
    // How UNKNOWN becomes false -- or worse, a figure -- one careless reader
    // downstream.
    const v = validateEvidencePack(pack({ claims: [
      { key: "payout", question: "q", state: "UNKNOWN", reason: "r", answer: "$50", checkedAt: CHECKED },
    ] }), NOW);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_CARRIES_AN_ANSWER");
  });

  it("UNKNOWN and ESTABLISHED persist distinguishably", () => {
    const v = validateEvidencePack(pack({ claims: [
      { key: "price", question: "q", state: "ESTABLISHED", answer: "$49", sources: [PUB], checkedAt: CHECKED },
      { key: "payout", question: "q", state: "UNKNOWN", reason: "not published", checkedAt: CHECKED },
    ] }), NOW);
    const rows = planEvidenceWrites(v.ok === true ? v.pack : (undefined as never));
    const est = rows.find((r) => r.claimKey === "price")!;
    const unk = rows.find((r) => r.claimKey === "payout")!;

    assert.equal(est.verificationStatus, "UNVERIFIED");
    assert.equal(unk.verificationStatus, "UNKNOWN");
    assert.equal(unk.normalizedValue, null);
    assert.notEqual(unk.normalizedValue, false);
    assert.equal(unk.evidenceCount, 0);
    assert.ok(est.evidenceCount > 0);
    // A gap is not public information either.
    assert.equal(unk.visibility, "CONFIDENTIAL");
  });
});

// ─── AC-04 / AC-05 ─────────────────────────────────────────────────

describe("AC-04/AC-05 — it touches nothing it was researching", () => {
  it("an output naming a project, article or opportunity is refused", () => {
    for (const f of ["project", "affiliateProject", "projectId", "article", "articleId", "opportunity"]) {
      const v = validateEvidencePack(pack({ [f]: "x" }), NOW);
      assert.equal(v.ok, false, `accepted an output carrying \`${f}\``);
      assert.equal(v.ok === false && v.reason, "ATTEMPTED_PROJECT_CREATION");
    }
  });

  it("a programme is emitted as a CANDIDATE and there is no field for a project", () => {
    const v = validateEvidencePack(pack({ candidates: [
      { vendorName: "Vendor", observedUrl: "https://vendor.example/affiliates", observedAt: CHECKED },
    ] }), NOW);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.pack.candidates.length, 1);
    assert.equal(v.ok === true && "project" in v.pack, false);
  });

  it("a candidate with no observed URL is refused", () => {
    const v = validateEvidencePack(pack({ candidates: [{ vendorName: "V", observedAt: CHECKED }] }), NOW);
    assert.equal(v.ok === false && v.reason, "CANDIDATE_WITHOUT_URL");
  });

  it("an undeclared top-level field is refused rather than ignored", () => {
    const v = validateEvidencePack(pack({ somethingElse: 1 }), NOW);
    assert.equal(v.ok === false && v.reason, "UNDECLARED_FIELD");
  });
});

// ─── AC-06 ─────────────────────────────────────────────────────────

describe("AC-06 — finding nothing is a normal outcome", () => {
  it("an empty pack is VALID and identifiable", () => {
    const v = validateEvidencePack(pack({ claims: [], candidates: [] }), NOW);
    assert.equal(v.ok, true);
    assert.equal(isEmptyPack(v.ok === true ? v.pack : (undefined as never)), true);
  });

  it("an empty pack is not the same as a refusal", () => {
    // Treating "found nothing" as an error would teach whoever reads
    // agent_runs to ignore failures.
    const empty = validateEvidencePack(pack({ claims: [], candidates: [] }), NOW);
    const refused = validateEvidencePack(pack({ briefId: "" }), NOW);
    assert.equal(empty.ok, true);
    assert.equal(refused.ok, false);
  });

  it("a non-empty pack is not reported as empty", () => {
    const v = validateEvidencePack(pack(), NOW);
    assert.equal(isEmptyPack(v.ok === true ? v.pack : (undefined as never)), false);
  });
});

// ─── AC-08: CONTROL ────────────────────────────────────────────────

describe("AC-08 — CONTROL: three refusals and one success", () => {
  it("a fabricated source, a promotion, and a project edit are each refused", () => {
    const fabricated = validateEvidencePack(pack({ claims: [{
      key: "price", question: "q", state: "ESTABLISHED", answer: "$49",
      sources: [{ url: "made up", publisher: null, excerpt: "x", accessClass: "PUBLIC_WEB" }],
      checkedAt: CHECKED,
    }] }), NOW);
    assert.equal(fabricated.ok, false);

    assert.equal(validateEvidencePack(pack({ visibility: "PUBLIC" }), NOW).ok, false);
    assert.equal(validateEvidencePack(pack({ articleId: "a1" }), NOW).ok, false);
  });

  it("a NORMAL run succeeds — the refusals are not blanket", () => {
    const v = validateEvidencePack(pack({
      claims: [
        { key: "price", question: "q", state: "ESTABLISHED", answer: "$49", sources: [PUB], checkedAt: CHECKED },
        { key: "rate", question: "q", state: "ESTABLISHED", answer: "18%", sources: [PORTAL], checkedAt: CHECKED },
        { key: "payout", question: "q", state: "UNKNOWN", reason: "not published", checkedAt: CHECKED },
      ],
      candidates: [{ vendorName: "V", observedUrl: "https://v.example/aff", observedAt: CHECKED }],
    }), NOW);
    assert.equal(v.ok, true);
    const rows = planEvidenceWrites(v.ok === true ? v.pack : (undefined as never));
    assert.equal(rows.length, 3);
    assert.equal(rows.find((r) => r.claimKey === "price")!.visibility, "INTERNAL");
    assert.equal(rows.find((r) => r.claimKey === "rate")!.visibility, "CONFIDENTIAL");
  });

  it("every refusal reason is reachable and none is ad-hoc", () => {
    const seen = new Set<string>();
    const cases: unknown[] = [
      "nope", pack({ briefId: "" }), pack({ extra: 1 }), pack({ projectId: "p" }),
      pack({ visibility: "PUBLIC" }),
      pack({ claims: [{ key: "k", question: "q", state: "ESTABLISHED", answer: "a", sources: [], checkedAt: CHECKED }] }),
      pack({ claims: [{ key: "k", question: "q", state: "ESTABLISHED", answer: "", sources: [PUB], checkedAt: CHECKED }] }),
      pack({ claims: [{ key: "k", question: "q", state: "ESTABLISHED", answer: "a", sources: [{ ...PUB, url: "x" }], checkedAt: CHECKED }] }),
      pack({ claims: [{ key: "k", question: "q", state: "ESTABLISHED", answer: "a", sources: [{ ...PUB, excerpt: "" }], checkedAt: CHECKED }] }),
      pack({ claims: [{ key: "k", question: "q", state: "ESTABLISHED", answer: "a", sources: [{ url: PUB.url, publisher: null, excerpt: "abc" }], checkedAt: CHECKED }] }),
      pack({ claims: [{ key: "k", question: "q", state: "UNKNOWN", checkedAt: CHECKED }] }),
      pack({ claims: [{ key: "k", question: "q", state: "UNKNOWN", reason: "r", answer: "a", checkedAt: CHECKED }] }),
      pack({ claims: [{ key: "k", question: "q", state: "ESTABLISHED", answer: "a", sources: [PUB], checkedAt: new Date(NOW.getTime() + 1) }] }),
      pack({ candidates: [{ vendorName: "V", observedAt: CHECKED }] }),
      pack({ claims: [
        { key: "k", question: "q", state: "ESTABLISHED", answer: "a", sources: [PUB], checkedAt: CHECKED },
        { key: "k", question: "q", state: "ESTABLISHED", answer: "b", sources: [PUB], checkedAt: CHECKED },
      ] }),
    ];
    for (const c of cases) {
      const v = validateEvidencePack(c, NOW);
      if (!v.ok) {
        assert.ok((EVIDENCE_REFUSALS as readonly string[]).includes(v.reason), `${v.reason} is ad-hoc`);
        seen.add(v.reason);
      }
    }
    assert.ok(seen.size >= 12, `only ${seen.size} refusal reasons were reachable`);
  });
});
