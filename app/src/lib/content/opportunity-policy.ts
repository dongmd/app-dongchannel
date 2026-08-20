/**
 * P2-R01 — what a ContentOpportunity is, and what may happen to it.
 *
 * Imports nothing: no `server-only`, no database, no clock. Same rule as
 * `content-mode-policy.ts` and `article-guard-policy.ts`, for the same reason —
 * AC-11 requires these decisions to be testable without a database.
 *
 * ## The semantic boundary this file draws
 *
 * `opportunity_signals` has existed since P1-R03/M5, and that model treats a
 * signal *as* the opportunity: it carries a score, a full editorial lifecycle,
 * and `opportunity_routes.opportunity_id` points at it. One signal was one
 * decision unit, by construction.
 *
 * P2 separates them, and the separation is the point (PROPOSED §2):
 *
 *   OpportunitySignal    an atomic, evidence-bearing observation. Something was
 *                        noticed. It carries provenance and no judgement.
 *
 *   ContentOpportunity   a DERIVED candidate, synthesised from one or more
 *                        signals, with its own lifecycle and its own score.
 *
 * **A single signal is never automatically an opportunity.** Three signals about
 * the same tool may produce one opportunity; one signal may produce several, or
 * an affiliate-project candidate, or both, or nothing at all. Collapsing the two
 * is what turns a discovery system into a content generator that writes about
 * whatever it happened to see last.
 */

// ─── Origin ───────────────────────────────────────────────────────
// AC-01. Exactly the eight from PF-01, derived from MASTER v3 §4 (ten types,
// minus the two YouTube-engine types V2 does not cover). The database enum
// mirrors this, so a ninth value is rejected at the boundary rather than by
// whichever caller remembered to check.
export const OPPORTUNITY_ORIGIN_TYPES = [
  "AFFILIATE_OFFER",
  "KEYWORD",
  "TREND",
  "PRODUCT_TOOL",
  "COMPETITOR_MOVE",
  "CONTENT_GAP",
  "PERFORMANCE_EXPANSION",
  "OWNER_SEED",
] as const;

export type OpportunityOriginType = (typeof OPPORTUNITY_ORIGIN_TYPES)[number];

const ORIGIN_SET: ReadonlySet<string> = new Set(OPPORTUNITY_ORIGIN_TYPES);

export function isOpportunityOriginType(v: unknown): v is OpportunityOriginType {
  return typeof v === "string" && ORIGIN_SET.has(v);
}

/**
 * AC-02 / AC-03 — the asymmetry, stated as a rule rather than left to the
 * database.
 *
 * `origin_type` is always known: even an owner idea typed into Telegram has a
 * type (`OWNER_SEED`). `origin_id` is nullable, because that idea points at no
 * source object. The reverse — an id whose type nobody recorded — is not a
 * state the system may hold, because nothing could then interpret the id.
 *
 * In the schema this is enforced by `origin_type NOT NULL`, which makes the
 * illegal combination unrepresentable rather than merely refused. This function
 * is the same rule at the application boundary, where the error can say why.
 */
export interface OriginRef {
  readonly originType: OpportunityOriginType | null | undefined;
  readonly originId: string | null | undefined;
}

export type OriginVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "ORIGIN_TYPE_MISSING" | "ORIGIN_TYPE_INVALID" };

export function checkOrigin(ref: OriginRef): OriginVerdict {
  if (ref.originType === null || ref.originType === undefined) {
    return { ok: false, reason: "ORIGIN_TYPE_MISSING" };
  }
  if (!isOpportunityOriginType(ref.originType)) {
    return { ok: false, reason: "ORIGIN_TYPE_INVALID" };
  }
  // A null originId is deliberately fine, and is NOT an error to be logged:
  // OWNER_SEED and CONTENT_GAP routinely have no source object.
  return { ok: true };
}

// ─── Lifecycle ────────────────────────────────────────────────────

/**
 * AC-04 — **"nothing" is a recorded outcome.**
 *
 * `REJECTED` and `DROPPED` are terminal states with a reason, not the absence of
 * a row. Discovery that considers something and declines must leave a trace, or
 * the system cannot distinguish "we looked and said no" from "we never looked" —
 * and it will keep rediscovering the same thing forever.
 *
 * The two differ: REJECTED is a judgement about the opportunity, DROPPED is a
 * withdrawal for a reason outside it (superseded, out of scope, duplicate).
 */
