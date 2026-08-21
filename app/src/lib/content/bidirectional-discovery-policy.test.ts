import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  affiliateProjectCandidates,
  candidateEvidence,
} from "../db/schema/discovery-candidate";
import {
  DISCOVERY_ACTIONS,
  TRISTATE,
  VERIFIABLE_FACTS,
  candidateKeyFor,
  checkFact,
  isExplainable,
  outcomeFor,
  proposeAffiliateCandidate,
  routeProgrammeToContent,
  unknownFact,
  defaultVisibilityFor,
  resolveVisibility,
  type AffiliateCandidateDraft,
} from "./bidirectional-discovery-policy";
import { OPPORTUNITY_ORIGIN_TYPES } from "./opportunity-policy";

// P2-R07 AC-01 … AC-09, plus the owner's requirement that BOTH directions be
// proven. One direction implemented and called bidirectional would leave the
// half that turns affiliate work into readable articles unbuilt.

const T0 = new Date("2026-08-20T00:00:00.000Z");
const SEEN = { observedUrl: "https://vendor.test/affiliates", observedAt: T0 };

function draft(over: Partial<AffiliateCandidateDraft> = {}): AffiliateCandidateDraft {
  return {
    vendorKey: "systeme-io",
    vendorName: "Systeme.io",
    programmeExists: { value: true, state: "YES", ...SEEN },
    facts: {},
    supportingSignalIds: ["sig-1"],
    ...over,
  };
}

function columns(table: object): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null && "columnType" in v) out[k] = v as Record<string, unknown>;
  }
  return out;
}

// ─── Direction A: research → affiliate candidate ──────────────────

test("A: research that observed a programme proposes a CANDIDATE", () => {
  const v = proposeAffiliateCandidate(draft());
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.status, "PROPOSED", "a candidate is never born accepted");
});

test("A: a candidate with no supporting signal is refused", () => {
  const v = proposeAffiliateCandidate(draft({ supportingSignalIds: [] }));
  assert.equal(v.ok === false && v.reason, "NO_SUPPORTING_EVIDENCE");
});

test("A: a candidate whose existence claim is UNKNOWN is a hunch, not a discovery", () => {
  const v = proposeAffiliateCandidate(draft({ programmeExists: unknownFact<boolean>() }));
  assert.equal(v.ok === false && v.reason, "PROGRAMME_NOT_OBSERVED");
});

test("A: observing that a programme does NOT exist is not a candidate either", () => {
  const v = proposeAffiliateCandidate(
    draft({ programmeExists: { value: false, state: "NO", ...SEEN } }),
  );
  assert.equal(v.ok === false && v.reason, "PROGRAMME_NOT_OBSERVED");
});

test("A: a claimed programme with no source is refused", () => {
  const v = proposeAffiliateCandidate(
    draft({ programmeExists: { value: true, state: "YES" } }),
  );
  assert.equal(v.ok === false && v.reason, "FACT_INVALID");
});

// ─── Direction B: affiliate programme → content opportunity ───────

test("B: a programme with topical scope and an angle routes to a content opportunity", () => {
  const v = routeProgrammeToContent({
    programmeId: "prog-1",
    vendorName: "Systeme.io",
    inTopicScope: true,
    hasAngle: true,
    supportingSignalIds: ["sig-1"],
  });
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.originType, "AFFILIATE_OFFER");
  assert.equal(v.ok === true && v.originId, "prog-1", "the trace back is structural");
});

test("B: 'this vendor pays a commission' is not an article", () => {
  // Routing every programme into content is how an affiliate site ends up with
  // a page per merchant and nothing anyone wants to read.
  const v = routeProgrammeToContent({
    programmeId: "prog-1", vendorName: "X", inTopicScope: true, hasAngle: false,
    supportingSignalIds: ["s"],
  });
  assert.equal(v.ok === false && v.reason, "NO_ANGLE");
});

test("B: an out-of-scope programme does not become content", () => {
  const v = routeProgrammeToContent({
    programmeId: "prog-1", vendorName: "X", inTopicScope: false, hasAngle: true,
    supportingSignalIds: ["s"],
  });
  assert.equal(v.ok === false && v.reason, "OUT_OF_TOPIC_SCOPE");
});

