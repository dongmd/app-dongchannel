/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-02 / PRJ-01: the owner creates, edits and archives projects in the real-data mode. A new project shows up everywhere without code changes
 * (sidebar, Dashboard, Office read the same rows). The name is unique case-insensitively (existing unique index); nothing is deleted.
 */
import { createHash } from "node:crypto";
import { audit, LumiError, requireRole, type Db } from "./core";
import { uniqueViolation } from "./assistants";

const AREAS = ["AFFILIATE", "YOUTUBE", "WEBSITE", "OTHER"] as const;
const OPEN_TASK_TERMINAL = ["COMPLETED", "CANCELLED", "IMPORTED"];
const LIVE_PLAN = ["DRAFTING", "PENDING_APPROVAL", "NEEDS_REVISION", "DEFERRED", "EXECUTING", "PAUSED_ADJUSTMENT"];

export interface ProjectInput { name: string; area: string; goal?: string | null; pmAssistantId?: string | null; pmActorRef?: string | null; memberIds?: string[] }

export function slugify(name: string): string {
  const s = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s.length >= 2 ? s : "du-an";
}
function uuidFromKey(k: string): string {
  const h = createHash("sha256").update(k).digest();
  h[6] = (h[6]! & 0x0f) | 0x40; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
export function validateProjectInput(i: Partial<ProjectInput>, partial: boolean): string[] {
  const bad: string[] = [];
  if (!partial || i.name !== undefined) { if (typeof i.name !== "string" || i.name.trim().length < 3 || i.name.length > 100) bad.push("name(3..100)"); }
  if (!partial || i.area !== undefined) { if (!(AREAS as readonly string[]).includes(i.area as string)) bad.push(`area(${AREAS.join("|")})`); }
  if (i.goal !== undefined && i.goal !== null && (typeof i.goal !== "string" || i.goal.length > 1000)) bad.push("goal(<=1000)");
  if (i.pmAssistantId && i.pmActorRef) bad.push("pm(chỉ một: trợ lý HOẶC người)");
  return bad;
}

async function applyMembers(t: Db, projectId: string, ids: string[]) {
  for (const id of ids) if (!(await t.query(`SELECT 1 FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [id])).length) throw new LumiError("NOT_FOUND", 404, { what: "assistant", id });
  await t.query(`DELETE FROM lumi_project_members WHERE project_id=$1 AND NOT (assistant_id = ANY($2::uuid[]))`, [projectId, ids]);
  for (const id of ids) await t.query(`INSERT INTO lumi_project_members(project_id,assistant_id,role) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [projectId, id]);
}

export async function createProject(db: Db, a: { actorRef: string; key: string; input: ProjectInput; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (!a.key || a.key.length < 8) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] });
  const bad = validateProjectInput(a.input, false);
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  const id = uuidFromKey(`project-create:${a.key}`);
  try { return await createProjectTx(db, a, id); } catch (e) {
    if (e && (e as any).code === "23505" && String((e as any).constraint_name ?? (e as any).constraint ?? (e as any).message ?? "").includes("lumi_projects_pkey")) { const [same] = await db.query<any>(`SELECT * FROM lumi_projects WHERE id=$1`, [id]); if (same) return { project: same, alreadyProcessed: true as const }; }
    throw uniqueViolation(e, [["lumi_projects_name_uq", "NAME_TAKEN"], ["slug", "NAME_TAKEN"]]) ?? e;
  }
}

async function createProjectTx(db: Db, a: { actorRef: string; key: string; input: ProjectInput; now: Date }, id: string) {
  const i = a.input;
  return db.tx(async (t) => {
    const [same] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1`, [id]);
    if (same) return { project: same, alreadyProcessed: true as const };
    if ((await t.query(`SELECT 1 FROM lumi_projects WHERE lower(name)=lower($1)`, [i.name.trim()])).length) throw new LumiError("NAME_TAKEN", 409);
    let slug = slugify(i.name); let n = 1;
    while ((await t.query(`SELECT 1 FROM lumi_projects WHERE slug=$1`, [slug])).length) { n += 1; slug = `${slugify(i.name).slice(0, 36)}-${n}`; }
    if (i.pmAssistantId && !(await t.query(`SELECT 1 FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [i.pmAssistantId])).length) throw new LumiError("NOT_FOUND", 404, { what: "assistant" });
    const [row] = await t.query<any>(
      `INSERT INTO lumi_projects(id,slug,name,area,goal,pm_actor_ref,pm_assistant_id,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8) RETURNING *`,
      [id, slug, i.name.trim(), i.area, i.goal ?? null, i.pmActorRef ?? null, i.pmAssistantId ?? null, a.now.toISOString()]);
    await applyMembers(t, id, i.memberIds ?? []);
    await audit(t, "project.created", a.actorRef, { projectId: id, slug, area: i.area }, a.now);
    return { project: row, alreadyProcessed: false as const };
  });
}

