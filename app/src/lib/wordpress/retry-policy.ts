/**
 * P1-R05 — the retry policy, kept pure on purpose.
 *
 * This module imports nothing: no `server-only`, no database, no fetch. That
 * is what makes AC-12 and AC-13 testable at all. The policy used to live
 * inside `client.ts` and `sync-worker.ts`, both of which pull in `server-only`
 * and a live `DATABASE_URL`, so the one decision worth testing -- retry or do
 * not retry -- could only be exercised against production.
 *
 * The split that matters is retryable vs not. Retrying a 400 only fails faster
 * (PROPOSED §9), and retrying a 412 is worse than useless: it is a conflict
 * that needs a human, and hammering it would turn one stale baseline into a
 * loop that never resolves.
 */

export type WordpressErrorKind =
  | "TRANSPORT" //        retryable: connection reset, DNS, TLS
  | "TIMEOUT" //          retryable
  | "SERVER" //           retryable: 5xx
  | "RATE_LIMITED" //     retryable, honour Retry-After
  | "IN_FLIGHT" //        retryable: 409 REQUEST_IN_FLIGHT, another worker owns it
  | "CONFLICT" //         NOT retryable: 412 precondition -- WordPress changed
  | "KEY_REUSED" //       NOT retryable: 409 IDEMPOTENCY_KEY_REUSED, a client bug
  | "VALIDATION" //       NOT retryable: 400
  | "FORBIDDEN" //        NOT retryable: 403 -- includes affiliate/verification refusals
  | "UNAUTHENTICATED" //  NOT retryable: 401 -- credential problem, not a blip
  | "NOT_FOUND" //        NOT retryable: 404
  | "DISABLED" //         retryable: 503, the namespace kill switch is off
  | "UNKNOWN";

/** AC-13. Anything not named here is not retried, so a new kind fails closed. */
const RETRYABLE_KINDS: ReadonlySet<WordpressErrorKind> = new Set<WordpressErrorKind>([
  "TRANSPORT",
  "TIMEOUT",
  "SERVER",
  "RATE_LIMITED",
  "IN_FLIGHT",
  "DISABLED",
]);

export function isRetryableKind(kind: WordpressErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

const RETRYABLE_CODES = new Set(["REQUEST_IN_FLIGHT", "RATE_LIMITED", "NAMESPACE_DISABLED", "WRITES_DISABLED"]);

export function classifyWordpressError(status: number, code: string): WordpressErrorKind {
  if (code === "REQUEST_IN_FLIGHT") return "IN_FLIGHT";
  if (code === "IDEMPOTENCY_KEY_REUSED") return "KEY_REUSED";
  if (code === "NAMESPACE_DISABLED" || code === "WRITES_DISABLED") return "DISABLED";

  switch (status) {
    case 400:
    case 415:
      return "VALIDATION";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return RETRYABLE_CODES.has(code) ? "IN_FLIGHT" : "KEY_REUSED";
    case 412:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "SERVER" : "UNKNOWN";
  }
}

/** AC-12. Bounded, and bounded deliberately: six attempts over roughly ten minutes. */
export const MAX_ATTEMPTS = 6;

export const BASE_BACKOFF_MS = 5_000;

/** The exponent stops growing here, so the delay has a ceiling rather than a trend. */
export const MAX_BACKOFF_EXPONENT = 6;

export const MAX_JITTER_MS = 1_000;

export function backoffMs(attempts: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  // Exponential with jitter. Jitter matters here because a queue drained after
  // an outage would otherwise re-hit WordPress in lockstep.
  const exp = BASE_BACKOFF_MS * 2 ** Math.min(Math.max(attempts, 0), MAX_BACKOFF_EXPONENT);
  return exp + Math.floor(Math.random() * MAX_JITTER_MS);
}
