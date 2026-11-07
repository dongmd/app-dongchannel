/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-02 / ORG-02, OFC-02, OFC-04, EXE-01: the owner creates, edits and archives AI assistants (employee profiles) in the real-data mode, and asks for a
 * REAL connection check. Three states stay separate: profile created (this row), connected (connection_state, set ONLY by the check that runs on the
 * worker host, which can reach Hermes) and executing (dispatch_enabled + runs).
 * No secret is ever stored here: tokens/keys live in the Hermes profile, outside the app (OFC-04).
 */
import { createHash, randomUUID } from "node:crypto";
import { activity, audit, KNOWN_TOOLS, LumiError, requireRole, type Db } from "./core";

const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const OPEN_TASK_TERMINAL = ["COMPLETED", "CANCELLED", "IMPORTED"];
const iso = (d: Date) => d.toISOString();


/** A concurrent writer can pass the pre-checks and lose on the UNIQUE index: turn that into the same business error the pre-check gives (409), never a 500. */
export function uniqueViolation(e: any, map: [string, string][]): LumiError | null {
  if (e?.code !== "23505") return null;
  const hay = `${e.constraint_name ?? ""} ${e.constraint ?? ""} ${e.detail ?? ""} ${e.message ?? ""}`;
  for (const [frag, code] of map) if (hay.includes(frag)) return new LumiError(code, 409);
  return null;
}
const isPkViolation = (e: any, table: string) => e?.code === "23505" && `${e.constraint_name ?? ""} ${e.constraint ?? ""} ${e.message ?? ""}`.includes(`${table}_pkey`);

export interface AssistantLimits { runDeadlineSeconds: number; ackDeadlineSeconds: number; maxRunFailures: number; maxTransportAttempts: number; maxRevisionRounds: number; maxRunsPerDay: number }
export interface AssistantInput {
  slug: string; name: string; roleLabel: string; description?: string; avatar?: string; kind?: "SPECIALIST" | "PM";
  hermesProfile?: string | null; toolAllowlist: string[]; limits: AssistantLimits; projectIds?: string[];
}

function uuidFromKey(k: string): string {
  const h = createHash("sha256").update(k).digest();
  h[6] = (h[6]! & 0x0f) | 0x40; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Field-by-field validation shared by create and update (`partial`: only the supplied fields are checked). */
export function validateAssistantInput(i: Partial<AssistantInput>, partial: boolean): string[] {
  const bad: string[] = [];
  const has = (k: keyof AssistantInput) => i[k] !== undefined;
  if (!partial || has("slug")) { if (typeof i.slug !== "string" || !SLUG.test(i.slug)) bad.push("slug(a-z0-9-, 2..31, bắt đầu bằng chữ)"); }
  if (!partial || has("name")) { if (typeof i.name !== "string" || i.name.trim().length < 2 || i.name.length > 80) bad.push("name(2..80)"); }
  if (!partial || has("roleLabel")) { if (typeof i.roleLabel !== "string" || i.roleLabel.trim().length < 2 || i.roleLabel.length > 80) bad.push("roleLabel(2..80)"); }
  if (has("description") && i.description !== undefined && (typeof i.description !== "string" || i.description.length > 1000)) bad.push("description(<=1000)");
  if (has("avatar") && i.avatar !== undefined && (typeof i.avatar !== "string" || i.avatar.length > 16)) bad.push("avatar(<=16 ký tự)");
  if (has("hermesProfile") && i.hermesProfile !== null && i.hermesProfile !== undefined && (typeof i.hermesProfile !== "string" || !PROFILE.test(i.hermesProfile))) bad.push("hermesProfile(a-z0-9_-)");
  if (!partial || has("toolAllowlist")) {
    const t = i.toolAllowlist;
    if (!Array.isArray(t) || t.length === 0) bad.push("toolAllowlist(không rỗng)");
    else if (t.some((x) => !(KNOWN_TOOLS as readonly string[]).includes(x))) bad.push(`toolAllowlist(chỉ gồm: ${KNOWN_TOOLS.join(", ")})`);
  }
  if (!partial || has("limits")) {
    const l = i.limits as AssistantLimits | undefined;
    const r = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
    if (!l) bad.push("limits");
    else {
      if (!r(l.runDeadlineSeconds, 30, 3600)) bad.push("limits.runDeadlineSeconds(30..3600)");
      if (!r(l.ackDeadlineSeconds, 10, 600)) bad.push("limits.ackDeadlineSeconds(10..600)");
      if (!r(l.maxRunFailures, 1, 10)) bad.push("limits.maxRunFailures(1..10)");
      if (!r(l.maxTransportAttempts, 1, 5)) bad.push("limits.maxTransportAttempts(1..5)");
      if (!r(l.maxRevisionRounds, 0, 10)) bad.push("limits.maxRevisionRounds(0..10)");
      if (!r(l.maxRunsPerDay, 1, 1000)) bad.push("limits.maxRunsPerDay(1..1000)");
    }
  }
  return bad;
}

export async function createAssistant(db: Db, a: { actorRef: string; key: string; input: AssistantInput; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (!a.key || a.key.length < 8) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] });
  const bad = validateAssistantInput(a.input, false);
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  const id = uuidFromKey(`assistant-create:${a.key}`);
  try { return await createAssistantTx(db, a, id); } catch (e) {
    if (isPkViolation(e, "lumi_assistants")) { const [same] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [id]); if (same) return { assistant: same, alreadyProcessed: true as const }; }
    throw uniqueViolation(e, [["hermes_profile", "PROFILE_TAKEN"], ["slug", "SLUG_TAKEN"]]) ?? e;
  }
}

