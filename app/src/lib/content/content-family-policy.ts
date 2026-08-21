import {
  EVIDENCE_FLOOR,
  effectiveTtlDays,
  evidenceRank,
  isContentMode,
  type ContentMode,
  type EvidenceLevel,
} from "./content-mode-policy";
import { ALL_DIMENSIONS, type Dimension } from "./scoring-policy";

/**
 * P2-R08 — `dc_deal` and `dc_workflow` as full content families.
 *
 * Owner answer **Q21**, layer 1 of 2. This module owns the **domain**: the data
 * model, the content-mode mapping, eligibility and routing rules, scoring
 * integration and evidence requirements. **`P5-R10` owns the templates** — the
 * WordPress rendering, the public UX — and nothing here anticipates them.
 *
 * Q21 is `SATISFIED` only when both are complete.
 *
 * ## content_family and content_mode are not competitors
 *
 * They answer different questions, and the relationship between them is
 * **many-to-one and explicit**:
 *
 *   content_family   WHAT KIND of thing this is. A deal, a workflow, a review.
 *                    It maps to WordPress post types.
 *   content_mode     HOW IT IS TREATED — TTL, QA depth, evidence floor, SLA.
 *                    P2-R05 owns it, and it remains the single source of truth
 *                    for all four.
 *
 * A family does **not** carry its own TTL or its own QA rule. It carries a
 * *mapping* to a mode, and the mode answers. Two sources of truth for "how long
 * until this is stale" is exactly the drift this project has spent requirements
 * removing.
 */

// ─── The families ─────────────────────────────────────────────────
//
// A closed set, in one place. The alternative -- the string "dc_deal" appearing
// in a template, a query, a REST route and a scoring branch -- is how a family
// ends up supported in three places and forgotten in the fourth.
export const CONTENT_FAMILIES = [
  "dc_review",
  "dc_bestpicks",
  "dc_comparison",
  "dc_workflow",
  "dc_deal",
] as const;

export type ContentFamily = (typeof CONTENT_FAMILIES)[number];

const FAMILY_SET: ReadonlySet<string> = new Set(CONTENT_FAMILIES);

export function isContentFamily(v: unknown): v is ContentFamily {
  return typeof v === "string" && FAMILY_SET.has(v);
}

/** The two Q21 promoted. Named so a test can assert they are covered. */
export const Q21_FAMILIES: readonly ContentFamily[] = ["dc_deal", "dc_workflow"];

// ─── Family → mode, and the evidence a family owes ────────────────

export interface FamilyPolicy {
  /** P2-R05's mode. The family does not restate TTL or QA -- the mode answers. */
  readonly contentMode: ContentMode;
  /** May be raised above the mode's floor, never lowered below it. */
  readonly minEvidenceLevel: EvidenceLevel;
  /**
   * Claim keys a piece in this family typically rests on. Feeds
   * `effectiveTtlDays`, where the SHORTEST wins — so a deal quoting a discount
   * expires on the discount's schedule rather than on a family constant.
   */
  readonly typicalClaimKeys: readonly string[];
}

export const FAMILY_POLICY_VERSION = "family-v0-2026-08-20";

export const DEFAULT_FAMILY_POLICY: Readonly<Record<ContentFamily, FamilyPolicy>> = {
  dc_review: {
    contentMode: "COMMERCIAL",
    minEvidenceLevel: "E3",
    typicalClaimKeys: ["price", "availability"],
  },
  dc_bestpicks: {
    contentMode: "COMMERCIAL",
    minEvidenceLevel: "E3",
    typicalClaimKeys: ["price", "availability"],
  },
  dc_comparison: {
    contentMode: "COMMERCIAL",
    minEvidenceLevel: "E3",
    typicalClaimKeys: ["price", "availability"],
  },
  // A workflow is a process explainer: it stays true for a long time, and its
  // claims are about how something works rather than what it costs.
  dc_workflow: {
    contentMode: "EVERGREEN",
    minEvidenceLevel: "E2",
    typicalClaimKeys: [],
  },
  // A deal is the shortest-lived thing the site publishes. The mode is
  // COMMERCIAL, but the TTL that actually binds comes from the DISCOUNT claim,
  // which expires in a week.
  dc_deal: {
    contentMode: "COMMERCIAL",
    minEvidenceLevel: "E3",
    typicalClaimKeys: ["discount", "price", "availability"],
  },
};

export type FamilyPolicyOverride = { -readonly [K in keyof FamilyPolicy]?: FamilyPolicy[K] };
export type FamilyPolicyOverrides = Partial<Record<ContentFamily, FamilyPolicyOverride>>;

/**
 * AC-02 + AC-03. Configuration merges over the default, then the evidence floor
 * clamps — exactly as P2-R05 does for modes, and for the same reason: the one
 * setting that could reintroduce unverified claims is the one setting
 * configuration must not reach.
 */
export function resolveFamilyPolicy(
  family: ContentFamily,
  overrides?: FamilyPolicyOverrides,
): FamilyPolicy {
  const base = DEFAULT_FAMILY_POLICY[family];
  const over = overrides?.[family];
  if (!over) return base;

  const mode = over.contentMode && isContentMode(over.contentMode) ? over.contentMode : base.contentMode;
  const evidence = over.minEvidenceLevel ?? base.minEvidenceLevel;

  return {
    contentMode: mode,
    minEvidenceLevel:
      evidenceRank(evidence) < evidenceRank(EVIDENCE_FLOOR) ? EVIDENCE_FLOOR : evidence,
    typicalClaimKeys: over.typicalClaimKeys ?? base.typicalClaimKeys,
  };
}

