/**
 * P2-R03 — the opportunity score, and the arithmetic behind it.
 *
 * Imports nothing. Same rule as every other policy module here.
 *
 * ## Three different numbers, and they are not interchangeable
 *
 * The project now holds three things that could all be called "a score", and
 * conflating any two of them would undo P2's separation:
 *
 *   OpportunitySignal.confidence     how reliable is this OBSERVATION.
 *                                    Evidence quality, inherited from the
 *                                    source's trust tier.
 *
 *   opportunity_routes.fit_score     how well does this signal fit THIS
 *                                    ROUTING DESTINATION. A property of one
 *                                    decision about where to send something.
 *
 *   ContentOpportunity score         BUSINESS PRIORITISATION. Which of the
 *   (this file)                      things we could do should we do first.
 *
 * **Neither of the first two may ever be read as the opportunity score**, and
 * the opportunity score is computed here and nowhere else. A test asserts the
 * three live on three different tables and that no alias creeps in.
 *
 * ## And a fourth thing this is emphatically NOT
 *
 * **An internal opportunity score is not a public product rating.** P0-R08
 * suppressed reader-facing ratings, and the standing rule is that none returns
 * until a real published rubric exists. Nothing computed here may reach a
 * reader, a `dc_rating` field, or schema markup. That is AC-04, and it is
 * asserted structurally rather than promised.
 */

// ─── Dimensions ───────────────────────────────────────────────────

export const POSITIVE_DIMENSIONS = [
  "audience_usefulness",
  "search_opportunity",
  "topical_relevance",
  "evidence_availability",
  "internal_link_value",
  "trend_freshness",
  "business_relevance",
  "affiliate_potential",
  "uniqueness",
] as const;

export const PENALTY_DIMENSIONS = ["maintenance_cost", "risk"] as const;

export type PositiveDimension = (typeof POSITIVE_DIMENSIONS)[number];
export type PenaltyDimension = (typeof PENALTY_DIMENSIONS)[number];
export type Dimension = PositiveDimension | PenaltyDimension;

export const ALL_DIMENSIONS: readonly Dimension[] = [
  ...POSITIVE_DIMENSIONS,
  ...PENALTY_DIMENSIONS,
];

/**
 * The 70/30 grouping, made mechanical.
 *
 * The project's stated content mix is roughly 70% with no product attached.
 * A scorer whose weights lean commercial will produce a queue that leans
 * commercial however the mix is described elsewhere, so the discipline has to
 * live in the weights.
 *
 * `COMMERCIAL_DIMENSIONS` is the set whose value depends on there being
 * something to sell. `validateConfig` refuses a weight set where that group
 * exceeds `MAX_COMMERCIAL_SHARE` of the positive budget.
 */
export const COMMERCIAL_DIMENSIONS: ReadonlySet<PositiveDimension> = new Set([
  "business_relevance",
  "affiliate_potential",
]);

/** The commercial group may never exceed 30% of the positive weight budget. */
export const MAX_COMMERCIAL_SHARE = 0.3;

// ─── Configuration ────────────────────────────────────────────────

export interface ScoringConfig {
  readonly version: string;
  readonly weights: Readonly<Record<Dimension, number>>;
}

/**
 * V0 baseline — owner decision **Q29**, approved as a default and explicitly
 * **not** a frozen business rule.
 *
 * The positive weights sum to **exactly 100**; penalties are applied after, so
 * a raw score runs from −20 to 100 before normalisation. `affiliate_potential`
 * carries **6 of the 100** — enough to contribute, never enough to gate.
 * `risk` at −15 is the largest single term because publishing something wrong
 * costs more than missing something right.
 */
export const SCORING_CONFIG_V0: ScoringConfig = {
  version: "scoring-v0-2026-08-20",
  weights: {
    audience_usefulness: 20,
    search_opportunity: 15,
    topical_relevance: 15,
    evidence_availability: 12,
    internal_link_value: 10,
    trend_freshness: 10,
    business_relevance: 8,
    affiliate_potential: 6,
    uniqueness: 4,
    maintenance_cost: -5,
    risk: -15,
  },
};

export const POSITIVE_BUDGET = 100;
/** Raw scores run [MIN_RAW, MAX_RAW]; see `normalise`. */
export const MIN_RAW = -20;
export const MAX_RAW = 100;

export type ConfigVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * AC-13 + the 70/30 rule. A configuration that fails any of these produces a
 * queue that is wrong in a way nobody would notice from the output.
 */