test("B: the opportunity carries CLAIMS TO CHECK, never checked claims", () => {
  const v = routeProgrammeToContent({
    programmeId: "p", vendorName: "X", inTopicScope: true, hasAngle: true, supportingSignalIds: ["s"],
  });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.ok(v.claimsToCheck.length >= 3);
  // Questions, not values. No number, no percentage, no currency.
  for (const c of v.claimsToCheck) {
    assert.equal(/\d+\s*%|\$\d|USD\s*\d/.test(c), false, `"${c}" reads like an answer`);
  }
});

test("BOTH directions exist — one of them alone is not bidirectional", () => {
  const a = proposeAffiliateCandidate(draft());
  const b = routeProgrammeToContent({
    programmeId: "p", vendorName: "X", inTopicScope: true, hasAngle: true, supportingSignalIds: ["s"],
  });
  assert.equal(a.ok, true, "Direction A must produce an affiliate candidate");
  assert.equal(b.ok, true, "Direction B must produce a content opportunity");
  assert.ok(OPPORTUNITY_ORIGIN_TYPES.includes("AFFILIATE_OFFER"));
});

// ─── Fabrication guard ────────────────────────────────────────────

test("every commercial fact defaults to UNKNOWN", () => {
  const f = unknownFact<number>();
  assert.equal(f.state, "UNKNOWN");
  assert.equal(f.value, null);
  assert.equal(checkFact("payout", f).ok, true);
});

test("UNKNOWN is not NO — the two are different values", () => {
  assert.deepEqual([...TRISTATE], ["YES", "NO", "UNKNOWN"]);
  // "We have not checked whether PPC is allowed" and "PPC is forbidden" lead to
  // different decisions; collapsing them invents a prohibition or a permission.
  assert.notEqual("UNKNOWN", "NO");
});

test("a value carried alongside UNKNOWN is refused — that is how a guess survives", () => {
  const v = checkFact("payout", { value: 30, state: "UNKNOWN" });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "UNKNOWN_WITH_VALUE");
});

test("a known fact must name where it was seen and when", () => {
  const noSource = checkFact("cookie_duration", { value: 60, state: "YES" });
  assert.equal(noSource.ok === false && noSource.reason, "CLAIMED_WITHOUT_SOURCE");

  const bad = checkFact("cookie_duration", {
    value: 60, state: "YES", observedUrl: "https://x.test", observedAt: new Date("nope"),
  });
  assert.equal(bad.ok === false && bad.reason, "CLAIMED_WITHOUT_SOURCE");

  assert.equal(checkFact("cookie_duration", { value: 60, state: "YES", ...SEEN }).ok, true);
});

test("every fact the owner named is in the guarded set", () => {
  for (const f of [
    "programme_exists", "network", "payout", "epc", "geo",
    "cookie_duration", "ppc_allowed", "brand_bidding_allowed",
    "deep_link_support", "product_availability",
  ]) {
    assert.ok((VERIFIABLE_FACTS as readonly string[]).includes(f), `${f} must be guarded`);
  }
});

test("an invalid fact anywhere sinks the whole candidate", () => {
  const v = proposeAffiliateCandidate(
    draft({ facts: { payout: { value: 30, state: "UNKNOWN" } } }),
  );
  assert.equal(v.ok === false && v.reason, "FACT_INVALID");
  assert.ok(v.ok === false && (v.detail ?? "").startsWith("payout"));
});

test("the database refuses a claimed programme with no source too", () => {
  // Asserted against the GENERATED SQL, not the Drizzle template: the template
  // interpolates `${t.programmeObservedUrl}`, so matching the column name in
  // the .ts file would only prove the template was written, never that the
  // constraint reached a migration.
  const sql = readFileSync(
    join(process.cwd(), "src/lib/db/migrations/0025_p2r07_discovery_candidates.sql"),
    "utf8",
  );
  assert.ok(
    /existence_needs_source[\s\S]{0,400}programme_observed_url[\s\S]{0,160}IS NOT NULL/.test(sql),
    "the fabrication guard must reach the migration, not only the schema file",
  );
  assert.ok(
    /rejection_needs_reason/.test(sql),
    "a rejection with no reason must be refused by the database too",
  );
});

// ─── AC-06 — P1-R04 visibility travels with every fact ────────────

test("AC-06: AUTHENTICATED and FIRST_PARTY default to CONFIDENTIAL", () => {
  assert.equal(defaultVisibilityFor("PUBLIC_WEB"), "PUBLIC");
  assert.equal(defaultVisibilityFor("AUTHENTICATED"), "CONFIDENTIAL");
  assert.equal(defaultVisibilityFor("FIRST_PARTY"), "CONFIDENTIAL");
});

