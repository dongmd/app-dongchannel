/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Rollback step "drain" (TDD 14.7): switch M1 off and return every task to a value the PREVIOUS release understands, so the old
 * code never meets an enum value it does not know. Idempotent. It never deletes data and never touches in-flight runs it cannot
 * safely stop — those are REPORTED so the operator can wait or cancel them first.
 *
 *   ON_HOLD            -> FAILED     (hold reason stays in tasks.hold_reason)
 *   WAITING_ASSISTANT  -> CAPTURED   (still owned by the assistant; re-release is a manual M1 action)
 * Every change is recorded in task_activities (event_type 'drain.status_rewritten') so it can be reversed by hand.
 */
import { audit, activity, type Db } from "./core";

export interface DrainReport { rewritten: { onHold: number; waitingAssistant: number }; pendingRunsCancelled: number; inFlightRuns: number }

export async function drainM1(db: Db, actorRef: string, now: Date): Promise<DrainReport> {
  const iso = now.toISOString();
  return db.tx(async (t) => {
    await t.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','false'::jsonb,$1,$2) ON CONFLICT (key) DO UPDATE SET value='false'::jsonb,set_by=EXCLUDED.set_by,set_at=EXCLUDED.set_at`, [actorRef, iso]);
    // Runs not yet handed to Hermes can be cancelled safely together with their outbox event.
    const pend = await t.query<any>(`UPDATE lumi_task_runs SET state='CANCELLED',finished_at=$1 WHERE state='PENDING' RETURNING id`, [iso]);
    if (pend.length) await t.query(`UPDATE lumi_outbox SET state='DEAD',last_error='drained',lease_owner=NULL,lease_expires_at=NULL WHERE kind='DISPATCH_RUN' AND state IN ('PENDING','LEASED') AND aggregate_id = ANY($1::uuid[])`, [pend.map((r: any) => r.id)]);
    const hold = await t.query<any>(`UPDATE tasks SET status='FAILED',updated_at=$1 WHERE status='ON_HOLD' RETURNING id`, [iso]);
    for (const r of hold) await activity(t, r.id, "drain.status_rewritten", now, { from: "ON_HOLD", to: "FAILED" });
    const wait = await t.query<any>(`UPDATE tasks SET status='CAPTURED',updated_at=$1 WHERE status='WAITING_ASSISTANT' RETURNING id`, [iso]);
    for (const r of wait) await activity(t, r.id, "drain.status_rewritten", now, { from: "WAITING_ASSISTANT", to: "CAPTURED" });
    const [fl] = await t.query<{ n: number }>(`SELECT count(*)::int AS n FROM lumi_task_runs WHERE state IN ('DISPATCHED','DISPATCH_UNCERTAIN','RUNNING')`);
    await audit(t, "m1.drain", actorRef, { taskId: "", onHold: hold.length, waiting: wait.length, pending: pend.length, inFlight: fl!.n }, now);
    return { rewritten: { onHold: hold.length, waitingAssistant: wait.length }, pendingRunsCancelled: pend.length, inFlightRuns: fl!.n };
  });
}
