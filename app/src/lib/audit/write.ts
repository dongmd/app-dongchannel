import { auditEvents } from "../db/schema/audit";
import { buildAuditRecord, type AuditInput } from "./audit-policy";

// Deliberately NOT `import "server-only"`.
//
// The convention marks modules that must never reach the browser bundle
// because they hold a connection, an env var or a secret. This module holds
// none: the transaction is INJECTED, and the schema import is a pure Drizzle
// declaration. That is the same reasoning TD-21 recorded when `decideRetry`
// was lifted out of `sync-worker.ts` -- a decision that can only be exercised
// against production is a decision nobody exercises. AC-09's throw semantics
// are the heart of this requirement and have to be provable offline.

/**
 * P3-R06 — writing to the canonical audit log.
 *
 * ## Two rules, and they are the whole module
 *
 * **AC-08 — the entry and the change are one transaction.** This function
 * takes the transaction handle rather than opening its own. A change that
 * commits while its audit entry rolls back is an unrecorded change, and the
 * only way to make that impossible is to give the caller no way to separate
 * them.
 *
 * **AC-09 — a failed audit write fails the operation.** It throws. The log is
 * not best-effort: an action that could not be recorded did not happen.
 *
 * ## Why this is a new function rather than a change to the old one
 *
 * `lib/auth/audit.ts` catches and swallows, with the recorded reason that an
 * audit failure must not lock the owner out of their own dashboard. That is a
 * P1-era behaviour under a superseded story id, and R06's scope is **P3 state
 * changes** (AC-06). Changing the login path would widen this requirement into
 * an unrelated one and trade an availability property nobody asked to trade.
 * The divergence is recorded for the owner rather than resolved here.
 */

/** The narrow slice of a Drizzle transaction this needs. */
export interface AuditTx {
  insert: (table: typeof auditEvents) => {
    values: (row: Record<string, unknown>) => Promise<unknown>;
  };
}

export class AuditWriteError extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    // The detail names a PATH, never a value -- `buildAuditRecord` refuses to
    // echo a field it suspects of carrying a secret, and an exception message
    // travels into logs and error reports.
    super(`audit write refused: ${reason} (${detail})`);
    this.name = "AuditWriteError";
    this.reason = reason;
  }
}

/**
 * Record one audited action inside the caller's transaction.
 *
 * Throws on a refused or failed write. Callers do not catch it: the point is
 * that the surrounding transaction rolls back with it.
 */
export async function recordAudit(
  tx: AuditTx,
  input: AuditInput,
  now: Date,
): Promise<void> {
  const verdict = buildAuditRecord(input, now);

  if (!verdict.ok) {
    throw new AuditWriteError(verdict.reason, verdict.detail);
  }

  const r = verdict.record;

  // No try/catch. A database error propagates and takes the transaction with
  // it, which is AC-09 stated as code rather than as a comment.
  await tx.insert(auditEvents).values({
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    beforeJson: r.beforeJson,
    afterJson: r.afterJson,
    requestId: r.requestId,
    result: r.result,
    telegramRef: r.telegramRef,
    createdAt: r.at,
  });
}
