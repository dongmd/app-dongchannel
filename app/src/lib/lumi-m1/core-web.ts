/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * M1 additions used by the HTTP layer and the worker: web task creation (TDD 8.6.4), releasing tasks that waited for an
 * assistant, transition endpoint (8.6.8), lease renewal (8.5), identity mirror, and read models for the UI.
 */
import { LumiError, activity, audit, cancelTask, createRun, enqueueNotify, missingExecConfig, requireRole, roleOf, type Db, type Role } from "./core";

const iso = (d: Date) => d.toISOString();

/** Mirror of the canonical role (email_allowlist) used by the core's role checks. Called by the HTTP layer per request. */
export async function upsertActor(db: Db, actorRef: string, role: Role, channel = "WEB") {
  await db.query(`INSERT INTO lumi_actors(actor_ref,role,channel) VALUES ($1,$2,$3) ON CONFLICT (actor_ref) DO UPDATE SET role=EXCLUDED.role`, [actorRef, role, channel]);
}

export async function createTask(
  db: Db,
  a: { actorRef: string; clientRequestId: string; projectId: string; assigneeId?: string; assigneeActorRef?: string; title: string; description?: string; due?: string; expectedOutput?: string; now: Date },
) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const missing: string[] = [];
  if (!a.clientRequestId) missing.push("client_request_id");
  if (!a.projectId) missing.push("project_id");
  if (!a.assigneeId && !a.assigneeActorRef) missing.push("assignee_id");
  if (!a.title || a.title.trim().length < 3) missing.push("title");
  if (missing.length) throw new LumiError("VALIDATION_ERROR", 400, { missing });
  const sourceKey = `web:${a.clientRequestId}`;
  return db.tx(async (t) => {
    const prior = await t.query<any>(`SELECT id,code,status FROM tasks WHERE source_key=$1`, [sourceKey]);
    if (prior[0]) return { task: prior[0], alreadyProcessed: true as const };
    const [proj] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [a.projectId]);
    if (!proj) throw new LumiError("NOT_FOUND", 404, { what: "project" });
    let asst: any = null;
    if (a.assigneeId) {
      [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [a.assigneeId]);
      if (!asst) throw new LumiError("NOT_FOUND", 404, { what: "assignee" });
    } else if (!(await roleOf(t, a.assigneeActorRef!))) throw new LumiError("NOT_FOUND", 404, { what: "assignee" });
    let dueAt: string | null = null;
    if (a.due) {
      const d = new Date(a.due);
      if (Number.isNaN(d.getTime())) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["due(invalid)"] });
      dueAt = d.toISOString();
    }
    let status: "QUEUED" | "WAITING_ASSISTANT" = "QUEUED";
    if (asst) {
      if (asst.connection_state !== "VERIFIED") status = "WAITING_ASSISTANT";
      else {
        const miss = missingExecConfig(asst);
        if (miss.length) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: miss });
        if (!asst.dispatch_enabled) status = "WAITING_ASSISTANT";
      }
    }
    const [task] = await t.query<any>(
      `INSERT INTO tasks (code,profile_slug,title,description,status,review_status,project_id,owner_kind,owner_assistant_id,owner_actor_ref,source_key,due_at,expected_output,created_at,updated_at)
       VALUES ('DL-'||lpad(nextval('lumi_task_code_seq')::text,3,'0'),$1,$2,$3,$4::task_status,'NONE',$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id,code,status`,
      [asst?.hermes_profile ?? "unassigned", a.title.trim(), a.description ?? null, status, proj.id, asst ? "BOT" : "HUMAN", asst?.id ?? null, asst ? null : a.assigneeActorRef, sourceKey, dueAt, a.expectedOutput ?? null, iso(a.now)],
    );
    await activity(t, task.id, "task.created", a.now, { source: "WEB", by: a.actorRef });
    if (asst && status === "QUEUED") await createRun(t, task.id, asst, "INITIAL", a.now, { text: a.description ?? a.title, title: a.title, expected_output: a.expectedOutput ?? null, due: dueAt });
    if (!asst) await enqueueNotify(t, `notify:assign:${task.id}`, { type: "HUMAN_ASSIGNED", taskCode: task.code, to: a.assigneeActorRef }, a.now);
    await audit(t, "task.created", a.actorRef, { taskId: task.id, source: "WEB" }, a.now);
    return { task, alreadyProcessed: false as const };
  });
}