test("AC-06: an AGENT may not promote a dashboard-only figure to public", () => {
  // The exact failure P1-R04 exists to prevent: a commission rate read off a
  // logged-in dashboard published because nobody classified it.
  const dashboardFigure = {
    value: 40, state: "YES" as const, ...SEEN,
    sourceAccess: "AUTHENTICATED" as const, visibility: "PUBLIC" as const,
  };
  const asAgent = resolveVisibility(dashboardFigure, "AGENT");
  assert.equal(asAgent.ok, false);
  assert.equal(asAgent.ok === false && asAgent.reason, "AGENT_MAY_NOT_PROMOTE");

  // A named human may. That is what visibility_override_by records.
  assert.equal(resolveVisibility(dashboardFigure, "OWNER").ok, true);
});

test("AC-06: an agent MAY lower visibility — the asymmetry is the guarantee", () => {
  const publicFigure = {
    value: 30, state: "YES" as const, ...SEEN,
    sourceAccess: "PUBLIC_WEB" as const, visibility: "INTERNAL" as const,
  };
  const v = resolveVisibility(publicFigure, "AGENT");
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.visibility, "INTERNAL");
});

test("AC-06: a known fact with no source_access is refused, not defaulted", () => {
  const v = resolveVisibility({ value: 1, state: "YES", ...SEEN }, "AGENT");
  assert.equal(v.ok === false && v.reason, "NO_SOURCE_ACCESS");
});

test("AC-06: an UNKNOWN fact is CONFIDENTIAL — forgetting leaves it closed", () => {
  const v = resolveVisibility(unknownFact<number>(), "AGENT");
  assert.equal(v.ok === true && v.visibility, "CONFIDENTIAL");
});

test("AC-06: a candidate carrying an unpromotable fact is refused entirely", () => {
  const v = proposeAffiliateCandidate(
    draft({
      facts: {
        payout: {
          value: 40, state: "YES", ...SEEN,
          sourceAccess: "FIRST_PARTY", visibility: "PUBLIC",
        },
      },
    }),
  );
  assert.equal(v.ok === false && v.reason, "FACT_INVALID");
  assert.ok(v.ok === false && (v.detail ?? "").includes("AGENT_MAY_NOT_PROMOTE"));
});

test("AC-06: the rules come from P1-R04, not a second copy", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/bidirectional-discovery-policy.ts"), "utf8");
  assert.ok(
    /from "\.\.\/claims\/visibility"/.test(src),
    "the visibility types must come from the P1-R04 module",
  );
});

// ─── AC-03 — it never alters the article it was researching ───────

test("AC-03: the layer cannot reach any article write path", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/bidirectional-discovery-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const forbidden of [
    "updateArticle", "wp_update_post", "post_content", "postContent",
    "articleSync", "wordpressArticleSync", "guardArticleUpdate",
  ]) {
    assert.equal(src.includes(forbidden), false, `the layer mentions ${forbidden}`);
  }
  // And the schema it writes to has no article reference at all.
  const schema = readFileSync(join(process.cwd(), "src/lib/db/schema/discovery-candidate.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(/wpPostId|wp_post_id|article/i.test(schema), false);
});

// ─── Idempotency and provenance ───────────────────────────────────

test("re-running research on the same vendor yields the same candidate key", () => {
  assert.equal(candidateKeyFor("Systeme.io"), candidateKeyFor("  systeme.io "));
});

test("different vendors do not collide", () => {
  assert.notEqual(candidateKeyFor("systeme-io"), candidateKeyFor("convertkit"));
});

