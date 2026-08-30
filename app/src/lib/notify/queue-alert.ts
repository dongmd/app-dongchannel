import "server-only";

/**
 * P4-R09 AC-05 — putting a failure where the collector will find it.
 *
 * `idempotency-policy.ts` decides that a failure is terminal and that the owner
 * must be told; `buildOwnerAlert` composes what they are told. This is the one
 * step between: write it once, for the right assistant.
 */

import { db } from "@/lib/db";
import { ownerOutboundAlerts } from "@/lib/db/schema/notifications";
import { buildOwnerAlert, shouldAlert, type FailureOutcome, type OwnerAlert }
  from "@/lib/publish/idempotency-policy";
import { prepareAlert, type AlertRefusal } from "./outbound-policy";

export type QueueResult =
  | { readonly ok: true; readonly queued: boolean; readonly reason?: "NOT_ALERTABLE" | "ALREADY_QUEUED" }
  | { readonly ok: false; readonly reason: AlertRefusal; readonly detail: string | null };

/**
 * Queue the owner alert for one publish outcome.
 *
 * `queued: false` with `NOT_ALERTABLE` is a normal, successful outcome — a
 * retryable failure that will be retried in thirty seconds is not news, and
 * `shouldAlert` is what decides that. Returning an error for it would make the
 * caller treat a working system as broken.
 */
export async function queueOwnerAlert(
  outcome: FailureOutcome,
  alert: OwnerAlert,
  entityType = "article",
): Promise<QueueResult> {
  if (!shouldAlert(outcome)) {
    return { ok: true, queued: false, reason: "NOT_ALERTABLE" };
  }

  const verdict = prepareAlert(entityType, alert.articleId, buildOwnerAlert(alert));
  if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail };

  const rows = await db
    .insert(ownerOutboundAlerts)
    .values({
      profile: verdict.alert.profile,
      entityType: verdict.alert.entityType,
      entityId: verdict.alert.entityId,
      body: verdict.alert.body,
    })
    // The unique index on (entity_type, entity_id, body) is what stops the same
    // failure being queued once per read of its state. Doing nothing on
    // conflict is the correct outcome, not an error: the alert is already
    // waiting, and the owner should be told once.
    .onConflictDoNothing()
    .returning({ id: ownerOutboundAlerts.id });

  return rows.length > 0
    ? { ok: true, queued: true }
    : { ok: true, queued: false, reason: "ALREADY_QUEUED" };
}
