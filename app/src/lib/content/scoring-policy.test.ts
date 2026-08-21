import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_DIMENSIONS,
  COMMERCIAL_DIMENSIONS,
  MAX_COMMERCIAL_SHARE,
  MIN_RAW,
  POSITIVE_BUDGET,
  POSITIVE_DIMENSIONS,
  PENALTY_DIMENSIONS,
  SCORING_CONFIG_V0,
  UNKNOWN,
  inputsFingerprint,
  isDisqualified,
  normalise,
  scoreOpportunity,
  validateConfig,
  reconcilesWith,
  RECONCILIATION_TOLERANCE,
  weightGroups,
  type ScoreInputs,
  type ScoringConfig,
} from "./scoring-policy";

// P2-R03 AC-01 … AC-16, plus the six conditions of record from owner Q29.
//
// The property under test is not "a score comes out". It is that the score
// cannot be gamed into the two failure modes this project actually has: a queue
// that quietly leans commercial, and thin evidence that scores well because
// nobody filled the fields in.

/**
 * Build a variant config by MOVING weight between dimensions, so the positive
 * budget stays at 100 by construction.
 *
 * The first version of these fixtures did the arithmetic inline and got it
 * wrong twice: one variant failed the budget rule instead of the grouping rule
 * it was written to test, and the other tripped the commercial cap and was
 * rejected before it could re-order anything. A fixture that fails for the
 * wrong reason tests nothing, so the arithmetic is done once, here, and
 * checked.
 */
function reweight(
  version: string,
  moves: Readonly<Record<string, number>>,
): ScoringConfig {
  const weights = { ...SCORING_CONFIG_V0.weights } as Record<string, number>;
  for (const [dim, delta] of Object.entries(moves)) weights[dim] = weights[dim]! + delta;

  const positive = POSITIVE_DIMENSIONS.reduce((s, d) => s + weights[d]!, 0);
  assert.equal(positive, POSITIVE_BUDGET, `reweight(${version}) broke the budget: ${positive}`);

  return { version, weights: weights as ScoringConfig["weights"] };
}

function full(over: Partial<Record<string, number>> = {}): ScoreInputs {
  const values: Record<string, number> = {};
  for (const d of POSITIVE_DIMENSIONS) values[d] = 0.5;
  for (const d of PENALTY_DIMENSIONS) values[d] = 0;
  return { values: { ...values, ...over } as ScoreInputs["values"] };
}

// ─── AC-01 / AC-13 — configuration, and the arithmetic is stated ──

test("AC-13: the positive weights sum to exactly the budget", () => {
  const positive = POSITIVE_DIMENSIONS.reduce((s, d) => s + SCORING_CONFIG_V0.weights[d], 0);
  assert.equal(positive, POSITIVE_BUDGET);
  assert.equal(positive, 100);
});

test("AC-13: penalties are negative and applied after the budget", () => {
  for (const d of PENALTY_DIMENSIONS) {
    assert.ok(SCORING_CONFIG_V0.weights[d] < 0, `${d} must be a penalty`);
  }
  assert.equal(SCORING_CONFIG_V0.weights.risk, -15);
  assert.equal(SCORING_CONFIG_V0.weights.maintenance_cost, -5);
  // Which is where MIN_RAW comes from, and it is not a magic number.
  assert.equal(MIN_RAW, SCORING_CONFIG_V0.weights.risk + SCORING_CONFIG_V0.weights.maintenance_cost);
});

test("AC-13: affiliate_potential carries 6 of the 100 — the retired notation, stated once", () => {
  assert.equal(SCORING_CONFIG_V0.weights.affiliate_potential, 6);
  assert.equal(POSITIVE_BUDGET, 100);
});

test("AC-01: a configuration that breaks the arithmetic is refused", () => {
  const bad: ScoringConfig = {
    version: "x",
    weights: { ...SCORING_CONFIG_V0.weights, audience_usefulness: 30 },
  };
  const v = validateConfig(bad);
  assert.equal(v.ok, false);
  assert.ok(v.ok === false && v.reason.startsWith("POSITIVE_BUDGET_MISMATCH"));
});

