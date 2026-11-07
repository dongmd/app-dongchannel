/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-03 (ORG-03, ORG-05, ORG-07, OFC-03): roles and appointments (who is responsible for which function), verified skills, the execution level the owner grants,
 * staff evaluation and the business case for adding a bot. APPOINTMENTS NEVER GRANT AUTHORITY: they say who answers for a function; grants/allowlists/capability
 * stay with the owner (ORG-04) and are never read or written here.
 */
import { activity, audit, LumiError, requireRole, type Db } from "./core";
import { createTask, type NewTask } from "./core-web";
import { reassignTaskTx } from "./coordination";
import { uniqueViolation } from "./assistants";
import { EXEC_LEVELS, MAX_LEVEL, toolsAboveLevel } from "./levels";

const iso = (d: Date) => d.toISOString();
const IN_FLIGHT = ["DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"];
const MOVABLE = ["CAPTURED", "QUEUED", "WAITING_ASSISTANT", "ON_HOLD", "FAILED", "REJECTED"];

// ───────────────────────── roles (ORG-03)
export async function createRole(db: Db, a: { actorRef: string; name: string; department?: string; description?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad: string[] = [];
  if (typeof a.name !== "string" || a.name.trim().length < 2 || a.name.length > 80) bad.push("name(2..80)");
  if (a.department !== undefined && a.department !== "" && !/^DEP-\d{2}$/.test(a.department)) bad.push("department(DEP-01..DEP-12)");
  if (a.description !== undefined && a.description.length > 1000) bad.push("description(<=1000)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  try {
    return await db.tx(async (t) => {
      if ((await t.query(`SELECT 1 FROM lumi_roles WHERE status='ACTIVE' AND lower(name)=lower($1)`, [a.name.trim()])).length) throw new LumiError("NAME_TAKEN", 409);
      const [r] = await t.query<any>(`INSERT INTO lumi_roles(code,name,department,description,created_by,created_at) VALUES ('ROLE-'||lpad(nextval('lumi_role_code_seq')::text,3,'0'),$1,$2,$3,$4,$5) RETURNING *`,
        [a.name.trim(), a.department || null, a.description?.trim() || null, a.actorRef, iso(a.now)]);
      await audit(t, "role.created", a.actorRef, { roleId: r.id, code: r.code }, a.now);
      return { role: r };
    });
  } catch (e) { throw uniqueViolation(e, [["lumi_roles_name_uq", "NAME_TAKEN"]]) ?? e; }
}

export async function archiveRole(db: Db, a: { actorRef: string; roleId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT * FROM lumi_roles WHERE id=$1 FOR UPDATE`, [a.roleId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    if (r.status === "ARCHIVED") return { alreadyProcessed: true as const };
    if ((await t.query(`SELECT 1 FROM lumi_appointments WHERE role_id=$1 AND state='ACTIVE'`, [a.roleId])).length) throw new LumiError("ROLE_IN_USE", 409);
    await t.query(`UPDATE lumi_roles SET status='ARCHIVED' WHERE id=$1`, [a.roleId]);
    await audit(t, "role.archived", a.actorRef, { roleId: a.roleId }, a.now);
    return { alreadyProcessed: false as const };
  });
}

// ───────────────────────── appointments (ORG-03)
export interface AppointmentInput { roleId: string; assistantId: string; scope?: "COMPANY" | "PROJECT" | "PLAN"; scopeRef?: string; effectiveFrom?: Date; effectiveTo?: Date; substituteId?: string; note?: string }
export async function createAppointment(db: Db, a: { actorRef: string; input: AppointmentInput; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const i = a.input; const scope = i.scope ?? "COMPANY";
  try {
    return await db.tx(async (t) => {
      const [role] = await t.query<any>(`SELECT * FROM lumi_roles WHERE id=$1 AND status='ACTIVE'`, [i.roleId]);
      if (!role) throw new LumiError("NOT_FOUND", 404, { what: "role" });
      const [asst] = await t.query<any>(`SELECT id FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [i.assistantId]);
      if (!asst) throw new LumiError("NOT_FOUND", 404, { what: "assistant" });
      if (scope === "COMPANY" && i.scopeRef) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["scope_ref(không dùng với phạm vi toàn công ty)"] });
      if (scope === "PROJECT" && !(await t.query(`SELECT 1 FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [i.scopeRef ?? null])).length) throw new LumiError("NOT_FOUND", 404, { what: "project" });
      if (scope === "PLAN" && !(await t.query(`SELECT 1 FROM lumi_plans WHERE id=$1`, [i.scopeRef ?? null])).length) throw new LumiError("NOT_FOUND", 404, { what: "plan" });
      if (i.substituteId) {
        if (i.substituteId === i.assistantId) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["substitute(khác người được bổ nhiệm)"] });
        if (!(await t.query(`SELECT 1 FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [i.substituteId])).length) throw new LumiError("NOT_FOUND", 404, { what: "substitute" });
      }
      const from = i.effectiveFrom ?? a.now;
      if (i.effectiveTo && i.effectiveTo.getTime() <= from.getTime()) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["effective_to(sau effective_from)"] });
      if ((i.note ?? "").length > 1000) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["note(<=1000)"] });
      const [ap] = await t.query<any>(
        `INSERT INTO lumi_appointments(role_id,assistant_id,scope,scope_ref,effective_from,effective_to,substitute_assistant_id,handover_note,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [i.roleId, i.assistantId, scope, scope === "COMPANY" ? null : i.scopeRef, iso(from), i.effectiveTo ? iso(i.effectiveTo) : null, i.substituteId ?? null, i.note ?? null, a.actorRef, iso(a.now)]);
      await audit(t, "appointment.created", a.actorRef, { appointmentId: ap.id, roleId: i.roleId, assistantId: i.assistantId, scope }, a.now);
      return { appointment: ap };
    });
  } catch (e) { throw uniqueViolation(e, [["lumi_appt_active_uq", "ALREADY_APPOINTED"]]) ?? e; }
}

export async function endAppointment(db: Db, a: { actorRef: string; id: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx(async (t) => {
    const [ap] = await t.query<any>(`SELECT * FROM lumi_appointments WHERE id=$1 FOR UPDATE`, [a.id]);
    if (!ap) throw new LumiError("NOT_FOUND", 404);
    if (ap.state === "ENDED") return { appointment: ap, alreadyProcessed: true as const };
    await t.query(`UPDATE lumi_appointments SET state='ENDED',ended_by=$2,ended_at=$3,end_reason=$4 WHERE id=$1`, [a.id, a.actorRef, iso(a.now), a.reason.trim()]);
    await audit(t, "appointment.ended", a.actorRef, { appointmentId: a.id, reason: a.reason }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_appointments WHERE id=$1`, [a.id]);
    return { appointment: row, alreadyProcessed: false as const };
  });
}

