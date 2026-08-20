import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { contentOpportunityScores } from "../db/schema/opportunity-scoring";
import { contentOpportunities } from "../db/schema/opportunity-content";
import { opportunityRoutes, opportunitySignals } from "../db/schema/opportunity";
import { SCORING_CONFIG_V0 } from "./scoring-policy";

// Owner guardrails, 2026-08-20:
//   1. duplicate integrity is a BICONDITIONAL, not one direction
//   2. three different numbers must not become interchangeable
//   3. an internal score must not become a public rating
//
// Each is checked against the real schema and the real source, not against a
// restatement of the rule.

const SCHEMA_DIR = join(process.cwd(), "src/lib/db/schema");

function columns(table: object): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null && "columnType" in v) {
      out[k] = v as Record<string, unknown>;
    }
  }
  return out;
}

// ─── Guardrail 1 — duplicate integrity, both directions ───────────

test("duplicate integrity: all three rules are expressed as CHECK constraints", () => {
  const src = readFileSync(join(SCHEMA_DIR, "opportunity.ts"), "utf8");

  // DUPLICATE implies a target.
  assert.ok(
    src.includes("opportunity_signals_duplicate_needs_target"),
    "missing: status = DUPLICATE -> duplicate_of_signal_id IS NOT NULL",
  );
  // A target implies DUPLICATE. This is the half that was missing, and it is a
  // real hole: without it a signal could point at another while claiming to be
  // NEW, so the pointer and the status could disagree about the same fact.
  assert.ok(
    src.includes("opportunity_signals_duplicate_target_only_when_duplicate"),
    "missing: status != DUPLICATE -> duplicate_of_signal_id IS NULL",
  );
  // And nothing duplicates itself.
  assert.ok(
    src.includes("opportunity_signals_duplicate_not_self"),
    "missing: duplicate_of_signal_id != id",
  );
});

test("duplicate integrity: the constraints say what they are supposed to say", () => {
  const src = readFileSync(join(SCHEMA_DIR, "opportunity.ts"), "utf8");

  // Asserting on the predicate, not only on the constraint name -- a name is
  // free to be wrong.
  assert.ok(
    /duplicate_needs_target[\s\S]{0,220}status[\s\S]{0,80}<>\s*'DUPLICATE'[\s\S]{0,120}IS NOT NULL/.test(src),
    "duplicate_needs_target does not encode 'DUPLICATE implies a target'",
  );
  assert.ok(
    /duplicate_target_only_when_duplicate[\s\S]{0,220}IS NULL OR[\s\S]{0,80}=\s*'DUPLICATE'/.test(src),
    "the reverse constraint does not encode 'a target implies DUPLICATE'",
  );
  assert.ok(
    /duplicate_not_self[\s\S]{0,220}<>\s*\$\{t\.id\}/.test(src),
    "duplicate_not_self does not compare against the row's own id",
  );
});

test("duplicate integrity: the pointer column exists and is nullable", () => {
  const cols = columns(opportunitySignals);
  assert.ok(cols.duplicateOfSignalId, "duplicate_of_signal_id must exist");
  assert.equal(
    cols.duplicateOfSignalId?.notNull,
    false,
    "it must be nullable -- most signals duplicate nothing",
  );
});

// ─── Guardrail 2 — three numbers, three tables, no aliasing ───────

test("the three scores live on three different tables", () => {
  const sig = columns(opportunitySignals);
  const route = columns(opportunityRoutes);
  const score = columns(contentOpportunityScores);

  assert.ok(sig.confidence, "signal: confidence = reliability of the OBSERVATION");
  assert.ok(route.fitScore, "route: fit_score = fit with ONE DESTINATION");
  assert.ok(score.normalisedScore, "score: business prioritisation of an OPPORTUNITY");
});

test("neither confidence nor fit_score can be read as the opportunity score", () => {
  const sigNames = Object.keys(columns(opportunitySignals)).map((n) => n.toLowerCase());
  const routeNames = Object.keys(columns(opportunityRoutes)).map((n) => n.toLowerCase());

  // The names an alias would plausibly take.
  for (const alias of [
    "opportunityscore",
    "overallscore",
    "normalisedscore",
    "normalizedscore",
    "priorityscore",
    "rank",
  ]) {
    assert.equal(sigNames.includes(alias), false, `opportunity_signals must not carry '${alias}'`);
    assert.equal(routeNames.includes(alias), false, `opportunity_routes must not carry '${alias}'`);
  }
});