async function createAssistantTx(db: Db, a: { actorRef: string; key: string; input: AssistantInput; now: Date }, id: string) {
  const i = a.input;
  return db.tx(async (t) => {
    const [same] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [id]);
    if (same) return { assistant: same, alreadyProcessed: true as const };
    if ((await t.query(`SELECT 1 FROM lumi_assistants WHERE slug=$1`, [i.slug])).length) throw new LumiError("SLUG_TAKEN", 409);
    if ((await t.query(`SELECT 1 FROM lumi_assistants WHERE status='ACTIVE' AND lower(name)=lower($1)`, [i.name.trim()])).length) throw new LumiError("NAME_TAKEN", 409);
    if (i.hermesProfile) {
      if ((await t.query(`SELECT 1 FROM lumi_assistants WHERE hermes_profile=$1`, [i.hermesProfile])).length) throw new LumiError("PROFILE_TAKEN", 409);
      await t.query(`INSERT INTO profiles(slug,name,type,status) VALUES ($1,$2,'bot','active') ON CONFLICT (slug) DO NOTHING`, [i.hermesProfile, i.name.trim()]);
    }
    const l = i.limits;
    const [row] = await t.query<any>(
      `INSERT INTO lumi_assistants (id,slug,name,avatar,role_label,description,kind,hermes_profile,connection_state,execution_level,tool_allowlist,dispatch_enabled,
         max_runs_per_day,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'NONE',0,$9::jsonb,false,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [id, i.slug, i.name.trim(), i.avatar ?? null, i.roleLabel.trim(), i.description ?? null, i.kind ?? "SPECIALIST", i.hermesProfile ?? null, JSON.stringify(i.toolAllowlist),
       l.maxRunsPerDay, l.runDeadlineSeconds, l.ackDeadlineSeconds, l.maxRunFailures, l.maxTransportAttempts, l.maxRevisionRounds, iso(a.now)]);
    for (const pid of i.projectIds ?? []) {
      const [p] = await t.query<any>(`SELECT id FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [pid]);
      if (!p) throw new LumiError("PROJECT_NOT_ACTIVE", 409, { project_id: pid });
      await t.query(`INSERT INTO lumi_project_members(project_id,assistant_id,role) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [pid, id]);
    }
    await audit(t, "assistant.created", a.actorRef, { assistantId: id, slug: i.slug, hermesProfile: i.hermesProfile ?? null, tools: i.toolAllowlist }, a.now);
    return { assistant: row, alreadyProcessed: false as const };
  });
}

export async function updateAssistant(db: Db, a: { actorRef: string; id: string; patch: Partial<AssistantInput>; now: Date }) {
  try { return await updateAssistantTx(db, a); } catch (e) { throw uniqueViolation(e, [["hermes_profile", "PROFILE_TAKEN"]]) ?? e; }
}

async function updateAssistantTx(db: Db, a: { actorRef: string; id: string; patch: Partial<AssistantInput>; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad = validateAssistantInput({ ...a.patch, slug: undefined }, true);
  if (a.patch.slug !== undefined) bad.push("slug(không đổi được sau khi tạo)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    const [cur] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 FOR UPDATE`, [a.id]);
    if (!cur) throw new LumiError("NOT_FOUND", 404);
    if (cur.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { assistant_status: cur.status });
    const p = a.patch;
    if (p.name !== undefined && (await t.query(`SELECT 1 FROM lumi_assistants WHERE status='ACTIVE' AND lower(name)=lower($1) AND id<>$2`, [p.name.trim(), a.id])).length) throw new LumiError("NAME_TAKEN", 409);
    if (p.hermesProfile !== undefined && p.hermesProfile !== null && p.hermesProfile !== cur.hermes_profile) {
      if ((await t.query(`SELECT 1 FROM lumi_assistants WHERE hermes_profile=$1 AND id<>$2`, [p.hermesProfile, a.id])).length) throw new LumiError("PROFILE_TAKEN", 409);
      await t.query(`INSERT INTO profiles(slug,name,type,status) VALUES ($1,$2,'bot','active') ON CONFLICT (slug) DO NOTHING`, [p.hermesProfile, p.name?.trim() ?? cur.name]);
    }
    const profileChanged = p.hermesProfile !== undefined && p.hermesProfile !== cur.hermes_profile;
    const toolsChanged = p.toolAllowlist !== undefined && JSON.stringify([...p.toolAllowlist].sort()) !== JSON.stringify([...(cur.tool_allowlist as string[])].sort());
    const l = p.limits;
    await t.query(
      `UPDATE lumi_assistants SET name=coalesce($2,name),role_label=coalesce($3,role_label),description=coalesce($4,description),avatar=coalesce($5,avatar),
         hermes_profile=CASE WHEN $6::boolean THEN $7 ELSE hermes_profile END,tool_allowlist=coalesce($8::jsonb,tool_allowlist),
         max_runs_per_day=coalesce($9::int,max_runs_per_day),run_deadline_seconds=coalesce($10::int,run_deadline_seconds),ack_deadline_seconds=coalesce($11::int,ack_deadline_seconds),
         max_run_failures=coalesce($12::int,max_run_failures),max_transport_attempts=coalesce($13::int,max_transport_attempts),max_revision_rounds=coalesce($14::int,max_revision_rounds)
       WHERE id=$1`,
      [a.id, p.name?.trim() ?? null, p.roleLabel?.trim() ?? null, p.description ?? null, p.avatar ?? null, p.hermesProfile !== undefined, p.hermesProfile ?? null,
       p.toolAllowlist ? JSON.stringify(p.toolAllowlist) : null, l?.maxRunsPerDay ?? null, l?.runDeadlineSeconds ?? null, l?.ackDeadlineSeconds ?? null, l?.maxRunFailures ?? null,
       l?.maxTransportAttempts ?? null, l?.maxRevisionRounds ?? null]);
    // Changing WHAT the assistant can run (profile or tool allowlist) invalidates the connection check and switches dispatch OFF until it is checked again.
    if (profileChanged || toolsChanged) {
      await t.query(`UPDATE lumi_assistants SET connection_state='NONE',connection_checked_at=NULL,connection_error=NULL,dispatch_enabled=false WHERE id=$1`, [a.id]);
      await audit(t, "assistant.connection_reset", a.actorRef, { assistantId: a.id, profileChanged, toolsChanged }, a.now);
    }
    if (p.projectIds) {
      for (const pid of p.projectIds) if (!(await t.query(`SELECT 1 FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [pid])).length) throw new LumiError("PROJECT_NOT_ACTIVE", 409, { project_id: pid });
      await t.query(`DELETE FROM lumi_project_members WHERE assistant_id=$1 AND NOT (project_id = ANY($2::uuid[]))`, [a.id, p.projectIds]);
      for (const pid of p.projectIds) await t.query(`INSERT INTO lumi_project_members(project_id,assistant_id,role) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [pid, a.id]);
    }
    await audit(t, "assistant.updated", a.actorRef, { assistantId: a.id, fields: Object.keys(p), connectionReset: profileChanged || toolsChanged }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]);
    return { assistant: row, connectionReset: profileChanged || toolsChanged };
  });
}

