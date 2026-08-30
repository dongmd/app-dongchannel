import "server-only";

/**
 * P4-R12 — performing a retry.
 *
 * `retry-policy.ts` decides; this executes and records. Every refusal path
 * returns BEFORE any re-execution is requested, which is what `AC-02` asks to
 * be provable rather than asserted: the execution callback is injected, and a
 * test can show it was never called.
 *
 * ## `AC-05`: audited through `P3-R06`'s writer
 *
 * `recordAudit` and nothing else. No direct `audit_events` insert, so a retry
 * cannot happen without an audit row — the write and the audit share one
 * transaction, and a database error takes both.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { tasks, taskRetryAttempts } from "@/lib/db/schema/tasks";
import { recordAudit } from "@/lib/audit/write";
import {
  RETRY_POLICY,
  authorizeRetry,
  buildRetryAttempt,
  retryEligibility,
  type RetryAuthRefusal,
  type RetryIneligible,
  type RetryRequester,
} from "./retry-policy";

export type RetryOutcome =
  | { readonly ok: true; readonly attempt: number; readonly attemptId: string }
  | { readonly ok: false; readonly reason: RetryIneligible | RetryAuthRefusal; readonly detail: string | null };

/** Injected, so `AC-02` can be proven by a spy rather than inferred. */
export interface ReExecute {
  (taskId: string, attempt: number): Promise<void>;
}

export async function retryTask(
  deps: { requester: RetryRequester; reExecute: ReExecute; now: () => Date },
  taskId: string,
): Promise<RetryOutcome> {
  const [task] = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      profileSlug: tasks.profileSlug,
      retryCount: sql<number>`(
        SELECT count(*)::int FROM task_retry_attempts a WHERE a.task_id = ${tasks.id}
      )`,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  // ---- AC-02 BEFORE AC-01, deliberately.
  //
  // An unauthorized caller must not learn whether the task exists or what state
  // it is in. Checking eligibility first and authorization second would leak
  // both through the error code.
  const auth = authorizeRetry(deps.requester, task?.profileSlug ?? null);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason, detail: null };
  }

  const eligible = retryEligibility(
    task ? { id: task.id, status: task.status, retryCount: task.retryCount } : null,
  );
  if (!eligible.ok) {
    return { ok: false, reason: eligible.reason, detail: eligible.detail };
  }

  const now = deps.now();
  const record = buildRetryAttempt(taskId, eligible, deps.requester.userId!, now, RETRY_POLICY);

  // ---- One transaction: the attempt row, the status change and the audit.
  //
  // A retry recorded without an audit, or an audit for a retry that did not
  // record, are both worse than a failure -- they make the history wrong rather
  // than incomplete.
  let attemptId = "";
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(taskRetryAttempts)
      .values({
        taskId: record.taskId,
        attempt: record.attempt,
        fromStatus: record.fromStatus,
        requestedBy: record.requestedBy,
        requestedAt: record.requestedAt,
        policyVersion: record.policyVersion,
      })
      .returning({ id: taskRetryAttempts.id });
    attemptId = row?.id ?? "";

    // The task re-enters the queue. The PREVIOUS failure is untouched: it lives
    // in the attempt row's `from_status` and in whatever error the projection
    // already carries. AC-03.
    await tx.update(tasks).set({ status: "QUEUED" }).where(eq(tasks.id, taskId));

    await recordAudit(
      tx as never,
      {
        actorType: "user",
        actorId: deps.requester.userId,
        action: "task.retry",
        result: "OK",
        entityType: "task",
        entityId: taskId,
        // `before`/`after` rather than a free-form detail blob: the audit
        // schema has these fields and a parallel one would be a second way to
        // say the same thing.
        before: { status: record.fromStatus, retries: record.attempt - 1 },
        after: { status: "QUEUED", retries: record.attempt, policyVersion: record.policyVersion },
      },
      now,
    );
  });

  // ---- Outside the transaction on purpose.
  //
  // The re-execution is an external effect. Holding a transaction open across
  // it would keep a row lock for the length of an agent run, and rolling back
  // afterwards could not un-run it anyway.
  await deps.reExecute(taskId, record.attempt);

  return { ok: true, attempt: record.attempt, attemptId };
}

/** `AC-03`. The history, newest first. Nothing here rewrites anything. */
export async function retryHistory(taskId: string) {
  return db
    .select()
    .from(taskRetryAttempts)
    .where(eq(taskRetryAttempts.taskId, taskId))
    .orderBy(taskRetryAttempts.attempt);
}

/** Close out an attempt once the re-execution reports back. */
export async function finishRetryAttempt(
  attemptId: string,
  outcome: "SUCCEEDED" | "FAILED",
  now: Date,
) {
  await db
    .update(taskRetryAttempts)
    .set({ outcome, finishedAt: now })
    .where(and(eq(taskRetryAttempts.id, attemptId)));
}
