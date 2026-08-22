/**
 * P3-R05 — two-step Approve → Confirm.
 *
 * Owner spec §6: `Approve & Publish` shows a summary, then `Confirm Publish` /
 * `Cancel`.
 *
 * ## Step 1 never acts
 *
 * The point of a two-step gate is that the first press is reversible. So step 1
 * produces exactly one artefact — a **pending action record** — and its effect
 * list is empty and typed so it cannot be anything else. No approval, no lock,
 * no queue entry, no write to the article.
 *
 * The temptation is to "prepare" the approval in step 1 and activate it in step
 * 2. That would make cancelling a matter of remembering to delete something,
 * and `AC-04` requires that cancelling leave nothing behind at all — which is
 * only free if nothing was created.
 *
 * ## The window between the steps is the whole risk
 *
 * Everything dangerous about this flow lives between the two presses: the
 * article can be edited, the consent can go stale, the token can be replayed,
 * or a confirm meant for one article can be aimed at another. Each is a refusal
 * here, and each has a name, because a single `INVALID` would make the four
 * indistinguishable in the audit log.
 *
 * ## Pure, like the rest of P3
 *
 * Nothing imported but the two policies it composes. `now` is a parameter and
 * every record is passed in. The ordering guarantee in `AC-03` is returned as
 * data — a list of steps — rather than performed, so a test can assert the order
 * without a database and a caller cannot accidentally reorder it.
 */

import { ACTION_ID_PATTERN, isActionId } from "./callback-policy";

// ─── The pending action record ────────────────────────────────────

export const PENDING_STATES = ["PENDING", "CONFIRMED", "CANCELLED"] as const;
export type PendingState = (typeof PENDING_STATES)[number];

export interface PendingAction {
  /** An opaque `P3-R03` action id. Step 2 presents this, not an article id. */
  readonly id: string;
  /** The numeric Telegram id this pair of buttons was offered to. */
  readonly issuedTo: number;
  readonly articleId: string;
  /** `AC-02`/`AC-06`. One revision, named at step 1 and checked at step 2. */
  readonly revisionId: string;
  /** `AC-02`. Where the publish would go, shown before consent is given. */
  readonly destination: string;
  /** The hash of exactly what the summary showed. */
  readonly payloadHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly state: PendingState;
}

// ─── Step 1 ───────────────────────────────────────────────────────

export const STEP1_REFUSALS = [
  "MALFORMED_ACTION_ID",
  "MISSING_ARTICLE",
  "MISSING_REVISION",
  "MISSING_DESTINATION",
  "MISSING_HASH",
  "BAD_ACTOR",
  "BAD_TTL",
] as const;
export type Step1Refusal = (typeof STEP1_REFUSALS)[number];

export interface BeginInput {
  readonly actionId: unknown;
  readonly issuedTo: unknown;
  readonly articleId: unknown;
  readonly revisionId: unknown;
  readonly destination: unknown;
  readonly payloadHash: unknown;
  readonly ttlMs: number;
}

/**
 * The effects step 1 is permitted to have.
 *
 * `never[]` rather than an empty array of some effect type: the type makes any
 * value unrepresentable, so a handler that wanted to enqueue something would
 * have to change this declaration, which is where a reviewer is looking.
 */
export type Step1Result =
  | { readonly ok: true; readonly pending: PendingAction; readonly effects: readonly never[] }
  | { readonly ok: false; readonly refusal: Step1Refusal; readonly reason: string };

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * `AC-01`. Build the pending action record, and nothing else.
 *
 * The action id is supplied rather than generated here so this stays pure and so
 * the caller can obtain it the same way `P3-R03` issues every other one — one
 * generator, one format, one place that decides what an action id looks like.
 */
