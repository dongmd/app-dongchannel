/**
 * `P4-R08 AC-10` / `P4-R09 AC-01`/`AC-02` -- the seam `publisher-policy.ts`
 * names and does not fill: "the executor that calls it is `P4-R08 AC-10`".
 * This is that executor. It is the first thing in Repo B that actually
 * calls `PATCH /dc/v1/articles/{id}/publish-status`.
 *
 * ## What it composes, and reuses rather than reimplements
 *
 *   1. `decidePublish` (`publisher-policy.ts`) -- the three gates, re-checked,
 *      never trusted from `P3`.
 *   2. `signPublishRequest` (`publish-signature.ts`) -- the exact HMAC
 *      contract `dc_core_publish_signature_valid()` verifies.
 *   3. `resolvePublishFailure` (`publish-runner.ts`) -- what a failed attempt
 *      means: cancel-or-retry, audit, alert. Already built, already tested,
 *      and its own module note says its WordPress writer "is P4-R08 AC-10" --
 *      this file is that writer, not a second failure policy next to it.
 *
 * ## Idempotency is the intent's lock, not a second table
 *
 * `idempotency-policy.ts`'s `decideReplay`/`PublishRecord` model a publish
 * that can go to more than one destination and can duplicate a POST. Neither
 * is true of `PATCH .../publish-status`: `dc_v1_handle_publish_status()`'s own
 * comment states the property directly -- *"`post_status` has one `'publish'`
 * value, so replaying an already-applied request changes nothing and creates
 * nothing (`D-03`'s 'no create route' property). `P4-R09 AC-01` owns
 * idempotency at the layer that actually varies -- the WordPress post id a
 * Repo B intent maps to."*
 *
 * That layer already exists: `P3-R05`'s `publish_intents_one_open_per_article`
 * index allows at most one `OPEN` intent per article, and a successful publish
 * here consumes it in the same step that would otherwise let a second attempt
 * begin. Read the intent, decide, and execute IN ONE PASS -- as every test
 * below does -- and a second pass against the same row reads `state !=
 * 'OPEN'` and `decidePublish` refuses it with `INTENT_NOT_OPEN` before
 * signing anything. A second content-addressed idempotency table would
 * duplicate a guarantee the schema already gives, which is the same "two
 * things doing one job" defect `AC-07` names for the publish/preview signing
 * keys. `idempotency-policy.ts` is not dead code -- it is the ready answer for
 * a FUTURE multi-destination publish, which this single-WordPress-destination
 * executor is not.
 *
 * This guarantee is only as atomic as the CALLER's claim on the intent.
 * `decidePublish`'s gate reads `input.intent.state` from whatever snapshot the
 * caller passed in -- it is not a `SELECT ... FOR UPDATE` performed by this
 * function. A future worker that reads the same `OPEN` row twice before
 * either call reaches `consumeIntent` could run two `executePublish`s that
 * both pass gate 1 and both reach WordPress; the route itself stays safe
 * either way (`D-03`), but the audit trail and the alert-on-failure path would
 * not be. `consumeIntent`/`cancelIntent` also return `void`, not "did this
 * transition actually apply" -- a real implementation SHOULD claim the intent
 * atomically (e.g. `UPDATE ... WHERE state = 'OPEN'`, checking rows affected)
 * before calling this function, not after. No such worker exists yet -- see
 * the `attempts` note below -- so this is a documented precondition for its
 * caller, not a gap this module's own tests can exercise.
 *
 * ## Injected, like `publish-runner.ts`
 *
 * No `node:crypto`, no `fetch`, no `server-only`, no `WordpressError` import
 * -- see the boundary test. `callWordpress` arrives as a plain function
 * returning `{ ok, ... }`, never a thrown client exception; the real one is
 * `wordpress/client.ts`'s `wordpressPublishCall(client)`, which is the one
 * place a real `WordpressError` is caught and flattened.
 *
 * ## `attempts` is the caller's, not this module's
 *
 * There is no attempts-counter table for this route today -- the same
 * DELIBERATE gap `wordpress_sync_jobs.attempts` fills for product sync (`P1-
 * R05`) has no `P4-R08` counterpart yet, because no queue worker for
 * `article_publish_intents` has been built. Owning that counter here would
 * mean inventing persistence this session was not asked to design; a future
 * worker (this executor's caller) tracks it, exactly as `sync-worker.ts`
 * tracks `wordpress_sync_jobs.attempts` around `patchFacts`.
 */

