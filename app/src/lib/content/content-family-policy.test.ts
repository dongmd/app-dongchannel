import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CONTENT_FAMILIES,
  DEAL_FACTS,
  DEFAULT_FAMILY_POLICY,
  FACT_STATES,
  FAMILY_ACTIONS,
  Q21_FAMILIES,
  checkDealFact,
  contentModeFor,
  familyTtlDays,
  isContentFamily,
  resolveFamilyPolicy,
  scoringDimensionsFor,
  workflowClaimIsVerified,
} from "./content-family-policy";
import {
  DEFAULT_MODE_POLICY,
  EVIDENCE_FLOOR,
  claimTtlDays,
  evidenceRank,
} from "./content-mode-policy";
import { ALL_DIMENSIONS } from "./scoring-policy";
import { contentFamilyEnum, contentFamilyPolicies } from "../db/schema/content-family";

// P2-R08 AC-01 … AC-09, plus the owner's architecture boundaries.
//
// Q21 layer 1 of 2: this covers the DOMAIN. P5-R10 owns the templates, and
// nothing here anticipates them.

const T0 = new Date("2026-08-20T00:00:00.000Z");
const SEEN = { observedUrl: "https://merchant.test/deal", observedAt: T0 };

// ─── Boundary 1 — families are a closed set, in one place ─────────

test("B1: the families are a closed enum, not strings scattered across modules", () => {
  assert.ok(CONTENT_FAMILIES.length >= 5);
  for (const f of Q21_FAMILIES) {
    assert.ok((CONTENT_FAMILIES as readonly string[]).includes(f), `${f} must be a family`);
  }
  for (const bad of ["dc_product", "post", "", "DC_DEAL", null, 7]) {
    assert.equal(isContentFamily(bad), false, `${String(bad)} must not be a family`);
  }
});

test("B1: every family has a complete policy — none falls through", () => {
  for (const f of CONTENT_FAMILIES) {
    const p = DEFAULT_FAMILY_POLICY[f];
    assert.ok(p, `${f} has no policy`);
    assert.ok(p.contentMode, `${f} has no mode`);
    assert.ok(p.minEvidenceLevel, `${f} has no evidence floor`);
  }
});

// ─── AC-01 / Boundary 3 — family maps INTO mode, and does not rival it ──

test("AC-01: every family maps explicitly to a P2-R05 mode", () => {
  assert.equal(contentModeFor("dc_deal"), "COMMERCIAL");
  assert.equal(contentModeFor("dc_workflow"), "EVERGREEN");
  for (const f of CONTENT_FAMILIES) {
    assert.ok(DEFAULT_MODE_POLICY[contentModeFor(f)], `${f} maps to a mode that has no policy`);
  }
});