export async function updateProject(db: Db, a: { actorRef: string; id: string; patch: Partial<ProjectInput>; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad = validateProjectInput(a.patch, true);
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    const [cur] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1 FOR UPDATE`, [a.id]);
    if (!cur) throw new LumiError("NOT_FOUND", 404);
    if (cur.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { project_status: cur.status });
    const p = a.patch;
    if (p.name !== undefined && (await t.query(`SELECT 1 FROM lumi_projects WHERE lower(name)=lower($1) AND id<>$2`, [p.name.trim(), a.id])).length) throw new LumiError("NAME_TAKEN", 409);
    const pmA = p.pmAssistantId !== undefined; const pmH = p.pmActorRef !== undefined;
    await t.query(
      `UPDATE lumi_projects SET name=coalesce($2,name),area=coalesce($3,area),goal=CASE WHEN $4::boolean THEN $5 ELSE goal END,
         pm_assistant_id=CASE WHEN $6::boolean OR $8::boolean THEN $7 ELSE pm_assistant_id END,pm_actor_ref=CASE WHEN $6::boolean OR $8::boolean THEN $9 ELSE pm_actor_ref END WHERE id=$1`,
      [a.id, p.name?.trim() ?? null, p.area ?? null, p.goal !== undefined, p.goal ?? null, pmA, p.pmAssistantId ?? null, pmH, p.pmActorRef ?? null]);
    if (p.memberIds) await applyMembers(t, a.id, p.memberIds);
    await audit(t, "project.updated", a.actorRef, { projectId: a.id, fields: Object.keys(p) }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1`, [a.id]);
    return { project: row };
  });
}

/** Archive only a project with nothing open; the name and history stay. */
export async function archiveProject(db: Db, a: { actorRef: string; id: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [cur] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1 FOR UPDATE`, [a.id]);
    if (!cur) throw new LumiError("NOT_FOUND", 404);
    if (cur.status === "ARCHIVED") return { project: cur, alreadyProcessed: true as const };
    if (cur.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { project_status: cur.status });
    const [o] = await t.query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks WHERE project_id=$1 AND status::text <> ALL($2::text[])`, [a.id, OPEN_TASK_TERMINAL]);
    const live = await t.query<any>(`SELECT code FROM lumi_plans WHERE project_id=$1 AND status = ANY($2::text[])`, [a.id, LIVE_PLAN]);
    const goals = await t.query<any>(`SELECT code FROM lumi_goals WHERE project_id=$1 AND status='ACTIVE'`, [a.id]);
    if (o!.n > 0 || live.length || goals.length) throw new LumiError("PROJECT_BUSY", 409, { open_tasks: o!.n, live_plans: live.map((x: any) => x.code), active_goals: goals.map((x: any) => x.code) });
    await t.query(`UPDATE lumi_projects SET status='ARCHIVED' WHERE id=$1`, [a.id]);
    await audit(t, "project.archived", a.actorRef, { projectId: a.id, slug: cur.slug }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1`, [a.id]);
    return { project: row, alreadyProcessed: false as const };
  });
}
