/**
 * P4-R06 — the QA Agent.
 *
 * `G-43` is the sentence to keep in view: *"nothing mechanically prevents 'we
 * tested this' at E1."* This file is mostly about making that sentence false.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AGENT_REGISTRY, PROJECT_RESEARCH_AGENT, QA_AGENT, checkTool } from "./agent-policy";
import {
  CLAIM_STRENGTH_PATTERNS,
  QA_AGENT_FAILURES,
  explainFinding,
  impliedStrength,
  judgeDraft,
  qaGatePasses,
  rankOf,
  type QaSubject,
} from "./qa-agent-policy";

function subject(over: Partial<QaSubject> = {}): QaSubject {
  return {
    draftId: "draft-1",
    evidencePackId: "pack-1",
    contentMode: "COMMERCIAL",
    sections: [
      { section: "PRICING", text: "According to the vendor, it costs $49.", citedClaims: ["price"] },
    ],
    claims: [{ key: "price", evidenceLevel: "E2" }],
    ...over,
  };
}

// ─── AC-01 / AC-02: it is a different agent, with no way to write ──

describe("AC-01/AC-02 — a separate agent that cannot touch the draft", () => {
  it("is registered under its own name, not the Writer's", () => {
    assert.equal(AGENT_REGISTRY.has(QA_AGENT.name), true);
    assert.notEqual(QA_AGENT.name, PROJECT_RESEARCH_AGENT.name);
    assert.notEqual(QA_AGENT.taskClass, PROJECT_RESEARCH_AGENT.taskClass);
  });

  it("its task class is QA, so it routes to its own model policy", () => {
    assert.equal(QA_AGENT.taskClass, "QA");
  });

  it("declares NO draft-mutating tool", () => {
    for (const t of QA_AGENT.tools) {
      assert.equal(/write|update|edit|delete|publish|approve/i.test(t), false,
        `QA declares a mutating tool: ${t}`);
    }
  });

  it("a write attempt is REFUSED at call time by the framework", () => {
    // AC-02 structurally: the refusal comes from P4-R01's closed tool set, not
    // from a reviewer noticing.
    for (const tool of ["draft.write", "article.update", "draft.delete", "publish"]) {
      const d = checkTool(AGENT_REGISTRY, QA_AGENT.name, tool);
      assert.equal(d.ok, false, `QA was allowed to call ${tool}`);
      assert.equal(d.ok === false && d.reason, "TOOL_NOT_DECLARED");
    }
  });

  it("CONTROL — its declared read tools ARE allowed", () => {
    // Otherwise the test above passes against an agent that can call nothing.
    for (const tool of QA_AGENT.tools) {
      assert.equal(checkTool(AGENT_REGISTRY, QA_AGENT.name, tool).ok, true);
    }
  });
});

// ─── AC-03: G-43, mechanically ─────────────────────────────────────

describe("AC-03 — a claim stronger than its evidence fails", () => {
  it("THE canonical case: 'we tested this' at E1 FAILS", () => {
    const v = judgeDraft(subject({
      sections: [{ section: "VERDICT", text: "We tested this for a week.", citedClaims: ["price"] }],
      claims: [{ key: "price", evidenceLevel: "E1" }],
    }), "E1");
    assert.equal(v.ok, false);
    const f = v.ok === false ? v.findings[0]! : (undefined as never);
    assert.equal(f.reason, "CLAIM_STRONGER_THAN_ITS_EVIDENCE");
    assert.equal(f.implied, "E4");
    assert.equal(f.actual, "E1");
  });

  it("the same wording at E4 PASSES", () => {
    // The check does work rather than always answering the same way.
    const v = judgeDraft(subject({
      sections: [{ section: "VERDICT", text: "We tested this for a week.", citedClaims: ["price"] }],
      claims: [{ key: "price", evidenceLevel: "E4" }],
    }), "E2");
    assert.equal(v.ok, true);
  });

  it("a strength claim citing NOTHING is refused", () => {
    const v = judgeDraft(subject({
      sections: [{ section: "VERDICT", text: "We measured the response time.", citedClaims: [] }],
      claims: [],
    }), "E2");
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.findings[0]!.reason, "UNSUPPORTED_STRENGTH_CLAIM");
  });

  it("UNKNOWN evidence supports NO strength claim", () => {
    // UNKNOWN is not a low level -- it is the absence of one. Treating it as
    // E0 would let it be compared, and comparison implies it is a level.
    const v = judgeDraft(subject({
      sections: [{ section: "VERDICT", text: "We tested this.", citedClaims: ["price"] }],
      claims: [{ key: "price", evidenceLevel: null }],
    }), "E2");
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.findings[0]!.reason, "CITED_CLAIM_HAS_NO_EVIDENCE_LEVEL");
  });

  it("the STRONGEST implication in a paragraph wins", () => {
    // "According to the vendor" does not excuse "we tested this" in the same
    // sentence.
    const s = impliedStrength("According to the vendor it is fast, and we tested this ourselves.");
    assert.equal(s?.implies, "E4");
  });

  it("prose making no strength claim implies nothing", () => {
    assert.equal(impliedStrength("The interface is clean and the docs are short."), null);
  });

  it("every strength pattern is reachable and ordered strongest-first", () => {
    let last = 5;
    for (const p of CLAIM_STRENGTH_PATTERNS) {
      assert.ok(rankOf(p.implies) < last, `${p.implies} is out of order`);
      last = rankOf(p.implies);
    }
    assert.equal(impliedStrength("We tested this")?.implies, "E4");
    assert.equal(impliedStrength("Independently confirmed")?.implies, "E3");
    assert.equal(impliedStrength("The vendor states")?.implies, "E2");
    assert.equal(impliedStrength("Reportedly")?.implies, "E1");
  });
});

// ─── AC-04 ─────────────────────────────────────────────────────────

describe("AC-04 — a failure a person can act on", () => {
  it("names the section, the claim, both levels, and quotes the phrase", () => {
    const v = judgeDraft(subject({
      sections: [{ section: "VERDICT", text: "We tested this thoroughly.", citedClaims: ["price"] }],
      claims: [{ key: "price", evidenceLevel: "E1" }],
    }), "E1");
    const msg = explainFinding(v.ok === false ? v.findings[0]! : (undefined as never));
    assert.match(msg, /VERDICT/);
    assert.match(msg, /price/);
    assert.match(msg, /E4/);
    assert.match(msg, /E1/);
    assert.match(msg, /we tested/i);
    // "QA failed" alone is explicitly not a pass of this criterion.
    assert.ok(msg.length > 40);
  });

  it("ALL findings are returned, not just the first", () => {
    // A person fixing a draft needs the whole list; one at a time turns one
    // review into five.
    const v = judgeDraft(subject({
      sections: [
        { section: "A", text: "We tested this.", citedClaims: ["p1"] },
        { section: "B", text: "We measured that.", citedClaims: ["p2"] },
      ],
      claims: [{ key: "p1", evidenceLevel: "E1" }, { key: "p2", evidenceLevel: "E1" }],
    }), "E1");
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.findings.length, 2);
  });

  it("every failure reason produces a legible message", () => {
    const seen = new Set<string>();
    const cases: QaSubject[] = [
      subject({ sections: [{ section: "A", text: "We tested this.", citedClaims: ["p"] }],
                claims: [{ key: "p", evidenceLevel: "E1" }] }),
      subject({ sections: [{ section: "A", text: "We tested this.", citedClaims: ["p"] }],
                claims: [{ key: "p", evidenceLevel: null }] }),
      subject({ sections: [{ section: "A", text: "We tested this.", citedClaims: [] }], claims: [] }),
      subject({ sections: [{ section: "A", text: "It is nice.", citedClaims: ["p"] }],
                claims: [{ key: "p", evidenceLevel: "E1" }] }),
    ];
    for (const c of cases) {
      const v = judgeDraft(c, "E3");
      if (!v.ok) for (const f of v.findings) {
        assert.ok((QA_AGENT_FAILURES as readonly string[]).includes(f.reason), `${f.reason} is ad-hoc`);
        seen.add(f.reason);
        assert.ok(explainFinding(f).length > 20);
      }
    }
    assert.deepEqual([...seen].sort(), [...QA_AGENT_FAILURES].sort());
  });
});

// ─── AC-05 / AC-06 ─────────────────────────────────────────────────

describe("AC-05/AC-06 — no downgrade, and a pass confers nothing", () => {
  it("the verdict has no field that could carry a lowered requirement", () => {
    const v = judgeDraft(subject(), "E2");
    for (const f of ["downgrade", "adjustedLevel", "waiver", "override", "severity"]) {
      assert.equal(f in v, false, `the verdict carries \`${f}\``);
    }
  });

  it("a failing draft cannot be made to pass by re-judging it at a lower bar HERE", () => {
    // The bar comes from P4-R07 as a parameter. This module cannot change it,
    // and a caller lowering it is P4-R07's clamp problem, not a downgrade path
    // in QA.
    const sub = subject({
      sections: [{ section: "A", text: "Fine.", citedClaims: ["p"] }],
      claims: [{ key: "p", evidenceLevel: "E1" }],
    });
    assert.equal(judgeDraft(sub, "E3").ok, false);
    assert.equal(judgeDraft(sub, "E1").ok, true);
    // Both answers came from the CALLER's level. Nothing in the verdict
    // suggests, records or performs the change.
  });

  it("a QA pass is a boolean gate and nothing more", () => {
    const pass = judgeDraft(subject(), "E2");
    assert.equal(qaGatePasses(pass), true);

    // Found by mutation: `qaGatePasses` hard-coded to `true` killed no test,
    // because only the PASSING direction was ever asserted. A gate that always
    // opens is not a gate, and P4-R08 would consume it as one of three.
    const fail = judgeDraft(subject({ claims: [{ key: "price", evidenceLevel: "E0" }] }), "E3");
    assert.equal(fail.ok, false);
    assert.equal(qaGatePasses(fail), false);
    for (const f of ["approved", "verified", "publish", "dcVerified"]) {
      assert.equal(f in pass, false);
    }
  });
});

// ─── AC-07 / AC-08 ─────────────────────────────────────────────────

describe("AC-07/AC-08 — traceable, and doing real work", () => {
  it("every verdict names the draft and the evidence pack it judged", () => {
    const pass = judgeDraft(subject(), "E2");
    const fail = judgeDraft(subject({ claims: [{ key: "price", evidenceLevel: "E0" }] }), "E3");
    for (const v of [pass, fail]) {
      assert.equal(v.draftId, "draft-1");
      assert.equal(v.evidencePackId, "pack-1");
    }
  });

  it("CONTROL — the same draft passes at one level and fails at another", () => {
    // The criterion by name. Without it, every assertion above is met by a
    // judge that always says the same thing.
    const sub = subject({
      sections: [{ section: "PRICING", text: "The vendor states it costs $49.", citedClaims: ["price"] }],
      claims: [{ key: "price", evidenceLevel: "E2" }],
    });
    assert.equal(judgeDraft(sub, "E2").ok, true);
    const fail = judgeDraft(sub, "E3");
    assert.equal(fail.ok, false);
    assert.equal(fail.ok === false && fail.findings[0]!.reason, "CLAIM_BELOW_MODE_POLICY");
    assert.match(explainFinding(fail.ok === false ? fail.findings[0]! : (undefined as never)), /E3/);
  });

  it("a clean draft at a satisfied bar passes", () => {
    const v = judgeDraft(subject({
      sections: [{ section: "PRICING", text: "It costs $49.", citedClaims: ["price"] }],
      claims: [{ key: "price", evidenceLevel: "E4" }],
    }), "E2");
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.claimsChecked, 1);
  });
});
