import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  decideRetry,
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

// ─── TD-21 — the state machine's wiring, now reachable ────────────
//
// TD-21 was recorded at P1 closure because these branches lived inside
// `sync-worker.ts` (server-only + a live DATABASE_URL) and could only be
// exercised against production. `decideRetry` is that decision, extracted.

const T0 = new Date("2026-08-20T00:00:00.000Z");

test("TD-21: a non-retryable error stops immediately, whatever the attempt count", () => {
  for (const attemptsMade of [1, 3, 99]) {
    const d = decideRetry({ retryable: false, attemptsMade, now: T0 });
    assert.equal(d.action, "FAIL_PERMANENT");
    // The reason matters: "we were never going to try" is a different
    // operational fact from "we ran out of attempts".
    assert.equal(d.action === "FAIL_PERMANENT" && d.reason, "NOT_RETRYABLE");
  }
});

test("TD-21: attempts are exhausted AT the maximum, not one past it", () => {
  const last = decideRetry({ retryable: true, attemptsMade: MAX_ATTEMPTS - 1, now: T0 });
  assert.equal(last.action, "RETRY", "one attempt short of the max must still retry");

  const done = decideRetry({ retryable: true, attemptsMade: MAX_ATTEMPTS, now: T0 });
  assert.equal(done.action, "FAIL_PERMANENT");
  assert.equal(done.action === "FAIL_PERMANENT" && done.reason, "ATTEMPTS_EXHAUSTED");
});

test("TD-21: the next attempt is scheduled forward from the supplied clock", () => {
  const d = decideRetry({ retryable: true, attemptsMade: 1, now: T0 });
  assert.equal(d.action, "RETRY");
  if (d.action !== "RETRY") return;
  assert.ok(d.nextAttemptAt.getTime() > T0.getTime(), "a retry must be scheduled in the future");
});

test("TD-21: Retry-After is honoured by the state machine, not just by backoffMs", () => {
  const withHeader = decideRetry({
    retryable: true, attemptsMade: 1, retryAfterSeconds: 600, now: T0,
  });
  const without = decideRetry({ retryable: true, attemptsMade: 1, now: T0 });
  assert.ok(withHeader.action === "RETRY" && without.action === "RETRY");
  if (withHeader.action !== "RETRY" || without.action !== "RETRY") return;
  assert.ok(
    withHeader.nextAttemptAt.getTime() > without.nextAttemptAt.getTime(),
    "a server asking for ten minutes must push the retry further out",
  );
});

test("TD-21: retryability is checked BEFORE the attempt count", () => {
  // A 412 conflict does not become retryable because attempts remain.
  const d = decideRetry({ retryable: false, attemptsMade: 0, now: T0 });
  assert.equal(d.action === "FAIL_PERMANENT" && d.reason, "NOT_RETRYABLE");
});

test("TD-21 CONTROL: the two permanent-failure reasons are distinguishable", () => {
  const reasons = new Set(
    [
      decideRetry({ retryable: false, attemptsMade: 1, now: T0 }),
      decideRetry({ retryable: true, attemptsMade: MAX_ATTEMPTS, now: T0 }),
      decideRetry({ retryable: true, attemptsMade: 1, now: T0 }),
    ].map((d) => (d.action === "RETRY" ? "RETRY" : d.reason)),
  );
  assert.deepEqual([...reasons].sort(), ["ATTEMPTS_EXHAUSTED", "NOT_RETRYABLE", "RETRY"]);
});

test("TD-21: the worker really calls it — the decision is not a parallel copy", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/wordpress/sync-worker.ts"), "utf8");
  assert.ok(src.includes("decideRetry("), "the worker must use the extracted decision");
  // And must not have kept the old inline branch beside it.
  assert.equal(
    /job\.attempts \+ 1 < MAX_ATTEMPTS/.test(src),
    false,
    "the inline retry branch must be gone, not duplicated",
  );
});
