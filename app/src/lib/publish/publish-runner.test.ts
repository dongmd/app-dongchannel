/**
 * `P4-R09 AC-04`/`AC-05`/`AC-07` — the failure path, driven end to end.
 *
 * These exercise the REAL modules: the real WordPress classifier, the real
 * `resolveFailure`, the real `buildOwnerAlert`, and the real routing and
 * refusal rules from `outbound-policy`. Only the four things that touch the
 * world are fakes -- the clock, the intent writer, the audit sink and the
 * insert.
 *
 * That matters for what they can claim. They do not prove a production
 * publish; they prove that when one fails, the chain from the error to a queued
 * alert is joined and behaves. The delivery leg beyond the queue was verified
 * separately, in production.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MAX_ATTEMPTS } from "@/lib/wordpress/retry-policy";
import { prepareAlert, routeToProfile } from "@/lib/notify/outbound-policy";
import { shouldAlert } from "./idempotency-policy";
import {
  previewOwnerAlert,
  resolvePublishFailure,
  type AuditEntry,
  type PublishAttemptFailure,
  type PublishRunnerDeps,
} from "./publish-runner";

const NOW = new Date("2026-08-30T12:00:00Z");

function harness(over: Partial<PublishRunnerDeps> = {}) {
  const cancelled: { id: string; at: Date }[] = [];
  const audits: AuditEntry[] = [];
  // The fake queue runs the REAL prepareAlert, so a body this chain composes
  // that the queue would refuse fails here rather than in production.
  const queued: { profile: string; body: string }[] = [];
  // Counted separately from `queued`. The runner has its OWN alertOwner guard
  // and `queueOwnerAlert` has `shouldAlert` -- defence in depth, but it means
  // outcome assertions cannot see which guard did the work. Mutation proved it:
  // replacing the runner's guard with `if (true)` killed no test, because the
  // fake below refused the alert exactly as the real queue would.
  const alertCalls: string[] = [];
  const deps: PublishRunnerDeps = {
    now: () => NOW,
    cancelIntent: async (id, at) => { cancelled.push({ id, at }); },
    recordAudit: async (e) => { audits.push(e); },
    queueAlert: async (outcome, alert, entityType) => {
      alertCalls.push(outcome.publishState);
      if (!shouldAlert(outcome)) return { ok: true, queued: false, reason: "NOT_ALERTABLE" };
      const v = prepareAlert(entityType, alert.articleId, previewOwnerAlert(
        { ...FAILURE, articleId: alert.articleId, revisionId: alert.revisionId, attempts: alert.attempts },
        outcome,
      ));
      if (!v.ok) return { ok: false, reason: v.reason };
      if (queued.some((q) => q.body === v.alert.body)) {
        return { ok: true, queued: false, reason: "ALREADY_QUEUED" };
      }
      queued.push({ profile: v.alert.profile, body: v.alert.body });
      return { ok: true, queued: true };
    },
    ...over,
  };
  return { deps, cancelled, audits, queued, alertCalls };
}

const FAILURE: PublishAttemptFailure = {
  intentId: "intent-1",
  articleId: "art-1",
  revisionId: "rev-1",
  status: 400,
  code: "rest_invalid_param",
  attempts: 1,
};

// ─── AC-04: a validation error is terminal ─────────────────────────

describe("a non-retryable failure ends the attempt and tells the owner", () => {
  it("cancels the intent, audits, and queues one alert", async () => {
    const h = harness();
    const r = await resolvePublishFailure(FAILURE, h.deps);

    assert.equal(r.outcome.publishState, "FAILED_REQUIRES_ATTENTION");
    assert.equal(r.intentCancelled, true);
    assert.equal(r.alertQueued, true);
    assert.deepEqual(h.cancelled, [{ id: "intent-1", at: NOW }]);
    assert.equal(h.queued.length, 1);
  });

  it("the alert goes to the AFF assistant, because an article is AFF work", async () => {
    const h = harness();
    await resolvePublishFailure(FAILURE, h.deps);
    assert.equal(h.queued[0]!.profile, "aff");
    assert.equal(routeToProfile("article"), "aff");
  });

  it("the alert says WHY, names the article and the revision, and gives the count", async () => {
    // "Publish failed" satisfies nothing. AC-05's second sentence is the
    // requirement: a failure nobody is told about is a failure that waits.
    const h = harness();
    await resolvePublishFailure({ ...FAILURE, attempts: 2 }, h.deps);
    const body = h.queued[0]!.body;
    assert.match(body, /art-1/);
    assert.match(body, /rev-1/);
    assert.match(body, /FAILED_REQUIRES_ATTENTION/);
    assert.match(body, /2/);
    assert.ok(body.length >= 40, "the queue would refuse a body this thin");
  });

  it("the audit records the error KIND, never the WordPress message", async () => {
    // A message can quote the request, and the request carries the integration
    // credential.
    const h = harness();
    await resolvePublishFailure(FAILURE, h.deps);
    const a = h.audits[0]!;
    assert.equal(a.action, "PUBLISH_FAILED");
    assert.equal(a.entityId, "intent-1");
    assert.match(a.detail, /intent CANCEL/);
    assert.equal(/rest_invalid_param/.test(a.detail), false, "the raw WP code leaked into the audit");
  });
});

// ─── AC-06: exhausting the budget is terminal too ──────────────────

describe("a retryable failure alerts only once the budget is gone", () => {
  it("CONTROL: a retryable failure with attempts left does NOT alert and does NOT cancel", async () => {
    // Without this, "it alerted" would prove nothing -- everything would alert,
    // and the channel that carries real failures would be the one the owner
    // has learned to ignore.
    const h = harness();
    const r = await resolvePublishFailure({ ...FAILURE, status: 503, code: "", attempts: 1 }, h.deps);

    assert.equal(r.outcome.publishState, "FAILED_RETRYING");
    assert.equal(r.intentCancelled, false, "a retry must keep its lock -- the attempt is not finished");
    assert.equal(r.alertQueued, false);
    assert.equal(h.queued.length, 0);
    assert.equal(h.cancelled.length, 0);
    // The runner must not even ASK. Asserting only that nothing was queued
    // would pass on a runner that alerts unconditionally and leans on the
    // queue to refuse -- which is a second place for the rule to live and a
    // second place for it to change.
    assert.deepEqual(h.alertCalls, [], "the runner called the alert queue for a retryable failure");
    // It is still audited: an attempt that happened is a fact.
    assert.equal(h.audits.length, 1);
  });

  it("the same failure at the attempt ceiling cancels and alerts", async () => {
    const h = harness();
    const r = await resolvePublishFailure(
      { ...FAILURE, status: 503, code: "", attempts: MAX_ATTEMPTS }, h.deps);

    assert.equal(r.outcome.publishState, "FAILED_REQUIRES_ATTENTION");
    assert.equal(r.outcome.reason, "retry budget exhausted");
    assert.equal(r.intentCancelled, true);
    assert.equal(r.alertQueued, true);
  });

  it("the ceiling comes from TD-21, not from a literal here", async () => {
    // AC-06: bounded and CONFIGURED. A literal in this file would drift from
    // the backoff that actually governs the retries.
    const h = harness();
    const below = await resolvePublishFailure(
      { ...FAILURE, status: 503, code: "", attempts: MAX_ATTEMPTS - 1 }, h.deps);
    assert.equal(below.outcome.publishState, "FAILED_RETRYING");
  });
});

// ─── AC-07: the intent is resolved honestly ────────────────────────

describe("a failed publish never leaves the lock held and never claims success", () => {
  it("it cancels -- it does not CONSUME, which would say the publish happened", async () => {
    const h = harness();
    const r = await resolvePublishFailure(FAILURE, h.deps);
    assert.equal(r.outcome.intent, "CANCEL");
    assert.notEqual(r.outcome.intent as string, "CONSUME");
  });

  it("the intent is resolved BEFORE the alert is queued", async () => {
    // If the alert went first and the cancel then failed, the owner would be
    // told about a failure whose intent still holds the per-article lock -- a
    // message that makes a stuck system look handled.
    const order: string[] = [];
    const h = harness({
      cancelIntent: async () => { order.push("cancel"); },
      queueAlert: async () => { order.push("alert"); return { ok: true, queued: true }; },
      recordAudit: async () => { order.push("audit"); },
    });
    await resolvePublishFailure(FAILURE, h.deps);
    assert.deepEqual(order, ["cancel", "audit", "alert"]);
  });

  it("a failure to queue the alert does NOT undo the resolution", async () => {
    // The failure stays recorded and visible in the Ops Hub. A lost alert
    // delays the owner; an unresolved intent blocks the article forever.
    const h = harness({
      queueAlert: async () => { throw new Error("queue unreachable"); },
    });
    await assert.rejects(() => resolvePublishFailure(FAILURE, h.deps));
    assert.equal(h.cancelled.length, 1, "the intent was left OPEN by an alerting failure");
    assert.equal(h.audits.length, 1, "the attempt went unaudited because the alert failed");
  });
});

// ─── The duplicate the ledger must absorb ──────────────────────────

describe("the same failure read twice tells the owner once", () => {
  it("a second resolution of the identical failure queues nothing new", async () => {
    const h = harness();
    await resolvePublishFailure(FAILURE, h.deps);
    const second = await resolvePublishFailure(FAILURE, h.deps);
    assert.equal(second.alertQueued, false);
    assert.equal(second.alertNote, "ALREADY_QUEUED");
    assert.equal(h.queued.length, 1, "the owner was told twice about one failure");
  });

  it("a DIFFERENT failure on the same article is still its own alert", async () => {
    // CONTROL for the case above: dedup that swallowed distinct failures would
    // be worse than no dedup, because the second failure would vanish.
    //
    // The second failure must be TERMINAL to be comparable. The first version
    // of this case used a retryable 503, which is not alertable at all -- so it
    // failed for the right reason and would have proven nothing had it passed.
    const h = harness();
    await resolvePublishFailure(FAILURE, h.deps);
    await resolvePublishFailure({ ...FAILURE, attempts: 4 }, h.deps);
    assert.equal(h.queued.length, 2);
    assert.notEqual(h.queued[0]!.body, h.queued[1]!.body);
  });
});
