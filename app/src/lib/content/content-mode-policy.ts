/**
 * P2-R05 — content modes, and everything a mode decides.
 *
 * This module imports nothing: no `server-only`, no database, no clock. Every
 * function takes `now` as an argument. That is what makes AC-09 testable
 * without a database and without waiting for real time to pass, and it is the
 * same shape as `wordpress/retry-policy.ts` and `wordpress/article-guard-policy.ts`
 * for the same reason — the decision worth testing must be reachable without
 * production.
 *
 * The gap this closes (G-21) is stated in three parts: the TTL is *not
 * configurable*, *not per claim*, and *not per mode*. `dc_product::is_stale()`
 * hard-codes 90 days for every record and triggers nothing. All three parts
 * are addressed here, and the fourth — a worker that marks `REFRESH_REQUIRED` —
 * is the only thing that consumes it.
 *
 * The load-bearing rule is AC-10: **mode never relaxes the claim rules.** A
 * NEWS item may skip depth, may skip polish, may ship in a day. It may not
 * assert a claim nobody checked. That is enforced here by clamping, not by
 * documentation — a configuration row that tries to drop NEWS below the
 * evidence floor is raised back to the floor, and a test proves it.
 */

// ─── The five modes ───────────────────────────────────────────────
// Closed. The database enum mirrors this exactly, so a sixth value is rejected
// at the boundary rather than by whichever caller remembered to check.
export const CONTENT_MODES = [
  "COMMERCIAL", //  a product/offer piece; the money engine's output
  "EVERGREEN", //   a guide or explainer meant to stay true for a year
  "NEWS", //        time-critical; late is the same as wrong
  "TREND", //       a moment worth catching, shorter shelf life than evergreen
  "UPDATE", //      a revision of something already published
] as const;

export type ContentMode = (typeof CONTENT_MODES)[number];

const CONTENT_MODE_SET: ReadonlySet<string> = new Set(CONTENT_MODES);

/** Narrowing guard for values arriving from outside TypeScript's reach. */
export function isContentMode(value: unknown): value is ContentMode {
  return typeof value === "string" && CONTENT_MODE_SET.has(value);
}

// ─── QA depth ─────────────────────────────────────────────────────
// How much process a piece goes through — NOT how true it has to be. Those are
// deliberately different axes; see EVIDENCE_FLOOR below.
export const QA_DEPTHS = ["FULL", "STANDARD", "EXPEDITED"] as const;
export type QaDepth = (typeof QA_DEPTHS)[number];