export const OPPORTUNITY_STATUSES = [
  "PROPOSED", //       exists, nobody has decided
  "RESEARCHING", //    being worked up
  "READY", //          researched, scored, awaiting production
  "IN_PRODUCTION", //  a draft exists elsewhere
  "PUBLISHED", //      terminal, succeeded
  "REJECTED", //       terminal, declined on the merits
  "DROPPED", //        terminal, withdrawn for an external reason
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<OpportunityStatus> = new Set([
  "PUBLISHED",
  "REJECTED",
  "DROPPED",
]);

/** The two terminal states that mean "no content came of this". */
export const CLOSED_WITHOUT_CONTENT: ReadonlySet<OpportunityStatus> = new Set([
  "REJECTED",
  "DROPPED",
]);

/**
 * AC-09 — transitions are explicit, and anything not listed is refused.
 *
 * An allowlist rather than a denylist: a status added later with no edges is
 * unreachable and inescapable, which is a loud failure. A denylist would make it
 * silently reachable from everywhere.
 */
const TRANSITIONS: Readonly<Record<OpportunityStatus, readonly OpportunityStatus[]>> = {
  PROPOSED: ["RESEARCHING", "REJECTED", "DROPPED"],
  RESEARCHING: ["READY", "REJECTED", "DROPPED"],
  READY: ["IN_PRODUCTION", "REJECTED", "DROPPED"],
  IN_PRODUCTION: ["PUBLISHED", "DROPPED"],
  // Terminal. Reopening is a new opportunity, not a resurrected one: the
  // reasons it was rejected are part of its record and must not be overwritten.
  PUBLISHED: [],
  REJECTED: [],
  DROPPED: [],
};

export function allowedTransitionsFrom(
  from: OpportunityStatus,
): readonly OpportunityStatus[] {
  return TRANSITIONS[from];
}

export type TransitionVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "INVALID_TRANSITION" | "TERMINAL" | "REASON_REQUIRED";
    };

/**
 * AC-04 + AC-09. Closing without content requires a reason, at the same
 * boundary that checks the transition itself — a rule enforced one layer later
 * is a rule with a gap in front of it.
 */
export function checkTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
  reason?: string | null,
): TransitionVerdict {
  if (TERMINAL_STATUSES.has(from)) {
    return { ok: false, reason: "TERMINAL" };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: "INVALID_TRANSITION" };
  }
  if (CLOSED_WITHOUT_CONTENT.has(to) && !reason?.trim()) {
    return { ok: false, reason: "REASON_REQUIRED" };
  }
  return { ok: true };
}

// ─── Derivation from signals ──────────────────────────────────────

/**
 * AC-02 of P2-R02, seen from this side: **a signal is not an opportunity.**
 *
 * An opportunity is derived from zero or more signals — zero being the
 * `OWNER_SEED` case, where a person simply had an idea. The link is a table,
 * not a column, because the cardinality runs both ways: several signals about
 * one tool collapse into one opportunity, and one broad trend signal can spawn
 * several.
 *
 * This function exists to make the rule refusable at the boundary rather than
 * merely documented.
 */
export type DerivationVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "SIGNAL_REQUIRED" | "DUPLICATE_SIGNAL";
    };

export function checkDerivation(
  originType: OpportunityOriginType,
  signalIds: readonly string[],
): DerivationVerdict {
  // OWNER_SEED is the one origin that legitimately rests on no signal at all.
  // Every other origin claims something was observed, and an observation with
  // no signal behind it is an assertion.
  if (originType !== "OWNER_SEED" && signalIds.length === 0) {
    return { ok: false, reason: "SIGNAL_REQUIRED" };
  }
  if (new Set(signalIds).size !== signalIds.length) {
    return { ok: false, reason: "DUPLICATE_SIGNAL" };
  }
  return { ok: true };
}

// ─── What an opportunity may hold ─────────────────────────────────

/**
 * AC-07 and AC-12, as a shape rather than a warning.
 *
 * An opportunity is a **decision record**. It carries no prose, no draft, and no
 * checked claim. It may carry a *claim to check* — a question — which is the
 * distinction P0-R01 was broken on: writing down "costs $29/month" as though
 * checking had happened.
 *
 * `claimsToCheck` is deliberately a list of questions, not of values. There is
 * nowhere here to put an answer, so nothing can quietly become one.
 */
export interface OpportunityRecord {
  readonly originType: OpportunityOriginType;
  readonly originId: string | null;
  readonly title: string;
  readonly rationale: string | null;
  readonly claimsToCheck: readonly string[];
  readonly status: OpportunityStatus;
}

/** Fields an opportunity must never carry. Asserted structurally by test. */
export const FORBIDDEN_OPPORTUNITY_FIELDS: readonly string[] = [
  "body",
  "content",
  "draft",
  "html",
  "verified",
  "verifiedAt",
  "checkedAt",
  "claimValue",
  "price",
  "rating",
];
