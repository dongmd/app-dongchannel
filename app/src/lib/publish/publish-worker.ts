/**
 * `P4-R08 AC-10` — the caller the executor did not have.
 *
 * `publish-executor.ts` shipped able to publish and orphaned: nothing read
 * `article_publish_intents`, nothing assembled the state `decidePublish`
 * needs, and the WordPress post id a publish produced had nowhere to go. This
 * module is that missing middle, and it is the ONLY thing that turns an
 * approved intent into a real publish.
 *
 * ## The identity question this settles
 *
 * **An article IS a WordPress post.** That is not invented here — it is the
 * standing architecture, stated where it binds: `wordpress.ts` says *"There is
 * no `articles` table to reference: the app does not own article prose and
 * will not until a much later phase. The key is therefore the WordPress post
 * id, which is the only identity both sides agree on today"*, and `CLAUDE.md`
 * has WordPress as the CMS with prose *"never touched from here"*. So
 * `article_id` is the WordPress post id in text form, and `articleWpPostId()`
 * is the one place that conversion happens.
 *
 * ## The two hashes
 *
 * `dc/v1` returns `wp_content_hash` as `v1:<sha256>`; the signature guard
 * hashes `post_content` raw. `rawSha256FromWpHash()` bridges them, and
 * `article_approvals_hash_shape` (64 hex, no prefix) confirms which form the
 * approval chain stores. Get this wrong and the signature is perfectly formed
 * over the wrong payload.
 *
 * ## Injected, like `publish-runner.ts` and `agents/runner.ts`
 *
 * No `server-only`, no `db` import, no `fetch`. Everything that touches the
 * world arrives as a parameter, so the whole chain — claim, assemble, publish,
 * persist — is exercisable without a database and without a real post.
 * `publish-wiring.ts` builds the real dependencies.
 */

import {
  rawSha256FromWpHash,
} from "@/lib/wordpress/article-guard-policy";
import {
  DEFAULT_DESTINATION,
  publishIdempotencyKey,
  type PublishState,
} from "./idempotency-policy";
import {
  executePublish,
  type PublishExecutionResult,
  type PublishExecutorDeps,
} from "./publish-executor";
import type { ApprovalState, ArticleState, PublishIntent, QaGateInput, VerificationState } from "./publisher-policy";

// ─── What the worker reads ─────────────────────────────────────────

/** One row of `article_publish_intents`, as the worker needs it. */
export interface IntentRow {
  readonly id: string;
  readonly approvalId: string;
  readonly articleId: string;
  readonly revisionId: string;
  readonly payloadHash: string;
  readonly destination: string;
  readonly state: string;
}

/** What `dc/v1` says about the post right now. */
export interface WpArticleObservation {
  readonly id: number;
  readonly postStatus: string;
  readonly postModifiedGmt: string | null;
  /** The `v1:`-prefixed read-contract hash. */
  readonly wpContentHash: string;
}

/** The publish record for this idempotency key, if one exists. */
export interface PublishRecordRow {
  readonly wpPostId: number | null;
  readonly publishedHash: string | null;
  readonly wpModifiedGmt: string | null;
  readonly attempts: number;
  readonly state: PublishState;
}

export interface PublishWorkerDeps extends PublishExecutorDeps {
  /**
   * Compare-and-swap. Returns the intent only if THIS caller won the claim —
   * `null` means somebody else holds it. Never a plain read: see migration
   * `0038`'s note on the race a snapshot read leaves open.
   */
  readonly claimIntent: () => Promise<IntentRow | null>;
  /** The live approval, or `null` when none stands (withdrawn counts as none standing). */
  readonly loadApproval: (articleId: string, revisionId: string) => Promise<ApprovalState | null>;
  /** A live `dc/v1` read. `null` when WordPress has no such post. */
  readonly observeArticle: (wpPostId: number) => Promise<WpArticleObservation | null>;
  readonly loadPublishRecord: (idempotencyKey: string) => Promise<PublishRecordRow | null>;
  /** Bumps `attempts` and marks the record IN_FLIGHT before the network call. */
  readonly beginAttempt: (key: string, intent: IntentRow, wpPostId: number) => Promise<number>;
  readonly recordSuccess: (
    key: string,
    outcome: { wpPostId: number; publishedHash: string; wpModifiedGmt: string | null },
  ) => Promise<void>;
  readonly recordFailure: (
    key: string,
    outcome: { state: PublishState; kind: string; code: string },
  ) => Promise<void>;
  /** `P4-R06`/`P4-R07`'s verdict. Passed in, never recomputed here. */
  readonly loadQaVerdict: (articleId: string, revisionId: string) => Promise<QaGateInput>;
  readonly loadVerification: (articleId: string) => Promise<VerificationState>;
}

