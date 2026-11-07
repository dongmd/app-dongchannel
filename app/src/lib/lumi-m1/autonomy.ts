/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Autonomous assistants on top of M1 (TDD 8.11). Four DIFFERENT things, never merged into one "level":
 *   1. capability   — which tools the assistant HAS (declared; not restricted by this app)           → declareCapability
 *   2. resources    — which accounts/projects it may touch                                           → grants (account_ref, project)
 *   3. authority    — which outside actions it may take by itself, with limits and an expiry         → createGrant / requestAction
 *   4. decisions    — when it must stop and ask the owner (no grant, over limit, ask condition)      → lumi_action_requests / decideActionRequest
 *
 * HONEST SCOPE: `requestAction` is a decision point the assistant must call through an app tool. It does NOT, by itself, stop a
 * terminal/browser from acting with credentials the profile already holds (TDD 8.11.4 lists exactly what is and is not enforced).
 */
import { getPolicy } from "./policies";
import { createHash, randomUUID } from "node:crypto";
import { LumiError, activity, audit, createRun, enqueueNotify, flag, requireRole, type Db, type HermesPort } from "./core";

const iso = (d: Date) => d.toISOString();
const addH = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);

// ───────────────────────── 1. capability
/** Owner declares the assistant keeps ALL its tools (DECLARED_FULL) or returns to the restricted allowlist. Switching forces dispatch OFF (re-enable re-checks). */
export async function declareCapability(db: Db, hermes: HermesPort, actorRef: string, assistantId: string, mode: "RESTRICTED" | "DECLARED_FULL", acknowledged: boolean, now: Date) {
  await requireRole(db, actorRef, ["OWNER"]);
  const [a] = await db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [assistantId]);
  if (!a) throw new LumiError("NOT_FOUND", 404);
  if (mode === "DECLARED_FULL" && acknowledged !== true) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["acknowledged"] });
  let snapshot: any = null;
  if (mode === "DECLARED_FULL" && a.hermes_profile) {
    const tools = await hermes.readProfileTools(a.hermes_profile); // best effort: the declaration does not depend on it, the record does
    snapshot = { tools, read_at: iso(now), readable: tools !== null };
  }
  await db.tx(async (t) => {
    await t.query(
      `UPDATE lumi_assistants SET capability_mode=$2,capability_snapshot=$3::jsonb,capability_ack_by=$4,capability_ack_at=$5,dispatch_enabled=false WHERE id=$1`,
      [assistantId, mode, snapshot === null ? null : JSON.stringify(snapshot), mode === "DECLARED_FULL" ? actorRef : null, mode === "DECLARED_FULL" ? iso(now) : null],
    );
    await audit(t, "assistant.capability_declared", actorRef, { assistantId, mode, tools_readable: snapshot?.readable ?? null }, now);
  });
}

export async function setAutonomyLimits(db: Db, actorRef: string, assistantId: string, v: { maxContinuations?: number; maxSubtasks?: number }, now: Date) {
  await requireRole(db, actorRef, ["OWNER"]);
  const mc = v.maxContinuations, ms = v.maxSubtasks;
  if ((mc !== undefined && (!Number.isInteger(mc) || mc < 0 || mc > 50)) || (ms !== undefined && (!Number.isInteger(ms) || ms < 0 || ms > 100))) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["max_continuations(0..50)|max_subtasks(0..100)"] });
  await db.query(`UPDATE lumi_assistants SET max_continuations=coalesce($2,max_continuations),max_subtasks=coalesce($3,max_subtasks) WHERE id=$1`, [assistantId, mc ?? null, ms ?? null]);
  await audit(db, "assistant.autonomy_limits", actorRef, { assistantId, maxContinuations: mc, maxSubtasks: ms }, now);
}

