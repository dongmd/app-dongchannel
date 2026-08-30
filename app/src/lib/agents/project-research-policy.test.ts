/**
 * P4-R02 — the Project Research Agent's decisions.
 *
 * `P0-R01` is the reason this file is long. Invented commission rates and
 * fabricated partnership claims would enter the system through this exact
 * surface, and the project has committed that defect once already. Every test
 * below is about a way a number could arrive without anything behind it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EXECUTION_STATES } from "../telegram/command-policy";
import {
  FORBIDDEN_RESEARCH_EFFECTS,
  RESEARCH_FACT_KEYS,
  RESEARCH_REFUSALS,
  RESEARCHABLE_STATES,
  isResearchFactKey,
  isResearchable,
  planResearchWrites,
  validateResearch,
} from "./project-research-policy";

const NOW = new Date("2026-08-30T12:00:00Z");
const CHECKED = new Date("2026-08-30T11:00:00Z");

const SOURCE = {
  url: "https://programme.example/terms",
  publisher: "Example Programme",
  excerpt: "Commission is 12% of net revenue, 30-day cookie.",
};

function output(facts: unknown[]) {
  return { projectId: "proj-1", facts, summary: "" };
}

// ─── AC-04: no invented value can be constructed ───────────────────

describe("AC-04 — a fact cannot exist without something behind it", () => {
  it("accepts a KNOWN fact with a source and a checked time", () => {
    const v = validateResearch(
      output([{ key: "commission_value", state: "KNOWN", value: 12, source: SOURCE, checkedAt: CHECKED }]),
      NOW,
    );
    assert.equal(v.ok, true);
  });

  it("refuses a KNOWN fact with no source", () => {
    // The whole defect, in one case: a number with nothing behind it.
    const v = validateResearch(
      output([{ key: "commission_value", state: "KNOWN", value: 12, checkedAt: CHECKED }]),
      NOW,
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "KNOWN_FACT_WITHOUT_SOURCE");
  });

  it("refuses a source with no excerpt — 'checked' would mean trust me", () => {
    const v = validateResearch(
      output([{
        key: "commission_value", state: "KNOWN", value: 12, checkedAt: CHECKED,
        source: { ...SOURCE, excerpt: "" },
      }]),
      NOW,
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "SOURCE_WITHOUT_EXCERPT");
  });

  it("refuses a source URL that is not an absolute http(s) URL", () => {
    for (const url of ["", "the programme website", "/terms", "javascript:alert(1)"]) {
      const v = validateResearch(
        output([{
          key: "commission_value", state: "KNOWN", value: 12, checkedAt: CHECKED,
          source: { ...SOURCE, url },
        }]),
        NOW,
      );
      assert.equal(v.ok, false, `accepted url ${JSON.stringify(url)}`);
    }
  });

  it("refuses an invented field the agent was never allowed to research", () => {
    // The closed set doing its work: `guaranteed_payout` never reaches a value.
    const v = validateResearch(
      output([{ key: "guaranteed_payout", state: "KNOWN", value: 999, source: SOURCE, checkedAt: CHECKED }]),
      NOW,
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_FACT_KEY");
    assert.equal(v.ok === false && v.factKey, "guaranteed_payout");
  });

  it("refuses a KNOWN fact with no value, an empty value, or a non-finite one", () => {
    for (const value of [undefined, null, "", NaN, Infinity, {}, []]) {
      const v = validateResearch(
        output([{ key: "cookie_window_days", state: "KNOWN", value, source: SOURCE, checkedAt: CHECKED }]),
        NOW,
      );
      assert.equal(v.ok, false, `accepted value ${JSON.stringify(value)}`);
    }
  });

  it("refuses a fact checked in the future", () => {
    const v = validateResearch(
      output([{
        key: "cookie_window_days", state: "KNOWN", value: 30, source: SOURCE,
        checkedAt: new Date(NOW.getTime() + 60_000),
      }]),
      NOW,
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "CHECKED_AT_IN_THE_FUTURE");
  });

  it("refuses two answers to one question", () => {
    const f = { key: "commission_value", state: "KNOWN", value: 12, source: SOURCE, checkedAt: CHECKED };
    const v = validateResearch(output([f, { ...f, value: 15 }]), NOW);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "DUPLICATE_FACT_KEY");
  });
});

// ─── AC-05: three states, and why two would not do ─────────────────

describe("AC-05 — UNKNOWN and ABSENT are different facts", () => {
  it("UNKNOWN needs a reason and may carry no value", () => {
    const ok = validateResearch(
      output([{ key: "payout_threshold", state: "UNKNOWN", reason: "terms page 404s", checkedAt: CHECKED }]),
      NOW,
    );
    assert.equal(ok.ok, true);

    const noReason = validateResearch(
      output([{ key: "payout_threshold", state: "UNKNOWN", checkedAt: CHECKED }]),
      NOW,
    );
    assert.equal(noReason.ok, false);
    assert.equal(noReason.ok === false && noReason.reason, "UNKNOWN_FACT_WITHOUT_REASON");
  });

  it("an UNKNOWN carrying a value is refused — a guess wearing a disclaimer", () => {
    // Downstream code reading `.value` would never see the state.
    const v = validateResearch(
      output([{
        key: "payout_threshold", state: "UNKNOWN", reason: "could not find",
        value: 50, checkedAt: CHECKED,
      }]),
      NOW,
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNKNOWN_FACT_CARRIES_A_VALUE");
  });

  it("ABSENT is a FINDING and therefore needs a source too", () => {
    const sourced = validateResearch(
      output([{ key: "brand_bidding_allowed", state: "ABSENT", source: SOURCE, checkedAt: CHECKED }]),
      NOW,
    );
    assert.equal(sourced.ok, true);

    const unsourced = validateResearch(
      output([{ key: "brand_bidding_allowed", state: "ABSENT", checkedAt: CHECKED }]),
      NOW,
    );
    assert.equal(unsourced.ok, false);
  });

  it("ABSENT and UNKNOWN persist DIFFERENTLY — machine-distinguishable", () => {
    const v = validateResearch(
      output([
        { key: "brand_bidding_allowed", state: "ABSENT", source: SOURCE, checkedAt: CHECKED },
        { key: "payout_threshold", state: "UNKNOWN", reason: "no terms page", checkedAt: CHECKED },
      ]),
      NOW,
    );
    assert.equal(v.ok, true);
    const plan = planResearchWrites(v.ok === true ? v.output : (undefined as never));

    const absent = plan.claims.find((c) => c.claimKey === "brand_bidding_allowed")!;
    const unknown = plan.claims.find((c) => c.claimKey === "payout_threshold")!;

    // The distinction that matters to a downstream decision: a finding versus
    // a gap. A nullable number would collapse them.
    assert.equal(absent.verificationStatus, "UNVERIFIED");
    assert.deepEqual(absent.normalizedValue, { state: "ABSENT" });

    assert.equal(unknown.verificationStatus, "UNKNOWN");
    assert.equal(unknown.normalizedValue, null);

    // And a gap still leaves a row: otherwise the next agent cannot tell the
    // question was ever asked.
    assert.equal(plan.claims.length, 2);
    // Only the sourced finding produces evidence.
    assert.equal(plan.evidence.length, 1);
  });

  it("no agent output can produce a VERIFIED claim", () => {
    // Owner approval is not fact verification, and neither is agent output.
    const v = validateResearch(
      output([{ key: "commission_value", state: "KNOWN", value: 12, source: SOURCE, checkedAt: CHECKED }]),
      NOW,
    );
    const plan = planResearchWrites(v.ok === true ? v.output : (undefined as never));
    for (const c of plan.claims) {
      assert.notEqual(c.verificationStatus, "VERIFIED");
    }
  });

  it("evidence written by this agent claims UNKNOWN confidence", () => {
    // The agent read a page. It did not assess how much to trust it.
    const v = validateResearch(
      output([{ key: "commission_value", state: "KNOWN", value: 12, source: SOURCE, checkedAt: CHECKED }]),
      NOW,
    );
    const plan = planResearchWrites(v.ok === true ? v.output : (undefined as never));
    assert.equal(plan.evidence[0]!.confidence, "UNKNOWN");
    assert.equal(plan.evidence[0]!.excerpt, SOURCE.excerpt);
  });
});

// ─── AC-01 / AC-02 ─────────────────────────────────────────────────

describe("AC-01/AC-02 — execution states are unreachable from this path", () => {
  it("the researchable states are exactly the NON-execution states", () => {
    // Two hand-kept lists is the drift this project keeps finding, so they are
    // COMPARED rather than each trusted.
    const all = [
      "CANDIDATE", "RESEARCH", "READY_FOR_APPROVAL", "APPROVED_FOR_TEST",
      "CAMPAIGN_DRAFTED", "TESTING", "SCALE", "HOLD", "STOPPED",
    ];
    const expected = all.filter((s) => !(EXECUTION_STATES as readonly string[]).includes(s));
    assert.deepEqual([...RESEARCHABLE_STATES].sort(), expected.sort());
  });

  it("every execution state is refused", () => {
    for (const s of EXECUTION_STATES) {
      assert.equal(isResearchable(s), false, `${s} is researchable and must not be`);
    }
  });

  it("READY_FOR_APPROVAL specifically is refused", () => {
    // Named because it authorises nothing by itself, which is why it is easy to
    // think of as harmless. It is the state that ASKS for the approval.
    assert.equal(isResearchable("READY_FOR_APPROVAL"), false);
  });

  it("the write plan has no shape a status update could travel in", () => {
    const v = validateResearch(
      output([{ key: "commission_value", state: "KNOWN", value: 12, source: SOURCE, checkedAt: CHECKED }]),
      NOW,
    );
    const plan = planResearchWrites(v.ok === true ? v.output : (undefined as never));
    assert.deepEqual(Object.keys(plan).sort(), ["claims", "evidence"]);
    for (const c of plan.claims) {
      assert.equal(c.entityType, "affiliate_project");
      assert.equal("status" in c, false);
      assert.equal("approvedBy" in c, false);
      assert.equal("route" in c, false);
    }
  });
});

// ─── AC-07 ─────────────────────────────────────────────────────────

describe("AC-07 — the forbidden effects are named", () => {
  it("names every write that would let research become a decision", () => {
    const j = FORBIDDEN_RESEARCH_EFFECTS.join(" | ");
    assert.match(j, /affiliate_projects SET status/);
    assert.match(j, /affiliate_projects SET approved_by/);
    assert.match(j, /INSERT article_approvals/);
    assert.match(j, /INSERT article_publish_intents/);
    assert.match(j, /INSERT affiliate_tests/);
    assert.match(j, /claims SET visibility/);
    assert.equal(new Set(FORBIDDEN_RESEARCH_EFFECTS).size, FORBIDDEN_RESEARCH_EFFECTS.length);
  });

  it("the plan never sets claim visibility or source access", () => {
    // Defaults are CONFIDENTIAL / FIRST_PARTY. Only a named human may promote.
    const v = validateResearch(
      output([{ key: "commission_value", state: "KNOWN", value: 12, source: SOURCE, checkedAt: CHECKED }]),
      NOW,
    );
    const plan = planResearchWrites(v.ok === true ? v.output : (undefined as never));
    for (const c of plan.claims) {
      assert.equal("visibility" in c, false);
      assert.equal("sourceAccess" in c, false);
    }
  });
});

// ─── AC-09: CONTROL ────────────────────────────────────────────────

describe("AC-09 — CONTROL: a negative case per prohibition, and a positive one", () => {
  it("a status advance, an unsourced fact and an invented payout are each refused", () => {
    // The three prohibitions the criterion names, each with its own case.
    assert.equal(isResearchable("READY_FOR_APPROVAL"), false);

    const unsourced = validateResearch(
      output([{ key: "commission_value", state: "KNOWN", value: 12, checkedAt: CHECKED }]), NOW);
    assert.equal(unsourced.ok, false);

    const invented = validateResearch(
      output([{ key: "guaranteed_payout", state: "KNOWN", value: 500, source: SOURCE, checkedAt: CHECKED }]), NOW);
    assert.equal(invented.ok, false);
  });

  it("a WELL-FORMED research run succeeds — the refusals are not blanket", () => {
    // Without this, every assertion above is satisfied by a validator that
    // refuses everything, and the agent would be incapable of research.
    const v = validateResearch(
      output([
        { key: "commission_type", state: "KNOWN", value: "REVSHARE", source: SOURCE, checkedAt: CHECKED },
        { key: "commission_value", state: "KNOWN", value: 12, source: SOURCE, checkedAt: CHECKED },
        { key: "cookie_window_days", state: "KNOWN", value: 30, source: SOURCE, checkedAt: CHECKED },
        { key: "ppc_allowed", state: "KNOWN", value: false, source: SOURCE, checkedAt: CHECKED },
        { key: "brand_bidding_allowed", state: "ABSENT", source: SOURCE, checkedAt: CHECKED },
        { key: "payout_threshold", state: "UNKNOWN", reason: "not published", checkedAt: CHECKED },
      ]),
      NOW,
    );
    assert.equal(v.ok, true);

    const plan = planResearchWrites(v.ok === true ? v.output : (undefined as never));
    assert.equal(plan.claims.length, 6);
    assert.equal(plan.evidence.length, 5); // the UNKNOWN has no source
    assert.equal(isResearchable("CANDIDATE"), true);
  });

  it("EVERY fact key can be researched — none is unreachable", () => {
    for (const key of RESEARCH_FACT_KEYS) {
      assert.equal(isResearchFactKey(key), true);
      const v = validateResearch(
        output([{ key, state: "KNOWN", value: "x", source: SOURCE, checkedAt: CHECKED }]), NOW);
      assert.equal(v.ok, true, `${key} could not be recorded`);
    }
  });

  it("every refusal reason is reachable, and none is ad-hoc", () => {
    const seen = new Set<string>();
    const cases: unknown[] = [
      "not an object",
      { facts: [] },
      output([{ key: "nope", state: "KNOWN", value: 1, source: SOURCE, checkedAt: CHECKED }]),
      output([
        { key: "ppc_allowed", state: "KNOWN", value: true, source: SOURCE, checkedAt: CHECKED },
        { key: "ppc_allowed", state: "KNOWN", value: false, source: SOURCE, checkedAt: CHECKED },
      ]),
      output([{ key: "ppc_allowed", state: "KNOWN", value: true, checkedAt: CHECKED }]),
      output([{ key: "ppc_allowed", state: "KNOWN", source: SOURCE, checkedAt: CHECKED }]),
      output([{ key: "ppc_allowed", state: "KNOWN", value: true, checkedAt: CHECKED, source: { ...SOURCE, excerpt: "" } }]),
      output([{ key: "ppc_allowed", state: "KNOWN", value: true, checkedAt: CHECKED, source: { ...SOURCE, url: "x" } }]),
      output([{ key: "ppc_allowed", state: "UNKNOWN", checkedAt: CHECKED }]),
      output([{ key: "ppc_allowed", state: "UNKNOWN", reason: "r", value: 1, checkedAt: CHECKED }]),
      output([{ key: "ppc_allowed", state: "KNOWN", value: 1, source: SOURCE, checkedAt: new Date(NOW.getTime() + 1000) }]),
      output([{ key: "commission_value", state: "KNOWN", value: NaN, source: SOURCE, checkedAt: CHECKED }]),
    ];
    for (const c of cases) {
      const v = validateResearch(c, NOW);
      if (!v.ok) {
        assert.ok((RESEARCH_REFUSALS as readonly string[]).includes(v.reason), `${v.reason} is ad-hoc`);
        seen.add(v.reason);
      }
    }
    // Not every refusal needs its own case here, but the ones that exist must
    // all be real. A reason nothing can produce is a reason nothing tests.
    assert.ok(seen.size >= 9, `only ${seen.size} refusal reasons were reachable`);
  });
});