// ─── Article identity ──────────────────────────────────────────────

/**
 * `article_id` → WordPress post id.
 *
 * Refuses anything that is not a positive integer rather than coercing:
 * `Number("abc")` is `NaN` and `Number("")` is `0`, and both would sail into a
 * request path as `/articles/NaN/publish-status`. An article id this function
 * cannot read is an article this worker must not publish.
 */
export function articleWpPostId(articleId: string): number | null {
  if (!/^[1-9][0-9]*$/.test(articleId)) return null;
  const n = Number(articleId);
  return Number.isSafeInteger(n) ? n : null;
}

export type WorkerOutcome =
  | { readonly outcome: "IDLE" }
  | { readonly outcome: "UNREADABLE_ARTICLE_ID"; readonly intentId: string; readonly articleId: string }
  | { readonly outcome: "ARTICLE_NOT_FOUND"; readonly intentId: string; readonly wpPostId: number }
  | { readonly outcome: "HASH_CONTRACT_UNREADABLE"; readonly intentId: string; readonly wpPostId: number }
  | { readonly outcome: "ALREADY_PUBLISHED"; readonly intentId: string; readonly wpPostId: number }
  | { readonly outcome: "EXECUTED"; readonly intentId: string; readonly result: PublishExecutionResult };

/**
 * Claim one intent and carry it all the way, or report that there was nothing
 * to do.
 *
 * ## Order, and what each step refuses
 *
 * 1. **Claim** — compare-and-swap. No claim, no work.
 * 2. **Resolve identity** — `article_id` must name a real post id.
 * 3. **Observe WordPress** — the article's state NOW, not what P3 recorded.
 * 4. **Short-circuit a replay** — `AC-02`. If this key already published this
 *    exact hash, do not call WordPress again. The route is idempotent anyway
 *    (`D-03`), but a second call would bump `post_modified` and make the
 *    publisher look like a human editor to `AC-08` on the next run.
 * 5. **Execute** — `executePublish` re-checks all three gates itself. This
 *    function does not pre-judge them; it only assembles honest inputs.
 * 6. **Persist** — the post id, the hash published, and the state.
 */
