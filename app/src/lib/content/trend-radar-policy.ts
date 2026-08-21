import { claimTtlDays } from "./content-mode-policy";
import { isoWeekKey, observationKeyFor } from "./signal-policy";
import { decideRetry, type RetryDecision } from "../wordpress/retry-policy";

/**
 * P2-R06 — the Trend Radar, and the allowlist that keeps it from becoming a
 * generic tech-news feed.
 *
 * ## What it imports, and why that is the whole design
 *
 * This module imports **only other pure policy modules**, and each import is a
 * refusal to write a second copy of something:
 *
 *   claimTtlDays    freshness comes from the P2-R05 TTL policy. A radar with
 *                   its own "stale after N days" constant would be a second
 *                   answer to a question the project already answered.
 *   canonicalKeyFor the P2-R02 dedup key. A radar that keyed signals its own
 *                   way would produce duplicates of signals from every other
 *                   source.
 *   decideRetry     the P1-R05 retry state machine (AC-07), not a second one.
 *
 * No database, no network, no clock — `now` is always a parameter.
 *
 * ## The flow this must not short-circuit
 *
 *     trend observation → OpportunitySignal → routing → ContentOpportunity
 *                                                     / AffiliateProject candidate
 *
 * **The radar emits signals and stops.** A trend is not an opportunity: one
 * trend may produce nothing, one thing, or several, and that decision belongs
 * to routing (P2-R02) and scoring (P2-R03). A radar that created opportunities
 * directly would be a content generator with a feed attached.
 */

// ─── The allowlist ────────────────────────────────────────────────

export interface AllowlistEntry {
  /** Stable id, so a rejection can name the entry that did or did not match. */
  readonly id: string;
  readonly term: string;
  readonly enabled: boolean;
}

/**
 * The candidate list from `PROPOSED_SYSTEM_ARCHITECTURE.md` §3, as a **seed**.
 *
 * AC-01: the allowlist is configuration. This constant is what a fresh database
 * starts from, not where the list lives — changing it in production is a row
 * change, not a deploy.
 */
export const ALLOWLIST_SEED: readonly string[] = [
  "ai tools",
  "saas",
  "marketing tools",
  "affiliate",
  "advertising",
  "seo",
  "automation",
  "creator tools",
  "productivity",
  "hosting",
  "online business",
];