// ─── Evidence level ───────────────────────────────────────────────
// E0 … E4, ordered. The numeric rank exists so "at least" is a comparison
// rather than a lookup table someone has to keep in their head.
export const EVIDENCE_LEVELS = ["E0", "E1", "E2", "E3", "E4"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

const EVIDENCE_RANK: Readonly<Record<EvidenceLevel, number>> = {
  E0: 0, //  asserted, nothing behind it
  E1: 1, //  a secondary source
  E2: 2, //  a primary source, checked
  E3: 3, //  primary source plus a corroborating one
  E4: 4, //  first-party measurement
};

export function evidenceRank(level: EvidenceLevel): number {
  return EVIDENCE_RANK[level];
}

/**
 * AC-10. **No mode may require less than this.**
 *
 * E2 means "a primary source, checked". Below it is E1 — a secondary source —
 * and E0, which is an assertion with nothing behind it. P0-R01 happened at E0:
 * ratings, prices and testing claims that were simply written down. Speed is a
 * legitimate reason to cut research depth; it has never been a reason to
 * publish something nobody verified, so the floor is not a per-mode setting and
 * cannot be configured away.
 */
export const EVIDENCE_FLOOR: EvidenceLevel = "E2";

// ─── The policy itself ────────────────────────────────────────────

export interface ModePolicy {
  /** Days after the freshness anchor before the piece is due for review. */
  readonly ttlDays: number;
  readonly qaDepth: QaDepth;
  /** The lowest evidence level a claim in this mode may rest on. */
  readonly minEvidenceLevel: EvidenceLevel;
  /** Hours from commissioning to publication before the SLA is missed. */
  readonly slaHours: number;
}

/**
 * V0 baseline, owner-approved 2026-08-20 as a *default*, explicitly not a
 * frozen business rule. Overrides are supplied per mode from configuration and
 * merged by `resolveModePolicy`; the version string travels with any derived
 * value so a later "why was this due then?" has an answer.
 */
export const MODE_POLICY_VERSION = "v0-2026-08-20";

export const DEFAULT_MODE_POLICY: Readonly<Record<ContentMode, ModePolicy>> = {
  // Long TTL, deepest QA, highest evidence: this is the mode where a wrong
  // number costs money and trust at the same time.
  COMMERCIAL: { ttlDays: 90, qaDepth: "FULL", minEvidenceLevel: "E3", slaHours: 168 },
  // A year, because that is roughly how long a good guide stays true — and
  // because "evergreen" that is never revisited is just old.
  EVERGREEN: { ttlDays: 365, qaDepth: "STANDARD", minEvidenceLevel: "E2", slaHours: 168 },
  // 24 hours or it was not news. Expedited QA, but note the evidence level is
  // still at the floor, not below it.
  NEWS: { ttlDays: 14, qaDepth: "EXPEDITED", minEvidenceLevel: "E2", slaHours: 24 },
  TREND: { ttlDays: 30, qaDepth: "EXPEDITED", minEvidenceLevel: "E2", slaHours: 48 },
  UPDATE: { ttlDays: 180, qaDepth: "STANDARD", minEvidenceLevel: "E2", slaHours: 72 },
};

/**
 * A configuration row. Every field optional — an override overrides one thing.
 *
 * `-readonly` is deliberate: `ModePolicy` is readonly because a *resolved*
 * policy must not be mutated by whoever receives it, but an override is built
 * up field by field as a configuration row is read, and inheriting the
 * readonly modifier through `Partial` would make that impossible to write
 * without a cast.
 */
export type ModePolicyOverride = { -readonly [K in keyof ModePolicy]?: ModePolicy[K] };
export type ModePolicyOverrides = Partial<Record<ContentMode, ModePolicyOverride>>;

/**
 * AC-05 + AC-10. Merge configuration over the default, then clamp.
 *
 * The clamp is the point. Configuration can lengthen a TTL, shorten an SLA,
 * change QA depth — and it can raise the evidence requirement. It cannot lower
 * it past the floor, so the one setting that could quietly reintroduce
 * unverified claims is the one setting that does not obey configuration.
 */
export function resolveModePolicy(
  mode: ContentMode,
  overrides?: ModePolicyOverrides,
): ModePolicy {
  const base = DEFAULT_MODE_POLICY[mode];
  const over = overrides?.[mode];
  if (!over) return base;

  const merged: ModePolicy = {
    ttlDays: positiveOr(over.ttlDays, base.ttlDays),
    qaDepth: over.qaDepth ?? base.qaDepth,
    minEvidenceLevel: over.minEvidenceLevel ?? base.minEvidenceLevel,
    slaHours: positiveOr(over.slaHours, base.slaHours),
  };

  if (evidenceRank(merged.minEvidenceLevel) < evidenceRank(EVIDENCE_FLOOR)) {
    return { ...merged, minEvidenceLevel: EVIDENCE_FLOOR };
  }
  return merged;
}

/**
 * A TTL of 0 or a negative one would mark everything permanently overdue, and a
 * NaN would compare false against everything and mark nothing. Both are
 * configuration mistakes that present as a broken refresh queue rather than as
 * an error, so neither is accepted.
 */
function positiveOr(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

// ─── Per-claim TTL ────────────────────────────────────────────────
// The second half of G-21. A price inside a year-long evergreen guide does not
// get a year — it gets what a price gets. Keyed on `claims.claim_key`.
export const DEFAULT_CLAIM_TTL_DAYS = 90;

export const CLAIM_TTL_DAYS: Readonly<Record<string, number>> = {
  payout_value: 30,
  commission_rate: 30,
  price: 14,
  discount: 7,
  availability: 7,
  ppc_allowed: 60,
  brand_bidding_allowed: 60,
  cookie_duration: 90,
  geo_availability: 90,
  program_status: 30,
};

export function claimTtlDays(claimKey: string): number {
  return CLAIM_TTL_DAYS[claimKey] ?? DEFAULT_CLAIM_TTL_DAYS;
}

/**
 * The effective TTL for a piece: the tightest of its mode and every claim it
 * rests on. **The shortest wins**, never the longest — an evergreen guide
 * quoting a price is stale when the price is stale, whatever the guide's own
 * shelf life says. Taking the maximum here would be the bug that lets a
 * year-old price sit under a "verified" badge.
 */
export function effectiveTtlDays(
  mode: ContentMode,
  claimKeys: readonly string[] = [],
  overrides?: ModePolicyOverrides,
): number {
  let ttl = resolveModePolicy(mode, overrides).ttlDays;
  for (const key of claimKeys) {
    const claimTtl = claimTtlDays(key);
    if (claimTtl < ttl) ttl = claimTtl;
  }
  return ttl;
}

// ─── Freshness ────────────────────────────────────────────────────

/**
 * Three states, and the third is not a shrug.
 *
 * `UNKNOWN` means there is no freshness anchor — the piece has never been
 * verified, so nothing can be computed from it. P1-R05 and P1-R06 both
 * established that unknown is not false; here it means unknown is not FRESH
 * either. A reporting layer should treat UNKNOWN as needing attention, but it
 * must stay distinguishable from REFRESH_REQUIRED, because "we never checked"
 * and "we checked and it expired" call for different work.
 */
export const REFRESH_STATES = ["FRESH", "REFRESH_REQUIRED", "UNKNOWN"] as const;
export type RefreshState = (typeof REFRESH_STATES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export function deriveRefreshDueAt(
  mode: ContentMode,
  anchor: Date | null,
  claimKeys: readonly string[] = [],
  overrides?: ModePolicyOverrides,
): Date | null {
  if (anchor === null || Number.isNaN(anchor.getTime())) return null;
  return new Date(anchor.getTime() + effectiveTtlDays(mode, claimKeys, overrides) * DAY_MS);
}

export function deriveRefreshState(
  mode: ContentMode,
  anchor: Date | null,
  now: Date,
  claimKeys: readonly string[] = [],
  overrides?: ModePolicyOverrides,
): RefreshState {
  const due = deriveRefreshDueAt(mode, anchor, claimKeys, overrides);
  if (due === null) return "UNKNOWN";
  return now.getTime() >= due.getTime() ? "REFRESH_REQUIRED" : "FRESH";
}

/** AC-03 read the other way round: only one state is affirmatively fresh. */
export function isFresh(state: RefreshState): boolean {
  return state === "FRESH";
}

// ─── What expiry is allowed to do ─────────────────────────────────

/**
 * AC-04, made structural rather than promised.
 *
 * There is no unpublish action and no edit action in this union, so a refresh
 * worker written against this type cannot express either one. The strongest
 * form of "it never unpublishes" is a vocabulary in which unpublishing cannot
 * be said.
 */
export const REFRESH_ACTIONS = ["NONE", "MARK_REFRESH_REQUIRED", "MARK_UNKNOWN"] as const;
export type RefreshAction = (typeof REFRESH_ACTIONS)[number];

export function refreshActionFor(state: RefreshState): RefreshAction {
  switch (state) {
    case "REFRESH_REQUIRED":
      return "MARK_REFRESH_REQUIRED";
    case "UNKNOWN":
      return "MARK_UNKNOWN";
    case "FRESH":
      return "NONE";
  }
}

// ─── SLA ──────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

export function deriveSlaDeadline(
  mode: ContentMode,
  commissionedAt: Date,
  overrides?: ModePolicyOverrides,
): Date {
  return new Date(
    commissionedAt.getTime() + resolveModePolicy(mode, overrides).slaHours * HOUR_MS,
  );
}

/**
 * AC-06 — the SLA has to be *reportable*, which means a piece still in flight
 * can already be late. Measuring only completed work would hide exactly the
 * items worth chasing: a NEWS piece that has been open for three days is the
 * problem, and it has no completion timestamp to measure.
 */
export const SLA_OUTCOMES = ["MET", "MISSED", "IN_PROGRESS", "AT_RISK"] as const;
export type SlaOutcome = (typeof SLA_OUTCOMES)[number];

/** Fraction of the window past which an unfinished item is called AT_RISK. */
export const SLA_AT_RISK_FRACTION = 0.8;

export function slaOutcome(
  mode: ContentMode,
  commissionedAt: Date,
  publishedAt: Date | null,
  now: Date,
  overrides?: ModePolicyOverrides,
): SlaOutcome {
  const deadline = deriveSlaDeadline(mode, commissionedAt, overrides);

  if (publishedAt !== null) {
    return publishedAt.getTime() <= deadline.getTime() ? "MET" : "MISSED";
  }

  if (now.getTime() > deadline.getTime()) return "MISSED";

  const elapsed = now.getTime() - commissionedAt.getTime();
  const window = deadline.getTime() - commissionedAt.getTime();
  return elapsed >= window * SLA_AT_RISK_FRACTION ? "AT_RISK" : "IN_PROGRESS";
}

// ─── Re-derivation ────────────────────────────────────────────────

export interface DerivedModeState {
  readonly mode: ContentMode;
  readonly policyVersion: string;
  readonly ttlDays: number;
  readonly qaDepth: QaDepth;
  readonly minEvidenceLevel: EvidenceLevel;
  readonly refreshDueAt: Date | null;
  readonly refreshState: RefreshState;
  readonly refreshAction: RefreshAction;
}

/**
 * AC-07 — changing a mode must re-derive TTL and QA rather than leave the old
 * ones in place.
 *
 * Nothing here is cached, which is a stronger guarantee than re-deriving on
 * change: there is no stored TTL that *could* be left behind. The database
 * stores the inputs (mode, anchor) and this function produces the rest, so a
 * mode change cannot fail to take effect — it is not an update that might be
 * forgotten, it is the next call.
 */
export function deriveModeState(
  mode: ContentMode,
  anchor: Date | null,
  now: Date,
  claimKeys: readonly string[] = [],
  overrides?: ModePolicyOverrides,
): DerivedModeState {
  const policy = resolveModePolicy(mode, overrides);
  const refreshState = deriveRefreshState(mode, anchor, now, claimKeys, overrides);
  return {
    mode,
    policyVersion: MODE_POLICY_VERSION,
    ttlDays: effectiveTtlDays(mode, claimKeys, overrides),
    qaDepth: policy.qaDepth,
    minEvidenceLevel: policy.minEvidenceLevel,
    refreshDueAt: deriveRefreshDueAt(mode, anchor, claimKeys, overrides),
    refreshState,
    refreshAction: refreshActionFor(refreshState),
  };
}

// ─── Claim admissibility ──────────────────────────────────────────

/**
 * AC-10 at the point of use. A claim is admissible in a mode when its evidence
 * level reaches that mode's minimum — and the minimum has already been clamped
 * to the floor, so this cannot pass an E0 assertion in any configuration.
 */
export function isClaimAdmissible(
  mode: ContentMode,
  claimEvidenceLevel: EvidenceLevel,
  overrides?: ModePolicyOverrides,
): boolean {
  const required = resolveModePolicy(mode, overrides).minEvidenceLevel;
  return evidenceRank(claimEvidenceLevel) >= evidenceRank(required);
}
