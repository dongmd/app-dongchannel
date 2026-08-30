/**
 * P4-R09 — publish idempotency and non-retryable failure handling.
 *
 * `G-51`: *"retry would create duplicate posts."*
 * `G-53`: blind retry on a validation error is wrong.
 *
 * ## What this does NOT reimplement
 *
 * `TD-21`'s `wordpress/retry-policy.ts` already classifies WordPress errors as
 * retryable or not, computes bounded jittered backoff, and honours
 * `Retry-After`. `AC-03` and `AC-06` are largely satisfied by it, and
 * reimplementing them here would create two classifiers that can disagree —
 * which is the failure `P4-R07 AC-06` names for QA and applies just as well
 * here.
 *
 * So this module adds the parts that are about PUBLISHING rather than about
 * HTTP: the idempotency key, what a terminal failure does to the intent, and
 * when the owner has to be told.
 */

// ─── AC-01: the idempotency key ────────────────────────────────────

/**
 * `article_id + revision_id + destination`.
 *
 * The destination is in the key because the same revision may legitimately go
 * to more than one place — and because a key that omitted it would make a
 * second destination look like a duplicate of the first and silently skip it.
 *
 * Built by a function rather than by string concatenation at call sites, so
 * "keyed on those three" is one fact in one place. Two call sites building the
 * key slightly differently is how idempotency quietly stops working.
 */
export function publishIdempotencyKey(
  articleId: string,
  revisionId: string,
  destination: string,
): string {
  // Each component is ENCODED before joining.
  //
  // A plain `a::b::c` join is ambiguous the moment a component can contain the
  // separator: ("a::b", "c", "d") and ("a", "b::c", "d") both produce
  // "a::b::c::d" -- two different publishes sharing one idempotency key, which
  // means one of them silently never happens.
  //
  // Found by the test that asserts exactly that, before this was written the
  // second way. Article and revision ids are uuids today and would never
  // contain "::", but idempotency resting on the shape of an id is idempotency
  // that breaks the first time an id changes shape.
  return [articleId, revisionId, destination].map(encodeURIComponent).join("::");
}

export const DEFAULT_DESTINATION = "wordpress:dongchannel.com";

export interface PublishRecord {
  readonly idempotencyKey: string;
  /** The WordPress post id this key produced. `null` = never succeeded. */
  readonly wpPostId: number | null;
  readonly attempts: number;
  readonly state: PublishState;
}

/**
 * `AC-06`/`AC-07`. The states a publish attempt can be in.
 *
 * `FAILED_REQUIRES_ATTENTION` is separate from `FAILED_RETRYING` on purpose:
 * one waits for a person and the other waits for a timer, and a single
 * `FAILED` would make "what is stuck" unanswerable.
 */
export const PUBLISH_STATES = [
  "PENDING",
  "IN_FLIGHT",
  "SUCCEEDED",
  "FAILED_RETRYING",
  "FAILED_REQUIRES_ATTENTION",
] as const;

export type PublishState = (typeof PUBLISH_STATES)[number];

// ─── AC-01 / AC-02: replay decides UPDATE, never a second post ─────

export const REPLAY_ACTIONS = ["CREATE", "UPDATE", "ALREADY_DONE"] as const;
export type ReplayAction = (typeof REPLAY_ACTIONS)[number];

export interface ReplayDecision {
  readonly action: ReplayAction;
  /** Set for UPDATE and ALREADY_DONE. */
  readonly wpPostId: number | null;
  readonly reason: string;
}

/**
 * What should a publish for this key actually do?
 *
 * The three outcomes are deliberately distinct. `ALREADY_DONE` is not
 * `UPDATE`: replaying a publish whose content has not changed should touch
 * nothing, because an update bumps `post_modified` and `P4-R08 AC-08` compares
 * that to detect human edits. A no-op "update" would make the publisher itself
 * look like a human editor on the next run.
 */