/** TDD 8.6.8 — only transitions without a dedicated endpoint. */
export async function transitionTask(db: Db, a: { actorRef: string; taskId: string; to: string; expectedStatus: string; reason?: string; now: Date }) {
  const [t0] = await db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [a.taskId]);
  if (!t0) throw new LumiError("NOT_FOUND", 404);
  if (t0.status !== a.expectedStatus) throw new LumiError("STALE_VERSION", 409, { status: t0.status });
  if (a.to === "CANCELLED") {
    await cancelTask(db, a.actorRef, a.taskId, a.reason ?? "", a.now);
    return { status: "CANCELLED" };
  }
  throw new LumiError("INVALID_TRANSITION", 409, { to: a.to });
}

// ───────────────────────── read models for the UI (real rows, no mock)
export async function listTasks(db: Db, limit = 100) {
  return db.query<any>(
    `SELECT t.id,t.code,t.title,t.status,t.needs_decision,t.updated_at,t.due_at,p.name AS project_name,
            coalesce(a.name,t.owner_actor_ref) AS owner_name,t.owner_kind
     FROM tasks t LEFT JOIN lumi_projects p ON p.id=t.project_id LEFT JOIN lumi_assistants a ON a.id=t.owner_assistant_id
     WHERE t.project_id IS NOT NULL ORDER BY t.created_at DESC LIMIT $1`,
    [limit],
  );
}
export async function getTaskDetail(db: Db, taskId: string) {
  const [task] = await db.query<any>(
    `SELECT t.*,p.name AS project_name,a.name AS assistant_name,a.slug AS assistant_slug FROM tasks t
     LEFT JOIN lumi_projects p ON p.id=t.project_id LEFT JOIN lumi_assistants a ON a.id=t.owner_assistant_id WHERE t.id=$1`,
    [taskId],
  );
  if (!task) return null;
  const runs = await db.query<any>(`SELECT id,attempt_no,run_kind,state,remote_stop_state,error_code,error_message,created_at,finished_at FROM lumi_task_runs WHERE task_id=$1 ORDER BY attempt_no`, [taskId]);
  const outputs = await db.query<any>(`SELECT id,run_id,version,content,state,late,adopted_at,submitted_by,created_at FROM lumi_task_outputs WHERE task_id=$1 ORDER BY version`, [taskId]);
  const activities = await db.query<any>(`SELECT event_type,payload_redacted,occurred_at FROM task_activities WHERE task_id=$1 ORDER BY occurred_at,created_at`, [taskId]);
  const ids = outputs.map((o: any) => o.id);
  const approvals = ids.length ? await db.query<any>(`SELECT decision,reason,decided_by,channel,decided_at,object_version FROM lumi_approvals WHERE object_id = ANY($1::uuid[]) ORDER BY decided_at`, [ids]) : [];
  return { task, runs, outputs, activities, approvals };
}
export async function lumiOverview(db: Db) {
  const projects = await db.query<any>(`SELECT id,name,area FROM lumi_projects WHERE status='ACTIVE' ORDER BY name`);
  const assistants = await db.query<any>(`SELECT id,slug,name,connection_state,dispatch_enabled,dispatch_paused,hermes_profile FROM lumi_assistants WHERE status='ACTIVE' ORDER BY name`);
  const actors = await db.query<any>(`SELECT actor_ref,role FROM lumi_actors WHERE actor_ref NOT LIKE 'bot:%' ORDER BY actor_ref`);
  const flags = await db.query<any>(`SELECT key,value FROM lumi_system_flags`);
  const outbox = await db.query<any>(`SELECT state,count(*)::int AS n FROM lumi_outbox GROUP BY state`);
  return { projects, assistants, actors, flags, outbox };
}
