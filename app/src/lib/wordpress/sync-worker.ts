import "server-only";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  products,
  wordpressProductSync,
  wordpressSyncJobs,
  type ProductRow,
  type WordpressProductSyncRow,
  type WordpressSyncJobRow,
} from "@/lib/db/schema/wordpress";
import { auditEvents } from "@/lib/db/schema/audit";
import { WordpressClient, WordpressError, wordpressClientFromEnv } from "./client";
import { buildFacts, idempotencyKeyFor } from "./field-map";
import { backoffMs, MAX_ATTEMPTS } from "./retry-policy";

// P1-R05 — the worker that carries app facts to WordPress.
//
// Shape: app change → enqueue → worker → dc/v1 → sync state + audit (G-55).
// WP-Cron is not an option; it fires on visitor requests and this site has
// almost none.

export { MAX_ATTEMPTS } from "./retry-policy";

export interface SyncOutcome {
  jobId: string;
  result: "applied" | "replayed" | "skipped_stale" | "conflict" | "retry" | "permanent";
  detail: string;
}

/**
 * Queue a sync for one product.
 *
 * The key is derived from product + version, so enqueueing the same version
 * twice is one job, not two. `onConflictDoNothing` makes that a property of the
 * table rather than of the caller remembering.
 */
export async function enqueueProductSync(productId: string, sourceVersion: number): Promise<void> {
  await db
    .insert(wordpressSyncJobs)
    .values({
      productId,
      sourceVersion,
      idempotencyKey: idempotencyKeyFor(productId, sourceVersion),
    })
    .onConflictDoNothing({ target: wordpressSyncJobs.idempotencyKey });
}

async function recordAudit(
  action: string,
  job: WordpressSyncJobRow,
  outcome: string,
  detail: string,
  correlationId?: string,
): Promise<void> {
  await db.insert(auditEvents).values({
    actorType: "system",
    actorId: "r05-wordpress-sync",
    action,
    entityType: "product",
    entityId: job.productId,
    // Field *names* and outcomes only. No fact values, and above all no
    // credential — the same rule dc/v1's own audit follows.
    afterJson: { outcome, detail, sourceVersion: job.sourceVersion },
    requestId: correlationId ?? null,
  });
}

/**
 * Execute one job.
 *
 * Order is the design:
 *   1. stale-version check   — before any network call
 *   2. read baseline         — WordPress is the authority on its own state
 *   3. PATCH                 — with the deterministic key
 *   4. persist               — sync state, then the job's terminal state
 */
