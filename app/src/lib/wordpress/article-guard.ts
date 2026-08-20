import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { wordpressArticleSync, type WordpressArticleSyncRow } from "@/lib/db/schema/wordpress";
import { auditEvents } from "@/lib/db/schema/audit";
import { WordpressError, type WordpressClient } from "./client";
import {
  decideArticleSync,
  hashContractVersionOf,
  isDivergence,
  type ArticleGuardRefusal,
  type GuardDecision,
} from "./article-guard-policy";

// P1-R06 — the §1B guard (G-58, PROPOSED §7A).
//
// WordPress wins for article prose after publication, because that is where the
// owner writes. This module is the thing standing between an agent and the
// owner's paragraphs.
//
// Shape: read WordPress -> compare against the baseline -> ALLOW with a permit,
// or REFUSE and record the divergence. There is no third outcome and no way to
// skip the middle step, which is the point.

/**
 * The brand that makes a permit unforgeable.
 *
 * Declared, never exported as a value: no module outside this file can produce
 * an object satisfying `SyncPermit`, so `issueSyncPermit` is the only source of
 * one. That is AC-17 enforced by the type system rather than by a convention
 * somebody has to remember.
 */
declare const permitBrand: unique symbol;

export interface SyncPermit {
  readonly [permitBrand]: true;
  readonly wpPostId: number;
  readonly wpContentHash: string;
  readonly postModifiedGmt: string;
  readonly issuedAt: Date;
}

/**
 * Permits already spent.
 *
 * A permit says "WordPress looked like this a moment ago". Letting one be
 * replayed would let a second write ride on a check made before the first one
 * landed -- the article has moved, and the permit no longer describes it.
 */
const spent = new WeakSet<object>();

function issueSyncPermit(wpPostId: number, wpContentHash: string, postModifiedGmt: string): SyncPermit {
  return {
    wpPostId,
    wpContentHash,
    postModifiedGmt,
    issuedAt: new Date(),
  } as SyncPermit;
}

export interface PermitTarget {
  wpPostId: number;
  wpContentHash: string;
  postModifiedGmt: string;
}

/**
 * Spend a permit against the exact article it was issued for (AC-05).
 *
 * Throws rather than returning false: a caller that ignores a boolean is a
 * silent overwrite, and this module exists to make that impossible.
 */
export function consumeSyncPermit(permit: SyncPermit, target: PermitTarget): void {
  if (spent.has(permit)) {
    throw new Error("P1-R06: this sync permit has already been used");
  }

  if (permit.wpPostId !== target.wpPostId) {
    throw new Error(`P1-R06: permit is for post ${permit.wpPostId}, not ${target.wpPostId}`);
  }

  if (permit.wpContentHash !== target.wpContentHash) {
    throw new Error("P1-R06: permit does not match the article's current content hash");
  }

  if (permit.postModifiedGmt !== target.postModifiedGmt) {
    throw new Error("P1-R06: permit does not match the article's current post_modified_gmt");
  }

  spent.add(permit);
}

export type GuardOutcome =
  | { decision: "ALLOW"; permit: SyncPermit; wpContentHash: string; postModifiedGmt: string }
  | { decision: "REFUSE"; reason: ArticleGuardRefusal; detail: string };

async function recordAudit(
  action: string,
  wpPostId: number,
  outcome: string,
  detail: string,
  correlationId?: string,
): Promise<void> {
  await db.insert(auditEvents).values({
    actorType: "system",
    actorId: "r06-article-guard",
    action,
    entityType: "wp_article",
    entityId: String(wpPostId),
    // Outcome and reason only. Never the prose, never a hash the owner would
    // have to treat as content -- the same rule dc/v1's own audit follows.
    afterJson: { outcome, detail },
    requestId: correlationId ?? null,
  });
}

/** The current baseline row, or null. */
export async function getArticleBaseline(wpPostId: number): Promise<WordpressArticleSyncRow | null> {
  const [row] = await db
    .select()
    .from(wordpressArticleSync)
    .where(eq(wordpressArticleSync.wpPostId, wpPostId))
    .limit(1);

  return row ?? null;
}

/**
 * Record a baseline from a live read (AC-03).
 *
 * The values come from one `getArticleSyncState` call and are stored verbatim.
 * They are never assembled from separate reads: a hash from one moment and a
 * timestamp from another describe a post that never existed.
 *
 * Refuses to store a baseline WordPress could not fully state, because a
 * half-known baseline is a guard that cannot decide, and a guard that cannot
 * decide is a guard that will be tempted to.
 */