// ───────────────────────── 3. grants
export interface GrantInput {
  assistantId: string; projectId: string; accountRef: string; actionType: string; currency?: string;
  perActionMax?: number; budgetTotal?: number; countLimit?: number; askIfAmountOver?: number; validUntil: Date; note?: string;
}
const MAX_GRANT_DAYS = 365;
export async function createGrant(db: Db, actorRef: string, g: GrantInput, now: Date) {
  await requireRole(db, actorRef, ["OWNER"]);
  const money = g.perActionMax !== undefined || g.budgetTotal !== undefined || g.askIfAmountOver !== undefined;
  const bad: string[] = [];
  if (!g.accountRef?.trim()) bad.push("account_ref");
  if (!g.actionType?.trim()) bad.push("action_type");
  if (money && !g.currency) bad.push("currency");
  if (!(g.validUntil.getTime() > now.getTime())) bad.push("valid_until(future)");
  if (g.validUntil.getTime() > now.getTime() + MAX_GRANT_DAYS * 86400_000) bad.push(`valid_until(<=${MAX_GRANT_DAYS}d)`);
  for (const [k, v] of Object.entries({ per_action_max: g.perActionMax, budget_total: g.budgetTotal, count_limit: g.countLimit, ask_if_amount_over: g.askIfAmountOver })) if (v !== undefined && !(v >= 0)) bad.push(k);
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: bad });
  return db.tx(async (t) => {
    const [p] = await t.query<any>(`SELECT id,status FROM lumi_projects WHERE id=$1`, [g.projectId]);
    if (!p) throw new LumiError("NOT_FOUND", 404, { what: "project" });
    if (p.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { project_status: p.status }); // no authority on a mere proposal
    const [a] = await t.query<any>(`SELECT id FROM lumi_assistants WHERE id=$1`, [g.assistantId]);
    if (!a) throw new LumiError("NOT_FOUND", 404, { what: "assistant" });
    const [row] = await t.query<any>(
      `INSERT INTO lumi_grants (assistant_id,project_id,account_ref,action_type,currency,per_action_max,budget_total,count_limit,ask_if_amount_over,valid_from,valid_until,note,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [g.assistantId, g.projectId, g.accountRef.trim(), g.actionType.trim(), g.currency ?? null, g.perActionMax ?? null, g.budgetTotal ?? null, g.countLimit ?? null, g.askIfAmountOver ?? null, iso(now), iso(g.validUntil), g.note ?? null, actorRef],
    );
    await audit(t, "grant.created", actorRef, { assistantId: g.assistantId, grantId: row.id, accountRef: g.accountRef, actionType: g.actionType, budgetTotal: g.budgetTotal, validUntil: iso(g.validUntil) }, now);
    return row;
  });
}
export async function revokeGrant(db: Db, actorRef: string, grantId: string, now: Date) {
  await requireRole(db, actorRef, ["OWNER"]);
  const r = await db.query<any>(`UPDATE lumi_grants SET state='REVOKED',revoked_by=$2,revoked_at=$3 WHERE id=$1 AND state='ACTIVE' RETURNING id`, [grantId, actorRef, iso(now)]);
  if (!r.length) throw new LumiError("INVALID_TRANSITION", 409);
  await audit(db, "grant.revoked", actorRef, { grantId }, now);
}

// ───────────────────────── 3+4. evaluate / ask
export interface ActionRequestInput {
  assistantId: string; projectId: string; accountRef: string; actionType: string; amount?: number; currency?: string; summary: string;
  params?: unknown; taskId?: string; runId?: string; requestId?: string; now: Date;
}
export type ActionDecision =
  | { decision: "ALLOW"; grantId?: string; requestId?: string; reason: string }
  | { decision: "ASK"; requestId: string; basis: string; reason: string }
  | { decision: "DENY"; reason: string };

export const paramsHash = (i: { projectId: string; accountRef: string; actionType: string; amount?: number; currency?: string; params?: unknown }) =>
  createHash("sha256").update(JSON.stringify([i.projectId, i.accountRef, i.actionType, i.amount ?? null, i.currency ?? null, i.params ?? null])).digest("hex");

async function logDecision(t: Db, i: ActionRequestInput, hash: string, outcome: "ALLOW" | "ASK" | "DENY" | "USE_APPROVAL", reason: string, grantId?: string, requestId?: string) {
  await t.query(
    `INSERT INTO lumi_action_log (assistant_id,project_id,task_id,run_id,action_type,account_ref,amount,currency,params_hash,outcome,reason,grant_id,request_id,at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [i.assistantId, i.projectId, i.taskId ?? null, i.runId ?? null, i.actionType, i.accountRef, i.amount ?? null, i.currency ?? null, hash, outcome, reason, grantId ?? null, requestId ?? null, iso(i.now)],
  );
}

/**
 * The single decision point for an outside action. Returns ALLOW (grant consumed atomically, or an approval consumed once),
 * ASK (a pending request for the owner, bound to the exact parameters) or DENY (stop switches, inactive project, owner said no).
 */
export async function requestAction(db: Db, i: ActionRequestInput): Promise<ActionDecision> {
  if (!i.summary?.trim() || i.summary.length > 2000 || !i.actionType?.trim() || !i.accountRef?.trim()) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["summary|action_type|account_ref"] });
  const hash = paramsHash(i);
  return db.tx(async (t): Promise<ActionDecision> => {
    const [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [i.assistantId]);
    if (!asst) throw new LumiError("NOT_FOUND", 404);
    const deny = async (reason: string): Promise<ActionDecision> => { await logDecision(t, i, hash, "DENY", reason); return { decision: "DENY", reason }; };
    if (await flag(t, "emergency_stop")) return deny("EMERGENCY_STOP");
    if (asst.dispatch_paused) return deny("ASSISTANT_PAUSED");
    const [proj] = await t.query<any>(`SELECT id,status FROM lumi_projects WHERE id=$1`, [i.projectId]);
    if (!proj || proj.status !== "ACTIVE") return deny("PROJECT_NOT_ACTIVE");

    // A previously approved request is used ONCE, for the exact same parameters.
    if (i.requestId) {
      const [rq] = await t.query<any>(`SELECT * FROM lumi_action_requests WHERE id=$1 AND assistant_id=$2 FOR UPDATE`, [i.requestId, i.assistantId]);
      if (!rq || rq.params_hash !== hash) return deny("REQUEST_MISMATCH");
      if (rq.state === "APPROVED") {
        if (new Date(rq.expires_at) <= i.now) { await t.query(`UPDATE lumi_action_requests SET state='EXPIRED' WHERE id=$1`, [rq.id]); return deny("APPROVAL_EXPIRED"); }
        await t.query(`UPDATE lumi_action_requests SET state='CONSUMED',consumed_at=$2 WHERE id=$1`, [rq.id, iso(i.now)]);
        await logDecision(t, i, hash, "USE_APPROVAL", "owner approval used once", undefined, rq.id);
        return { decision: "ALLOW", requestId: rq.id, reason: "OWNER_APPROVED" };
      }
      if (rq.state === "PENDING") return { decision: "ASK", requestId: rq.id, basis: rq.basis, reason: "STILL_PENDING" };
      return deny(rq.state === "DENIED" ? "OWNER_DENIED" : `REQUEST_${rq.state}`);
    }

    const grants = await t.query<any>(
      `SELECT * FROM lumi_grants WHERE assistant_id=$1 AND project_id=$2 AND action_type=$3 AND account_ref=$4 AND state='ACTIVE' ORDER BY valid_until FOR UPDATE`,
      [i.assistantId, i.projectId, i.actionType, i.accountRef],
    );
    let basis = "NO_GRANT"; let basisGrant: string | undefined;
    const live = grants.filter((g: any) => new Date(g.valid_from) <= i.now && new Date(g.valid_until) > i.now);
    if (grants.length && !live.length) basis = "GRANT_EXPIRED";
    for (const g of live) {
      const hasMoneyLimits = g.per_action_max !== null || g.budget_total !== null || g.ask_if_amount_over !== null;
      const amt = i.amount;
      let why: string | null = null;
      if (hasMoneyLimits && amt === undefined) why = "OVER_LIMIT"; // a money-limited grant never covers an action with no stated amount
      else if (hasMoneyLimits && i.currency !== g.currency) why = "OVER_LIMIT";
      else if (g.per_action_max !== null && (amt ?? 0) > Number(g.per_action_max)) why = "OVER_LIMIT";
      else if (g.budget_total !== null && Number(g.spent) + (amt ?? 0) > Number(g.budget_total)) why = "BUDGET_LIMIT";
      else if (g.count_limit !== null && g.count_used + 1 > g.count_limit) why = "COUNT_LIMIT";
      else if (g.ask_if_amount_over !== null && (amt ?? 0) > Number(g.ask_if_amount_over)) why = "ASK_CONDITION";
      if (why) { basis = why; basisGrant = g.id; continue; }
      // Consume atomically (row is locked FOR UPDATE; re-check in the UPDATE itself so a bug above cannot overspend).
      const u = await t.query<any>(
        `UPDATE lumi_grants SET spent=spent+$2,count_used=count_used+1 WHERE id=$1 AND state='ACTIVE' AND valid_until > $3::timestamptz
           AND (budget_total IS NULL OR spent+$2 <= budget_total) AND (count_limit IS NULL OR count_used+1 <= count_limit) RETURNING id`,
        [g.id, amt ?? 0, iso(i.now)],
      );
      if (u.length === 1) { await logDecision(t, i, hash, "ALLOW", "within grant", g.id); return { decision: "ALLOW", grantId: g.id, reason: "WITHIN_GRANT" }; }
    }
    // No usable grant: the owner decides. One pending request per exact parameters (unique index), so a retry never piles up.
    const ins = await t.query<any>(
      `INSERT INTO lumi_action_requests (assistant_id,project_id,task_id,run_id,action_type,account_ref,amount,currency,summary,params_hash,basis,grant_id,expires_at,requested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING id`,
      [i.assistantId, i.projectId, i.taskId ?? null, i.runId ?? null, i.actionType, i.accountRef, i.amount ?? null, i.currency ?? null, i.summary, hash, basis, basisGrant ?? null, iso(addH(i.now, 24)), iso(i.now)],
    );
    let id: string = ins[0]?.id;
    if (!id) id = (await t.query<any>(`SELECT id FROM lumi_action_requests WHERE assistant_id=$1 AND project_id=$2 AND params_hash=$3 AND state IN ('PENDING','APPROVED')`, [i.assistantId, i.projectId, hash]))[0].id;
    else if (i.taskId) {
      await activity(t, i.taskId, "action.needs_decision", i.now, { requestId: id, basis, actionType: i.actionType });
      await enqueueNotify(t, `notify:action:${id}`, { type: "ACTION_NEEDS_DECISION", actionType: i.actionType, basis }, i.now);
    }
    await logDecision(t, i, hash, "ASK", basis, basisGrant, id);
    return { decision: "ASK", requestId: id, basis, reason: basis };
  });
}