export async function runSyncJob(
  job: WordpressSyncJobRow,
  client: WordpressClient = wordpressClientFromEnv(),
): Promise<SyncOutcome> {
  const correlationId = `r05-${job.id}`;
  const now = new Date();

  const [product] = await db.select().from(products).where(eq(products.id, job.productId)).limit(1);
  const [state] = await db
    .select()
    .from(wordpressProductSync)
    .where(eq(wordpressProductSync.productId, job.productId))
    .limit(1);

  if (!product || !state) {
    await failPermanent(job, "NO_MAPPING", "Product or WordPress mapping is missing");
    return { jobId: job.id, result: "permanent", detail: "NO_MAPPING" };
  }

  // ---- Monotonic guard (AC-09, AC-10).
  //
  // This is the layer R07's idempotency records cannot provide. Those expire
  // after seven days; once pruned, an old job replayed from a dead queue would
  // execute again and roll newer facts backwards. A version comparison does not
  // expire, and it is checked before the request rather than after.
  if (state.syncedSourceVersion !== null && job.sourceVersion < state.syncedSourceVersion) {
    await db
      .update(wordpressSyncJobs)
      .set({ state: "DONE", updatedAt: now, lastErrorCode: "STALE_VERSION" })
      .where(eq(wordpressSyncJobs.id, job.id));
    await recordAudit("r05.sync.skipped_stale", job, "skipped_stale",
      `job v${job.sourceVersion} < synced v${state.syncedSourceVersion}`, correlationId);
    return { jobId: job.id, result: "skipped_stale", detail: `v${job.sourceVersion} < v${state.syncedSourceVersion}` };
  }

  await db
    .update(wordpressSyncJobs)
    .set({ state: "RUNNING", attempts: job.attempts + 1, updatedAt: now, correlationId })
    .where(eq(wordpressSyncJobs.id, job.id));

  try {
    // Baseline comes from WordPress on every attempt, never from our cache of
    // it. §1B is only meaningful if the comparison uses current state.
    const projection = await client.getProduct(state.wpPostId, correlationId);

    const result = await client.patchFacts(
      state.wpPostId,
      { wpContentHash: projection.wpContentHash, postModifiedGmt: projection.postModifiedGmt },
      buildFacts(product as ProductRow),
      job.idempotencyKey,
      correlationId,
    );

    await db
      .update(wordpressProductSync)
      .set({
        status: "SYNCED",
        syncedSourceVersion: job.sourceVersion,
        wpContentHash: result.wpContentHash,
        wpPostModifiedGmt: result.postModifiedGmt,
        lastSuccessAt: new Date(),
        lastAttemptAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(wordpressProductSync.id, state.id));

    await db
      .update(wordpressSyncJobs)
      .set({ state: "DONE", updatedAt: new Date() })
      .where(eq(wordpressSyncJobs.id, job.id));

    const outcome = result.idempotentReplay ? "replayed" : "applied";
    await recordAudit(`r05.sync.${outcome}`, job, outcome,
      `applied=${result.applied.length} cleared=${result.cleared.length}`, correlationId);

    return { jobId: job.id, result: outcome, detail: result.applied.join(",") };
  } catch (err) {
    if (!(err instanceof WordpressError)) {
      await failPermanent(job, "UNEXPECTED", "Non-WordPress error during sync");
      return { jobId: job.id, result: "permanent", detail: "UNEXPECTED" };
    }

    // A 412 is not a transient failure and must never be retried. WordPress
    // changed under us: something edited the post by hand, and the honest
    // response is to stop and surface it. Retrying would either loop forever or,
    // worse, eventually succeed against a baseline nobody reviewed.
    if (err.kind === "CONFLICT") {
      await db
        .update(wordpressProductSync)
        .set({
          status: "CONFLICT",
          lastAttemptAt: new Date(),
          lastErrorCode: err.code,
          lastErrorMessage: err.message,
          updatedAt: new Date(),
        })
        .where(eq(wordpressProductSync.id, state.id));
      await failPermanent(job, err.code, err.message);
      await recordAudit("r05.sync.conflict", job, "conflict", err.code, correlationId);
      return { jobId: job.id, result: "conflict", detail: err.code };
    }

    if (err.retryable && job.attempts + 1 < MAX_ATTEMPTS) {
      const next = new Date(Date.now() + backoffMs(job.attempts + 1, err.retryAfterSeconds));
      await db
        .update(wordpressSyncJobs)
        .set({
          state: "FAILED_RETRYABLE",
          nextAttemptAt: next,
          lastErrorCode: err.code,
          lastErrorMessage: err.message,
          updatedAt: new Date(),
        })
        .where(eq(wordpressSyncJobs.id, job.id));
      await recordAudit("r05.sync.retry", job, "retry", err.code, correlationId);
      return { jobId: job.id, result: "retry", detail: err.code };
    }

    await db
      .update(wordpressProductSync)
      .set({
        status: "FAILED",
        lastAttemptAt: new Date(),
        lastErrorCode: err.code,
        lastErrorMessage: err.message,
        updatedAt: new Date(),
      })
      .where(eq(wordpressProductSync.id, state.id));
    await failPermanent(job, err.code, err.message);
    await recordAudit("r05.sync.failed", job, "permanent", err.code, correlationId);
    return { jobId: job.id, result: "permanent", detail: err.code };
  }
}

async function failPermanent(job: WordpressSyncJobRow, code: string, message: string): Promise<void> {
  await db
    .update(wordpressSyncJobs)
    .set({ state: "FAILED_PERMANENT", lastErrorCode: code, lastErrorMessage: message, updatedAt: new Date() })
    .where(eq(wordpressSyncJobs.id, job.id));
}

/**
 * Drain due jobs. Returns what happened to each, so a caller can log one line
 * per job rather than a count that hides a conflict.
 */
export async function runDueSyncJobs(limit = 10): Promise<SyncOutcome[]> {
  const due = await db
    .select()
    .from(wordpressSyncJobs)
    .where(
      and(
        sql`${wordpressSyncJobs.state} IN ('QUEUED','FAILED_RETRYABLE')`,
        lte(wordpressSyncJobs.nextAttemptAt, new Date()),
      ),
    )
    .limit(limit);

  const client = wordpressClientFromEnv();
  const outcomes: SyncOutcome[] = [];

  for (const job of due) {
    outcomes.push(await runSyncJob(job, client));
  }

  return outcomes;
}