test("AC-01: a penalty with a positive weight is refused", () => {
  const v = validateConfig({ version: "x", weights: { ...SCORING_CONFIG_V0.weights, risk: 15 } });
  assert.equal(v.ok === false && v.reason, "PENALTY_WEIGHT_POSITIVE:risk");
});

test("AC-01: an unversioned configuration is refused", () => {
  assert.equal(validateConfig({ ...SCORING_CONFIG_V0, version: "  " }).ok, false);
});

// ─── The 70/30 grouping, mechanical ───────────────────────────────

test("Q29.3: the commercial group is capped at 30% of the positive budget", () => {
  const g = weightGroups(SCORING_CONFIG_V0);
  assert.equal(g.commercial, 14); // business_relevance 8 + affiliate_potential 6
  assert.equal(g.editorial, 86);
  assert.ok(g.commercialShare <= MAX_COMMERCIAL_SHARE);
});

test("Q29.3: a weight set that leans commercial is REFUSED, not merely noted", () => {
  // +24 onto affiliate_potential, taken back out of editorial dimensions so the
  // budget is untouched and ONLY the grouping rule can fire.
  const tilted = reweight("tilted", {
    affiliate_potential: +24,
    audience_usefulness: -16,
    trend_freshness: -4,
    uniqueness: -4,
  });
  assert.equal(weightGroups(tilted).commercial, 38);

  const v = validateConfig(tilted);
  assert.equal(v.ok, false);
  assert.ok(v.ok === false && v.reason.startsWith("COMMERCIAL_SHARE_EXCEEDED"));
});

test("Q29.3: the guardrail is a CEILING — zero commercial weight is legal", () => {
  // Owner clarification 2026-08-20: 70/30 is not an exact split. There is no
  // floor, and weights must not be inflated toward 30 merely to reach it.
  const none = reweight("no-commercial", {
    affiliate_potential: -6,
    business_relevance: -8,
    audience_usefulness: +14,
  });
  assert.equal(weightGroups(none).commercial, 0);
  assert.equal(validateConfig(none).ok, true, "a config with no commercial weight must be legal");

  // And exactly at the ceiling is still legal -- the rule is "must not exceed".
  const atCeiling = reweight("at-ceiling", {
    affiliate_potential: +16,
    audience_usefulness: -16,
  });
  assert.equal(weightGroups(atCeiling).commercial, 30);
  assert.equal(validateConfig(atCeiling).ok, true, "30 is the ceiling, not the first illegal value");
});

test("Q29.3: the commercial group is exactly the dimensions that need a product", () => {
  assert.deepEqual([...COMMERCIAL_DIMENSIONS].sort(), ["affiliate_potential", "business_relevance"]);
});

// ─── AC-02 — affiliate_potential contributes, never gates ─────────

test("AC-02: an evergreen opportunity with zero affiliate potential can rank FIRST", () => {
  const evergreen = scoreOpportunity({
    values: {
      audience_usefulness: 1,
      search_opportunity: 1,
      topical_relevance: 1,
      evidence_availability: 1,
      internal_link_value: 1,
      trend_freshness: 0.5,
      business_relevance: 0,
      affiliate_potential: 0, // nothing to sell
      uniqueness: 1,
      maintenance_cost: 0,
      risk: 0,
    },
  });
  const commercial = scoreOpportunity({
    values: {
      audience_usefulness: 0.3,
      search_opportunity: 0.3,
      topical_relevance: 0.3,
      evidence_availability: 0.3,
      internal_link_value: 0.2,
      trend_freshness: 0.2,
      business_relevance: 1,
      affiliate_potential: 1, // maximum commercial pull
      uniqueness: 0.2,
      maintenance_cost: 0,
      risk: 0,
    },
  });

  assert.ok(evergreen.ok && commercial.ok);
  assert.ok(
    evergreen.ok && commercial.ok && evergreen.breakdown.rawScore > commercial.breakdown.rawScore,
    "a strong evergreen piece must be able to beat a marginal commercial one",
  );
});

test("AC-02: nothing in this module can disqualify anything", () => {
  // The strongest form of "affiliate_potential is not a gate": there is no gate.
  assert.equal(isDisqualified(), false);
  const zero = scoreOpportunity(full({ affiliate_potential: 0 }));
  assert.equal(zero.ok, true);
});