export function beginApprove(input: BeginInput, now: Date): Step1Result {
  if (!isActionId(input.actionId)) {
    return { ok: false, refusal: "MALFORMED_ACTION_ID", reason: "not a valid action id" };
  }
  if (typeof input.issuedTo !== "number" || !Number.isSafeInteger(input.issuedTo) || input.issuedTo <= 0) {
    return { ok: false, refusal: "BAD_ACTOR", reason: "no verified actor" };
  }
  if (!nonEmpty(input.articleId)) {
    return { ok: false, refusal: "MISSING_ARTICLE", reason: "no article" };
  }
  if (!nonEmpty(input.revisionId)) {
    // A pending action against "the latest revision" is the thing AC-06 exists
    // to prevent: it would confirm whatever happened to be current at step 2.
    return { ok: false, refusal: "MISSING_REVISION", reason: "no revision" };
  }
  if (!nonEmpty(input.destination)) {
    return { ok: false, refusal: "MISSING_DESTINATION", reason: "no destination" };
  }
  if (!nonEmpty(input.payloadHash)) {
    return { ok: false, refusal: "MISSING_HASH", reason: "no payload hash" };
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    return { ok: false, refusal: "BAD_TTL", reason: "confirm window must be positive" };
  }

  return {
    ok: true,
    effects: [],
    pending: {
      id: input.actionId,
      issuedTo: input.issuedTo,
      articleId: input.articleId,
      revisionId: input.revisionId,
      destination: input.destination,
      payloadHash: input.payloadHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + input.ttlMs),
      state: "PENDING",
    },
  };
}

// ─── The summary shown before consent ─────────────────────────────

export interface ConfirmationSummary {
  readonly articleId: string;
  readonly revisionId: string;
  readonly destination: string;
  readonly lines: readonly string[];
}

/**
 * `AC-02`. Consent is given against what will actually happen, so the summary
 * names the article, the revision and the destination.
 *
 * The revision is included as an id rather than as "the current draft". A
 * summary that said "the latest version" would be true when read and false when
 * acted on, which is the failure `AC-06` catches one step later.
 */
export function confirmationSummary(p: PendingAction): ConfirmationSummary {
  return {
    articleId: p.articleId,
    revisionId: p.revisionId,
    destination: p.destination,
    lines: [
      `article ${p.articleId}`,
      `revision ${p.revisionId}`,
      `destination ${p.destination}`,
      `confirm before ${p.expiresAt.toISOString()}`,
    ],
  };
}

// ─── Step 2 ───────────────────────────────────────────────────────

export const CONFIRM_OUTCOMES = [
  "ACT",
  "REFUSE_NOT_PENDING",
  "REFUSE_WRONG_USER",
  "REFUSE_WRONG_TARGET",
  "REFUSE_REVISION_CHANGED",
  "REFUSE_CONTENT_CHANGED",
  "RESTART_AT_STEP_1",
] as const;
export type ConfirmOutcome = (typeof CONFIRM_OUTCOMES)[number];

/**
 * `AC-03`. The order, as data.
 *
 * Approval first, because the lock and the queue entry are both consequences of
 * consent existing; locking before the approval would leave a revision locked
 * by a consent that then failed to record.
 *
 * `AC-08`: the last step is **ENQUEUE_PUBLISH**. P3 stops at the queue. `PUBLISH`
 * is deliberately not a member of this vocabulary, so there is no value this
 * module can return that means "published".
 */
export const CONFIRM_STEPS = ["CREATE_APPROVAL", "LOCK_REVISION", "ENQUEUE_PUBLISH"] as const;
export type ConfirmStep = (typeof CONFIRM_STEPS)[number];

export interface ConfirmInput {
  readonly pending: PendingAction | null;
  /** From the verified update, never from the callback payload. */
  readonly fromId: number;
  /** The article the confirm button claims to be for. */
  readonly articleId: string;
  /** The revision that is current NOW, read back at step 2. */
  readonly currentRevisionId: string;
  /** The hash of that revision's content, recomputed NOW. */
  readonly currentHash: string;
}