test("the candidate key is UNIQUE in the database, not merely indexed", () => {
  // An index that permits duplicates would let a second research run create a
  // second candidate for the same vendor -- exactly what the key prevents.
  const src = readFileSync(join(process.cwd(), "src/lib/db/schema/discovery-candidate.ts"), "utf8");
  assert.ok(/uniqueIndex\(\s*"affiliate_project_candidates_key_uq"/.test(src));
});

test("many signals may support ONE candidate without losing provenance", () => {
  // A table, not a column: three observations of the same vendor -- a footer
  // link, a network listing, a pricing page -- all support one candidate, and a
  // signal_id column would keep the first and lose the rest.
  const cols = columns(candidateEvidence);
  assert.ok(cols.candidateId && cols.signalId);
  assert.ok(cols.contribution, "each link says what that signal contributed");

  const candidateCols = Object.keys(columns(affiliateProjectCandidates)).map((n) => n.toLowerCase());
  assert.equal(candidateCols.includes("signalid"), false, "a signal_id column would cap it at one");
});

test("a candidate accepts several supporting signals", () => {
  const v = proposeAffiliateCandidate(draft({ supportingSignalIds: ["a", "b", "c"] }));
  assert.equal(v.ok, true);
});

// ─── Boundaries: what this layer may not do ───────────────────────

test("the action vocabulary cannot express creating a project or publishing", () => {
  for (const banned of [
    "CREATE_PROJECT", "CREATE_AFFILIATE_PROJECT", "APPLY_TO_NETWORK",
    "CREATE_ADS_CAMPAIGN", "PUBLISH", "EDIT_ARTICLE", "APPROVE",
  ]) {
    assert.equal(
      (DISCOVERY_ACTIONS as readonly string[]).includes(banned),
      false,
      `${banned} must not be expressible`,
    );
  }
});

test("the policy reaches no project, network, ads or publisher", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/bidirectional-discovery-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  assert.ok(specs.length > 0, "parsed no imports -- the guard would be vacuous");
  assert.deepEqual(
    specs.filter((s) => /\/aff\b|wordpress|publish|ads|google/i.test(s)),
    [],
  );
  // And it computes no score: P2-R03 owns scoring, and R07 must not bypass it.
  assert.equal(/scoreOpportunity|overallScore|fitScore|confidence/.test(src), false);
});

test("a candidate is not a project: the schema has no link to one", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/db/schema/discovery-candidate.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(
    /affiliateProjects/.test(src),
    false,
    "promotion is an owner action; a link before the decision invites code to follow it",
  );
});

test("ACCEPTED still is not a project — it is a triage outcome", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/db/schema/discovery-candidate.ts"), "utf8");
  assert.ok(/candidateStatusEnum[\s\S]{0,200}"ACCEPTED"/.test(src));
  assert.ok(/triageNeedsActor/.test(src), "triage is a human act and must name the human");
});

// ─── Explainability ───────────────────────────────────────────────

test("producing nothing is recorded with a reason, never silently", () => {
  const failed = proposeAffiliateCandidate(draft({ supportingSignalIds: [] }));
  const outcome = outcomeFor("A_RESEARCH_TO_AFFILIATE", failed, []);
  assert.equal(outcome.produced, "NO_ACTION");
  assert.equal(outcome.reason, "NO_SUPPORTING_EVIDENCE");
  assert.ok(isExplainable(outcome));
});

test("a successful outcome keeps its supporting signals", () => {
  const ok = proposeAffiliateCandidate(draft());
  const outcome = outcomeFor("A_RESEARCH_TO_AFFILIATE", ok, ["sig-1", "sig-2"]);
  assert.equal(outcome.produced, "CANDIDATE");
  assert.deepEqual([...outcome.supportingSignalIds], ["sig-1", "sig-2"]);
});

test("both directions are labelled, so a no-action says WHICH way it failed", () => {
  const a = outcomeFor("A_RESEARCH_TO_AFFILIATE", { ok: false, reason: "x" }, []);
  const b = outcomeFor("B_AFFILIATE_TO_CONTENT", { ok: false, reason: "y" }, []);
  assert.notEqual(a.direction, b.direction);
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: the happy paths pass, so every refusal above means something", () => {
  assert.equal(proposeAffiliateCandidate(draft()).ok, true);
  assert.equal(
    routeProgrammeToContent({
      programmeId: "p", vendorName: "X", inTopicScope: true, hasAngle: true, supportingSignalIds: ["s"],
    }).ok,
    true,
  );
  assert.equal(checkFact("geo", unknownFact<string[]>()).ok, true);
});

test("CONTROL: the candidate checker distinguishes its four refusals", () => {
  const reasons = new Set(
    [
      proposeAffiliateCandidate(draft({ vendorKey: "" })),
      proposeAffiliateCandidate(draft({ supportingSignalIds: [] })),
      proposeAffiliateCandidate(draft({ programmeExists: unknownFact<boolean>() })),
      proposeAffiliateCandidate(draft({ facts: { epc: { value: 1, state: "UNKNOWN" } } })),
    ].map((v) => (v.ok ? "OK" : v.reason)),
  );
  assert.deepEqual(
    [...reasons].sort(),
    ["FACT_INVALID", "NO_SUPPORTING_EVIDENCE", "NO_VENDOR", "PROGRAMME_NOT_OBSERVED"],
  );
});