/** Move a role to another bot: history stays, no authority is copied, running work is checked first (K8), open unstarted tasks of the role can follow. */
export async function transferAppointment(db: Db, a: { actorRef: string; id: string; toAssistantId: string; note?: string; moveOpenTasks?: boolean; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  try {
    return await db.tx(async (t) => {
      const [ap] = await t.query<any>(`SELECT * FROM lumi_appointments WHERE id=$1 FOR UPDATE`, [a.id]);
      if (!ap) throw new LumiError("NOT_FOUND", 404);
      if (ap.state !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { state: ap.state });
      if (ap.assistant_id === a.toAssistantId) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["to(khác người đang giữ vai)"] });
      if (!(await t.query(`SELECT 1 FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [a.toAssistantId])).length) throw new LumiError("NOT_FOUND", 404, { what: "assistant" });
      const running = await t.query<any>(`SELECT DISTINCT k.code FROM tasks k JOIN lumi_task_runs r ON r.task_id=k.id WHERE k.role_id=$1 AND k.owner_assistant_id=$2 AND r.state = ANY($3::text[])`, [ap.role_id, ap.assistant_id, IN_FLIGHT]);
      if (running.length) throw new LumiError("IN_FLIGHT", 409, { tasks: running.map((x: any) => x.code) }); // K8: wait for / stop running work first
      await t.query(`UPDATE lumi_appointments SET state='ENDED',ended_by=$2,ended_at=$3,end_reason='TRANSFERRED' WHERE id=$1`, [ap.id, a.actorRef, iso(a.now)]);
      const [nu] = await t.query<any>(
        `INSERT INTO lumi_appointments(role_id,assistant_id,scope,scope_ref,effective_from,handover_note,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$5) RETURNING *`,
        [ap.role_id, a.toAssistantId, ap.scope, ap.scope_ref, iso(a.now), a.note ?? ap.handover_note ?? null, a.actorRef]);
      let moved = 0;
      if (a.moveOpenTasks) {
        const open = await t.query<any>(`SELECT id FROM tasks WHERE role_id=$1 AND owner_assistant_id=$2 AND status::text = ANY($3::text[]) AND NOT EXISTS (SELECT 1 FROM lumi_task_runs r WHERE r.task_id=tasks.id AND r.state = ANY($4::text[]))`, [ap.role_id, ap.assistant_id, MOVABLE, IN_FLIGHT]);
        for (const k of open) { await reassignTaskTx(t, { taskId: k.id, toAssistantId: a.toAssistantId, actorRef: a.actorRef, reason: `Chuyển vai trò: ${a.note ?? "bổ nhiệm mới"}`, now: a.now }); moved += 1; }
      }
      await audit(t, "appointment.transferred", a.actorRef, { from: ap.assistant_id, to: a.toAssistantId, roleId: ap.role_id, movedTasks: moved }, a.now);
      return { appointment: nu, moved };
    });
  } catch (e) { throw uniqueViolation(e, [["lumi_appt_active_uq", "ALREADY_APPOINTED"]]) ?? e; }
}

/** A task is recorded under a role only if the assistant holds that role NOW (company-wide, for this project, or for a plan of this project). */
export async function assertRoleHeld(t: Db, roleId: string, assistantId: string, projectId: string, now: Date) {
  const r = await t.query(
    `SELECT 1 FROM lumi_appointments ap WHERE ap.role_id=$1 AND ap.assistant_id=$2 AND ap.state='ACTIVE' AND ap.effective_from <= $4::timestamptz AND (ap.effective_to IS NULL OR ap.effective_to > $4::timestamptz)
        AND (ap.scope='COMPANY' OR (ap.scope='PROJECT' AND ap.scope_ref=$3) OR (ap.scope='PLAN' AND EXISTS (SELECT 1 FROM lumi_plans p WHERE p.id=ap.scope_ref AND p.project_id=$3)))`, [roleId, assistantId, projectId, iso(now)]);
  if (!r.length) throw new LumiError("ROLE_NOT_HELD", 409, { role_id: roleId });
}

export async function createTaskWithRole(db: Db, a: NewTask & { roleId?: string; requiredSkill?: string }) {
  if (!a.roleId && !a.requiredSkill) return createTask(db, a);
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (a.requiredSkill !== undefined && (a.requiredSkill.trim().length < 2 || a.requiredSkill.length > 80)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["required_skill(2..80)"] });
  if (a.roleId && !a.assigneeId) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["role_id(cần người nhận là bot)"] });
  // validate the role BEFORE the task exists; the task is then created through the ordinary path (same validation, same idempotency)
  if (a.roleId) await assertRoleHeld(db, a.roleId, a.assigneeId!, a.projectId, a.now).catch((e) => { if (e instanceof LumiError && e.code === "ROLE_NOT_HELD") throw e; throw e; });
  const r = await createTask(db, a);
  if (!r.alreadyProcessed) {
    await db.query(`UPDATE tasks SET role_id=coalesce($2,role_id),required_skill=coalesce($3,required_skill) WHERE id=$1`, [r.task.id, a.roleId ?? null, a.requiredSkill?.trim() ?? null]);
    await db.tx(async (t) => activity(t, r.task.id, "task.role_recorded", a.now, { role: a.roleId ?? null, requiredSkill: a.requiredSkill ?? null }));
  }
  return r;
}

// ───────────────────────── verified skills (ORG-05)
export async function setSkill(db: Db, a: { actorRef: string; assistantId: string; skill: string; state: "UNVERIFIED" | "VERIFIED" | "MONITORED"; evidence?: string; environment?: string; limits?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad: string[] = [];
  if (typeof a.skill !== "string" || a.skill.trim().length < 2 || a.skill.length > 80) bad.push("skill(2..80)");
  if (!["UNVERIFIED", "VERIFIED", "MONITORED"].includes(a.state)) bad.push("state");
  if (a.state !== "UNVERIFIED") {
    if ((a.evidence ?? "").trim().length < 10) bad.push("evidence(>=10 ký tự: bằng chứng test)");
    if ((a.environment ?? "").trim().length < 2) bad.push("environment(môi trường đánh giá)");
  }
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    if (!(await t.query(`SELECT 1 FROM lumi_assistants WHERE id=$1`, [a.assistantId])).length) throw new LumiError("NOT_FOUND", 404);
    const verified = a.state !== "UNVERIFIED";
    const [row] = await t.query<any>(
      `INSERT INTO lumi_skills(assistant_id,skill,state,evidence,environment,limits,assessed_at,assessed_by,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (assistant_id, lower(skill)) DO UPDATE SET state=EXCLUDED.state,evidence=EXCLUDED.evidence,environment=EXCLUDED.environment,limits=EXCLUDED.limits,assessed_at=EXCLUDED.assessed_at,assessed_by=EXCLUDED.assessed_by,updated_at=EXCLUDED.updated_at RETURNING *`,
      [a.assistantId, a.skill.trim(), a.state, verified ? a.evidence!.trim() : (a.evidence?.trim() || null), verified ? a.environment!.trim() : (a.environment?.trim() || null), a.limits?.trim() || null, verified ? iso(a.now) : null, verified ? a.actorRef : null, iso(a.now)]);
    await audit(t, "skill.set", a.actorRef, { assistantId: a.assistantId, skill: a.skill.trim(), state: a.state }, a.now);
    return { skill: row };
  });
}

// ───────────────────────── execution level (OFC-03)
export async function setExecutionLevel(db: Db, a: { actorRef: string; assistantId: string; level: number; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (!Number.isInteger(a.level) || a.level < 0 || a.level > MAX_LEVEL) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`level(0..${MAX_LEVEL})`] });
  return db.tx(async (t) => {
    const [cur] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 FOR UPDATE`, [a.assistantId]);
    if (!cur) throw new LumiError("NOT_FOUND", 404);
    if (cur.execution_level === a.level) return { level: a.level, alreadyProcessed: true as const };
    if (a.level === MAX_LEVEL && cur.capability_mode !== "DECLARED_FULL") throw new LumiError("LEVEL_NEEDS_FULL", 409);
    const above = toolsAboveLevel(a.level, cur.tool_allowlist as string[], cur.capability_mode);
    if (above.length) throw new LumiError("LEVEL_BELOW_TOOLS", 409, { tools: above, level: a.level });
    await t.query(`UPDATE lumi_assistants SET execution_level=$2 WHERE id=$1`, [a.assistantId, a.level]);
    await audit(t, "assistant.execution_level", a.actorRef, { assistantId: a.assistantId, from: cur.execution_level, to: a.level, note: a.note ?? null }, a.now);
    return { level: a.level, alreadyProcessed: false as const };
  });
}

// ───────────────────────── evaluation and business cases (ORG-07)
/**
 * Period report per assistant from RECORDED facts. It states what was counted and what could not be measured; it draws NO efficiency conclusion
 * (counts of bots, tasks or tests are not evidence of value — K6 needs measured numbers) and never ranks or auto-recommends.
 */
export async function evaluateStaff(db: Db, o: { from: Date; to: Date }) {
  const a = [iso(o.from), iso(o.to)];
  const rows = await db.query<any>(
    `SELECT s.id,s.slug,s.name,s.status,s.execution_level,
       (SELECT coalesce(json_agg(r.name ORDER BY r.name),'[]'::json) FROM lumi_appointments ap JOIN lumi_roles r ON r.id=ap.role_id WHERE ap.assistant_id=s.id AND ap.state='ACTIVE') AS roles,
       (SELECT count(*)::int FROM tasks k WHERE k.owner_assistant_id=s.id AND k.created_at >= $1::timestamptz AND k.created_at < $2::timestamptz) AS tasks_created,
       (SELECT count(*)::int FROM tasks k WHERE k.owner_assistant_id=s.id AND k.status::text='COMPLETED' AND k.completed_at >= $1::timestamptz AND k.completed_at < $2::timestamptz) AS tasks_completed,
       (SELECT count(*)::int FROM tasks k WHERE k.owner_assistant_id=s.id AND k.status::text='COMPLETED' AND k.revision_round=0 AND k.completed_at >= $1::timestamptz AND k.completed_at < $2::timestamptz) AS first_pass,
       (SELECT coalesce(sum(k.revision_round),0)::int FROM tasks k WHERE k.owner_assistant_id=s.id AND k.updated_at >= $1::timestamptz AND k.updated_at < $2::timestamptz) AS revision_rounds,
       (SELECT count(*)::int FROM tasks k WHERE k.owner_assistant_id=s.id AND k.status::text IN ('FAILED','REJECTED') AND k.updated_at >= $1::timestamptz AND k.updated_at < $2::timestamptz) AS tasks_failed_or_rejected,
       (SELECT count(*)::int FROM lumi_task_runs r WHERE r.assistant_id=s.id AND r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz) AS runs,
       (SELECT count(*)::int FROM lumi_task_runs r WHERE r.assistant_id=s.id AND r.state IN ('FAILED','TIMED_OUT') AND r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz) AS runs_failed,
       (SELECT count(*)::int FROM lumi_handoffs h WHERE h.from_assistant_id=s.id AND h.created_at >= $1::timestamptz AND h.created_at < $2::timestamptz) AS handoffs_sent,
       (SELECT count(*)::int FROM lumi_handoffs h WHERE h.to_assistant_id=s.id AND h.created_at >= $1::timestamptz AND h.created_at < $2::timestamptz) AS handoffs_received,
       (SELECT count(*)::int FROM lumi_handoffs h WHERE h.to_assistant_id=s.id AND h.state IN ('REJECTED','ESCALATED') AND h.created_at >= $1::timestamptz AND h.created_at < $2::timestamptz) AS handoffs_rejected,
       (SELECT count(*)::int FROM task_activities x JOIN tasks k ON k.id=x.task_id WHERE k.owner_assistant_id=s.id AND x.event_type IN ('run.retry','run.reassign','task.reassigned','task.cancelled','task.reopened') AND x.occurred_at >= $1::timestamptz AND x.occurred_at < $2::timestamptz) AS owner_interventions,
       (SELECT count(*)::int FROM tasks k WHERE k.owner_assistant_id=s.id AND k.needs_decision) AS open_exceptions,
       (SELECT round(avg(extract(epoch FROM (ap.decided_at - o.created_at)))/3600.0, 2)::float FROM lumi_task_outputs o JOIN tasks k ON k.id=o.task_id JOIN lumi_approvals ap ON ap.kind='OUTPUT' AND ap.object_id=o.id AND ap.object_version=o.version WHERE k.owner_assistant_id=s.id AND ap.decided_at >= $1::timestamptz AND ap.decided_at < $2::timestamptz) AS avg_review_wait_hours
       FROM lumi_assistants s ORDER BY s.status, s.name`, a);
  return {
    from: iso(o.from), to: iso(o.to),
    staff: rows.map((r: any) => ({ ...r, first_pass_rate: r.tasks_completed > 0 ? r.first_pass / r.tasks_completed : null })),
    notes: [
      "Số liệu là số ĐẾM các sự kiện đã ghi; chi phí AI theo lượt CHƯA ĐO nên không có cột chi phí (không điền 0).",
      "Số bot, số việc hay số lần chạy KHÔNG phải bằng chứng hiệu quả; chưa kết luận giữ/gộp/tách/dừng.",
      "Quyết định thêm bot chỉ qua business case do người lập và Chủ duyệt; bot không tự tạo nhân viên hay tự duyệt đánh giá của mình.",
    ],
  };
}

const CASE_FIELDS = ["title", "work_needed", "volume", "extra_cost", "owner_time_saved", "trial_criteria", "stop_condition"] as const;
export async function createBotCase(db: Db, a: { actorRef: string; input: Record<(typeof CASE_FIELDS)[number], string> & { alternatives?: string }; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403); // a bot never creates paid staff
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const miss = CASE_FIELDS.filter((f) => typeof a.input[f] !== "string" || a.input[f].trim().length < 3);
  if (miss.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: miss });
  return db.tx(async (t) => {
    const [c] = await t.query<any>(
      `INSERT INTO lumi_bot_cases(code,title,work_needed,volume,extra_cost,owner_time_saved,trial_criteria,stop_condition,alternatives,proposed_by,created_at) VALUES ('BC-'||lpad(nextval('lumi_case_code_seq')::text,3,'0'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.input.title.trim(), a.input.work_needed.trim(), a.input.volume.trim(), a.input.extra_cost.trim(), a.input.owner_time_saved.trim(), a.input.trial_criteria.trim(), a.input.stop_condition.trim(), a.input.alternatives?.trim() || null, a.actorRef, iso(a.now)]);
    await audit(t, "botcase.created", a.actorRef, { caseId: c.id, code: c.code }, a.now);
    return { case: c };
  });
}
export async function decideBotCase(db: Db, a: { actorRef: string; caseId: string; decision: "APPROVE" | "REJECT"; note?: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [c] = await t.query<any>(`SELECT * FROM lumi_bot_cases WHERE id=$1 FOR UPDATE`, [a.caseId]);
    if (!c) throw new LumiError("NOT_FOUND", 404);
    const target = a.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (c.state === target) return { case: c, alreadyProcessed: true as const };
    if (c.state !== "PROPOSED") throw new LumiError("INVALID_TRANSITION", 409, { state: c.state });
    if (a.decision === "REJECT" && (a.note ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["note"] });
    await t.query(`UPDATE lumi_bot_cases SET state=$2,decided_by=$3,decided_at=$4,decision_note=$5 WHERE id=$1`, [a.caseId, target, a.actorRef, iso(a.now), a.note ?? null]);
    await audit(t, `botcase.${target.toLowerCase()}`, a.actorRef, { caseId: a.caseId }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_bot_cases WHERE id=$1`, [a.caseId]);
    return { case: row, alreadyProcessed: false as const };
  });
}

// ───────────────────────── read model
export async function listRoster(db: Db) {
  const roles = await db.query<any>(`SELECT * FROM lumi_roles ORDER BY status, code`);
  const appointments = await db.query<any>(
    `SELECT ap.*,r.name AS role_name,r.code AS role_code,a.name AS assistant_name,a.slug AS assistant_slug,s.name AS substitute_name,
            CASE ap.scope WHEN 'PROJECT' THEN (SELECT name FROM lumi_projects WHERE id=ap.scope_ref) WHEN 'PLAN' THEN (SELECT code FROM lumi_plans WHERE id=ap.scope_ref) ELSE NULL END AS scope_label
       FROM lumi_appointments ap JOIN lumi_roles r ON r.id=ap.role_id JOIN lumi_assistants a ON a.id=ap.assistant_id LEFT JOIN lumi_assistants s ON s.id=ap.substitute_assistant_id ORDER BY ap.state, r.code, ap.created_at DESC`);
  const skills = await db.query<any>(`SELECT k.*,a.slug AS assistant_slug,a.name AS assistant_name FROM lumi_skills k JOIN lumi_assistants a ON a.id=k.assistant_id ORDER BY a.name, lower(k.skill)`);
  const cases = await db.query<any>(`SELECT * FROM lumi_bot_cases ORDER BY created_at DESC LIMIT 50`);
  return { roles, appointments, skills, cases, levels: EXEC_LEVELS.map((l) => ({ level: l.level, label: l.label, note: l.note })) };
}