export function validateConfig(config: ScoringConfig): ConfigVerdict {
  if (!config.version.trim()) return { ok: false, reason: "VERSION_REQUIRED" };

  for (const d of ALL_DIMENSIONS) {
    const w = config.weights[d];
    if (typeof w !== "number" || !Number.isFinite(w)) {
      return { ok: false, reason: `WEIGHT_MISSING:${d}` };
    }
  }
  for (const d of POSITIVE_DIMENSIONS) {
    if (config.weights[d] < 0) return { ok: false, reason: `POSITIVE_WEIGHT_NEGATIVE:${d}` };
  }
  for (const d of PENALTY_DIMENSIONS) {
    if (config.weights[d] > 0) return { ok: false, reason: `PENALTY_WEIGHT_POSITIVE:${d}` };
  }

  const positive = POSITIVE_DIMENSIONS.reduce((s, d) => s + config.weights[d], 0);
  if (positive !== POSITIVE_BUDGET) {
    return { ok: false, reason: `POSITIVE_BUDGET_MISMATCH:${positive}` };
  }

  const commercial = POSITIVE_DIMENSIONS.filter((d) => COMMERCIAL_DIMENSIONS.has(d)).reduce(
    (s, d) => s + config.weights[d],
    0,
  );
  if (commercial > POSITIVE_BUDGET * MAX_COMMERCIAL_SHARE) {
    return { ok: false, reason: `COMMERCIAL_SHARE_EXCEEDED:${commercial}` };
  }

  return { ok: true };
}

/** The 70/30 split as numbers, for reporting rather than for gating. */
export function weightGroups(config: ScoringConfig): {
  readonly commercial: number;
  readonly editorial: number;
  readonly commercialShare: number;
} {
  const commercial = POSITIVE_DIMENSIONS.filter((d) => COMMERCIAL_DIMENSIONS.has(d)).reduce(
    (s, d) => s + config.weights[d],
    0,
  );
  const editorial = POSITIVE_BUDGET - commercial;
  return { commercial, editorial, commercialShare: commercial / POSITIVE_BUDGET };
}

// ─── Inputs ───────────────────────────────────────────────────────

/**
 * A dimension's input is a 0–1 fraction, or `UNKNOWN`.
 *
 * `UNKNOWN` is not zero and it is not a shrug: it means nobody has assessed
 * this dimension. It contributes nothing **and its weight stays in the
 * denominator** (AC-16), so thin evidence scores *lower* rather than being
 * quietly excused. Dropping unknown dimensions from the denominator is the bug
 * that makes an unresearched opportunity out-rank a researched one.
 */
export const UNKNOWN = "UNKNOWN" as const;
export type DimensionInput = number | typeof UNKNOWN;

export interface ScoreInputs {
  readonly values: Readonly<Partial<Record<Dimension, DimensionInput>>>;
  /**
   * AC-15 + the owner's traceability rule: every penalty must say what
   * triggered it and which evidence supports it. An unexplained −15 is
   * indistinguishable from a bug.
   */
  readonly penaltyReasons?: Readonly<Partial<Record<PenaltyDimension, string>>>;
  /** AC provenance: the signals this assessment rests on. */
  readonly evidenceSignalIds?: readonly string[];
}

// ─── The score ────────────────────────────────────────────────────

export interface DimensionContribution {
  readonly dimension: Dimension;
  readonly weight: number;
  readonly input: DimensionInput;
  readonly contribution: number;
  readonly known: boolean;
  readonly reason?: string;
}

export interface ScoreBreakdown {
  readonly configVersion: string;
  readonly contributions: readonly DimensionContribution[];
  readonly rawScore: number;
  readonly normalisedScore: number;
  readonly knownDimensions: number;
  readonly totalDimensions: number;
  readonly evidenceSignalIds: readonly string[];
  /** AC: the components must add up to the total. Proven, not assumed. */
  readonly reconciles: boolean;
}

export type ScoreVerdict =
  | { readonly ok: true; readonly breakdown: ScoreBreakdown }
  | { readonly ok: false; readonly reason: string };

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Two decimal places, so a float artefact cannot break reconciliation. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * AC-13's reconciliation test, exported so it can be exercised directly.
 *
 * It lives outside `scoreOpportunity` because of a mutation check: replacing
 * the inline comparison with `const reconciles = true` did not fail a single
 * test. The suite was verifying that the arithmetic happened to agree, never
 * that the GUARD would fire if it did not — and a guard nothing tests is a
 * comment. Pulling it out makes the disagreement case reachable.
 */
