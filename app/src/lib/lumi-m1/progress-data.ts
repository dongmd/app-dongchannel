/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/** Reads the recorded facts the "Tiến trình" bar needs (read-only) and hands them to the pure deriveProgress. */
import { runTotalCap, type Db } from "./core";
import { deriveProgress, type Progress, type ProgressInput } from "../lumi/progress";
import { buildChecklist } from "../lumi/progress-checklist";
import { fieldHint } from "./plan-schema";

const TERMINAL = ["REJECTED", "CANCELLED", "DONE", "PARTIAL_DONE"];

export async function buildProgress(db: Db, now: Date, opts: { planId?: string } = {}): Promise<{ server_now: string; items: Progress[] }> {
  const goals = await db.query<any>(`SELECT id,code,title,status FROM lumi_goals WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 20`);
  const items: Progress[] = [];
  for (const g of goals) {
    const [plan] = await db.query<any>(
      `SELECT p.id,p.code,p.status,p.current_version,p.planning_task_id,p.lead_assistant_id FROM lumi_plans p WHERE p.goal_id=$1 ORDER BY (p.status <> ALL($2::text[])) DESC, p.created_at DESC LIMIT 1`, [g.id, TERMINAL]);
    if (opts.planId && plan?.id !== opts.planId) continue;
    let runId: string | null = null;
    let input: ProgressInput = { goal: g, plan: null, version: null, planningTask: null, planningRun: null, runLimitSeconds: null, leadReady: false, leadName: null, runs: null, tasks: [] };
    if (plan) {
      const [lead] = await db.query<any>(`SELECT slug,name,run_deadline_seconds,(connection_state='VERIFIED' AND dispatch_enabled AND status='ACTIVE') AS ready FROM lumi_assistants WHERE id=$1`, [plan.lead_assistant_id]);
      const [version] = plan.current_version ? await db.query<any>(`SELECT version,state FROM lumi_plan_versions WHERE plan_id=$1 AND version=$2`, [plan.id, plan.current_version]) : [];
      const [ptask] = plan.planning_task_id ? await db.query<any>(`SELECT code,status::text AS status,error_code,needs_decision FROM tasks WHERE id=$1`, [plan.planning_task_id]) : [];
      const [prun] = plan.planning_task_id ? await db.query<any>(`SELECT id,state,attempt_no,created_at,started_at,deadline_at,error_code,error_message FROM lumi_task_runs WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [plan.planning_task_id]) : [];
      const tasks = await db.query<any>(`SELECT code,title,status::text AS status,needs_decision,error_code FROM tasks WHERE plan_id=$1 AND id IS DISTINCT FROM $2 ORDER BY created_at`, [plan.id, plan.planning_task_id]);
      const used = lead ? (await db.query<any>(`SELECT count(*)::int AS n FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE a.slug=$1`, [lead.slug]))[0].n : 0;
      runId = prun?.id ?? null;
      const iso = (v: any) => (v ? new Date(v).toISOString() : null);
      input = {
        goal: g, plan: { id: plan.id, code: plan.code, status: plan.status, current_version: plan.current_version },
        version: version ?? null, planningTask: ptask ?? null,
        planningRun: prun ? { ...prun, created_at: iso(prun.created_at)!, started_at: iso(prun.started_at), deadline_at: iso(prun.deadline_at) } : null,
        runLimitSeconds: lead?.run_deadline_seconds ?? null, leadReady: !!lead?.ready, leadName: lead?.name ?? null,
        runs: lead ? { used, cap: runTotalCap(lead.slug) } : null, tasks,
      };
    }
    const p = deriveProgress(input, now);
    if (plan) {
      const attempts = runId ? (await db.query<any>(`SELECT after_json->>'at' AS at, after_json->'errors' AS errors FROM audit_events WHERE action='plan.submit_rejected' AND after_json->>'runId'=$1 ORDER BY after_json->>'at'`, [runId])) : [];
      const [sub] = plan.current_version ? await db.query<any>(`SELECT version,submitted_at FROM lumi_plan_versions WHERE plan_id=$1 AND version=$2`, [plan.id, plan.current_version]) : [];
      p.checklist = buildChecklist({
        planStatus: plan.status, version: sub ? { version: sub.version, submitted_at: sub.submitted_at ? new Date(sub.submitted_at).toISOString() : null } : null,
        run: input.planningRun ? { state: input.planningRun.state, created_at: input.planningRun.created_at, started_at: input.planningRun.started_at, finished_at: null, error_code: input.planningRun.error_code } : null,
        attempts: attempts.map((a: any) => ({ at: a.at, errors: Array.isArray(a.errors) ? a.errors : [] })), tasks: input.tasks.map((t) => ({ status: t.status })), hintFor: fieldHint,
      });
    }
    items.push(p);
  }
  return { server_now: now.toISOString(), items };
}