import {
  decidePublish,
  type ApprovalState,
  type ArticleState,
  type PublishIntent,
  type PublishRefusal,
  type QaGateInput,
  type VerificationState,
} from "./publisher-policy";
import { signPublishRequest, type Signer } from "./publish-signature";
import {
  resolvePublishFailure,
  type PublishFailureResult,
  type PublishRunnerDeps,
} from "./publish-runner";
import type { WordpressErrorKind } from "@/lib/wordpress/retry-policy";

// ─── What the caller supplies ──────────────────────────────────────

export interface PublishAttemptInput {
  readonly intent: PublishIntent;
  readonly approval: ApprovalState | null;
  readonly article: ArticleState;
  readonly qa: QaGateInput;
  readonly verification: VerificationState;
  /**
   * Attempts already made for THIS intent, including this one. Owned by the
   * caller -- see the module note. `1` for a first try.
   */
  readonly attempts: number;
}

export type WordpressCallResult =
  | { readonly ok: true; readonly postStatus: string; readonly postModifiedGmt: string | null }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      /**
       * The real `WordpressError.kind`, when the caller has one. `TRANSPORT`/
       * `TIMEOUT` never had an HTTP status -- `status` will be `0` for those --
       * so `resolvePublishFailure` uses THIS instead of re-deriving a worse
       * answer from `(status, code)` alone. See `publish-runner.ts`'s
       * `PublishAttemptFailure.kind`.
       */
      readonly kind?: WordpressErrorKind;
    };

export type WordpressPublishCall = (
  wpPostId: number,
  headers: Readonly<Record<string, string>>,
) => Promise<WordpressCallResult>;

export interface PublishExecutorDeps extends PublishRunnerDeps {
  readonly sign: Signer;
  readonly callWordpress: WordpressPublishCall;
  /**
   * `AC-05`. Sets `state = 'CONSUMED'` and `resolved_at` TOGETHER -- the same
   * `publish_intent_resolution_consistent` CHECK `cancelIntent` answers to.
   */
  readonly consumeIntent: (intentId: string, at: Date) => Promise<void>;
}

// ─── What executing one attempt produces ───────────────────────────

export type PublishExecutionResult =
  | { readonly outcome: "REFUSED"; readonly reason: PublishRefusal; readonly detail: string | null }
  | { readonly outcome: "SIGNING_KEY_UNAVAILABLE" }
  | { readonly outcome: "WP_POST_MISSING" }
  | {
      readonly outcome: "PUBLISHED";
      readonly wpPostId: number;
      readonly dcVerified: boolean;
      readonly postModifiedGmt: string | null;
    }
  | { readonly outcome: "FAILED"; readonly failure: PublishFailureResult };

/**
 * `AC-01`/`AC-02`. The one non-retryable code this module invents rather than
 * receives from WordPress -- see the postStatus check below.
 */
const PUBLISH_NOT_APPLIED_STATUS = 403;
const PUBLISH_NOT_APPLIED_CODE = "PUBLISH_NOT_APPLIED";

