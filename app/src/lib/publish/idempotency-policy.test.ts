/**
 * P4-R09 — publish idempotency and non-retryable failure handling.
 *
 * `G-51`: retry would create duplicate posts.
 * `G-53`: blind retry on a validation error is wrong.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyWordpressError, isRetryableKind } from "../wordpress/retry-policy";
import {
  DEFAULT_DESTINATION,
  INTENT_RESOLUTIONS,
  PUBLISH_STATES,
  buildOwnerAlert,
  decideReplay,
  publishIdempotencyKey,
  resolveFailure,
  resolveSuccess,
  shouldAlert,
  type PublishRecord,
} from "./idempotency-policy";

const HASH = "sha256:abc";
const EXISTING: PublishRecord = {
  idempotencyKey: publishIdempotencyKey("a1", "r1", DEFAULT_DESTINATION),
  wpPostId: 42,
  attempts: 1,
  state: "SUCCEEDED",
};

// ─── AC-01 / AC-02 ─────────────────────────────────────────────────

describe("AC-01 — keyed on article + revision + destination", () => {
  it("the same three inputs give the same key", () => {
    assert.equal(
      publishIdempotencyKey("a1", "r1", DEFAULT_DESTINATION),
      publishIdempotencyKey("a1", "r1", DEFAULT_DESTINATION),
    );
  });

  it("a different revision is a different key", () => {
    assert.notEqual(
      publishIdempotencyKey("a1", "r1", DEFAULT_DESTINATION),
      publishIdempotencyKey("a1", "r2", DEFAULT_DESTINATION),
    );
  });

  it("a different DESTINATION is a different key", () => {
    // Omitting the destination would make a second destination look like a
    // duplicate of the first and silently skip it.
    assert.notEqual(
      publishIdempotencyKey("a1", "r1", "wordpress:dongchannel.com"),
      publishIdempotencyKey("a1", "r1", "wordpress:staging"),
    );
  });

  it("keys cannot collide by concatenation", () => {
    // "a::b" + "c" and "a" + "b::c" must not produce the same string.
    assert.notEqual(
      publishIdempotencyKey("a::b", "c", "d"),
      publishIdempotencyKey("a", "b::c", "d"),
    );
  });
});

describe("AC-02 — a replay UPDATES, it never creates a second post", () => {
  it("no existing post means CREATE", () => {
    const d = decideReplay(null, HASH, null);
    assert.equal(d.action, "CREATE");
    assert.equal(d.wpPostId, null);
  });

  it("a record with no post id still means CREATE", () => {
    // A row can exist for an attempt that never succeeded. That is not a post.
    const d = decideReplay({ ...EXISTING, wpPostId: null }, HASH, null);
    assert.equal(d.action, "CREATE");
  });

  it("an existing post with CHANGED content means UPDATE, and names the post", () => {
    const d = decideReplay(EXISTING, "sha256:new", HASH);
    assert.equal(d.action, "UPDATE");
    assert.equal(d.wpPostId, 42);
  });

  it("an existing post with the SAME content means ALREADY_DONE, not UPDATE", () => {
    // A no-op "update" bumps post_modified, and P4-R08 AC-08 compares that to
    // detect human edits -- so the publisher would look like a human editor on
    // its next run, and block itself.
    const d = decideReplay(EXISTING, HASH, HASH);
    assert.equal(d.action, "ALREADY_DONE");
    assert.equal(d.wpPostId, 42);
  });

  it("no replay path CREATES when a post already exists", () => {
    // G-51 restated: the duplicate-post outcome is unreachable once a post id
    // is known, whatever the hashes say.
    for (const [incoming, last] of [[HASH, HASH], [HASH, "other"], [HASH, null]] as const) {
      const d = decideReplay(EXISTING, incoming, last);
      assert.notEqual(d.action, "CREATE", `CREATE reached with last=${last}`);
    }
  });
});

// ─── AC-03 / AC-04 ─────────────────────────────────────────────────

describe("AC-03/AC-04 — the classifier is TD-21's, not a second one", () => {
  it("classification comes from the existing WordPress classifier", () => {
    // Reimplementing it here would create two classifiers that can disagree --
    // the failure P4-R07 AC-06 names for QA, in a second place.
    assert.equal(isRetryableKind(classifyWordpressError(500, "")), true);
    assert.equal(isRetryableKind(classifyWordpressError(400, "rest_invalid_param")), false);
  });

  it("a NON-retryable failure is not retried, and asks for a person", () => {
    // G-53 by name. A validation error fails identically forever, and retrying
    // burns quota to produce the same message.
    const o = resolveFailure(false, false);
    assert.equal(o.publishState, "FAILED_REQUIRES_ATTENTION");
    assert.equal(o.intent, "CANCEL");
    assert.equal(o.alertOwner, true);
  });

  it("a retryable failure with attempts left keeps retrying", () => {
    const o = resolveFailure(true, false);
    assert.equal(o.publishState, "FAILED_RETRYING");
    assert.equal(o.alertOwner, false);
  });

  it("exhausting the budget is TERMINAL, not an infinite loop", () => {
    const o = resolveFailure(true, true);
    assert.equal(o.publishState, "FAILED_REQUIRES_ATTENTION");
    assert.equal(o.intent, "CANCEL");
  });

  it("FAILED_RETRYING and FAILED_REQUIRES_ATTENTION are different states", () => {
    // One waits for a timer, the other for a person. A single FAILED would
    // make "what is stuck" unanswerable.
    assert.notEqual(resolveFailure(true, false).publishState,
                    resolveFailure(false, false).publishState);
  });
});

// ─── AC-07 ─────────────────────────────────────────────────────────

describe("AC-07 — a failed publish resolves its intent honestly", () => {
  it("a terminal failure CANCELS the intent — the lock is released", () => {
    // Leaving it OPEN forever would hold the per-article lock so nothing could
    // ever publish that article again.
    for (const o of [resolveFailure(false, false), resolveFailure(true, true)]) {
      assert.equal(o.intent, "CANCEL");
    }
  });

  it("a failed publish is NEVER marked CONSUMED", () => {
    // CONSUMED says the publish happened.
    for (const o of [resolveFailure(false, false), resolveFailure(true, false), resolveFailure(true, true)]) {
      assert.notEqual(o.intent, "CONSUME");
    }
  });

  it("a retry in progress leaves the intent OPEN, and that is correct", () => {
    // The publish is not finished, and the lock is doing its job: nothing else
    // should publish this article while an attempt is in flight.
    assert.equal(resolveFailure(true, false).intent, "LEAVE_OPEN");
  });

  it("only a SUCCESS consumes", () => {
    assert.equal(resolveSuccess().intent, "CONSUME");
    assert.equal(resolveSuccess().publishState, "SUCCEEDED");
  });

  it("every intent resolution is reachable", () => {
    const seen = new Set([
      resolveFailure(true, false).intent,
      resolveFailure(false, false).intent,
      resolveSuccess().intent,
    ]);
    assert.deepEqual([...seen].sort(), [...INTENT_RESOLUTIONS].sort());
  });
});

// ─── AC-05 ─────────────────────────────────────────────────────────

describe("AC-05 — the owner is told, and told something useful", () => {
  it("only terminal failures alert", () => {
    // A retry happening in thirty seconds is not news, and alerting on every
    // transient error teaches the owner to ignore the channel.
    assert.equal(shouldAlert(resolveFailure(true, false)), false);
    assert.equal(shouldAlert(resolveFailure(false, false)), true);
    assert.equal(shouldAlert(resolveFailure(true, true)), true);
    assert.equal(shouldAlert(resolveSuccess()), false);
  });

  it("the alert names the article, the revision, the state and WHY", () => {
    const msg = buildOwnerAlert({
      articleId: "a1", revisionId: "r1",
      state: "FAILED_REQUIRES_ATTENTION",
      reason: "non-retryable failure — a person has to change something",
      attempts: 1,
    });
    assert.match(msg, /a1/);
    assert.match(msg, /r1/);
    assert.match(msg, /FAILED_REQUIRES_ATTENTION/);
    assert.match(msg, /non-retryable/);
    // "publish failed" alone is not something anyone can act on.
    assert.ok(msg.length > 60);
  });

  it("the alert carries no content and no credential", () => {
    // It goes over Telegram, and P3-R06 AC-05 holds that ids travel and values
    // do not.
    const msg = buildOwnerAlert({
      articleId: "a1", revisionId: "r1", state: "FAILED_REQUIRES_ATTENTION",
      reason: "rest_invalid_param", attempts: 3,
    });
    assert.equal(/sk-|Bearer|password|token/i.test(msg), false);
  });
});

// ─── AC-08: CONTROL ────────────────────────────────────────────────

describe("AC-08 — CONTROL: the classifier is not answering one way", () => {
  it("a retryable failure IS retried and CAN then succeed", () => {
    const retrying = resolveFailure(true, false);
    assert.equal(retrying.publishState, "FAILED_RETRYING");
    // And the next attempt reaching success is a normal outcome.
    assert.equal(resolveSuccess().publishState, "SUCCEEDED");
  });

  it("a non-retryable failure is NOT retried at all", () => {
    assert.equal(resolveFailure(false, false).publishState, "FAILED_REQUIRES_ATTENTION");
  });

  it("both directions are reachable from real WordPress errors", () => {
    // Not a hypothetical boolean: 503 is retryable and a 400 validation error
    // is not, per TD-21's classifier.
    const transient = resolveFailure(isRetryableKind(classifyWordpressError(503, "")), false);
    const permanent = resolveFailure(isRetryableKind(classifyWordpressError(400, "rest_invalid_param")), false);
    assert.equal(transient.publishState, "FAILED_RETRYING");
    assert.equal(permanent.publishState, "FAILED_REQUIRES_ATTENTION");
  });

  it("every publish state is reachable", () => {
    const seen = new Set<string>([
      resolveSuccess().publishState,
      resolveFailure(true, false).publishState,
      resolveFailure(false, false).publishState,
    ]);
    // PENDING and IN_FLIGHT are set by the runner rather than by a resolution,
    // and are asserted present in the vocabulary rather than produced here.
    assert.ok(PUBLISH_STATES.includes("PENDING"));
    assert.ok(PUBLISH_STATES.includes("IN_FLIGHT"));
    assert.equal(seen.size, 3);
  });
});