/** OWNER decides a pending request. Repeat of the same decision is a no-op; the opposite decision is refused. Never by a bot. */
export async function decideActionRequest(db: Db, actorRef: string, requestId: string, decision: "APPROVE" | "DENY", note: string | undefined, now: Date) {
  if (actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT * FROM lumi_action_requests WHERE id=$1 FOR UPDATE`, [requestId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    const target = decision === "APPROVE" ? "APPROVED" : "DENIED";
    if (r.state === target || (decision === "APPROVE" && r.state === "CONSUMED")) return { alreadyProcessed: true as const, state: r.state };
    if (r.state !== "PENDING") throw new LumiError("ALREADY_DECIDED", 409, { state: r.state });
    if (new Date(r.expires_at) <= now) { await t.query(`UPDATE lumi_action_requests SET state='EXPIRED' WHERE id=$1`, [requestId]); throw new LumiError("GONE", 410); }
    if (decision === "DENY" && !(note ?? "").trim()) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["note"] });
    await t.query(`UPDATE lumi_action_requests SET state=$2,decided_by=$3,decided_at=$4,decision_note=$5 WHERE id=$1`, [requestId, target, actorRef, iso(now), note ?? null]);
    if (r.task_id) await activity(t, r.task_id, `action.${target.toLowerCase()}`, now, { requestId, by: actorRef });
    await audit(t, `action_request.${target.toLowerCase()}`, actorRef, { requestId, actionType: r.action_type, taskId: r.task_id ?? "" }, now);
    return { alreadyProcessed: false as const, state: target };
  });
}

// ───────────────────────── plan items (child tasks)
async function openRun(t: Db, assistantId: string, runId: string) {
  const [run] = await t.query<any>(`SELECT r.*,t.code AS task_code,t.project_id,t.parent_task_id FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.assistant_id=$2 FOR UPDATE OF r`, [runId, assistantId]);
  if (!run) throw new LumiError("NOT_FOUND", 404); // identical answer for unknown and someone else's
  if (!["DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"].includes(run.state)) throw new LumiError("INVALID_TRANSITION", 409, { run_state: run.state });
  return run;
}
const CHILD_STATE: Record<string, string> = { RUNNING: "RUNNING", COMPLETED: "COMPLETED", FAILED: "FAILED", SKIPPED: "CANCELLED" };

/** The assistant records a step of its plan as a child task of the task it was given. One level only; bounded by max_subtasks; idempotent per (run, title). */
export async function addPlanItem(db: Db, a: { assistantId: string; runId: string; title: string; description?: string; now: Date }) {
  const title = (a.title ?? "").trim();
  if (title.length < 3 || title.length > 200) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["title(3..200)"] });
  return db.tx(async (t) => {
    const run = await openRun(t, a.assistantId, a.runId);
    const [asst] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.assistantId]);
    if (run.parent_task_id) throw new LumiError("INVALID_TRANSITION", 409, { reason: "plan items cannot have plan items" });
    if (!(asst.max_subtasks > 0)) throw new LumiError("FORBIDDEN", 403, { reason: "SUBTASKS_DISABLED" });
    const key = `plan:${a.runId}:${createHash("sha256").update(title.toLowerCase()).digest("hex").slice(0, 16)}`;
    const prior = await t.query<any>(`SELECT code,status::text AS status FROM tasks WHERE source_key=$1`, [key]);
    if (prior[0]) return { item: prior[0], alreadyProcessed: true as const };
    const n = (await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM tasks WHERE parent_task_id=$1`, [run.task_id]))[0]!.n;
    if (Number(n) >= asst.max_subtasks) throw new LumiError("SUBTASK_LIMIT", 409, { max: asst.max_subtasks });
    const [row] = await t.query<any>(
      `INSERT INTO tasks (code,profile_slug,title,description,status,review_status,project_id,owner_kind,owner_assistant_id,parent_task_id,source_key,created_at,updated_at)
       VALUES ('DL-'||lpad(nextval('lumi_task_code_seq')::text,3,'0'),$1,$2,$3,'CAPTURED'::task_status,'NONE',$4,'BOT',$5,$6,$7,$8,$8) RETURNING code,status::text AS status`,
      [asst.hermes_profile ?? "unassigned", title, a.description ?? null, run.project_id, asst.id, run.task_id, key, iso(a.now)],
    );
    await activity(t, run.task_id, "plan.item_added", a.now, { code: row.code, title });
    return { item: row, alreadyProcessed: false as const };
  });
}