/**
 * Execute one publish attempt for one intent.
 *
 * ## Order, and why
 *
 * 1. `decidePublish` -- the three gates. A refusal here never reaches
 *    WordPress and never touches the signing key.
 * 2. `plan.wpPostId` must exist. `PATCH .../publish-status` flips a post's
 *    status; it creates nothing (`D-03`). A plan with no post id has nothing
 *    to flip, and this executor does not gain a create path by accident.
 * 3. Sign. A missing key refuses here, same fail-closed discipline as
 *    `signPublishRequest` itself.
 * 4. Call WordPress. `AC-10`'s CONTROL: `result.postStatus` is verified, not
 *    assumed from a call that merely returned `ok: true` -- WordPress's own
 *    guard already refuses a mismatch before a 200 can carry one, but this is
 *    the M-04 re-check on THIS process's own state, mirrored from
 *    `dc_v1_handle_publish_status()`'s own comment.
 * 5. Success consumes the intent (`AC-05`); failure hands off to
 *    `resolvePublishFailure` (`P4-R09`) -- one classifier, one failure policy,
 *    reused rather than duplicated.
 */
export async function executePublish(
  input: PublishAttemptInput,
  deps: PublishExecutorDeps,
): Promise<PublishExecutionResult> {
  const decision = decidePublish(
    input.intent,
    input.approval,
    input.article,
    input.qa,
    input.verification,
  );

  if (!decision.ok) {
    await deps.recordAudit({
      action: "PUBLISH_REFUSED",
      entityType: "article_publish_intent",
      entityId: input.intent.id,
      outcome: decision.reason,
      detail: decision.detail ?? decision.reason,
    });
    return { outcome: "REFUSED", reason: decision.reason, detail: decision.detail };
  }

  const { plan } = decision;

  if (plan.wpPostId === null) {
    await deps.recordAudit({
      action: "PUBLISH_REFUSED",
      entityType: "article_publish_intent",
      entityId: input.intent.id,
      outcome: "WP_POST_MISSING",
      detail: "no WordPress post id on the article; this executor cannot create one",
    });
    return { outcome: "WP_POST_MISSING" };
  }
  const wpPostId = plan.wpPostId;

  const signed = signPublishRequest(
    { wpPostId, revisionId: plan.revisionId, contentHash: plan.contentHash },
    deps.sign,
  );

  if (!signed.ok) {
    await deps.recordAudit({
      action: "PUBLISH_REFUSED",
      entityType: "article_publish_intent",
      entityId: input.intent.id,
      outcome: signed.reason,
      detail: "no publish signing key configured",
    });
    return { outcome: "SIGNING_KEY_UNAVAILABLE" };
  }

  const result = await deps.callWordpress(wpPostId, signed.headers);

  let status: number;
  let code: string;
  let kind: WordpressErrorKind | undefined;

  if (result.ok && result.postStatus === "publish") {
    const now = deps.now();
    await deps.consumeIntent(input.intent.id, now);
    await deps.recordAudit({
      action: "PUBLISH_SUCCEEDED",
      entityType: "article_publish_intent",
      entityId: input.intent.id,
      outcome: "SUCCEEDED",
      detail: `wp post ${wpPostId}, dcVerified=${plan.dcVerified}`,
    });
    return {
      outcome: "PUBLISHED",
      wpPostId,
      dcVerified: plan.dcVerified,
      postModifiedGmt: result.postModifiedGmt,
    };
  } else if (result.ok) {
    // `ok: true` with a body that does not say `'publish'`. Treated as a
    // failure at the SAME severity WordPress's own guard gives it (403,
    // non-retryable) -- see `PUBLISH_NOT_APPLIED_STATUS/CODE` above.
    status = PUBLISH_NOT_APPLIED_STATUS;
    code = PUBLISH_NOT_APPLIED_CODE;
  } else {
    status = result.status;
    code = result.code;
    kind = result.kind;
  }

  const failure = await resolvePublishFailure(
    {
      intentId: input.intent.id,
      articleId: input.intent.articleId,
      revisionId: input.intent.revisionId,
      status,
      code,
      kind,
      attempts: input.attempts,
    },
    deps,
  );

  return { outcome: "FAILED", failure };
}
