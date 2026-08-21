/**
 * P2-R02 — what an `OpportunitySignal` is, and what may be decided about it.
 *
 * Imports nothing. Same rule as the other policy modules, for the same reason:
 * AC-09 requires these decisions to be testable without a database.
 *
 * ## The one sentence this file exists to enforce
 *
 * **A signal is an observation, not a decision.** It records that something was
 * noticed, by whom or by what, and when. It carries no score, no verdict and no
 * editorial lifecycle — those live on `ContentOpportunity` (P2-R01) and on
 * routes.
 *
 * The separation is what stops discovery collapsing into a content generator:
 * a system where noticing a thing *is* deciding to write about it will write
 * about whatever it happened to see most recently.
 */

// ─── Intake lifecycle ─────────────────────────────────────────────
//
// Four states, none of them editorial. The nine this replaces
// (RESEARCHING, NEEDS_EVIDENCE, READY_FOR_DECISION, WATCHLIST, APPROVED,
// REJECTED, ARCHIVED) were the lifecycle of a decision.
export const SIGNAL_STATUSES = ["NEW", "ROUTED", "DUPLICATE", "DISCARDED"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** Fields a signal must never carry: AC-10, as a list a test can check. */
export const FORBIDDEN_SIGNAL_FIELDS: readonly string[] = [
  "overallScore",
  "overall_score",
  "scoringVersion",
  "scoring_version",
  "scoreBreakdown",
  "score_breakdown",
  "verdict",
  "priority",
  "rank",
];

// ─── Provenance ───────────────────────────────────────────────────

/**
 * AC-06 — provenance is mandatory, and it takes two forms.
 *
 * A connector signal has a source. An owner seed typed into Telegram has a
 * person. Demanding `sourceId` outright would make owner seeds unrepresentable;
 * demanding nothing would allow a signal that cannot say where it came from,
 * which is an assertion wearing an observation's clothes.
 *
 * Owner directive, 2026-08-20: an `OWNER_SEED` may skip the signal layer
 * entirely, but never the record of who seeded it and when.
 */
export interface SignalProvenance {
  readonly sourceId?: string | null;
  readonly capturedBy?: string | null;
  readonly capturedAt?: Date | null;
}

export type ProvenanceVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "NO_PROVENANCE" | "NO_CAPTURE_TIME" | "INVALID_CAPTURE_TIME";
    };

export function checkProvenance(p: SignalProvenance): ProvenanceVerdict {
  const hasSource = typeof p.sourceId === "string" && p.sourceId.trim().length > 0;
  const hasActor = typeof p.capturedBy === "string" && p.capturedBy.trim().length > 0;

  if (!hasSource && !hasActor) return { ok: false, reason: "NO_PROVENANCE" };
  if (p.capturedAt === null || p.capturedAt === undefined) {
    return { ok: false, reason: "NO_CAPTURE_TIME" };
  }
  // An unparseable timestamp is worse than a missing one: it looks like an
  // answer and compares false against everything.
  if (Number.isNaN(p.capturedAt.getTime())) {
    return { ok: false, reason: "INVALID_CAPTURE_TIME" };
  }
  return { ok: true };
}

// ─── Normalisation ────────────────────────────────────────────────

/**
 * AC-05 — every source produces the same shape.
 *
 * A signal that cannot be normalised is `DISCARDED` with a reason, not silently
 * dropped: a connector that stops producing usable rows should be visible as a
 * pile of discards, not as silence.
 */
export interface NormalisedSignal {
  readonly canonicalKey: string;
  readonly kind: string;
  readonly originMode: string;
  readonly title: string;
}

export type NormaliseVerdict =
  | { readonly ok: true; readonly signal: NormalisedSignal }
  | { readonly ok: false; readonly reason: string };

export function normalise(raw: Partial<NormalisedSignal>): NormaliseVerdict {
  for (const field of ["canonicalKey", "kind", "originMode", "title"] as const) {
    const v = raw[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      return { ok: false, reason: `MISSING_${field.toUpperCase()}` };
    }
  }
  return {
    ok: true,
    signal: {
      canonicalKey: raw.canonicalKey!.trim(),
      kind: raw.kind!,
      originMode: raw.originMode!,
      title: raw.title!.trim(),
    },
  };
}

/**
 * AC-07 — the dedup key is deterministic, so the same observation arriving
 * twice collapses instead of being re-scored into a second opportunity.
 *
 * Lower-cased and whitespace-collapsed because the same programme title arrives
 * from two connectors with different capitalisation and padding, and a key that
 * treats those as different keys does not deduplicate anything.
 */
export function canonicalKeyFor(kind: string, identity: string): string {
  const norm = identity.trim().toLowerCase().replace(/\s+/g, " ");
  return `${kind.trim().toUpperCase()}:${norm}`;
}

export function isDuplicateKey(a: string, b: string): boolean {
  return a === b;
}