/** Archive keeps the history (the name stays on past tasks/outputs/runs). Open tasks go back to the owner; nothing is deleted. */
export async function archiveAssistant(db: Db, a: { actorRef: string; id: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [cur] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 FOR UPDATE`, [a.id]);
    if (!cur) throw new LumiError("NOT_FOUND", 404);
    if (cur.status === "ARCHIVED") return { assistant: cur, alreadyProcessed: true as const, transferred: 0 };
    const [fl] = await t.query<{ n: number }>(`SELECT count(*)::int AS n FROM lumi_task_runs WHERE assistant_id=$1 AND state IN ('DISPATCHED','DISPATCH_UNCERTAIN','RUNNING')`, [a.id]);
    if (fl!.n > 0) throw new LumiError("IN_FLIGHT", 409, { runs: fl!.n });
    const live = await t.query<any>(`SELECT code,status FROM lumi_plans WHERE lead_assistant_id=$1 AND status IN ('DRAFTING','PENDING_APPROVAL','NEEDS_REVISION','DEFERRED','EXECUTING','PAUSED_ADJUSTMENT')`, [a.id]);
    if (live.length) throw new LumiError("PLAN_LIVE", 409, { plans: live.map((p: any) => p.code) });
    // runs not yet handed to Hermes can be cancelled safely together with their outbox rows
    const pend = await t.query<any>(`UPDATE lumi_task_runs SET state='CANCELLED',finished_at=$2 WHERE assistant_id=$1 AND state='PENDING' RETURNING id`, [a.id, iso(a.now)]);
    if (pend.length) await t.query(`UPDATE lumi_outbox SET state='DEAD',last_error='assistant archived',lease_owner=NULL,lease_expires_at=NULL WHERE kind='DISPATCH_RUN' AND state IN ('PENDING','LEASED') AND aggregate_id = ANY($1::uuid[])`, [pend.map((r: any) => r.id)]);
    const open = await t.query<any>(`SELECT id,status::text AS status FROM tasks WHERE owner_assistant_id=$1 AND status::text <> ALL($2::text[])`, [a.id, OPEN_TASK_TERMINAL]);
    for (const k of open) {
      const nextStatus = ["QUEUED", "WAITING_ASSISTANT"].includes(k.status) ? "CAPTURED" : k.status;
      await t.query(`UPDATE tasks SET owner_kind='HUMAN',owner_actor_ref=$2,owner_assistant_id=NULL,status=$3::task_status,updated_at=$4 WHERE id=$1`, [k.id, a.actorRef, nextStatus, iso(a.now)]);
      await activity(t, k.id, "task.owner_changed_on_archive", a.now, { from_assistant: cur.name, from_slug: cur.slug, status_before: k.status, status_after: nextStatus });
    }
    await t.query(`UPDATE lumi_assistants SET status='ARCHIVED',dispatch_enabled=false WHERE id=$1`, [a.id]);
    await audit(t, "assistant.archived", a.actorRef, { assistantId: a.id, slug: cur.slug, transferredTasks: open.length }, a.now);
    const [row] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]);
    return { assistant: row, alreadyProcessed: false as const, transferred: open.length };
  });
}

/** The owner asks for a real connection check. The WORKER (which can reach Hermes) performs it and writes the result. A double click is ONE request while one is
 *  still unprocessed; once it has run, asking again (e.g. after fixing the configuration) always creates a new request — never a silent no-op. */
export async function requestVerify(db: Db, a: { actorRef: string; id: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const [cur] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]);
  if (!cur) throw new LumiError("NOT_FOUND", 404);
  if (cur.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { assistant_status: cur.status });
  if (!cur.hermes_profile) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: ["hermes_profile"] });
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`verify:${a.id}`]); // two concurrent clicks cannot both see "nothing pending"
    const pending = await t.query(`SELECT 1 FROM lumi_outbox WHERE kind='VERIFY_ASSISTANT' AND aggregate_id=$1 AND state IN ('PENDING','LEASED')`, [a.id]);
    if (!pending.length) {
      await t.query(
        `INSERT INTO lumi_outbox (kind,aggregate_type,aggregate_id,dedupe_key,payload,max_attempts,next_attempt_at,created_at)
         VALUES ('VERIFY_ASSISTANT','assistant',$1,$2,$3::jsonb,2,$4,$4)`,
        [a.id, `verify:${a.id}:${randomUUID()}`, JSON.stringify({ assistantId: a.id }), iso(a.now)]);
      await audit(t, "assistant.verify_requested", a.actorRef, { assistantId: a.id }, a.now);
    }
    return { requested: true as const, alreadyPending: pending.length > 0 };
  });
}

/** Everything the Organization screen needs, read-only: profile, the real configuration the derived Q label comes from, and the last check. */
export async function listAssistants(db: Db) {
  return db.query<any>(
    `SELECT a.*,
       (SELECT coalesce(json_agg(json_build_object('id',p.id,'slug',p.slug,'name',p.name) ORDER BY p.name),'[]'::json) FROM lumi_project_members m JOIN lumi_projects p ON p.id=m.project_id WHERE m.assistant_id=a.id) AS projects,
       (SELECT json_build_object('state',o.state,'created_at',o.created_at,'last_error',o.last_error) FROM lumi_outbox o WHERE o.kind='VERIFY_ASSISTANT' AND o.aggregate_id=a.id ORDER BY o.created_at DESC LIMIT 1) AS verify_request,
       (SELECT count(*)::int FROM lumi_task_runs r WHERE r.assistant_id=a.id) AS runs_total,
       (SELECT count(*)::int FROM lumi_task_runs r WHERE r.assistant_id=a.id AND r.state IN ('DISPATCHED','DISPATCH_UNCERTAIN','RUNNING')) AS runs_in_flight,
       (SELECT count(*)::int FROM tasks k WHERE k.owner_assistant_id=a.id AND k.status::text <> ALL($1::text[])) AS open_tasks,
       (SELECT count(*)::int FROM lumi_grants g WHERE g.assistant_id=a.id AND g.state='ACTIVE' AND g.valid_until > now()) AS active_grants
       FROM lumi_assistants a ORDER BY a.status, a.created_at`, [OPEN_TASK_TERMINAL]);
}