export async function updatePlanItem(db: Db, a: { assistantId: string; runId: string; code: string; state: "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED"; note?: string; now: Date }) {
  if (!CHILD_STATE[a.state]) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["state"] });
  return db.tx(async (t) => {
    const run = await openRun(t, a.assistantId, a.runId);
    const [c] = await t.query<any>(`SELECT id,status::text AS status FROM tasks WHERE code=$1 AND parent_task_id=$2 FOR UPDATE`, [a.code, run.task_id]);
    if (!c) throw new LumiError("NOT_FOUND", 404);
    const to = CHILD_STATE[a.state]!;
    if (c.status === to) return { alreadyProcessed: true as const };
    if (["COMPLETED", "CANCELLED"].includes(c.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: c.status });
    await t.query(`UPDATE tasks SET status=$2::task_status,started_at=CASE WHEN $2='RUNNING' THEN coalesce(started_at,$3::timestamptz) ELSE started_at END,completed_at=CASE WHEN $2 IN ('COMPLETED','CANCELLED','FAILED') THEN $3::timestamptz ELSE completed_at END,hold_reason=$4,updated_at=$3 WHERE id=$1`, [c.id, to, iso(a.now), a.note ?? null]);
    await activity(t, run.task_id, "plan.item_updated", a.now, { code: a.code, state: a.state, note: a.note ?? "" });
    return { alreadyProcessed: false as const };
  });
}

