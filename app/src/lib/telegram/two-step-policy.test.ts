/**
 * P3-R05 — two-step Approve → Confirm.
 *
 * `AC-09` is a CONTROL rather than a feature: the suite has to prove that step 1
 * alone cannot publish. It is not enough for step 1 to return an empty effect
 * list — that would be satisfied by a step 1 that did nothing *and* by one whose
 * effects were simply not reported. So the control runs step 1 and then asserts
 * against the full vocabulary of things that could have happened.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ACTION_ID_PATTERN, makeActionId } from "./callback-policy";
import {
  CONFIRM_OUTCOMES,
  CONFIRM_STEPS,
  P3_PUBLISHES,
  P3_STOPS_AT,
  PENDING_STATES,
  STEP1_REFUSALS,
  beginApprove,
  cancelApprove,
  confirmPublish,
  confirmationSummary,
  isActionId,
  type PendingAction,
} from "./two-step-policy";

const ACTION = "act_" + "a".repeat(32);
const NOW = new Date("2026-08-22T12:00:00Z");
const OWNER = 4242;
const TTL = 10 * 60 * 1000;

function begin(over: Partial<Record<string, unknown>> = {}) {
  return beginApprove(
    {
      actionId: ACTION,
      issuedTo: OWNER,
      articleId: "art-1",
      revisionId: "rev-7",
      destination: "dongchannel.com/blog",
      payloadHash: "h-abc",
      ttlMs: TTL,
      ...over,
    },
    NOW,
  );
}

function pending(over: Partial<PendingAction> = {}): PendingAction {
  const r = begin();
  assert.equal(r.ok, true);
  return { ...(r as { pending: PendingAction }).pending, ...over };
}

function confirmWith(over: Partial<Parameters<typeof confirmPublish>[0]> = {}, now = NOW) {
  return confirmPublish(
    {
      pending: pending(),
      fromId: OWNER,
      articleId: "art-1",
      currentRevisionId: "rev-7",
      currentHash: "h-abc",
      ...over,
    },
    now,
  );
}

describe("P3-R05 AC-01: step 1 never acts", () => {
  it("produces a pending record and an empty effect list", () => {
    const r = begin();
    assert.equal(r.ok, true);
    const ok = r as { pending: PendingAction; effects: readonly unknown[] };
    assert.equal(ok.effects.length, 0);
    assert.equal(ok.pending.state, "PENDING");
  });

  it("the pending record carries the revision, never 'the latest'", () => {
    const p = pending();
    assert.equal(p.revisionId, "rev-7");
    assert.equal(/latest|current|head/i.test(p.revisionId), false);
  });

  it("MUST FAIL: no revision -- a pending action against 'whatever is current' is refused", () => {
    const r = begin({ revisionId: "" });
    assert.equal(r.ok, false);
    assert.equal((r as { refusal: string }).refusal, "MISSING_REVISION");
  });

  it("MUST FAIL: no verified actor", () => {
    for (const bad of [undefined, null, "4242", -1, 0, 1.5]) {
      const r = begin({ issuedTo: bad });
      assert.equal(r.ok, false, String(bad));
      assert.equal((r as { refusal: string }).refusal, "BAD_ACTOR");
    }
  });

  it("MUST FAIL: an action id that is not P3-R03's format", () => {
    for (const bad of ["approve:art-1", "act_" + "z".repeat(32), "act_abc", ""]) {
      assert.equal(begin({ actionId: bad }).ok, false, bad);
    }
  });

  it("uses P3-R03's action id format rather than one of its own", () => {
    assert.equal(ACTION_ID_PATTERN.test(makeActionId("b".repeat(32))), true);
    assert.equal(isActionId(pending().id), true);
  });

  it("MUST FAIL: a non-positive confirm window", () => {
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(begin({ ttlMs: t }).ok, false, String(t));
    }
  });

  it("the refusal vocabulary is closed", () => {
    assert.equal(STEP1_REFUSALS.length, 7);
    assert.equal(new Set(STEP1_REFUSALS).size, 7);
  });
});

describe("P3-R05 AC-02: the summary shows what consent is being given to", () => {
  it("names article, revision and destination", () => {
    const s = confirmationSummary(pending());
    assert.equal(s.articleId, "art-1");
    assert.equal(s.revisionId, "rev-7");
    assert.equal(s.destination, "dongchannel.com/blog");
    const text = s.lines.join("\n");
    for (const needle of ["art-1", "rev-7", "dongchannel.com/blog"]) {
      assert.ok(text.includes(needle), `summary omits ${needle}`);
    }
  });

  it("shows the deadline, so stale consent is visible before it is given", () => {
    const s = confirmationSummary(pending());
    assert.ok(s.lines.some((l) => l.includes("2026-08-22T12:10:00")));
  });

  it("CONTROL: the summary is not a fixed string -- it follows the record", () => {
    const other = confirmationSummary(
      pending({ articleId: "art-2", revisionId: "rev-9", destination: "elsewhere" }),
    );
    assert.equal(other.lines.join("\n").includes("art-1"), false);
    assert.ok(other.lines.join("\n").includes("art-2"));
  });
});

describe("P3-R05 AC-03: only Confirm acts, and in this order", () => {
  it("confirming returns the three steps in the required order", () => {
    const v = confirmWith();
    assert.equal(v.outcome, "ACT");
    assert.deepEqual(v.steps, ["CREATE_APPROVAL", "LOCK_REVISION", "ENQUEUE_PUBLISH"]);
  });

  it("approval comes first -- a lock held by a consent that failed to record is worse", () => {
    assert.equal(CONFIRM_STEPS[0], "CREATE_APPROVAL");
  });

  it("a refusal returns no steps at all", () => {
    for (const v of [
      confirmWith({ pending: null }),
      confirmWith({ fromId: 999 }),
      confirmWith({ articleId: "art-2" }),
      confirmWith({ currentRevisionId: "rev-8" }),
      confirmWith({ currentHash: "h-other" }),
      confirmWith({}, new Date(NOW.getTime() + TTL)),
    ]) {
      assert.notEqual(v.outcome, "ACT");
      assert.equal(v.steps, undefined, `${v.outcome} returned steps`);
    }
  });
});

describe("P3-R05 AC-04: Cancel leaves nothing behind", () => {
  it("produces no effects", () => {
    const c = cancelApprove();
    assert.equal(c.effects.length, 0);
    assert.equal(c.state, "CANCELLED");
  });

  it("a cancelled action cannot then be confirmed", () => {
    const v = confirmWith({ pending: pending({ state: "CANCELLED" }) });
    assert.equal(v.outcome, "REFUSE_NOT_PENDING");
  });

  it("nor can an already-confirmed one -- no second act from one consent", () => {
    const v = confirmWith({ pending: pending({ state: "CONFIRMED" }) });
    assert.equal(v.outcome, "REFUSE_NOT_PENDING");
  });

  it("the state vocabulary is closed", () => {
    assert.deepEqual([...PENDING_STATES], ["PENDING", "CONFIRMED", "CANCELLED"]);
  });
});

describe("P3-R05 AC-05: the confirm token is bound to one article", () => {
  it("a valid token aimed at a different article is refused", () => {
    const v = confirmWith({ articleId: "art-2" });
    assert.equal(v.outcome, "REFUSE_WRONG_TARGET");
  });

  it("wrong-target is reported before expiry, so it is not mistaken for a timing problem", () => {
    const v = confirmWith({ articleId: "art-2" }, new Date(NOW.getTime() + TTL * 2));
    assert.equal(v.outcome, "REFUSE_WRONG_TARGET");
  });

  it("a token issued to another user is refused before anything about the article", () => {
    const v = confirmWith({ fromId: 777, articleId: "art-2" });
    assert.equal(v.outcome, "REFUSE_WRONG_USER");
  });

  it("each pending action carries its own opaque id", () => {
    const a = pending();
    const b = pending({ id: "act_" + "c".repeat(32) });
    assert.notEqual(a.id, b.id);
    assert.ok(isActionId(a.id) && isActionId(b.id));
  });
});

describe("P3-R05 AC-06: an edit inside the two-step window is refused", () => {
  it("a changed revision is refused", () => {
    const v = confirmWith({ currentRevisionId: "rev-8" });
    assert.equal(v.outcome, "REFUSE_REVISION_CHANGED");
  });

  it("a changed hash under the SAME revision id is also refused", () => {
    // The revision id staying put does not mean the bytes did. Consent was
    // given against the hash, and this is the case that catches an in-place
    // edit -- the one a revision-id check alone would wave through.
    const v = confirmWith({ currentHash: "h-tampered" });
    assert.equal(v.outcome, "REFUSE_CONTENT_CHANGED");
  });

  it("CONTROL: unchanged content confirms, so the checks are not refusing everything", () => {
    assert.equal(confirmWith().outcome, "ACT");
  });
});

describe("P3-R05 AC-07: an expired confirm returns to step 1", () => {
  it("returns RESTART_AT_STEP_1, not a bare refusal", () => {
    const v = confirmWith({}, new Date(NOW.getTime() + TTL + 1));
    assert.equal(v.outcome, "RESTART_AT_STEP_1");
    assert.equal(v.steps, undefined);
  });

  it("expiry is inclusive -- exactly at the deadline is expired", () => {
    assert.equal(confirmWith({}, new Date(NOW.getTime() + TTL)).outcome, "RESTART_AT_STEP_1");
  });

  it("one millisecond earlier still acts", () => {
    assert.equal(confirmWith({}, new Date(NOW.getTime() + TTL - 1)).outcome, "ACT");
  });

  it("an expired action does not act on a changed article either", () => {
    // Expiry is checked before the revision comparison, so this asserts the
    // ORDER: a stale confirm on an edited article is a timing answer, and
    // re-showing the summary re-reads the article anyway.
    const v = confirmWith({ currentRevisionId: "rev-9" }, new Date(NOW.getTime() + TTL + 1));
    assert.equal(v.outcome, "RESTART_AT_STEP_1");
  });
});

describe("P3-R05 AC-08: enqueuing is not publishing", () => {
  it("the last step is ENQUEUE_PUBLISH", () => {
    assert.equal(CONFIRM_STEPS[CONFIRM_STEPS.length - 1], "ENQUEUE_PUBLISH");
    assert.equal(P3_STOPS_AT, "ENQUEUE_PUBLISH");
  });

  it("no step means publishing", () => {
    for (const s of CONFIRM_STEPS) {
      assert.equal(/^PUBLISH$|^SEND|^WORDPRESS/i.test(s), false, s);
    }
    assert.equal(P3_PUBLISHES, false);
  });

  it("the step vocabulary is exactly three and closed", () => {
    assert.equal(CONFIRM_STEPS.length, 3);
    assert.equal(new Set(CONFIRM_STEPS).size, 3);
  });

  it("the outcome vocabulary is closed", () => {
    assert.equal(new Set(CONFIRM_OUTCOMES).size, CONFIRM_OUTCOMES.length);
    assert.equal(CONFIRM_OUTCOMES.includes("PUBLISHED" as never), false);
  });
});

describe("P3-R05 AC-09: CONTROL -- step 1 alone cannot publish", () => {
  it("running step 1 produces nothing that could publish or approve", () => {
    const r = begin();
    assert.equal(r.ok, true);
    const ok = r as { pending: PendingAction; effects: readonly unknown[] };

    // Not merely "effects is empty". Every name that would mean something
    // happened is checked against the entire result, because an effect that was
    // performed but not reported would also leave the list empty.
    const serialised = JSON.stringify(ok);
    for (const forbidden of [
      "CREATE_APPROVAL",
      "LOCK_REVISION",
      "ENQUEUE_PUBLISH",
      "PUBLISH",
      "approval",
      "queue",
    ]) {
      assert.equal(
        serialised.includes(forbidden),
        false,
        `step 1 result mentions ${forbidden}`,
      );
    }
    assert.equal(ok.pending.state, "PENDING");
  });

  it("and the pending record is the ONLY thing step 1 yields", () => {
    const r = begin() as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(r).sort(), ["effects", "ok", "pending"]);
  });

  it("CONTROL: step 2 DOES produce those steps -- so the absence above is meaningful", () => {
    // Without this, the case above would pass against a module that could never
    // publish at all, which would prove the flow broken rather than safe.
    const v = confirmWith();
    assert.equal(v.outcome, "ACT");
    assert.ok(JSON.stringify(v).includes("ENQUEUE_PUBLISH"));
  });
});