// ─── Two kinds of identity, and conflating them loses data ────────
//
// Owner invariant, 2026-08-20, and it caught a real defect.
//
// `canonicalKeyFor` keys on (kind, subject) alone. That is exactly right for a
// signal about a THING -- an affiliate programme is the same programme in August
// and in December, and a second sighting of it should collapse.
//
// It is exactly WRONG for a point-in-time OBSERVATION. A trend measured in
// August and the same trend measured in December are two observations, and
// keying them identically means the December one is silently deduplicated
// against the August one and never enters the queue again. A trend radar that
// runs on a schedule would go quiet after its first pass and look healthy.
//
// So identity splits by what the signal is ABOUT:
//
//   entity-like    AFFILIATE_PROGRAM, PRODUCT — the subject persists.
//                  canonicalKeyFor(kind, subject)
//   observation    TREND, KEYWORD volume — the subject is a measurement taken
//                  at a time. observationKeyFor(kind, subject, window)
//
// The window is supplied by the caller -- a scheduled run knows its own window,
// and inventing a granularity here would be a constant nobody chose.

/**
 * A deterministic ISO-week bucket, for callers that want the common case.
 *
 * Weeks rather than days because a trend that persists for a fortnight is one
 * story, not fourteen; and rather than months because a month is long enough
 * for a trend to rise and die inside one bucket.
 */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weeks run Monday-Sunday and belong to the year containing their Thursday.
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Identity for a point-in-time observation.
 *
 * Three dimensions, and each one is a distinct fact:
 *
 *   subject   what was observed
 *   window    when it was observed
 *   source    WHO observed it
 *
 * Retrying or replaying the same observation from the same source, in the same
 * window, yields the same key -- so a retry cannot duplicate. A new window
 * yields a different key, so a re-emerging trend is not lost.
 *
 * **And a different SOURCE yields a different key**, which is the dimension the
 * first version missed. Two providers reporting the same trend in the same week
 * are two independent observations: a signal is defined as an ATOMIC,
 * EVIDENCE-BEARING observation, so collapsing them would silently discard the
 * second provider's evidence and its provenance along with it. If the two ever
 * should be merged, that is an aggregation decision made above this layer, by
 * something that can record *why* -- not a side effect of how a key was built.
 *
 * `sourceKey` is an opaque identifier the caller supplies. Nothing here knows
 * about any particular provider, and no provider-specific branching belongs in
 * a generic key.
 */
export function observationKeyFor(
  kind: string,
  identity: string,
  windowKey: string,
  sourceKey: string,
): string {
  const w = windowKey.trim();
  if (!w) {
    throw new Error("observationKeyFor requires a window: an observation without a time is not an observation");
  }
  const s = sourceKey.trim().toLowerCase();
  if (!s) {
    throw new Error("observationKeyFor requires a source: an observation with no observer is not an observation");
  }
  return `${canonicalKeyFor(kind, identity)}@${w}#${s}`;
}

// ─── Routing ──────────────────────────────────────────────────────

/**
 * AC-02 — all four outcomes are representable, and **"nothing" is one of them.**
 *
 * One signal may produce many content opportunities, an affiliate-project
 * candidate, both, or nothing at all. `NO_ACTION` is a route that gets written
 * down, not a route that is omitted — AC-03. A scorer that never declines is
 * not scoring, and a radar that rejects everything must be distinguishable from
 * one that rejects nothing.
 */
export const ROUTE_TYPES = [
  "AFFILIATE_PROJECT",
  "CONTENT_OPPORTUNITY",
  "YOUTUBE_NICHE",
  "WATCHLIST",
  "NO_ACTION",
] as const;
export type RouteType = (typeof ROUTE_TYPES)[number];

export const ROUTE_STATUSES = ["PROPOSED", "ACCEPTED", "REJECTED", "SUPERSEDED"] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

export interface RouteDecision {
  readonly routeType: RouteType;
  readonly status: RouteStatus;
  readonly reason?: string | null;
}

export type RoutingVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "REASON_REQUIRED" | "DUPLICATE_ROUTE_TYPE" | "EMPTY_DECISION_SET";
    };

/**
 * AC-02 + AC-03. A signal's routing is the whole set of decisions taken about
 * it, checked together — because "produced nothing" is a property of the set,
 * not of any one route.
 */
export function checkRouting(decisions: readonly RouteDecision[]): RoutingVerdict {
  // Not even a NO_ACTION. Silence is the one outcome that is not allowed,
  // because it is indistinguishable from never having looked.
  if (decisions.length === 0) return { ok: false, reason: "EMPTY_DECISION_SET" };

  const seen = new Set<RouteType>();
  for (const d of decisions) {
    if (seen.has(d.routeType)) return { ok: false, reason: "DUPLICATE_ROUTE_TYPE" };
    seen.add(d.routeType);

    const declining = d.routeType === "NO_ACTION" || d.status === "REJECTED";
    if (declining && !d.reason?.trim()) return { ok: false, reason: "REASON_REQUIRED" };
  }
  return { ok: true };
}

/** True when the signal was considered and produced no downstream work. */
export function producedNothing(decisions: readonly RouteDecision[]): boolean {
  if (decisions.length === 0) return false; // never considered ≠ produced nothing
  return decisions.every((d) => d.routeType === "NO_ACTION" || d.status === "REJECTED");
}

/**
 * AC-04 — a signal never writes an article, never creates a project and never
 * publishes. The vocabulary contains no such verb, so a caller written against
 * this type cannot express one.
 */
export const SIGNAL_ACTIONS = ["RECORD_ROUTE", "MARK_DUPLICATE", "DISCARD", "NONE"] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];
