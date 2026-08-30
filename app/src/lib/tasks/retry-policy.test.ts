/**
 * P4-R12 — task recovery.
 *
 * The formalization of `DC-015`: a promise shown to a user in production that
 * named a story id existing in no register. This is that promise, owned.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RETRYABLE_STATES,
  RETRY_INELIGIBLE,
  RETRY_POLICY,
  RETRY_ROLES,
  STATUS_TRANSPORTS,
  authorizeRetry,
  buildRetryAttempt,
  describeFreshness,
  retryEligibility,
  type RetryRequester,
} from "./retry-policy";

const NOW = new Date("2026-08-30T12:00:00Z");
const OWNER: RetryRequester = { userId: "u1", role: "OWNER", profiles: null };

function task(status: string, retryCount = 0) {
  return { id: "t1", status, retryCount };
}

// ─── AC-01 ─────────────────────────────────────────────────────────

describe("AC-01 — eligibility is decided in one place, and names what blocked it", () => {
  it("a FAILED task is eligible", () => {
    const e = retryEligibility(task("FAILED"));
    assert.equal(e.ok, true);
    assert.equal(e.ok === true && e.attempt, 1);
    assert.equal(e.ok === true && e.from, "FAILED");
  });

  it("SYNC_DELAYED is eligible — a transport failure, not a task failure", () => {
    // The work may well have succeeded upstream and the projection simply did
    // not arrive.
    assert.equal(retryEligibility(task("SYNC_DELAYED")).ok, true);
  });

  it("a RUNNING task is refused, and the reason says so", () => {
    const e = retryEligibility(task("RUNNING"));
    assert.equal(e.ok, false);
    assert.equal(e.ok === false && e.reason, "TASK_STILL_RUNNING");
    assert.equal(e.ok === false && e.detail, "RUNNING");
  });

  it("a task that already succeeded is refused", () => {
    for (const s of ["COMPLETED", "APPROVED"]) {
      const e = retryEligibility(task(s));
      assert.equal(e.ok === false && e.reason, "TASK_ALREADY_SUCCEEDED");
    }
  });

  it("a CANCELLED task is refused — retrying would undo a decision", () => {
    // Somebody stopped it on purpose. Restarting cancelled work is a NEW task.
    const e = retryEligibility(task("CANCELLED"));
    assert.equal(e.ok === false && e.reason, "TASK_WAS_CANCELLED");
  });

  it("a task waiting on a person is refused", () => {
    // It is not stuck; retrying would discard a review in progress.
    for (const s of ["WAITING_REVIEW", "REVISION_REQUESTED"]) {
      assert.equal(retryEligibility(task(s)).ok === false, true);
    }
    assert.equal(
      (retryEligibility(task("WAITING_REVIEW")) as { reason: string }).reason,
      "TASK_AWAITING_REVIEW",
    );
  });

  it("a missing task is refused before anything else", () => {
    assert.equal((retryEligibility(null) as { reason: string }).reason, "TASK_NOT_FOUND");
  });

  it("every ineligible reason is reachable", () => {
    const seen = new Set<string>();
    for (const t of [null, task("RUNNING"), task("COMPLETED"), task("CANCELLED"),
                     task("WAITING_REVIEW"), task("IMPORTED"), task("FAILED", 3)]) {
      const e = retryEligibility(t);
      if (!e.ok) seen.add(e.reason);
    }
    assert.deepEqual([...seen].sort(), [...RETRY_INELIGIBLE].sort());
  });
});

// ─── AC-04 ─────────────────────────────────────────────────────────

describe("AC-04 — bounded, versioned, and exhaustion is its own reason", () => {
  it("the bound is versioned configuration", () => {
    assert.equal(typeof RETRY_POLICY.version, "number");
    assert.ok(RETRY_POLICY.maxAttempts > 0);
  });

  it("retries are allowed up to the bound and refused past it", () => {
    for (let n = 0; n < RETRY_POLICY.maxAttempts; n++) {
      assert.equal(retryEligibility(task("FAILED", n)).ok, true, `attempt ${n + 1} refused`);
    }
    const e = retryEligibility(task("FAILED", RETRY_POLICY.maxAttempts));
    assert.equal(e.ok, false);
    assert.equal(e.ok === false && e.reason, "RETRY_BUDGET_EXHAUSTED");
  });

  it("exhaustion is DISTINCT from a permission failure", () => {
    // They need completely different responses: one is "wait or escalate", the
    // other is "you are not allowed". A shared reason would conflate them.
    const exhausted = retryEligibility(task("FAILED", 99));
    const forbidden = authorizeRetry({ ...OWNER, role: "VIEWER" }, null);
    assert.notEqual(
      (exhausted as { reason: string }).reason,
      (forbidden as { reason: string }).reason,
    );
  });

  it("the attempt number counts from 1, not 0", () => {
    // The ORIGINAL run is not an attempt of this table. Numbering it 0 invites
    // an off-by-one every time someone compares against the bound.
    assert.equal((retryEligibility(task("FAILED", 0)) as { attempt: number }).attempt, 1);
    assert.equal((retryEligibility(task("FAILED", 2)) as { attempt: number }).attempt, 3);
  });
});

// ─── AC-02 ─────────────────────────────────────────────────────────

describe("AC-02 — authorization, decided before anything runs", () => {
  it("an unauthenticated caller is refused", () => {
    const a = authorizeRetry({ userId: null, role: "OWNER", profiles: null }, null);
    assert.equal(a.ok, false);
    assert.equal(a.ok === false && a.reason, "NOT_AUTHENTICATED");
  });

  it("a role outside the permitted set is refused", () => {
    for (const role of ["VIEWER", "EDITOR", null, ""]) {
      const a = authorizeRetry({ userId: "u1", role, profiles: null }, null);
      assert.equal(a.ok, false, `role ${role} was allowed`);
    }
  });

  it("CONTROL — every permitted role IS allowed", () => {
    for (const role of RETRY_ROLES) {
      assert.equal(authorizeRetry({ userId: "u1", role, profiles: null }, null).ok, true);
    }
  });

  it("`null` profiles means no per-user restriction exists — not 'no access'", () => {
    // This codebase has no per-user profile allowlist: session.user carries a
    // role and nothing else. Passing `[]` would refuse every task with a
    // profile and break retry while LOOKING like security.
    assert.equal(authorizeRetry(OWNER, "aff").ok, true);
    assert.equal(authorizeRetry(OWNER, null).ok, true);
  });

  it("when a profile list IS supplied it is enforced, and fails closed", () => {
    const scoped: RetryRequester = { userId: "u1", role: "OWNER", profiles: ["aff"] };
    assert.equal(authorizeRetry(scoped, "aff").ok, true);
    assert.equal(authorizeRetry(scoped, "yt").ok, false);
    // A task with NO profile is refused rather than treated as "any".
    assert.equal(authorizeRetry(scoped, null).ok, false);
  });
});

// ─── AC-03 ─────────────────────────────────────────────────────────

describe("AC-03 — a retry is a new attempt, not a rewritten history", () => {
  it("the record names who, when, and from which failure", () => {
    const e = retryEligibility(task("FAILED", 1));
    const r = buildRetryAttempt("t1", e as never, "u1", NOW);
    assert.equal(r.taskId, "t1");
    assert.equal(r.attempt, 2);
    assert.equal(r.fromStatus, "FAILED");
    assert.equal(r.requestedBy, "u1");
    assert.equal(r.requestedAt, NOW);
    assert.equal(r.policyVersion, RETRY_POLICY.version);
  });

  it("the record has NO field naming a previous attempt to overwrite", () => {
    // The evidence of WHY it failed is the thing a person retrying most needs,
    // and the thing they lose exactly when they need it.
    const e = retryEligibility(task("FAILED"));
    const r = buildRetryAttempt("t1", e as never, "u1", NOW);
    for (const f of ["previousAttemptId", "replaces", "supersedes", "overwrite"]) {
      assert.equal(f in r, false, `the record carries \`${f}\``);
    }
  });

  it("two retries of the same task produce DIFFERENT attempt numbers", () => {
    const first = buildRetryAttempt("t1", retryEligibility(task("FAILED", 0)) as never, "u1", NOW);
    const second = buildRetryAttempt("t1", retryEligibility(task("FAILED", 1)) as never, "u1", NOW);
    assert.notEqual(first.attempt, second.attempt);
  });

  it("the from-status is carried per attempt, so a changing failure is readable", () => {
    const a = buildRetryAttempt("t1", retryEligibility(task("FAILED", 0)) as never, "u1", NOW);
    const b = buildRetryAttempt("t1", retryEligibility(task("SYNC_DELAYED", 1)) as never, "u1", NOW);
    assert.equal(a.fromStatus, "FAILED");
    assert.equal(b.fromStatus, "SYNC_DELAYED");
  });
});

// ─── AC-06 ─────────────────────────────────────────────────────────

describe("AC-06 — the surface is honest about how current it is", () => {
  it("the transport is a value the surface must carry, not an assumption", () => {
    assert.deepEqual([...STATUS_TRANSPORTS], ["STREAM", "POLL", "NONE"]);
  });

  it("each transport describes itself differently", () => {
    const s = describeFreshness({ transport: "STREAM", asOf: NOW, pollIntervalMs: null });
    const p = describeFreshness({ transport: "POLL", asOf: NOW, pollIntervalMs: 5000 });
    const n = describeFreshness({ transport: "NONE", asOf: NOW, pollIntervalMs: null });
    assert.notEqual(s, p);
    assert.notEqual(p, n);
    assert.match(p, /5s/);
    // NONE says so plainly rather than showing a stale value as current.
    assert.match(n, /tải lại|không tự cập nhật/);
  });

  it("a poll interval is stated in the description, not hidden", () => {
    assert.match(describeFreshness({ transport: "POLL", asOf: NOW, pollIntervalMs: 30000 }), /30s/);
  });
});

// ─── AC-07: CONTROL ────────────────────────────────────────────────

describe("AC-07 — CONTROL: an eligible task, an authorized owner, and it works", () => {
  it("the happy path produces an attempt", () => {
    // Without this every refusal above is satisfied by a policy that refuses
    // everything -- and retry would be a button that never works, which is
    // exactly what DC-015 promised not to be.
    const auth = authorizeRetry(OWNER, "aff");
    assert.equal(auth.ok, true);

    const e = retryEligibility(task("FAILED"));
    assert.equal(e.ok, true);

    const r = buildRetryAttempt("t1", e as never, OWNER.userId!, NOW);
    assert.equal(r.attempt, 1);
  });

  it("every retryable state can actually be retried", () => {
    for (const s of RETRYABLE_STATES) {
      assert.equal(retryEligibility(task(s)).ok, true, `${s} could not be retried`);
    }
  });
});
