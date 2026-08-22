/**
 * P3-R01 AC-09 — a caller cannot act on another owner's objects.
 *
 * ## Why this is testable at all, with one owner in production
 *
 * The criterion is about a *binding*, not about a user table. Every actionable
 * object in P3 records the numeric Telegram id it was **offered to**:
 * `ActionRecord.issuedTo` (`P3-R03`), `PendingAction.issuedTo` (`P3-R05`),
 * `ApprovalRecord.approvedBy` (`P3-R04`). "Another owner's object" is therefore
 * an object whose `issuedTo` is not the caller — a comparison that needs two
 * *ids*, not two *accounts*.
 *
 * So the isolation is proven here with deterministic synthetic subjects. That
 * is not a stand-in for a real second owner: the code path exercised is the one
 * production runs, and adding a real second owner would change nothing about
 * it. What a live second owner would test is the allowlist, and the allowlist
 * is already covered by `AC-01`…`AC-06`.
 *
 * ## The first clause, re-asserted
 *
 * The decision cannot see a chat at all — there is no field for one — so a
 * valid, allowlisted id arriving on a different chat is evaluated on its own
 * merits. That half is asserted first, because the second half only means
 * something if the caller's identity is what is being compared.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authorize } from "./gateway-policy";
import { resolveCallback, type ActionRecord } from "./callback-policy";
import { confirmPublish, type PendingAction } from "./two-step-policy";
import { authorisesPublish, buildApproval } from "./approval-policy";

const OWNER_A = 4242;
const OWNER_B = 7777;
const NOW = new Date("2026-08-22T12:00:00Z");
const ACTION_B = "act_" + "b".repeat(32);

/** An action record offered to owner B. */
function recordForB(over: Partial<ActionRecord> = {}): ActionRecord {
  return {
    actionId: ACTION_B,
    issuedTo: OWNER_B,
    action: "confirm",
    targetType: "article",
    targetId: "art-owned-by-b",
    issuedAt: new Date(NOW.getTime() - 1000),
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedResult: null,
    consumedAt: null,
    ...over,
  };
}

/** A pending two-step action offered to owner B. */
function pendingForB(over: Partial<PendingAction> = {}): PendingAction {
  return {
    id: ACTION_B,
    issuedTo: OWNER_B,
    articleId: "art-owned-by-b",
    revisionId: "rev-1",
    destination: "dongchannel.com",
    payloadHash: "h-b",
    issuedAt: new Date(NOW.getTime() - 1000),
    expiresAt: new Date(NOW.getTime() + 60_000),
    state: "PENDING",
    ...over,
  };
}

describe("P3-R01 AC-09, first clause: the decision cannot see a chat", () => {
  it("there is no chat field to trust", () => {
    // Asserted on the shape rather than on behaviour: a field that does not
    // exist cannot be trusted by a future edit either.
    const d = authorize(
      { kind: "command", fromId: OWNER_A, text: "/status" } as never,
      [OWNER_A],
      NOW,
    );
    assert.equal("chatId" in d, false);
    assert.equal(JSON.stringify(d).toLowerCase().includes("chat"), false);
  });

  it("an allowlisted id is allowed regardless of any extra field on the update", () => {
    // A chat id smuggled onto the update changes nothing, because nothing reads
    // it. This is the "different chat" negative case: same merits, same answer.
    const withChat = {
      kind: "command",
      fromId: OWNER_A,
      text: "/status",
      chat: { id: -100999 },
    } as never;
    assert.equal(authorize(withChat, [OWNER_A], NOW).outcome, "ALLOW");
  });

  it("and a non-allowlisted id is denied regardless of the same extra field", () => {
    const withChat = {
      kind: "command",
      fromId: OWNER_B,
      text: "/status",
      chat: { id: -100999 },
    } as never;
    assert.equal(authorize(withChat, [OWNER_A], NOW).outcome, "DENY_NOT_ALLOWLISTED");
  });
});