function normalise(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Scope ────────────────────────────────────────────────────────

export type ScopeVerdict =
  | { readonly ok: true; readonly matchedEntryId: string; readonly matchedTerm: string }
  | {
      readonly ok: false;
      readonly reason: "OUT_OF_SCOPE" | "EMPTY_ALLOWLIST" | "NO_SUBJECT";
      /** AC-02: the term that failed, so a rejection can be read months later. */
      readonly subject: string;
    };

/**
 * AC-02 and AC-04.
 *
 * **An empty allowlist rejects everything.** Failing open would turn a
 * misconfiguration — a wiped table, a failed config load — into "publish about
 * anything", which is the one outcome the allowlist exists to prevent. Failing
 * closed turns the same mistake into an obvious pile of rejections.
 *
 * A disabled entry is not a match. Disabling is how a topic is retired without
 * losing the record that it was once in scope.
 */
export function checkScope(
  subject: string,
  allowlist: readonly AllowlistEntry[],
): ScopeVerdict {
  const s = normalise(subject);
  if (!s) return { ok: false, reason: "NO_SUBJECT", subject };

  const active = allowlist.filter((e) => e.enabled);
  if (active.length === 0) return { ok: false, reason: "EMPTY_ALLOWLIST", subject: s };

  for (const entry of active) {
    const term = normalise(entry.term);
    if (term && s.includes(term)) {
      return { ok: true, matchedEntryId: entry.id, matchedTerm: term };
    }
  }
  return { ok: false, reason: "OUT_OF_SCOPE", subject: s };
}

// ─── Provider outcomes ────────────────────────────────────────────

/**
 * Four outcomes a provider run can have, and they are **not** interchangeable.
 *
 *   PROVIDER_ERROR  the call failed. We know nothing.
 *   NO_DATA         the call succeeded and returned no rows at all.
 *   UNKNOWN         the call succeeded and returned rows, but the field we
 *                   needed was absent.
 *   ZERO            the call succeeded and the answer is genuinely zero.
 *
 * Collapsing the first three into "no results" is how a broken connector looks
 * healthy for a month: the queue is empty either way, and only the distinction
 * says whether that is good news. `ZERO` in particular is a *fact* — "nobody
 * searched for this" — and treating it as an error would discard real evidence.
 */
export const PROVIDER_OUTCOMES = ["OK", "PROVIDER_ERROR", "NO_DATA", "UNKNOWN", "ZERO"] as const;
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

export interface ProviderResult {
  readonly outcome: ProviderOutcome;
  readonly rows: number;
  /** Present for PROVIDER_ERROR; a reason nobody can read is not a reason. */
  readonly error?: string | null;
}

export function classifyProviderResult(input: {
  readonly failed: boolean;
  readonly error?: string | null;
  readonly rows?: number | null;
  readonly valueMissing?: boolean;
}): ProviderResult {
  if (input.failed) {
    return { outcome: "PROVIDER_ERROR", rows: 0, error: input.error ?? "unspecified" };
  }
  if (input.rows === null || input.rows === undefined) {
    // The call worked but we cannot say how many rows: unknown, not zero.
    return { outcome: "UNKNOWN", rows: 0 };
  }
  if (input.rows === 0) return { outcome: "NO_DATA", rows: 0 };
  if (input.valueMissing) return { outcome: "UNKNOWN", rows: input.rows };
  return { outcome: "OK", rows: input.rows };
}

/** A genuine measured zero, which is evidence rather than absence. */
export function isGenuineZero(measured: number | null | undefined): boolean {
  return measured === 0;
}

/** AC-06 + the fabrication rule: only OK may become a signal. */
export function mayEmitSignal(outcome: ProviderOutcome): boolean {
  return outcome === "OK";
}

// ─── Emission ─────────────────────────────────────────────────────

export interface TrendObservation {
  readonly subject: string;
  readonly sourceId: string;
  readonly capturedAt: Date;
  readonly measuredValue?: number | null;
  /**
   * The observation window this measurement belongs to. Defaults to the ISO
   * week of `capturedAt`.
   *
   * This exists because keying a trend on its subject alone collapses every
   * future sighting of it into the first one -- a radar that goes quiet after
   * its first pass and looks healthy doing it.
   */
  readonly windowKey?: string;
}

export type EmitVerdict =
  | {
      readonly ok: true;
      readonly signal: {
        readonly canonicalKey: string;
        readonly kind: "TREND";
        readonly originMode: "SCHEDULED_DISCOVERY";
        readonly sourceId: string;
        readonly capturedAt: Date;
        readonly matchedEntryId: string;
      };
    }
  | { readonly ok: false; readonly reason: string; readonly subject: string };

/**
 * AC-05 — an emitted signal carries its provenance: the source, the capture
 * time, **and the allowlist entry it matched**. The last one is what makes a
 * later "why is this in the queue?" answerable without re-running anything.
 *
 * AC-07 of P2-R02 is inherited rather than reimplemented: the dedup key comes
 * from `canonicalKeyFor`, so the same trend seen by the radar and by a
 * connector collapses to one signal instead of two.
 */
export function emitSignal(
  observation: TrendObservation,
  allowlist: readonly AllowlistEntry[],
  provider: ProviderResult,
): EmitVerdict {
  if (!mayEmitSignal(provider.outcome)) {
    // A provider error is not a trend. Emitting one would be fabrication: a
    // record asserting something was observed when nothing was.
    return { ok: false, reason: `PROVIDER_${provider.outcome}`, subject: observation.subject };
  }
  if (!observation.sourceId?.trim()) {
    return { ok: false, reason: "NO_PROVENANCE", subject: observation.subject };
  }
  if (Number.isNaN(observation.capturedAt.getTime())) {
    return { ok: false, reason: "INVALID_CAPTURE_TIME", subject: observation.subject };
  }

  const scope = checkScope(observation.subject, allowlist);
  if (!scope.ok) return { ok: false, reason: scope.reason, subject: scope.subject };

  return {
    ok: true,
    signal: {
      canonicalKey: observationKeyFor(
        "TREND",
        observation.subject,
        observation.windowKey ?? isoWeekKey(observation.capturedAt),
      ),
      kind: "TREND",
      originMode: "SCHEDULED_DISCOVERY",
      sourceId: observation.sourceId,
      capturedAt: observation.capturedAt,
      matchedEntryId: scope.matchedEntryId,
    },
  };
}

// ─── Counting rejections ──────────────────────────────────────────

export interface RadarRunTally {
  readonly emitted: number;
  readonly deduplicated: number;
  readonly rejected: Readonly<Record<string, number>>;
  readonly providerOutcomes: Readonly<Record<string, number>>;
}

/**
 * AC-03 — **a radar that rejects everything and one that rejects nothing must be
 * distinguishable from the record.**
 *
 * Both produce an empty queue. Only the tally says whether the allowlist is
 * working or the connector is dead, and that is the difference between a
 * healthy quiet week and a month of silent failure.
 */
export function tallyRun(
  results: readonly { readonly verdict: EmitVerdict; readonly outcome: ProviderOutcome; readonly duplicate?: boolean }[],
): RadarRunTally {
  const rejected: Record<string, number> = {};
  const providerOutcomes: Record<string, number> = {};
  let emitted = 0;
  let deduplicated = 0;

  for (const r of results) {
    providerOutcomes[r.outcome] = (providerOutcomes[r.outcome] ?? 0) + 1;
    if (r.verdict.ok) {
      if (r.duplicate) deduplicated += 1;
      else emitted += 1;
    } else {
      rejected[r.verdict.reason] = (rejected[r.verdict.reason] ?? 0) + 1;
    }
  }
  return { emitted, deduplicated, rejected, providerOutcomes };
}

/** Total rejections, so "rejected everything" is one number rather than a scan. */
export function totalRejected(tally: RadarRunTally): number {
  return Object.values(tally.rejected).reduce((s, n) => s + n, 0);
}

// ─── Freshness, retries, and what the radar may do ────────────────

/**
 * Freshness comes from the P2-R05 claim TTL. There is deliberately **no new
 * constant here**: a radar with its own staleness rule would be a second answer
 * to a question the project already settled, and the two would drift.
 */
export function trendTtlDays(): number {
  return claimTtlDays("availability");
}

export function isTrendStale(capturedAt: Date | null, now: Date): boolean {
  if (capturedAt === null || Number.isNaN(capturedAt.getTime())) return true;
  return now.getTime() - capturedAt.getTime() > trendTtlDays() * 24 * 60 * 60 * 1000;
}

/**
 * AC-07 — fetch failures are retryable and bounded, **reusing** the P1-R05
 * policy rather than growing a second one.
 *
 * A retry must never produce a second signal: the caller re-runs the fetch, and
 * `canonicalKeyFor` gives the same key, so the emission deduplicates. That is
 * why the dedup key is derived from the subject rather than from the attempt.
 */
export function decideFetchRetry(input: {
  readonly retryable: boolean;
  readonly attemptsMade: number;
  readonly retryAfterSeconds?: number | null;
  readonly now: Date;
}): RetryDecision {
  return decideRetry(input);
}

/**
 * AC-06, as a vocabulary. There is no `CREATE_OPPORTUNITY` and no
 * `WRITE_CONTENT`, so a radar written against this type cannot express either.
 */
export const RADAR_ACTIONS = ["EMIT_SIGNAL", "SKIP_DUPLICATE", "RECORD_REJECTION", "NONE"] as const;
export type RadarAction = (typeof RADAR_ACTIONS)[number];