// ───────────────────────── proposals (a project IDEA is not an ACTIVE project)
const AREAS = ["AFFILIATE", "YOUTUBE", "WEBSITE", "OTHER"];
export async function proposeProject(db: Db, a: { assistantId: string; name: string; area: string; goal: string; evidence: string; now: Date }) {
  const name = (a.name ?? "").trim();
  if (name.length < 3 || name.length > 120 || !AREAS.includes(a.area) || (a.goal ?? "").trim().length < 3 || (a.evidence ?? "").trim().length < 10) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["name(3..120)|area|goal|evidence(>=10)"] });
  return db.tx(async (t) => {
    const open = (await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM lumi_projects WHERE proposed_by_assistant_id=$1 AND status='PROPOSED'`, [a.assistantId]))[0]!.n;
    if (Number(open) >= 20) throw new LumiError("TOO_MANY_PROPOSALS", 409, { max: 20 });
    const slug = `${name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "proposal"}-${randomUUID().slice(0, 6)}`;
    const ins = await t.query<any>(
      `INSERT INTO lumi_projects (slug,name,area,goal,status,proposal,proposed_by_assistant_id) VALUES ($1,$2,$3,$4,'PROPOSED',$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING id,slug`,
      [slug, name, a.area, a.goal.trim(), JSON.stringify({ evidence: a.evidence.trim(), proposed_at: iso(a.now) }), a.assistantId],
    );
    if (!ins[0]) { const [ex] = await t.query<any>(`SELECT id,slug FROM lumi_projects WHERE lower(name)=lower($1)`, [name]); return { project: ex, alreadyProcessed: true as const }; }
    await enqueueNotify(t, `notify:proposal:${ins[0].id}`, { type: "PROJECT_PROPOSED", name }, a.now);
    return { project: ins[0], alreadyProcessed: false as const };
  });
}

/** Owner turns a proposal into an ACTIVE project (activation itself commits nothing external: grants and spending are separate) or rejects it. */
export async function decideProposal(db: Db, actorRef: string, projectId: string, decision: "ACTIVATE" | "REJECT", now: Date) {
  if (actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [p] = await t.query<any>(`SELECT id,status,created_at FROM lumi_projects WHERE id=$1 FOR UPDATE`, [projectId]);
    if (!p) throw new LumiError("NOT_FOUND", 404);
    const target = decision === "ACTIVATE" ? "ACTIVE" : "REJECTED";
    if (p.status === target) return { alreadyProcessed: true as const };
    if (p.status !== "PROPOSED") throw new LumiError("INVALID_TRANSITION", 409, { status: p.status });
    if (decision === "ACTIVATE") {
      // CMP-03: when the owner has set a proposal lifetime, an expired proposal can no longer be activated (no policy set = no expiry; the system invents no number).
      const ttl = await getPolicy(t, "proposal_ttl_days");
      if (ttl && now.getTime() - new Date(p.created_at).getTime() > Number(ttl.value) * 86400_000) throw new LumiError("GONE", 410, { reason: "proposal_expired", ttl_days: Number(ttl.value) });
    }
    await t.query(`UPDATE lumi_projects SET status=$2,decided_by=$3,decided_at=$4 WHERE id=$1`, [projectId, target, actorRef, iso(now)]);
    await audit(t, `project.${decision.toLowerCase()}`, actorRef, { taskId: "", projectId }, now);
    return { alreadyProcessed: false as const };
  });
}

/** For knowledge_context: the plan and the earlier checkpoints of THIS task only. */
export async function taskPlanContext(db: Db, taskId: string) {
  const items = await db.query<any>(`SELECT code,title,status::text AS status,hold_reason FROM tasks WHERE parent_task_id=$1 ORDER BY created_at`, [taskId]);
  const checkpoints = await db.query<any>(`SELECT version,content FROM lumi_task_outputs WHERE task_id=$1 AND state='PROGRESS' ORDER BY version`, [taskId]);
  return { items, checkpoints };
}
export { createRun };