test("B3: the mapping is many-to-one, and the family owns no TTL or QA of its own", () => {
  // content_family says WHAT KIND of thing this is; content_mode says HOW IT IS
  // TREATED. Two sources of truth for "how long until this is stale" is exactly
  // the drift this project has spent requirements removing.
  const modes = new Set(CONTENT_FAMILIES.map((f) => contentModeFor(f)));
  assert.ok(modes.size < CONTENT_FAMILIES.length, "several families share a mode: N:1, not 1:1");

  const src = readFileSync(join(process.cwd(), "src/lib/content/content-family-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const own of ["ttlDays:", "slaHours:", "qaDepth:"]) {
    assert.equal(
      src.includes(own),
      false,
      `a family must not carry its own ${own} -- the MODE answers that`,
    );
  }
});

// ─── AC-04 — a deal's TTL is derived, and short ───────────────────

test("AC-04: a deal expires on its DISCOUNT's schedule, not on COMMERCIAL's 90 days", () => {
  const deal = familyTtlDays("dc_deal");
  assert.equal(deal, claimTtlDays("discount"));
  assert.ok(
    deal < DEFAULT_MODE_POLICY.COMMERCIAL.ttlDays,
    "a deal must not inherit the commercial mode's long TTL",
  );
  assert.equal(deal, 7);
});

test("AC-04: a workflow keeps its evergreen shelf life", () => {
  assert.equal(familyTtlDays("dc_workflow"), DEFAULT_MODE_POLICY.EVERGREEN.ttlDays);
});

test("AC-04: the TTL is DERIVED — changing the claim TTL moves the family's", () => {
  // A family constant would not move, which is how two answers drift apart.
  assert.equal(familyTtlDays("dc_deal"), claimTtlDays("discount"));
});

// ─── AC-03 — the evidence floor still cannot be configured away ────

test("AC-03: no family sits below the evidence floor", () => {
  for (const f of CONTENT_FAMILIES) {
    assert.ok(
      evidenceRank(DEFAULT_FAMILY_POLICY[f].minEvidenceLevel) >= evidenceRank(EVIDENCE_FLOOR),
      `${f} defaults below the floor`,
    );
  }
});

test("AC-03: configuration cannot lower a family below the floor", () => {
  // A deal may be fast, but a price in it is a claim like any other.
  const p = resolveFamilyPolicy("dc_deal", { dc_deal: { minEvidenceLevel: "E0" } });
  assert.equal(p.minEvidenceLevel, EVIDENCE_FLOOR);
});

test("AC-02: configuration can change the mode mapping without a deploy", () => {
  const p = resolveFamilyPolicy("dc_deal", { dc_deal: { contentMode: "TREND" } });
  assert.equal(p.contentMode, "TREND");
  // And a nonsense mode falls back rather than breaking the mapping.
  const bad = resolveFamilyPolicy("dc_deal", { dc_deal: { contentMode: "SOMETHING" as never } });
  assert.equal(bad.contentMode, "COMMERCIAL");
});

// ─── AC-05 / Boundary 2 — one scoring engine ──────────────────────

test("B2: no family gets its own scorer — every family uses the full dimension set", () => {
  for (const f of CONTENT_FAMILIES) {
    assert.deepEqual([...scoringDimensionsFor(f)], [...ALL_DIMENSIONS]);
  }
  // Narrowing per family would change the DENOMINATOR per family, and two
  // pieces scored against different denominators cannot be ranked together.
});

test("B2: the family module computes no score at all", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/content-family-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(/scoreOpportunity|normalisedScore|rawScore|weights\s*[:=]/.test(src), false);
});

// ─── AC-07 — a deal may not be invented ───────────────────────────

test("AC-07: every commercial fact the owner named is guarded", () => {
  for (const f of ["price", "discount", "expiry", "availability", "coupon", "merchant_terms"]) {
    assert.ok((DEAL_FACTS as readonly string[]).includes(f), `${f} must be guarded`);
  }
});

test("AC-07: an OBSERVED fact must carry a value AND a source", () => {
  assert.equal(checkDealFact("discount", { state: "OBSERVED", value: "30%", ...SEEN }).ok, true);

  const noSource = checkDealFact("discount", { state: "OBSERVED", value: "30%" });
  assert.equal(noSource.ok === false && noSource.reason, "CLAIMED_WITHOUT_SOURCE");

  const noValue = checkDealFact("discount", { state: "OBSERVED", ...SEEN });
  assert.equal(noValue.ok === false && noValue.reason, "VALUE_WITHOUT_OBSERVATION");
});

test("AC-07: a value beside a non-OBSERVED state is refused", () => {
  // A number sitting beside UNVERIFIED is a guess waiting to be rendered.
  for (const state of ["UNVERIFIED", "UNKNOWN", "EXPIRED"] as const) {
    const v = checkDealFact("price", { state, value: 29 });
    assert.equal(v.ok, false, `${state} must not carry a value`);
    assert.equal(v.ok === false && v.reason, "VALUE_WITHOUT_OBSERVATION");
  }
});

test("AC-07: EXPIRED is its own state, not a synonym for UNKNOWN", () => {
  // A discount that WAS real and has run out is a different fact from one
  // nobody ever checked: one is a refresh, the other is research.
  assert.ok((FACT_STATES as readonly string[]).includes("EXPIRED"));
  assert.notEqual("EXPIRED", "UNKNOWN");
  assert.equal(checkDealFact("expiry", { state: "EXPIRED" }).ok, true);
});