describe("P3-R01 AC-09, second clause: A cannot act on B's objects", () => {
  // Both owners are allowlisted throughout. This is the point: the refusal is
  // NOT the allowlist doing its job, it is the object binding doing its own.
  const BOTH = [OWNER_A, OWNER_B];

  it("both owners pass the gateway -- so any refusal below is about the object", () => {
    for (const id of BOTH) {
      assert.equal(
        authorize({ kind: "command", fromId: id, text: "/status" }, BOTH, NOW).outcome,
        "ALLOW",
        String(id),
      );
    }
  });

  it("P3-R03: A pressing a button issued to B is refused", () => {
    const d = resolveCallback(
      { callbackData: ACTION_B, fromId: OWNER_A, record: recordForB() },
      NOW,
    );
    assert.equal(d.outcome, "REFUSE_WRONG_USER");
  });

  it("P3-R03 CONTROL: B pressing the same button acts", () => {
    // Without this, the refusal above would be equally explained by a resolver
    // that refuses every callback.
    const d = resolveCallback(
      { callbackData: ACTION_B, fromId: OWNER_B, record: recordForB() },
      NOW,
    );
    assert.equal(d.outcome, "ACT");
  });

  it("P3-R05: A confirming B's pending publish is refused", () => {
    const v = confirmPublish(
      {
        pending: pendingForB(),
        fromId: OWNER_A,
        articleId: "art-owned-by-b",
        currentRevisionId: "rev-1",
        currentHash: "h-b",
      },
      NOW,
    );
    assert.equal(v.outcome, "REFUSE_WRONG_USER");
    assert.equal(v.steps, undefined, "a refused confirm returned steps");
  });

  it("P3-R05 CONTROL: B confirming the same action acts", () => {
    const v = confirmPublish(
      {
        pending: pendingForB(),
        fromId: OWNER_B,
        articleId: "art-owned-by-b",
        currentRevisionId: "rev-1",
        currentHash: "h-b",
      },
      NOW,
    );
    assert.equal(v.outcome, "ACT");
  });

  it("the refusal is decided by the caller's id and nothing else", () => {
    // Identical inputs but for `fromId`, opposite answers. Anything else
    // differing would leave the cause ambiguous.
    const base = {
      pending: pendingForB(),
      articleId: "art-owned-by-b",
      currentRevisionId: "rev-1",
      currentHash: "h-b",
    };
    assert.equal(confirmPublish({ ...base, fromId: OWNER_A }, NOW).outcome, "REFUSE_WRONG_USER");
    assert.equal(confirmPublish({ ...base, fromId: OWNER_B }, NOW).outcome, "ACT");
  });

  it("P3-R04: an approval records WHO approved, so consent is attributable", () => {
    const v = buildApproval({
      articleId: "art-owned-by-b",
      revisionId: "rev-1",
      approvedBy: OWNER_B,
      payloadHash: "f".repeat(64),
      callbackNonce: "n1",
      ttlMs: 60_000,
    }, NOW);
    assert.equal(v.ok, true);
    assert.equal((v as { record: { approvedBy: number } }).record.approvedBy, OWNER_B);
  });

  it("A's identity never appears on an object A did not act on", () => {
    const d = resolveCallback(
      { callbackData: ACTION_B, fromId: OWNER_A, record: recordForB() },
      NOW,
    );
    // The refusal names the decision, not the subject: it must not leak that
    // the object exists, who owns it, or what it points at.
    assert.equal(d.reason.includes(String(OWNER_B)), false);
    assert.equal(d.reason.includes("art-owned-by-b"), false);
    assert.equal(d.targetId, undefined);
  });

  it("a publish is not authorised by an approval for another article", () => {
    const approval = (buildApproval({
      articleId: "art-owned-by-b",
      revisionId: "rev-1",
      approvedBy: OWNER_B,
      payloadHash: "f".repeat(64),
      callbackNonce: "n1",
      ttlMs: 60_000,
    }, NOW) as { record: Record<string, unknown> }).record;

    const v = authorisesPublish(
      {
        approval: { ...approval, id: "id-1" } as never,
        revisionId: "rev-OTHER",
        currentHash: "f".repeat(64),
      },
      NOW,
    );
    assert.notEqual(v.authorisation, "AUTHORISED");
  });
});