export async function establishArticleBaseline(
  wpPostId: number,
  client: WordpressClient,
  correlationId?: string,
): Promise<WordpressArticleSyncRow> {
  const observed = await client.getArticleSyncState(wpPostId, correlationId);

  if (!observed.wpContentHash || observed.postModifiedGmt === null) {
    throw new Error(
      `P1-R06: refusing to baseline post ${wpPostId} — WordPress could not state ${
        !observed.wpContentHash ? "a content hash" : "a post_modified_gmt"
      }`,
    );
  }

  const now = new Date();
  const values = {
    wpPostId,
    state: "BASELINE_SET" as const,
    wpContentHash: observed.wpContentHash,
    wpPostModifiedGmt: observed.postModifiedGmt,
    wpPostStatus: observed.postStatus,
    hashContractVersion: hashContractVersionOf(observed.wpContentHash),
    wpLastSyncedAt: now,
    // Re-baselining is how a conflict is resolved (AC-16), so the conflict
    // context is cleared here and only here.
    conflictDetectedAt: null,
    conflictReason: null,
    conflictBaselineHash: null,
    conflictObservedHash: null,
    conflictBaselineModifiedGmt: null,
    conflictObservedModifiedGmt: null,
    updatedAt: now,
  };

  const [row] = await db
    .insert(wordpressArticleSync)
    .values(values)
    .onConflictDoUpdate({ target: wordpressArticleSync.wpPostId, set: values })
    .returning();

  if (!row) throw new Error(`P1-R06: failed to record a baseline for post ${wpPostId}`);

  await recordAudit("r06.baseline.set", wpPostId, "baselined", observed.wpContentHash, correlationId);

  return row;
}

/**
 * PROPOSED §7A steps 1–3: fetch, compare, decide.
 *
 * Every path that is not a clean, comparable, unchanged article returns REFUSE.
 * An upstream failure is a refusal too (AC-12) — unreachable is not unchanged,
 * and the retry belongs to the caller, not to a guard that would be guessing.
 */
export async function guardArticleUpdate(
  wpPostId: number,
  client: WordpressClient,
  correlationId?: string,
): Promise<GuardOutcome> {
  const baseline = await getArticleBaseline(wpPostId);

  let observedHash: string | null = null;
  let observedModified: string | null = null;
  let observedStatus: string | null = null;

  try {
    const observed = await client.getArticleSyncState(wpPostId, correlationId);
    observedHash = observed.wpContentHash;
    observedModified = observed.postModifiedGmt;
    observedStatus = observed.postStatus;
  } catch (err) {
    // AC-12, AC-13. Note the shape: the catch cannot fall through to ALLOW,
    // because every branch returns.
    const reason: ArticleGuardRefusal =
      err instanceof WordpressError && err.kind === "NOT_FOUND" ? "NOT_FOUND" : "UPSTREAM_UNAVAILABLE";
    const detail = err instanceof Error ? err.message : String(err);

    await recordAudit("r06.guard.refused", wpPostId, reason, detail, correlationId);
    return { decision: "REFUSE", reason, detail };
  }

  const verdict: GuardDecision = decideArticleSync(baseline, {
    wpContentHash: observedHash,
    postModifiedGmt: observedModified,
    postStatus: observedStatus,
  });

  if (verdict.decision === "REFUSE") {
    // §7A step 5 — capture the divergence now. Going back to WordPress later
    // to reconstruct it does not work: by then it may have moved again.
    if (baseline && isDivergence(verdict.reason) && baseline.state !== "CONFLICT") {
      await db
        .update(wordpressArticleSync)
        .set({
          state: "CONFLICT",
          conflictDetectedAt: new Date(),
          conflictReason: verdict.reason,
          conflictBaselineHash: baseline.wpContentHash,
          conflictObservedHash: observedHash,
          conflictBaselineModifiedGmt: baseline.wpPostModifiedGmt,
          conflictObservedModifiedGmt: observedModified,
          updatedAt: new Date(),
        })
        .where(eq(wordpressArticleSync.id, baseline.id));
    }

    await recordAudit("r06.guard.refused", wpPostId, verdict.reason, verdict.detail, correlationId);
    return { decision: "REFUSE", reason: verdict.reason, detail: verdict.detail };
  }

  await recordAudit("r06.guard.allowed", wpPostId, "allowed", verdict.wpContentHash, correlationId);

  return {
    decision: "ALLOW",
    permit: issueSyncPermit(wpPostId, verdict.wpContentHash, verdict.postModifiedGmt),
    wpContentHash: verdict.wpContentHash,
    postModifiedGmt: verdict.postModifiedGmt,
  };
}

/**
 * Resolve a conflict by re-baselining from a fresh read (AC-16).
 *
 * Deliberately not a flag flip. Clearing a conflict without re-reading would
 * leave the app believing a baseline that WordPress has already left behind,
 * which is the same defect as never having checked. The owner's decision about
 * *what to do with* the divergence is a later phase; this only restores the
 * guard's ability to compare.
 */
export async function resolveArticleConflict(
  wpPostId: number,
  client: WordpressClient,
  correlationId?: string,
): Promise<WordpressArticleSyncRow> {
  const row = await establishArticleBaseline(wpPostId, client, correlationId);
  await recordAudit("r06.conflict.resolved", wpPostId, "rebaselined", row.wpContentHash ?? "", correlationId);
  return row;
}