export async function runPublishOnce(deps: PublishWorkerDeps): Promise<WorkerOutcome> {
  const intent = await deps.claimIntent();
  if (!intent) return { outcome: "IDLE" };

  const wpPostId = articleWpPostId(intent.articleId);
  if (wpPostId === null) {
    await deps.recordAudit({
      action: "PUBLISH_REFUSED",
      entityType: "article_publish_intent",
      entityId: intent.id,
      outcome: "UNREADABLE_ARTICLE_ID",
      detail: `article_id ${JSON.stringify(intent.articleId)} is not a WordPress post id`,
    });
    await deps.cancelIntent(intent.id, deps.now());
    return { outcome: "UNREADABLE_ARTICLE_ID", intentId: intent.id, articleId: intent.articleId };
  }

  const observed = await deps.observeArticle(wpPostId);
  if (!observed) {
    await deps.recordAudit({
      action: "PUBLISH_REFUSED",
      entityType: "article_publish_intent",
      entityId: intent.id,
      outcome: "ARTICLE_NOT_FOUND",
      detail: `WordPress has no post ${wpPostId}`,
    });
    await deps.cancelIntent(intent.id, deps.now());
    return { outcome: "ARTICLE_NOT_FOUND", intentId: intent.id, wpPostId };
  }

  // The signature's hash, derived from the read contract's. A `null` here means
  // WordPress answered with a hash this build cannot read -- fail closed rather
  // than sign over a guess.
  const liveHash = rawSha256FromWpHash(observed.wpContentHash);
  if (liveHash === null) {
    await deps.recordAudit({
      action: "PUBLISH_REFUSED",
      entityType: "article_publish_intent",
      entityId: intent.id,
      outcome: "HASH_CONTRACT_UNREADABLE",
      detail: `wp_content_hash is not a readable v1 hash for post ${wpPostId}`,
    });
    // NOT cancelled: an unreadable hash is a contract problem, not a verdict on
    // this intent. Cancelling would discard the owner's consent over a fault
    // that a fixed build would resolve.
    return { outcome: "HASH_CONTRACT_UNREADABLE", intentId: intent.id, wpPostId };
  }

  const destination = intent.destination || DEFAULT_DESTINATION;
  const key = publishIdempotencyKey(intent.articleId, intent.revisionId, destination);
  const record = await deps.loadPublishRecord(key);

  // AC-02. The replay short-circuit, BEFORE any signing or network call.
  if (
    record &&
    record.state === "SUCCEEDED" &&
    record.wpPostId !== null &&
    record.publishedHash === intent.payloadHash
  ) {
    await deps.recordAudit({
      action: "PUBLISH_REPLAY_NOOP",
      entityType: "article_publish_intent",
      entityId: intent.id,
      outcome: "ALREADY_DONE",
      detail: `key already published wp post ${record.wpPostId}; no second write`,
    });
    // The intent is still consumed -- it asked for a state the world is already
    // in, so leaving it OPEN would hold the per-article lock over nothing.
    await deps.consumeIntent(intent.id, deps.now());
    return { outcome: "ALREADY_PUBLISHED", intentId: intent.id, wpPostId: record.wpPostId };
  }

  const approval = await deps.loadApproval(intent.articleId, intent.revisionId);
  const qa = await deps.loadQaVerdict(intent.articleId, intent.revisionId);
  const verification = await deps.loadVerification(intent.articleId);

  const article: ArticleState = {
    articleId: intent.articleId,
    revisionId: intent.revisionId,
    // The article NOW. Gate 2 compares this against what was approved, so it
    // must be the live value and never the intent's own copy.
    contentHash: liveHash,
    contentMode: "COMMERCIAL",
    wpPostId,
    wpModifiedGmt: observed.postModifiedGmt,
    // AC-08's baseline: what the publisher itself last wrote. From the publish
    // record, not from the sync baseline -- the question is "did anyone change
    // it since WE published", and only this record knows when that was.
    lastPublishedHash: record?.publishedHash ?? null,
    lastPublishedModifiedGmt: record?.wpModifiedGmt ?? null,
  };

  const attempts = await deps.beginAttempt(key, intent, wpPostId);

  const publishIntent: PublishIntent = {
    id: intent.id,
    articleId: intent.articleId,
    revisionId: intent.revisionId,
    contentHash: intent.payloadHash,
    state: intent.state,
  };

  const result = await executePublish(
    { intent: publishIntent, approval, article, qa, verification, attempts },
    deps,
  );

  if (result.outcome === "PUBLISHED") {
    await deps.recordSuccess(key, {
      wpPostId: result.wpPostId,
      // What was actually published is what the gates agreed on: the approved
      // hash, which gate 2 has just proven equals the live one.
      publishedHash: intent.payloadHash,
      wpModifiedGmt: result.postModifiedGmt,
    });
  } else if (result.outcome === "FAILED") {
    await deps.recordFailure(key, {
      state: result.failure.outcome.publishState,
      kind: result.failure.kind,
      code: "",
    });
  } else {
    // REFUSED / SIGNING_KEY_UNAVAILABLE / WP_POST_MISSING. The executor has
    // already audited the reason. The record is moved off IN_FLIGHT so a stuck
    // row does not look like a publish still in progress.
    await deps.recordFailure(key, {
      state: "FAILED_REQUIRES_ATTENTION",
      kind: result.outcome,
      code: result.outcome === "REFUSED" ? result.reason : result.outcome,
    });
  }

  return { outcome: "EXECUTED", intentId: intent.id, result };
}