/** AC-01. Explicit, never defaulted: a family with no mapping is a bug. */
export function contentModeFor(
  family: ContentFamily,
  overrides?: FamilyPolicyOverrides,
): ContentMode {
  return resolveFamilyPolicy(family, overrides).contentMode;
}

/**
 * AC-04. The TTL is **derived**, never a family constant.
 *
 * `effectiveTtlDays` takes the shortest of the mode's TTL and every claim the
 * piece rests on, so a `dc_deal` inherits the discount's seven days rather than
 * COMMERCIAL's ninety. A family that carried its own number would be a second
 * answer to a question P2-R05 already owns.
 */
export function familyTtlDays(
  family: ContentFamily,
  overrides?: FamilyPolicyOverrides,
): number {
  const policy = resolveFamilyPolicy(family, overrides);
  return effectiveTtlDays(policy.contentMode, policy.typicalClaimKeys);
}

// ─── Scoring integration, not a second engine ─────────────────────

/**
 * AC-05. Every family must be scoreable by **P2-R03**, and no family gets its
 * own scorer.
 *
 * This returns the dimensions a family is expected to have inputs for. It
 * computes nothing: a family-specific scoring branch would be an alternate
 * ranking nobody could compare against the main one.
 *
 * A dimension a family has no input for stays `UNKNOWN` in P2-R03, which keeps
 * its weight in the denominator — thin evidence scores lower, never higher.
 */
export function scoringDimensionsFor(_family: ContentFamily): readonly Dimension[] {
  // Deliberately the full set for every family. Narrowing it per family would
  // change the denominator per family, and two pieces scored against different
  // denominators cannot be ranked against each other.
  return ALL_DIMENSIONS;
}

// ─── Evidence: a deal may not be invented ─────────────────────────

/**
 * AC-07. The commercial facts a `dc_deal` rests on, each of which has been a
 * fabrication route in this project's history.
 */
export const DEAL_FACTS = [
  "price",
  "discount",
  "expiry",
  "availability",
  "coupon",
  "merchant_terms",
] as const;
export type DealFact = (typeof DEAL_FACTS)[number];

export const FACT_STATES = ["OBSERVED", "EXPIRED", "UNVERIFIED", "UNKNOWN"] as const;
export type FactState = (typeof FACT_STATES)[number];

export interface DealFactValue {
  readonly state: FactState;
  readonly value?: string | number | null;
  readonly observedUrl?: string | null;
  readonly observedAt?: Date | null;
}

export type DealVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly fact: DealFact;
      readonly reason: "CLAIMED_WITHOUT_SOURCE" | "VALUE_WITHOUT_OBSERVATION" | "BAD_STATE";
    };

/**
 * A deal fact may be `OBSERVED` with a value and a source, or it may be
 * `EXPIRED` / `UNVERIFIED` / `UNKNOWN` with no value.
 *
 * `EXPIRED` deserves its own state rather than being folded into `UNKNOWN`: a
 * discount that *was* real and has run out is a different fact from one nobody
 * ever checked, and the two call for different work — one is a refresh, the
 * other is research.
 */
export function checkDealFact(fact: DealFact, v: DealFactValue): DealVerdict {
  if (!(FACT_STATES as readonly string[]).includes(v.state)) {
    return { ok: false, fact, reason: "BAD_STATE" };
  }
  if (v.state === "OBSERVED") {
    if (v.value === null || v.value === undefined) {
      return { ok: false, fact, reason: "VALUE_WITHOUT_OBSERVATION" };
    }
    if (!v.observedUrl?.trim() || !v.observedAt || Number.isNaN(v.observedAt.getTime())) {
      return { ok: false, fact, reason: "CLAIMED_WITHOUT_SOURCE" };
    }
    return { ok: true };
  }
  // Any non-OBSERVED state must carry no value: a number sitting beside
  // UNVERIFIED is a guess waiting to be rendered.
  if (v.value !== null && v.value !== undefined) {
    return { ok: false, fact, reason: "VALUE_WITHOUT_OBSERVATION" };
  }
  return { ok: true };
}

/**
 * AC-06 read from the family side. A `dc_workflow` asserts how something works,
 * and a generated workflow is not a verified fact until someone checked it.
 */
export function workflowClaimIsVerified(state: FactState): boolean {
  return state === "OBSERVED";
}

// ─── What R08 may do ──────────────────────────────────────────────

/**
 * No `PUBLISH`, no `EDIT_ARTICLE`, no `APPROVE`. R08 defines domain, contracts
 * and rules; publishing stays behind the owner-approval boundary that P1 and P3
 * own.
 */
export const FAMILY_ACTIONS = [
  "CLASSIFY_FAMILY",
  "DERIVE_MODE",
  "MARK_REFRESH_REQUIRED",
  "RECORD_EVIDENCE",
  "NONE",
] as const;
export type FamilyAction = (typeof FAMILY_ACTIONS)[number];