export function decideReplay(
  existing: PublishRecord | null,
  incomingContentHash: string,
  lastPublishedHash: string | null,
): ReplayDecision {
  if (!existing || existing.wpPostId === null) {
    return { action: "CREATE", wpPostId: null, reason: "no post exists for this key" };
  }
  if (lastPublishedHash !== null && lastPublishedHash === incomingContentHash) {
    return {
      action: "ALREADY_DONE",
      wpPostId: existing.wpPostId,
      reason: "the same content is already published under this key",
    };
  }
  return {
    action: "UPDATE",
    wpPostId: existing.wpPostId,
    reason: "a post exists for this key and the content differs",
  };
}

// ─── AC-04 / AC-07: what a terminal failure does ───────────────────

/**
 * `AC-07`. A failed publish must resolve its intent honestly.
 *
 * Two wrong answers this rules out:
 *
 *   - leaving the intent `OPEN` forever, holding the per-article lock so
 *     nothing can ever publish that article again;
 *   - marking it `CONSUMED`, which says the publish happened.
 *
 * `P3` gave `article_publish_intents` a `CANCELLED` terminal state and
 * deliberately did not decide when a failed publish becomes one. That decision
 * is this requirement's, and it is: on a terminal failure, and only then.
 */
export const INTENT_RESOLUTIONS = ["LEAVE_OPEN", "CONSUME", "CANCEL"] as const;
export type IntentResolution = (typeof INTENT_RESOLUTIONS)[number];

export interface FailureOutcome {
  readonly publishState: PublishState;
  readonly intent: IntentResolution;
  /** `AC-05`. Does a person need to be told, now? */
  readonly alertOwner: boolean;
  readonly reason: string;
}

/**
 * `AC-03`/`AC-04`. Decide what a failure means.
 *
 * `retryable` and `attemptsExhausted` come from `TD-21`'s classifier and
 * backoff — they are not re-derived here, so there is one classifier and one
 * answer.
 */
export function resolveFailure(
  retryable: boolean,
  attemptsExhausted: boolean,
): FailureOutcome {
  if (!retryable) {
    // G-53 by name. A validation error will fail identically forever, and
    // retrying it burns quota to produce the same message.
    return {
      publishState: "FAILED_REQUIRES_ATTENTION",
      intent: "CANCEL",
      alertOwner: true,
      reason: "non-retryable failure — a person has to change something",
    };
  }
  if (attemptsExhausted) {
    // AC-06. Terminal and recorded, not an infinite loop.
    return {
      publishState: "FAILED_REQUIRES_ATTENTION",
      intent: "CANCEL",
      alertOwner: true,
      reason: "retry budget exhausted",
    };
  }
  // Still retrying. The intent stays OPEN because this publish is not finished
  // -- and the lock it holds is doing its job: nothing else should publish this
  // article while an attempt is in flight.
  return {
    publishState: "FAILED_RETRYING",
    intent: "LEAVE_OPEN",
    alertOwner: false,
    reason: "retryable failure, attempts remain",
  };
}

/** A success resolves the intent the one way `P4-R08 AC-05` requires. */
export function resolveSuccess(): FailureOutcome {
  return {
    publishState: "SUCCEEDED",
    intent: "CONSUME",
    alertOwner: false,
    reason: "published",
  };
}

// ─── AC-05: the alert ──────────────────────────────────────────────

export interface OwnerAlert {
  readonly articleId: string;
  readonly revisionId: string;
  readonly state: PublishState;
  readonly reason: string;
  readonly attempts: number;
}

/**
 * `AC-05`. What the owner is told.
 *
 * Names the article, the revision, and WHY — not "publish failed". A failure
 * nobody is told about is a failure that waits, and a failure described only as
 * "failed" is one nobody can act on without opening a log.
 *
 * The message carries no content and no credential: it goes over Telegram, and
 * `P3-R06 AC-05` holds that ids travel and values do not.
 */
export function buildOwnerAlert(a: OwnerAlert): string {
  return (
    `⚠️ Publish thất bại · bài ${a.articleId} · bản ${a.revisionId}\n` +
    `Trạng thái: ${a.state} · sau ${a.attempts} lần thử\n` +
    `Lý do: ${a.reason}`
  );
}

/**
 * Only a terminal failure alerts.
 *
 * A retry that will happen in thirty seconds is not news, and alerting on every
 * transient error is how an owner learns to ignore the channel that also
 * carries the real ones.
 */
export function shouldAlert(outcome: FailureOutcome): boolean {
  return outcome.alertOwner;
}
