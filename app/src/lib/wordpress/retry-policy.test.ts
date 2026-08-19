import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backoffMs,
  BASE_BACKOFF_MS,
  classifyWordpressError,
  isRetryableKind,
  MAX_ATTEMPTS,
  MAX_BACKOFF_EXPONENT,
  MAX_JITTER_MS,
  type WordpressErrorKind,
} from "./retry-policy";

// P1-R05 AC-12 and AC-13. These are the two criteria the production E2E cannot
// prove: making WordPress time out or return 500 on demand is not something to
// arrange against a live site.

// ── AC-13 · what is retried, and what is never retried ───────────────────

test("AC-13: transient kinds retry", () => {
  for (const kind of ["TRANSPORT", "TIMEOUT", "SERVER", "RATE_LIMITED", "IN_FLIGHT", "DISABLED"] as const) {
    assert.equal(isRetryableKind(kind), true, `${kind} should retry`);
  }
});

test("AC-13: a conflict, a refusal or a client bug is never retried", () => {
  for (const kind of ["CONFLICT", "KEY_REUSED", "VALIDATION", "FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND", "UNKNOWN"] as const) {
    assert.equal(isRetryableKind(kind), false, `${kind} must not retry`);
  }
});

test("AC-13: a kind nobody classified fails closed", () => {
  // The allowlist is the mechanism: a kind added later is not retried until
  // someone puts it in RETRYABLE_KINDS on purpose.
  assert.equal(isRetryableKind("NOT_A_REAL_KIND" as WordpressErrorKind), false);
});

test("AC-14: 412 classifies as CONFLICT and CONFLICT does not retry", () => {
  const kind = classifyWordpressError(412, "PRECONDITION_FAILED");
  assert.equal(kind, "CONFLICT");
  assert.equal(isRetryableKind(kind), false);
});

test("AC-13: each non-retryable status maps to a non-retryable kind", () => {
  const cases: Array<[number, string]> = [
    [400, "VALIDATION_ERROR"],
    [401, "rest_not_logged_in"],
    [403, "FORBIDDEN_FIELD"],
    [404, "NOT_FOUND"],
    [409, "IDEMPOTENCY_KEY_REUSED"],
    [412, "PRECONDITION_FAILED"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
  ];
  for (const [status, code] of cases) {
    assert.equal(isRetryableKind(classifyWordpressError(status, code)), false, `${status} ${code} must not retry`);
  }
});

test("AC-12: each retryable status maps to a retryable kind", () => {
  const cases: Array<[number, string]> = [
    [429, "RATE_LIMITED"],
    [500, "INTERNAL"],
    [502, "BAD_GATEWAY"],
    [503, "NAMESPACE_DISABLED"],
    [409, "REQUEST_IN_FLIGHT"],
  ];
  for (const [status, code] of cases) {
    assert.equal(isRetryableKind(classifyWordpressError(status, code)), true, `${status} ${code} should retry`);
  }
});

test("AC-13: a 409 is read by code, not by status", () => {
  // The same status means "someone else is mid-write, come back" and "you sent
  // one key with two payloads". One retries; the other is a bug that would
  // retry forever.
  assert.equal(classifyWordpressError(409, "REQUEST_IN_FLIGHT"), "IN_FLIGHT");
  assert.equal(classifyWordpressError(409, "IDEMPOTENCY_KEY_REUSED"), "KEY_REUSED");
});

// ── AC-12 · the backoff is exponential, jittered and bounded ─────────────

test("AC-12: the attempt count is capped", () => {
  assert.equal(MAX_ATTEMPTS, 6);
});

test("AC-12: backoff grows exponentially with the attempt", () => {
  for (let n = 1; n < MAX_BACKOFF_EXPONENT; n += 1) {
    const lo = backoffMs(n);
    const hi = backoffMs(n + 1);
    // Compare floors, so jitter cannot make an interval look non-monotonic.
    assert.ok(hi - MAX_JITTER_MS >= lo, `attempt ${n + 1} (${hi}) must exceed attempt ${n} (${lo})`);
  }
});

test("AC-12: backoff is bounded -- the exponent stops growing", () => {
  const ceiling = BASE_BACKOFF_MS * 2 ** MAX_BACKOFF_EXPONENT + MAX_JITTER_MS;
  for (const attempts of [MAX_BACKOFF_EXPONENT, 7, 20, 1000]) {
    assert.ok(backoffMs(attempts) <= ceiling, `attempt ${attempts} exceeded the ceiling`);
  }
});

test("AC-12: backoff is jittered, not lockstep", () => {
  // A queue drained after an outage must not re-hit WordPress in unison.
  const seen = new Set(Array.from({ length: 200 }, () => backoffMs(3)));
  assert.ok(seen.size > 1, "backoff produced one identical value 200 times");
});

test("AC-12: Retry-After wins over the computed backoff", () => {
  assert.equal(backoffMs(1, 90), 90_000);
  assert.equal(backoffMs(6, 5), 5_000);
});

test("AC-12: a nonsensical Retry-After falls back to the computed backoff", () => {
  for (const bad of [0, -1, Number.NaN]) {
    const ms = backoffMs(2, bad);
    assert.ok(ms >= BASE_BACKOFF_MS * 4, `Retry-After=${bad} produced ${ms}`);
  }
});

test("AC-12: a negative attempt count cannot produce a sub-base delay", () => {
  assert.ok(backoffMs(-5) >= BASE_BACKOFF_MS);
});