// ─── AC-03 / AC-09 — deterministic and idempotent ─────────────────

test("AC-03: identical inputs and version produce an identical score", () => {
  const a = scoreOpportunity(full());
  const b = scoreOpportunity(full());
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.ok && a.breakdown, b.ok && b.breakdown);
});

test("AC-03: the config version travels with the score", () => {
  const r = scoreOpportunity(full());
  assert.equal(r.ok && r.breakdown.configVersion, SCORING_CONFIG_V0.version);
});

test("AC-09: the input fingerprint is stable and discriminating", () => {
  const a = inputsFingerprint(full(), SCORING_CONFIG_V0);
  const b = inputsFingerprint(full(), SCORING_CONFIG_V0);
  assert.equal(a, b, "same inputs must fingerprint identically -- that is what makes recompute idempotent");

  const c = inputsFingerprint(full({ uniqueness: 0.9 }), SCORING_CONFIG_V0);
  assert.notEqual(a, c, "different inputs must fingerprint differently");

  const d = inputsFingerprint(full(), { ...SCORING_CONFIG_V0, version: "other" });
  assert.notEqual(a, d, "a version change must invalidate the fingerprint");
});

test("AC-01: changing a weight re-orders the queue", () => {
  const opp = full({ affiliate_potential: 1, audience_usefulness: 0 });

  // +14 onto affiliate_potential keeps the commercial group at 22 -- under the
  // 30 cap, so this variant is VALID and the re-ordering is what gets tested.
  const boosted = reweight("boosted", { affiliate_potential: +14, audience_usefulness: -14 });
  assert.ok(validateConfig(boosted).ok, "the fixture must be a legal config");

  const base = scoreOpportunity(opp);
  const after = scoreOpportunity(opp, boosted);
  assert.ok(base.ok && after.ok);
  assert.ok(
    base.ok && after.ok && after.breakdown.rawScore > base.breakdown.rawScore,
    "weighting affiliate potential higher must lift an affiliate-heavy opportunity",
  );
});

// ─── AC-06 / AC-16 — unknown is not zero, and never favourable ────

test("AC-16: thin evidence scores LOWER, never artificially higher", () => {
  const researched = scoreOpportunity(full({ audience_usefulness: 0.8 }));

  // The same opportunity with most dimensions simply not assessed.
  const thin = scoreOpportunity({
    values: { audience_usefulness: 0.8, maintenance_cost: 0, risk: 0 },
  });

  assert.ok(researched.ok && thin.ok);
  assert.ok(
    researched.ok && thin.ok && thin.breakdown.rawScore < researched.breakdown.rawScore,
    "an unassessed opportunity must not out-rank an assessed one",
  );
});

test("AC-06: an unassessed dimension keeps its weight in the denominator", () => {
  const thin = scoreOpportunity({ values: { audience_usefulness: 1, maintenance_cost: 0, risk: 0 } });
  assert.ok(thin.ok);
  if (!thin.ok) return;

  // Every dimension is still represented, marked unknown rather than dropped.
  assert.equal(thin.breakdown.totalDimensions, ALL_DIMENSIONS.length);
  assert.ok(thin.breakdown.knownDimensions < ALL_DIMENSIONS.length);

  const unknowns = thin.breakdown.contributions.filter((c) => !c.known);
  assert.ok(unknowns.length > 0);
  for (const u of unknowns) {
    assert.equal(u.contribution, 0, "unknown contributes nothing");
    assert.equal(u.input, UNKNOWN, "and stays visibly unknown, not silently zero");
  }
});

test("AC-06: UNKNOWN is distinguishable from an explicit zero", () => {
  const explicitZero = scoreOpportunity(full({ uniqueness: 0 }));
  const unassessed = scoreOpportunity({
    values: { ...full().values, uniqueness: undefined } as ScoreInputs["values"],
  });
  assert.ok(explicitZero.ok && unassessed.ok);

  const z = explicitZero.ok && explicitZero.breakdown.contributions.find((c) => c.dimension === "uniqueness");
  const u = unassessed.ok && unassessed.breakdown.contributions.find((c) => c.dimension === "uniqueness");
  assert.equal(z && z.known, true, "an explicit 0 is an assessment");
  assert.equal(u && u.known, false, "an absent value is not");
  // Same contribution, different meaning -- and the breakdown keeps them apart.
  assert.equal(z && z.contribution, u && u.contribution);
});

