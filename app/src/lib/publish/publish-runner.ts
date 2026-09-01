/**
 * `P4-R09 AC-04`/`AC-05`/`AC-07` — what happens when a publish fails.
 *
 * This is the seam the alert path was missing. `idempotency-policy.ts` decides
 * what a failure MEANS; `queue-alert.ts` puts an alert where the collector will
 * find it; nothing joined them, so `queueOwnerAlert` had no caller and a
 * terminal failure resolved nothing.
 *
 * ## Deliberately not a publisher
 *
 * It does not call WordPress and does not decide whether to publish —
 * `decidePublish` in `publisher-policy.ts` owns that, and the executor that
 * calls it is `P4-R08 AC-10`, which needs the cPanel-deployed draft-forcing
 * exception (`AC-06`) before it can be proven. Building a WordPress writer here
 * would pre-empt criteria that are not yet demonstrable and would put the
 * publish decision in two places.
 *
 * What it owns is narrower and complete: **an attempt has failed — now what.**
 *
 * ## Injected, like `agents/runner.ts`
 *
 * No `server-only`, no imports of `db`. The clock, the intent writer, the audit
 * sink and the alert queue all arrive as parameters, so the whole chain is
 * exercisable in a test without a database and without a fabricated approval.
 */

import {
  classifyWordpressError,
  isRetryableKind,
  MAX_ATTEMPTS,
  type WordpressErrorKind,
} from "@/lib/wordpress/retry-policy";
import {
  buildOwnerAlert,
  resolveFailure,
  type FailureOutcome,
} from "./idempotency-policy";

/** What a failed publish attempt tells us. */
export interface PublishAttemptFailure {
  readonly intentId: string;
  readonly articleId: string;
  readonly revisionId: string;
  /** The HTTP status WordPress answered with. */
  readonly status: number;
  /** WordPress's own error code, e.g. `rest_invalid_param`. */
  readonly code: string;
  /** How many attempts have been made, including this one. */
  readonly attempts: number;
  /**
   * Set ONLY when the caller already holds a real `WordpressError.kind` --
   * `TRANSPORT`/`TIMEOUT` never had an HTTP status to begin with (the request
   * never reached WordPress), so `classifyWordpressError(status, code)` cannot
   * reconstruct them from `(0, "TRANSPORT")` and falls through to `UNKNOWN`,
   * which is NOT retryable. That silently turned a network blip into the same
   * terminal, owner-alerting failure `G-53` reserves for a real validation
   * error. `article-guard.ts` and `sync-worker.ts` both read `err.kind`
   * directly for exactly this reason; this is the one classifier, used the
   * same way, not a second one.
   */
  readonly kind?: WordpressErrorKind;
}

export interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly outcome: string;
  readonly detail: string;
}

/**
 * Everything that touches the world.
 *
 * `cancelIntent` must set `state` and `resolved_at` together — the
 * `publish_intent_resolution_consistent` CHECK refuses any other combination,
 * so a caller that forgets gets a database error rather than a half-resolved
 * intent.
 */
export interface PublishRunnerDeps {
  readonly now: () => Date;
  readonly cancelIntent: (intentId: string, at: Date) => Promise<void>;
  readonly recordAudit: (entry: AuditEntry) => Promise<void>;
  readonly queueAlert: (
    outcome: FailureOutcome,
    alert: ReturnType<typeof toOwnerAlert>,
    entityType: string,
  ) => Promise<{ ok: boolean; queued?: boolean; reason?: string }>;
}

function toOwnerAlert(f: PublishAttemptFailure, outcome: FailureOutcome) {
  return {
    articleId: f.articleId,
    revisionId: f.revisionId,
    state: outcome.publishState,
    reason: outcome.reason,
    attempts: f.attempts,
  };
}

export interface PublishFailureResult {
  readonly outcome: FailureOutcome;
  readonly kind: WordpressErrorKind;
  readonly intentCancelled: boolean;
  readonly alertQueued: boolean;
  /** Set when the alert was refused or was already waiting. */
  readonly alertNote: string | null;
}

/**
 * Resolve one failed publish attempt.
 *
 * ## The order is the design
 *
 * 1. **Resolve the intent** — `AC-07`. A terminal failure that left the intent
 *    `OPEN` would hold the per-article lock forever and nothing could ever
 *    publish that article again.
 * 2. **Audit** — `P3-R06` is the single audit authority, and the record of what
 *    happened must not depend on a notification succeeding.
 * 3. **Alert** — last, because it is the only step whose failure is survivable.
 *
 * Reversing 1 and 3 would be worse in a specific way: if the alert were queued
 * first and the cancel then failed, the owner would be told about a failure
 * whose intent still holds the lock — a message that makes the system look
 * handled while it is stuck. This way round, a lost alert leaves the failure
 * recorded and visible in the Ops Hub's own surfaces; the owner learns of it
 * later rather than never.
 */
export async function resolvePublishFailure(
  failure: PublishAttemptFailure,
  deps: PublishRunnerDeps,
): Promise<PublishFailureResult> {
  // ONE classifier. `TD-21`'s, the same one the retry loop uses -- two
  // classifiers that can disagree is exactly the defect `P4-R07 AC-06` names
  // for QA, and it applies here identically. `failure.kind`, when the caller
  // already has a real `WordpressError.kind`, is that SAME classifier's
  // answer computed earlier and carried forward -- not a second one.
  const kind = failure.kind ?? classifyWordpressError(failure.status, failure.code);
  const retryable = isRetryableKind(kind);
  const exhausted = failure.attempts >= MAX_ATTEMPTS;

  const outcome = resolveFailure(retryable, exhausted);
  const now = deps.now();

  let intentCancelled = false;
  if (outcome.intent === "CANCEL") {
    await deps.cancelIntent(failure.intentId, now);
    intentCancelled = true;
  }

  await deps.recordAudit({
    action: "PUBLISH_FAILED",
    entityType: "article_publish_intent",
    entityId: failure.intentId,
    outcome: outcome.publishState,
    // The WordPress error CODE, never its message: a message can quote the
    // request, and the request carries the integration credential.
    detail: `${kind} after ${failure.attempts} attempt(s); intent ${outcome.intent}`,
  });

  let alertQueued = false;
  let alertNote: string | null = null;
  if (outcome.alertOwner) {
    const r = await deps.queueAlert(outcome, toOwnerAlert(failure, outcome), "article");
    alertQueued = r.ok === true && r.queued === true;
    alertNote = r.queued ? null : (r.reason ?? null);
  }

  return { outcome, kind, intentCancelled, alertQueued, alertNote };
}

/**
 * The exact text the owner will receive, without sending it.
 *
 * Exported so a caller can log or preview the alert body without reaching for
 * `buildOwnerAlert` and reconstructing the argument shape — two call sites
 * composing the same message differently is how the owner ends up with two
 * formats for one event.
 */
export function previewOwnerAlert(
  failure: PublishAttemptFailure,
  outcome: FailureOutcome,
): string {
  return buildOwnerAlert(toOwnerAlert(failure, outcome));
}
