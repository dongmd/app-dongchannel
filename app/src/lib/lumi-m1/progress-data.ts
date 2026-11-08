/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/** Reads the recorded facts the "Tiến trình" bar needs (read-only) and hands them to the pure deriveProgress. */
import { runTotalCap, type Db } from "./core";
import { deriveProgress, type Progress, type ProgressInput } from "../lumi/progress";

const TERMINAL = ["REJECTED", "CANCELLED", "DONE", "PARTIAL_DONE"];

export async function buildProgress(db: Db, now: Date, opts: { planId?: string } = {}): Promise<{ server_now: string; items: Progress[] }> {
  const goals = await db.query<any>(`SELECT id,code,title,status FROM lumi_goals WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 20`);
  const items: Progress[] = [];
  for (const g of goals) {
    const [plan] = await db.query<any>(
      `SELECT p.id,p.code,p.status,p.current_version,p.planning_task_id,p.lead_assistant_id FROM lumi_plans p WHERE p.goal_id=$1 ORDER BY (p.status <> ALL($2::text[])) DESC, p.created_at DESC LIMIT 1`, [g.id, TERMINAL]);
    if (opts.planId && plan?.id !== opts.planId) continue;
    let input: ProgressInput = { goal: g, plan: null, version: null, planningTask: null, planningRun: null, runLimitSeconds: null, leadReady: false, leadName: null, runs: null, tasks: [] };
    if (plan) {
      const [lead] = await db.query<any>(`SELECT slug,name,run_deadline_seconds,(connection_state='VERIFIED' AND dispatch_enabled AND status='ACTIVE') AS ready FROM lumi_assistants WHERE id=$1`, [plan.lead_assistant_id]);
      const [version] = plan.current_version ? await db.query<any>(`SELECT version,state FROM lumi_plan_versions WHERE plan_id=$1 AND version=$2`, [plan.id, plan.current_version]) : [];
      const [ptask] = plan.planning_task_id ? await db.query<any>(`SELECT code,status::text AS status,error_code,needs_decision FROM tasks WHERE id=$1`, [plan.planning_task_id]) : [];
      const [prun] = plan.planning_task_id ? await db.query<any>(`SELECT state,attempt_no,created_at,started_at,deadline_at,error_code,error_message FROM lumi_task_runs WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [plan.planning_task_id]) : [];
      const tasks = await db.query<any>(`SELECT code,title,status::text AS status,needs_decision,error_code FROM tasks WHERE plan_id=$1 AND id IS DISTINCT FROM $2 ORDER BY created_at`, [plan.id, plan.planning_task_id]);
      const used = lead ? (await db.query<any>(`SELECT count(*)::int AS n FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE a.slug=$1`, [lead.slug]))[0].n : 0;
      const iso = (v: any) => (v ? new Date(v).toISOString() : null);
      input = {
        goal: g, plan: { id: plan.id, code: plan.code, status: plan.status, current_version: plan.current_version },
        version: version ?? null, planningTask: ptask ?? null,
        planningRun: prun ? { ...prun, created_at: iso(prun.created_at)!, started_at: iso(prun.started_at), deadline_at: iso(prun.deadline_at) } : null,
        runLimitSeconds: lead?.run_deadline_seconds ?? null, leadReady: !!lead?.ready, leadName: lead?.name ?? null,
        runs: lead ? { used, cap: runTotalCap(lead.slug) } : null, tasks,
      };
    }
    items.push(deriveProgress(input, now));
  }
  return { server_now: now.toISOString(), items };
}
