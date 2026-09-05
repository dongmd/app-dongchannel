import "server-only";

/**
 * `P4-R08 AC-10` — the real dependencies behind `publish-worker.ts`.
 *
 * The worker is injected and knows nothing about a database or a network; this
 * is the one module that does. Kept apart for the same reason
 * `publish-signer.ts` is kept apart from `publish-signature.ts`: the policy
 * stays exercisable without production, and everything that touches the world
 * lives somewhere a reader can find all at once.
 *
 * Nothing here decides anything. Every verdict — the three gates, the failure
 * classification, the alert threshold — belongs to a module that was already
 * tested without a database, and this file only fetches and stores.
 */

import { and, eq, isNull, or, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { recordAudit as writeAudit } from "@/lib/audit/write";
import { articleApprovals, articleVerification } from "@/lib/db/schema/approval";
import { articlePublishRecords } from "@/lib/db/schema/publish";
import { articlePublishIntents } from "@/lib/db/schema/two-step";
import { wordpressClientFromEnv } from "@/lib/wordpress/client";
import { wordpressPublishCall } from "@/lib/wordpress/client";
import { queueOwnerAlert } from "@/lib/notify/queue-alert";
import { publishSignerFromEnv } from "./publish-signer";
import type { PublishState } from "./idempotency-policy";
import type { IntentRow, PublishWorkerDeps, WpArticleObservation } from "./publish-worker";
import type { ApprovalState } from "./publisher-policy";

/**
 * How long a claim may be held before another worker may take it.
 *
 * Longer than `MAX_ATTEMPTS` × the bounded backoff, so a live worker is never
 * robbed of its own intent; short enough that a crashed one does not hold the
 * per-article lock for a working day.
 */
const CLAIM_RECLAIM_MINUTES = 10;

/**
 * The compare-and-swap claim.
 *
 * A `SELECT` then `UPDATE` would leave exactly the race a code review found in
 * the executor: two workers reading one OPEN intent, both passing gate 1, both
 * calling WordPress. This is a single conditional `UPDATE ... RETURNING` — the
 * database decides who won, and a caller that did not win gets `null`.
 */
async function claimIntent(): Promise<IntentRow | null> {
  const cutoff = sql`now() - interval '${sql.raw(String(CLAIM_RECLAIM_MINUTES))} minutes'`;

  const rows = await db
    .update(articlePublishIntents)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(articlePublishIntents.state, "OPEN"),
        or(isNull(articlePublishIntents.claimedAt), lt(articlePublishIntents.claimedAt, cutoff)),
        // One intent per call. `ctid` rather than `id` so the subquery does not
        // need the row's own key, and `FOR UPDATE SKIP LOCKED` so two workers
        // racing pick DIFFERENT rows instead of one blocking on the other.
        sql`${articlePublishIntents.id} = (
          select i.id from ${articlePublishIntents} i
           where i.state = 'OPEN'
             and (i.claimed_at is null or i.claimed_at < ${cutoff})
           order by i.enqueued_at asc
           for update skip locked
           limit 1
        )`,
      ),
    )
    .returning({
      id: articlePublishIntents.id,
      approvalId: articlePublishIntents.approvalId,
      articleId: articlePublishIntents.articleId,
      revisionId: articlePublishIntents.revisionId,
      payloadHash: articlePublishIntents.payloadHash,
      destination: articlePublishIntents.destination,
      state: articlePublishIntents.state,
    });

  return rows[0] ?? null;
}

/**
 * The live approval for one revision, or `null`.
 *
 * "Live" is two conditions, because `article_approvals` is immutable and a
 * withdrawal is a SEPARATE ROW: this row must not itself be a withdrawal, and
 * no other row may withdraw it. Reading a `withdrawn_at` column — which does
 * not exist — would count every withdrawal as an approval, the worst possible
 * direction for a consent record to be wrong in. The same two conditions
 * `fetchStatusCounts` already uses.
 */