export const RECONCILIATION_TOLERANCE = 0.005;

export function reconcilesWith(sum: number, raw: number): boolean {
  return Math.abs(sum - raw) < RECONCILIATION_TOLERANCE;
}

/**
 * Map a raw score onto 0–100.
 *
 * The raw range is [−20, 100]: the positive budget minus the two penalties.
 * The mapping is linear across that whole range rather than a clamp at zero,
 * because clamping would make every heavily-penalised opportunity look
 * identical, and "bad" and "much worse" are different queue positions.
 */
export function normalise(raw: number): number {
  const scaled = ((raw - MIN_RAW) / (MAX_RAW - MIN_RAW)) * 100;
  return round2(clamp(scaled, 0, 100));
}

export function scoreOpportunity(
  inputs: ScoreInputs,
  config: ScoringConfig = SCORING_CONFIG_V0,
): ScoreVerdict {
  const configOk = validateConfig(config);
  if (!configOk.ok) return { ok: false, reason: `CONFIG_INVALID:${configOk.reason}` };

  const contributions: DimensionContribution[] = [];
  let raw = 0;
  let known = 0;

  for (const dimension of ALL_DIMENSIONS) {
    const weight = config.weights[dimension];
    const rawInput = inputs.values[dimension];
    const input: DimensionInput = rawInput === undefined ? UNKNOWN : rawInput;

    if (input !== UNKNOWN) {
      if (!Number.isFinite(input) || input < 0 || input > 1) {
        return { ok: false, reason: `INPUT_OUT_OF_RANGE:${dimension}` };
      }
    }

    const isKnown = input !== UNKNOWN;
    // AC-16: UNKNOWN contributes nothing, and the weight is NOT removed from
    // the budget. Thin evidence therefore scores lower, never artificially
    // higher.
    const contribution = isKnown ? round2(weight * (input as number)) : 0;

    const reason =
      (PENALTY_DIMENSIONS as readonly string[]).includes(dimension) && isKnown
        ? inputs.penaltyReasons?.[dimension as PenaltyDimension]
        : undefined;

    // AC-15. A penalty that actually bites must say why.
    if (contribution !== 0 && weight < 0 && !reason?.trim()) {
      return { ok: false, reason: `PENALTY_REASON_REQUIRED:${dimension}` };
    }

    contributions.push({ dimension, weight, input, contribution, known: isKnown, reason });
    raw = round2(raw + contribution);
    if (isKnown) known += 1;
  }

  const sum = round2(contributions.reduce((s, c) => s + c.contribution, 0));
  const reconciles = reconcilesWith(sum, raw);
  if (!reconciles) return { ok: false, reason: `RECONCILIATION_FAILED:${sum}!=${raw}` };

  return {
    ok: true,
    breakdown: {
      configVersion: config.version,
      contributions,
      rawScore: raw,
      normalisedScore: normalise(raw),
      knownDimensions: known,
      totalDimensions: ALL_DIMENSIONS.length,
      evidenceSignalIds: [...(inputs.evidenceSignalIds ?? [])],
      reconciles,
    },
  };
}

/**
 * AC-02 — `affiliate_potential = 0` must never disqualify.
 *
 * There is no gate in `scoreOpportunity` at all, which is the strongest form of
 * this guarantee: nothing can be removed from the queue for having no product
 * attached, because nothing in this module removes anything. This function
 * exists so a test can state the property directly.
 */
export function isDisqualified(): false {
  return false;
}

/**
 * Deterministic input fingerprint (AC-03, AC-09).
 *
 * Identical inputs under an identical config version must produce an identical
 * score, and recomputation must be idempotent. Storing this alongside the score
 * lets a unique index enforce idempotency in the database rather than in a
 * caller's memory.
 *
 * Deliberately not a cryptographic hash: this is an identity key, not a
 * security boundary, and a dependency-free module cannot import one.
 */
export function inputsFingerprint(inputs: ScoreInputs, config: ScoringConfig): string {
  const parts: string[] = [config.version];
  for (const d of ALL_DIMENSIONS) {
    const v = inputs.values[d];
    parts.push(`${d}=${v === undefined ? UNKNOWN : v}`);
  }
  for (const d of PENALTY_DIMENSIONS) {
    const r = inputs.penaltyReasons?.[d];
    if (r) parts.push(`${d}:reason=${r.trim()}`);
  }
  parts.push(`signals=${[...(inputs.evidenceSignalIds ?? [])].sort().join(",")}`);
  return parts.join("|");
}