// ─── AC-15 — penalties are explainable ────────────────────────────

test("AC-15: a penalty that bites without a reason is refused", () => {
  const v = scoreOpportunity({ values: { ...full().values, risk: 1 } });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "PENALTY_REASON_REQUIRED:risk");
});

test("AC-15: the reason is carried into the breakdown, not just checked", () => {
  const v = scoreOpportunity({
    values: { ...full().values, risk: 1 },
    penaltyReasons: { risk: "vendor forbids comparison claims" },
  });
  assert.ok(v.ok);
  const risk = v.ok && v.breakdown.contributions.find((c) => c.dimension === "risk");
  assert.equal(risk && risk.reason, "vendor forbids comparison claims");
  assert.equal(risk && risk.contribution, -15);
});

test("AC-15: a zero penalty needs no reason — the rule targets deductions", () => {
  assert.equal(scoreOpportunity(full({ risk: 0 })).ok, true);
});

// ─── AC-13 — components reconcile, bounds are explicit ────────────

test("AC-13: the contributions add up to the raw score", () => {
  const v = scoreOpportunity({
    values: { ...full().values, risk: 0.5 },
    penaltyReasons: { risk: "unverified pricing" },
  });
  assert.ok(v.ok);
  if (!v.ok) return;

  const sum = v.breakdown.contributions.reduce((s, c) => s + c.contribution, 0);
  assert.ok(Math.abs(sum - v.breakdown.rawScore) < 0.005);
  assert.equal(v.breakdown.reconciles, true);
});

test("AC-13: the reconciliation guard actually fires on a mismatch", () => {
  // Added after a mutation check: replacing the inline comparison with
  // `true` passed the whole suite. The arithmetic was being verified; the
  // guard was not.
  assert.equal(reconcilesWith(42, 42), true);
  assert.equal(reconcilesWith(42, 41.9), false, "a real disagreement must be caught");
  assert.equal(reconcilesWith(42, 42 + RECONCILIATION_TOLERANCE * 2), false);
  // And float noise must NOT trip it, or every score would fail.
  assert.equal(reconcilesWith(0.1 + 0.2, 0.3), true);
});

test("AC-13: normalisation maps the stated range onto 0-100", () => {
  assert.equal(normalise(MIN_RAW), 0);
  assert.equal(normalise(100), 100);
  assert.ok(normalise(0) > 0, "raw 0 is not the bottom of the scale -- penalties go below it");
  // Monotonic: a better raw score never normalises lower.
  assert.ok(normalise(50) > normalise(20));
});

test("AC-13: an out-of-range input is refused rather than clamped silently", () => {
  assert.equal(scoreOpportunity(full({ uniqueness: 1.5 })).ok, false);
  assert.equal(scoreOpportunity(full({ uniqueness: -1 })).ok, false);
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: the V0 config is valid, so every refusal above means something", () => {
  assert.deepEqual(validateConfig(SCORING_CONFIG_V0), { ok: true });
  const v = scoreOpportunity(full());
  assert.equal(v.ok, true);
  assert.ok(v.ok && v.breakdown.rawScore > 0);
});

test("CONTROL: the scorer distinguishes its refusal reasons", () => {
  const reasons = new Set(
    [
      scoreOpportunity(full({ uniqueness: 5 })),
      scoreOpportunity({ values: { ...full().values, risk: 1 } }),
      scoreOpportunity(full(), { version: "", weights: SCORING_CONFIG_V0.weights }),
    ].map((v) => (v.ok ? "OK" : v.reason.split(":")[0])),
  );
  assert.deepEqual(
    [...reasons].sort(),
    ["CONFIG_INVALID", "INPUT_OUT_OF_RANGE", "PENALTY_REASON_REQUIRED"],
  );
});