async function loadApproval(articleId: string, revisionId: string): Promise<ApprovalState | null> {
  const rows = await db
    .select({ id: articleApprovals.id })
    .from(articleApprovals)
    .where(
      and(
        eq(articleApprovals.articleId, articleId),
        eq(articleApprovals.revisionId, revisionId),
        isNull(articleApprovals.withdrawsId),
        sql`not exists (
          select 1 from ${articleApprovals} w where w.withdraws_id = ${articleApprovals.id}
        )`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return { approvalId: row.id, articleId, revisionId, withdrawn: false };
}

/** A live `dc/v1` read. `null` when WordPress has no such post. */
async function observeArticle(wpPostId: number): Promise<WpArticleObservation | null> {
  const client = wordpressClientFromEnv();
  try {
    const s = await client.getArticleSyncState(wpPostId);
    return {
      id: s.id,
      postStatus: s.postStatus,
      postModifiedGmt: s.postModifiedGmt,
      wpContentHash: s.wpContentHash,
    };
  } catch (err) {
    // NOT_FOUND is an answer; anything else is a fault and must propagate
    // rather than be reported as "no such article", which would cancel the
    // owner's intent over a transient outage.
    if (err && typeof err === "object" && "kind" in err && (err as { kind: string }).kind === "NOT_FOUND") {
      return null;
    }
    throw err;
  }
}

async function loadPublishRecord(key: string) {
  const rows = await db
    .select({
      wpPostId: articlePublishRecords.wpPostId,
      publishedHash: articlePublishRecords.publishedHash,
      wpModifiedGmt: articlePublishRecords.wpModifiedGmt,
      attempts: articlePublishRecords.attempts,
      state: articlePublishRecords.state,
    })
    .from(articlePublishRecords)
    .where(eq(articlePublishRecords.idempotencyKey, key))
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  return { ...r, state: r.state as PublishState };
}

/**
 * Bump the attempt count and mark the row IN_FLIGHT, returning the attempt
 * number this call owns.
 *
 * Upsert on the idempotency key, so the FIRST attempt creates the row and
 * every later one increments the same row — which is what makes `attempts`
 * meaningful across retries and what `MAX_ATTEMPTS` is compared against.
 */
async function beginAttempt(key: string, intent: IntentRow, wpPostId: number): Promise<number> {
  const rows = await db
    .insert(articlePublishRecords)
    .values({
      idempotencyKey: key,
      articleId: intent.articleId,
      revisionId: intent.revisionId,
      destination: intent.destination,
      state: "IN_FLIGHT",
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: articlePublishRecords.idempotencyKey,
      set: {
        state: "IN_FLIGHT",
        attempts: sql`${articlePublishRecords.attempts} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ attempts: articlePublishRecords.attempts });

  void wpPostId; // recorded on success only -- a post id here would claim a publish that has not happened
  return rows[0]?.attempts ?? 1;
}

async function recordSuccess(
  key: string,
  outcome: { wpPostId: number; publishedHash: string; wpModifiedGmt: string | null },
): Promise<void> {
  await db
    .update(articlePublishRecords)
    .set({
      state: "SUCCEEDED",
      wpPostId: outcome.wpPostId,
      publishedHash: outcome.publishedHash,
      wpModifiedGmt: outcome.wpModifiedGmt,
      lastErrorKind: null,
      lastErrorCode: null,
      updatedAt: new Date(),
    })
    .where(eq(articlePublishRecords.idempotencyKey, key));
}

async function recordFailure(
  key: string,
  outcome: { state: PublishState; kind: string; code: string },
): Promise<void> {
  await db
    .update(articlePublishRecords)
    .set({
      state: outcome.state,
      // Kind and code only. A WordPress message can quote the request, and the
      // request carries the integration credential.
      lastErrorKind: outcome.kind,
      lastErrorCode: outcome.code || null,
      updatedAt: new Date(),
    })
    .where(eq(articlePublishRecords.idempotencyKey, key));
}

/**
 * `AC-05`. The intent is CONSUMED with `resolved_at` in the same statement —
 * the `publish_intent_resolution_consistent` CHECK refuses any other
 * combination, so this is one `set`, never two.
 */
async function consumeIntent(intentId: string, at: Date): Promise<void> {
  await db
    .update(articlePublishIntents)
    .set({ state: "CONSUMED", resolvedAt: at })
    .where(eq(articlePublishIntents.id, intentId));
}

async function cancelIntent(intentId: string, at: Date): Promise<void> {
  await db
    .update(articlePublishIntents)
    .set({ state: "CANCELLED", resolvedAt: at })
    .where(eq(articlePublishIntents.id, intentId));
}

/**
 * `P4-R06`/`P4-R07`'s QA verdict.
 *
 * Read from `article_verification`, which `P3-R04` made the KNOWLEDGE half of
 * the approval/verification split. A missing row is **not** a pass: an article
 * nobody has QA'd has not passed QA, and defaulting the other way is the
 * `P0-R01` failure in a new place.
 */
async function loadQaVerdict(articleId: string) {
  const rows = await db
    .select({ qaResult: articleVerification.qaResult })
    .from(articleVerification)
    .where(eq(articleVerification.articleId, articleId))
    .limit(1);

  const qa = rows[0]?.qaResult ?? null;
  if (qa === "PASS") return { passed: true, reason: null };
  return { passed: false, reason: qa === null ? "NO_QA_RECORD" : qa };
}

/**
 * `AC-04`. The verification state, and nothing derived from the approval.
 *
 * A missing row means nothing has been verified, which publishes UNVERIFIED —
 * with the reader notice, out of schema, `noindex`. It does not block the
 * publish, and it must never be read as verified.
 */
async function loadVerification(articleId: string) {
  const rows = await db
    .select({
      evidenceLevel: articleVerification.evidenceLevel,
      unsupportedClaims: articleVerification.unsupportedClaims,
      conflictingClaims: articleVerification.conflictingClaims,
    })
    .from(articleVerification)
    .where(eq(articleVerification.articleId, articleId))
    .limit(1);

  const v = rows[0];
  if (!v) return { allClaimsMeetBar: false, unsourcedClaimCount: 0 };

  return {
    allClaimsMeetBar: v.evidenceLevel !== "E0" && v.conflictingClaims === 0,
    unsourcedClaimCount: v.unsupportedClaims,
  };
}

/**
 * The worker's outcome vocabulary → the audit's.
 *
 * A refusal never reached WordPress; a failure did. Keeping them apart is what
 * makes "did we touch the site?" answerable from the log alone. A replayed
 * no-op is neither — it is the system working, and `REPLAYED` says so without
 * reading as an error.
 *
 * Anything unrecognised maps to a refusal with `ERROR`, not to a success: an
 * outcome nobody enumerated is not evidence that a publish happened.
 */
function auditShapeFor(workerAction: string): { action: string; result: string } {
  switch (workerAction) {
    case "PUBLISH_SUCCEEDED":
      return { action: "publish.execute", result: "OK" };
    case "PUBLISH_REFUSED":
      return { action: "publish.refuse", result: "REFUSED" };
    case "PUBLISH_FAILED":
      return { action: "publish.execute", result: "ERROR" };
    case "PUBLISH_REPLAY_NOOP":
      return { action: "publish.replay", result: "REPLAYED" };
    default:
      return { action: "publish.refuse", result: "ERROR" };
  }
}

/**
 * Build the real dependency set.
 *
 * `wordpressClientFromEnv()` and `publishSignerFromEnv()` are both called at
 * request time rather than at module load, so a process that started without a
 * key still works the moment one is deployed.
 */
export function publishWorkerDeps(): PublishWorkerDeps {
  const client = wordpressClientFromEnv();

  return {
    now: () => new Date(),
    sign: publishSignerFromEnv(),
    callWordpress: wordpressPublishCall(client),

    claimIntent,
    loadApproval,
    observeArticle,
    loadPublishRecord,
    beginAttempt,
    recordSuccess,
    recordFailure,
    loadQaVerdict: (articleId: string) => loadQaVerdict(articleId),
    loadVerification,

    consumeIntent,
    cancelIntent,

    // P3-R06 is the single audit authority. The publish path does not get its
    // own log; it writes through the same canonical writer as everything else.
    //
    // Both vocabularies are CLOSED and the writer REFUSES anything outside
    // them, so the executor's own richer outcome (`APPROVAL_WITHDRAWN`,
    // `SUCCEEDED`, …) is carried in `after` and mapped here to the audit's
    // three-value action and five-value result. Passing it straight through is
    // what the first version did, and the real writer rejected the row --
    // caught by the AC-10 end-to-end run, not by the unit tests, which fake
    // this function.
    recordAudit: async (entry) => {
      const { action, result } = auditShapeFor(entry.action);
      await db.transaction((tx) =>
        writeAudit(
          tx as unknown as Parameters<typeof writeAudit>[0],
          {
            actorType: "system",
            action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            result,
            // The executor's own outcome survives here, where the vocabulary is
            // not constrained -- nothing is lost by the mapping above.
            after: { outcome: entry.outcome, detail: entry.detail },
          },
          new Date(),
        ),
      );
    },

    queueAlert: (outcome, alert, entityType) => queueOwnerAlert(outcome, alert, entityType),
  };
}