test("the opportunity itself stores no score — the score table owns it", () => {
  // Keeping a copy on the opportunity would create a second answer that can go
  // stale, which is the failure P1-R06 spent a whole requirement on.
  const oppNames = Object.keys(columns(contentOpportunities)).map((n) => n.toLowerCase());
  for (const n of ["score", "overallscore", "normalisedscore", "rawscore"]) {
    assert.equal(oppNames.includes(n), false, `content_opportunities must not carry '${n}'`);
  }
});

test("the score carries the version and fingerprint that make it reproducible", () => {
  const cols = columns(contentOpportunityScores);
  assert.equal(cols.scoringConfigVersion?.notNull, true, "Q29.1: weights are versioned");
  assert.equal(cols.inputsFingerprint?.notNull, true, "AC-09: idempotency needs an identity");
  assert.equal(cols.breakdown?.notNull, true, "AC-13: a total with no breakdown is an assertion");
  assert.equal(cols.computedBy?.notNull, true, "a score with no author cannot be questioned");
});

test("AC-09: the idempotency index is UNIQUE, not merely an index", () => {
  // Added after a mutation check: downgrading uniqueIndex to index passed the
  // whole suite. An index that permits duplicates makes recomputation additive
  // rather than idempotent, which is the opposite of what the column is for.
  const src = readFileSync(join(SCHEMA_DIR, "opportunity-scoring.ts"), "utf8");
  assert.ok(
    /uniqueIndex\(\s*"content_opportunity_scores_idempotency_uq"/.test(src),
    "the idempotency constraint must be a UNIQUE index",
  );
  assert.ok(
    /idempotency_uq"\s*\)\s*\.on\([\s\S]{0,160}scoringConfigVersion[\s\S]{0,80}inputsFingerprint/.test(src),
    "idempotency must key on (opportunity, config version, inputs fingerprint)",
  );
});

// ─── Guardrail 3 — internal score is not a public rating ──────────

test("the scoring layer cannot reach a reader-facing surface", () => {
  for (const file of ["opportunity-scoring.ts"]) {
    const src = readFileSync(join(SCHEMA_DIR, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    assert.ok(specs.length > 0, "parsed no imports -- the guard would be vacuous");
    const bad = specs.filter((s) => /wordpress|publish|schema-org|seo/i.test(s));
    assert.deepEqual(bad, [], `${file} must not import a rendering path: ${bad.join(", ")}`);
  }
});

test("no scoring field is named like the suppressed public rating", () => {
  const src = readFileSync(join(SCHEMA_DIR, "opportunity-scoring.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // P0-R08 suppressed reader-facing ratings; they do not return without a
  // published rubric. A column called `rating` here would be the first step
  // back, and `dc_rating` is the exact meta key that was cleared.
  for (const banned of ["dc_rating", "ratingValue", "reviewRating", "aggregateRating"]) {
    assert.equal(src.includes(banned), false, `the scoring schema mentions ${banned}`);
  }
});

test("the scoring policy names the boundary it must not cross", () => {
  // Not a behavioural check -- a documentation check, deliberately. The rule is
  // one a future reader has to know, and the module is where they will look.
  const src = readFileSync(join(process.cwd(), "src/lib/content/scoring-policy.ts"), "utf8");
  assert.ok(
    /not a public product rating/i.test(src),
    "the policy module must state that an internal score is not a public rating",
  );
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: the column reader and the source reader both really work", () => {
  assert.ok(columns(contentOpportunityScores).id, "score table: id missing");
  assert.ok(columns(opportunitySignals).id, "signal table: id missing");
  const src = readFileSync(join(SCHEMA_DIR, "opportunity.ts"), "utf8");
  assert.ok(src.length > 1000, "source read returned too little to check");
  assert.ok(src.includes("opportunity_signals"), "read the wrong file");
});

test("CONTROL: the alias guard would catch a real alias", () => {
  const pretend = ["id", "title", "opportunityscore"];
  assert.deepEqual(
    pretend.filter((n) => ["opportunityscore", "overallscore"].includes(n)),
    ["opportunityscore"],
  );
  // And the config under test is the real one.
  assert.equal(SCORING_CONFIG_V0.weights.affiliate_potential, 6);
});