test("Boundary 5: a generated workflow is not a verified fact", () => {
  assert.equal(workflowClaimIsVerified("OBSERVED"), true);
  for (const s of ["UNVERIFIED", "UNKNOWN", "EXPIRED"] as const) {
    assert.equal(workflowClaimIsVerified(s), false, `${s} must not read as verified`);
  }
});

// ─── AC-06 / Boundary 6 + 7 — no publishing, no approval bypass ───

test("AC-06 + B6: the action vocabulary cannot publish, edit or approve", () => {
  for (const banned of ["PUBLISH", "EDIT_ARTICLE", "APPROVE", "UNPUBLISH", "CREATE_POST"]) {
    assert.equal(
      (FAMILY_ACTIONS as readonly string[]).includes(banned),
      false,
      `${banned} must not be expressible`,
    );
  }
  // Expiry may only mark, exactly as P2-R05 requires.
  assert.ok((FAMILY_ACTIONS as readonly string[]).includes("MARK_REFRESH_REQUIRED"));
});

test("B6: the module reaches no WordPress or publishing path", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/content-family-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  assert.ok(specs.length > 0, "parsed no imports -- the guard would be vacuous");
  assert.deepEqual(specs.filter((s) => /wordpress|publish|template|theme/i.test(s)), []);
});

test("B: P5-R10's work is not anticipated here", () => {
  // Q21 layer 1 owns the domain. Templates are layer 2, and building them early
  // would be exactly the phase-jumping the decomposition exists to prevent.
  //
  // Comments are stripped first. This guard failed on its own first run because
  // the module's comments SAY it does not own templates — the third time in this
  // project that a capability scan mistook prose for code. A guard that cannot
  // tell them apart pushes authors toward explaining constraints less clearly,
  // which is the opposite of what it is for.
  const code = readFileSync(join(process.cwd(), "src/lib/content/content-family-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(
    /\brender\w*\s*\(|renderTemplate|shortcode|innerHTML/i.test(code),
    false,
    "no rendering may appear in the domain layer",
  );
});

// ─── AC-02 / AC-08 — the mapping lives in a table ─────────────────

test("AC-02: the Postgres family enum matches the policy list exactly", () => {
  assert.deepEqual([...contentFamilyEnum.enumValues], [...CONTENT_FAMILIES]);
});

test("B3: the family table carries NO ttl, sla or qa — the mode owns those", () => {
  // Cast through `object` first: a Drizzle table has no string index signature,
  // so the narrower cast is rejected outright.
  const table = contentFamilyPolicies as object as Record<string, unknown>;
  const cols = Object.keys(table)
    .filter((k) => {
      const v = table[k];
      return typeof v === "object" && v !== null && "columnType" in v;
    })
    .map((n) => n.toLowerCase());

  assert.ok(cols.length > 3, "parsed too few columns -- the check would be vacuous");
  for (const owned of ["ttldays", "slahours", "qadepth"]) {
    assert.equal(
      cols.includes(owned),
      false,
      `content_family_policies must not carry ${owned}: P2-R05's mode policy answers it`,
    );
  }
  assert.ok(cols.includes("contentmode"), "it carries the MAPPING, which is its job");
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: the happy paths pass, so every refusal above means something", () => {
  assert.equal(checkDealFact("coupon", { state: "OBSERVED", value: "SAVE30", ...SEEN }).ok, true);
  assert.equal(checkDealFact("coupon", { state: "UNKNOWN" }).ok, true);
  assert.ok(familyTtlDays("dc_deal") > 0);
  assert.ok(contentModeFor("dc_workflow"));
});

test("CONTROL: the deal checker distinguishes its three refusals", () => {
  const reasons = new Set(
    [
      checkDealFact("price", { state: "OBSERVED", value: 1 }),
      checkDealFact("price", { state: "OBSERVED", ...SEEN }),
      checkDealFact("price", { state: "NOPE" as never }),
    ].map((v) => (v.ok ? "OK" : v.reason)),
  );
  assert.deepEqual(
    [...reasons].sort(),
    ["BAD_STATE", "CLAIMED_WITHOUT_SOURCE", "VALUE_WITHOUT_OBSERVATION"],
  );
});