export interface ConfirmVerdict {
  readonly outcome: ConfirmOutcome;
  /** Present only on ACT, in the order they must happen. */
  readonly steps?: readonly ConfirmStep[];
  readonly reason: string;
}

/**
 * `AC-03`, `AC-05`, `AC-06`, `AC-07`.
 *
 * Check order matters and is not arbitrary:
 *
 *   not pending  → the record was already used or cancelled; nothing else about
 *                  it is worth evaluating.
 *   wrong user   → answered before anything about the article, so a stranger
 *                  learns nothing about its state.
 *   wrong target → `AC-05`. A confirm token is bound to one article. Checked
 *                  before expiry so that aiming a valid token at another article
 *                  is reported as what it is, not as a timing problem.
 *   expired      → `AC-07`. Returns to step 1 rather than refusing outright:
 *                  the owner's intent is still legible, only their consent is
 *                  stale, and re-showing the summary is the correct answer.
 *   revision     → `AC-06`. The two-step window is exactly where an edit slips
 *                  in.
 *   content      → the revision id can stay the same while the content behind
 *                  it changes; consent was given against the hash.
 */
export function confirmPublish(input: ConfirmInput, now: Date): ConfirmVerdict {
  const p = input.pending;
  if (!p) return { outcome: "REFUSE_NOT_PENDING", reason: "no pending action" };
  if (p.state !== "PENDING") {
    return { outcome: "REFUSE_NOT_PENDING", reason: `action is ${p.state}` };
  }
  if (p.issuedTo !== input.fromId) {
    return { outcome: "REFUSE_WRONG_USER", reason: "not the user this was offered to" };
  }
  if (p.articleId !== input.articleId) {
    return { outcome: "REFUSE_WRONG_TARGET", reason: "confirm does not belong to this article" };
  }
  // `>=`: an action that expires exactly now is expired. The alternative gives
  // a one-instant window in which stale consent is honoured.
  if (now.getTime() >= p.expiresAt.getTime()) {
    return { outcome: "RESTART_AT_STEP_1", reason: "confirmation expired; showing the summary again" };
  }
  if (p.revisionId !== input.currentRevisionId) {
    return { outcome: "REFUSE_REVISION_CHANGED", reason: "the article changed after the summary" };
  }
  if (p.payloadHash !== input.currentHash) {
    return { outcome: "REFUSE_CONTENT_CHANGED", reason: "the content changed after the summary" };
  }
  return { outcome: "ACT", steps: CONFIRM_STEPS, reason: "confirmed" };
}

// ─── Cancel ───────────────────────────────────────────────────────

export interface CancelResult {
  readonly state: "CANCELLED";
  /** Always empty. `AC-04`: cancelling leaves nothing behind. */
  readonly effects: readonly never[];
}

/**
 * `AC-04`. Cancelling writes one thing: the pending record's own state.
 *
 * Nothing is deleted, because nothing was created — step 1 created no approval
 * and no queue entry, so there is nothing for cancel to clean up. The pending
 * row is marked rather than removed so the audit log can show that a decision
 * was made and reversed, which is a different fact from a decision never taken.
 */
export function cancelApprove(): CancelResult {
  return { state: "CANCELLED", effects: [] };
}

// ─── AC-08: enqueuing is not publishing ───────────────────────────

/**
 * The last thing P3 does. Stated as a constant so the criterion has something
 * to assert against, and so a future step appended to `CONFIRM_STEPS` shows up
 * as a test failure rather than as a quiet extension of what P3 may do.
 */
export const P3_STOPS_AT: ConfirmStep = "ENQUEUE_PUBLISH";

/** `P4` re-checks every gate. Nothing here is a promise it should trust. */
export const P3_PUBLISHES = false;

// Re-exported so a caller does not need both modules to validate an id, and so
// the test can assert this module uses P3-R03's format rather than one of its
// own.
export { ACTION_ID_PATTERN, isActionId };
