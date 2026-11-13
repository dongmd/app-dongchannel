/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 8 (nhóm 1) — ORG-06 capacity/pause/transfer, PLN-04 preparation fund + availability board, PLN-01 change of plan lead.
 * Principles: a transfer never moves work that is running (two bots never execute one task); every change keeps history; a fund is an internal limit set by the owner, never a cost;
 * "available" is computed from MEASURED spend only and says how many runs are unmeasured.
 */
import { LumiError, audit, enqueueNotify, requireRole, type Db } from "./core";

const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_SQL = `t.status::text NOT IN ('COMPLETED','CANCELLED','FAILED','REJECTED','APPROVED','IMPORTED')`;

// ───────────────────────── ORG-06
export async function openCountFor(t: Db, assistantId: string): Promise<number> {
  const [r] = await t.query<any>(`SELECT count(*)::int n FROM tasks t WHERE t.owner_assistant_id=$1 AND ${OPEN_SQL}`, [assistantId]);
  return r?.n ?? 0;
}
/** called inside task creation: a full assistant refuses new work (the owner can transfer or raise the capacity) */
export async function enforceCapacity(t: Db, asst: any) {
  if (!asst?.capacity) return;
  await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cap:${asst.id}`]); // concurrent creations are serialised so the capacity can never be exceeded
  const n = await openCountFor(t, asst.id);
  if (n >= asst.capacity) throw new LumiError("CAPACITY_REACHED", 409, { assistant: asst.slug, capacity: asst.capacity, open: n });
}
export async function setCapacity(db: Db, a: { actorRef: string; assistantId: string; capacity: number | null; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (a.capacity !== null && !(Number.isInteger(a.capacity) && a.capacity >= 1 && a.capacity <= 50)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["capacity(1..50 hoặc bỏ trống)"] });
  const up = await db.query<any>(`UPDATE lumi_assistants SET capacity=$2 WHERE id=$1 RETURNING id,slug,capacity`, [a.assistantId, a.capacity]);
  if (!up.length) throw new LumiError("NOT_FOUND", 404);
  await audit(db, "assistant.capacity", a.actorRef, { assistantId: a.assistantId, capacity: a.capacity }, a.now);
  return { assistant: up[0] };
}
export async function setAssistantPaused(db: Db, a: { actorRef: string; assistantId: string; paused: boolean; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const up = await db.query<any>(`UPDATE lumi_assistants SET dispatch_paused=$2 WHERE id=$1 RETURNING id,slug,dispatch_paused`, [a.assistantId, a.paused]);
  if (!up.length) throw new LumiError("NOT_FOUND", 404);
  await audit(db, a.paused ? "assistant.paused" : "assistant.resumed", a.actorRef, { assistantId: a.assistantId }, a.now);
  return { assistant: up[0] };
}
/** moves QUEUED / waiting work (never RUNNING) to another active assistant of the same project; each move is a history row */
export async function transferWork(db: Db, a: { actorRef: string; fromId: string; toId: string; taskIds?: string[]; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (typeof a.reason !== "string" || a.reason.trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  if (a.fromId === a.toId) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["from≠to"] });
  if ((a.taskIds ?? []).some((x) => !UUID.test(x))) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["task_ids(uuid[])"] });
  return db.tx(async (t) => {
    const [from] = await t.query<any>(`SELECT id,slug FROM lumi_assistants WHERE id=$1 FOR UPDATE`, [a.fromId]);
    const [to] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE' FOR UPDATE`, [a.toId]);
    if (!from || !to) throw new LumiError("NOT_FOUND", 404);
    const movable = await t.query<any>(
      `SELECT t.id,t.code,t.project_id FROM tasks t WHERE t.owner_assistant_id=$1 AND t.status::text IN ('QUEUED','CAPTURED','WAITING_ASSISTANT') AND NOT EXISTS (SELECT 1 FROM lumi_task_runs r WHERE r.task_id=t.id AND r.state IN ('RUNNING','SENT','ACKED'))
         ${a.taskIds?.length ? "AND t.id = ANY($2::uuid[])" : ""} FOR UPDATE`, a.taskIds?.length ? [a.fromId, a.taskIds] : [a.fromId]);
    const moved: string[] = []; const skipped: string[] = [];
    for (const m of movable) {
      const [member] = await t.query<any>(`SELECT 1 FROM lumi_project_members WHERE project_id=$1 AND assistant_id=$2`, [m.project_id, to.id]);
      if (!member) { skipped.push(`${m.code}: bên nhận chưa thuộc dự án`); continue; }
      if (to.capacity && (await openCountFor(t, to.id)) + moved.length >= to.capacity) { skipped.push(`${m.code}: bên nhận đã đủ công suất`); continue; }
      await t.query(`UPDATE tasks SET owner_assistant_id=$2,profile_slug=$3,updated_at=$4 WHERE id=$1`, [m.id, to.id, to.hermes_profile ?? "unassigned", iso(a.now)]);
      await t.query(`UPDATE lumi_task_runs SET state='CANCELLED' WHERE task_id=$1 AND state='PENDING'`, [m.id]).catch(() => undefined);
      await t.query(`INSERT INTO lumi_transfers(task_id,from_assistant_id,to_assistant_id,reason,by,at) VALUES ($1,$2,$3,$4,$5,$6)`, [m.id, from.id, to.id, a.reason.trim(), a.actorRef, iso(a.now)]);
      moved.push(m.code);
    }
    await audit(t, "assistant.transfer", a.actorRef, { from: from.slug, to: to.slug, moved: moved.length, skipped: skipped.length }, a.now);
    return { moved, skipped, note: "Việc đang chạy không bị chuyển (không có hai bot cùng thực thi một việc); lịch sử và chi phí giữ nguyên." };
  });
}
export async function listCapacity(db: Db) {
  const rows = await db.query<any>(
    `SELECT a.id,a.slug,a.name,a.status,a.capacity,a.dispatch_paused,a.dispatch_enabled,
            (SELECT count(*)::int FROM tasks t WHERE t.owner_assistant_id=a.id AND ${OPEN_SQL}) AS open_tasks,
            (SELECT count(*)::int FROM tasks t WHERE t.owner_assistant_id=a.id AND t.status::text IN ('QUEUED','CAPTURED','WAITING_ASSISTANT')) AS movable
       FROM lumi_assistants a WHERE a.status='ACTIVE' ORDER BY a.name`);
  const hist = await db.query<any>(`SELECT tr.at,tr.reason,tr.by,t.code,f.slug AS from_slug,o.slug AS to_slug FROM lumi_transfers tr JOIN tasks t ON t.id=tr.task_id JOIN lumi_assistants f ON f.id=tr.from_assistant_id JOIN lumi_assistants o ON o.id=tr.to_assistant_id ORDER BY tr.at DESC LIMIT 30`);
  return { assistants: rows, transfers: hist };
}

// ───────────────────────── PLN-04 preparation fund + availability board
export async function setPrepFund(db: Db, a: { actorRef: string; scope: string; assistantId?: string; amount: number; periodStart: string; periodEnd: string; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad: string[] = [];
  if (!["COMPANY", "ASSISTANT"].includes(a.scope)) bad.push("scope(COMPANY|ASSISTANT)");
  if (a.scope === "ASSISTANT" && !(a.assistantId && UUID.test(a.assistantId))) bad.push("assistant_id(uuid)");
  if (a.scope === "COMPANY" && a.assistantId) bad.push("assistant_id(không dùng cho COMPANY)");
  if (!(Number(a.amount) > 0)) bad.push("amount(>0)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.periodStart ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(a.periodEnd ?? "") || a.periodEnd < a.periodStart) bad.push("period(YYYY-MM-DD, đến ≥ từ)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`prep-fund:${a.scope}:${a.assistantId ?? ""}`]);
    if (a.scope === "ASSISTANT") { const [x] = await t.query<any>(`SELECT 1 FROM lumi_assistants WHERE id=$1`, [a.assistantId]); if (!x) throw new LumiError("NOT_FOUND", 404); }
    await t.query(`UPDATE lumi_prep_funds SET active=false WHERE scope=$1 AND coalesce(assistant_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND active`, [a.scope, a.assistantId ?? null]);
    const [f] = await t.query<any>(`INSERT INTO lumi_prep_funds(scope,assistant_id,amount,period_start,period_end,set_by,note,set_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [a.scope, a.assistantId ?? null, a.amount, a.periodStart, a.periodEnd, a.actorRef, a.note ?? null, iso(a.now)]);
    await audit(t, "fund.prep_set", a.actorRef, { scope: a.scope, amount: a.amount }, a.now);
    return { fund: f };
  });
}
/** spend of runs that belong to NO approved plan task (planning runs, meetings, ad-hoc work): measured only, unmeasured counted apart */
async function prepSpend(db: Db, f: any) {
  const [r] = await db.query<any>(
    `SELECT coalesce(sum(CASE WHEN pr.state='MEASURED' THEN pr.after_usage-pr.before_usage END),0)::float AS measured,
            count(r.id) FILTER (WHERE pr.run_id IS NULL OR pr.state<>'MEASURED')::int AS unknown_runs
       FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id LEFT JOIN lumi_run_cost_probes pr ON pr.run_id=r.id
      WHERE r.state IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED') AND t.plan_task_key IS NULL
        AND r.finished_at >= $1::date AND r.finished_at < ($2::date + 1) ${f.assistant_id ? "AND r.assistant_id=$3" : ""}`, f.assistant_id ? [f.period_start, f.period_end, f.assistant_id] : [f.period_start, f.period_end]);
  return { measured: Number(r?.measured ?? 0), unknown_runs: Number(r?.unknown_runs ?? 0) };
}
export async function fundsOverview(db: Db) {
  const funds = await db.query<any>(`SELECT f.*, a.name AS assistant_name, a.slug AS assistant_slug FROM lumi_prep_funds f LEFT JOIN lumi_assistants a ON a.id=f.assistant_id WHERE f.active ORDER BY f.scope DESC, a.name`);
  const prep: any[] = [];
  for (const f of funds) {
    const s = await prepSpend(db, f); const amount = Number(f.amount);
    prep.push({ id: f.id, scope: f.scope, assistant_name: f.assistant_name, assistant_slug: f.assistant_slug, amount, currency: f.currency, period_start: f.period_start, period_end: f.period_end, set_by: f.set_by, set_at: f.set_at,
      spent_measured: s.measured, unknown_runs: s.unknown_runs, available: Math.max(0, amount - s.measured), over: s.measured > amount });
  }
  const plans = await db.query<any>(
    `SELECT p.id AS plan_id, p.code, p.lead_assistant_id, g.title, p.status, b.currency, b.ceiling::float AS ceiling, b.actual::float AS actual, b.committed::float AS committed, b.reserve::float AS reserve, b.unknown_count
       FROM lumi_budgets b JOIN lumi_plans p ON p.id=b.plan_id JOIN lumi_goals g ON g.id=p.goal_id WHERE b.kind='EXECUTE' AND b.state='ACTIVE' ORDER BY p.code`);
  return {
    prep, plans: plans.map((p: any) => ({ ...p, available: p.ceiling === null ? null : Math.max(0, p.ceiling - p.actual - p.committed - p.reserve) })),
    note: "Khả dụng = ngân sách − thực tế đã ghi nhận − cam kết còn mở − dự phòng khóa. Quỹ chuẩn bị chỉ trừ chi phí ĐO THẬT của các lượt không thuộc việc của kế hoạch đã duyệt; lượt chưa đo đếm riêng, không phải 0. Phân bổ giữa bot là hạn mức nội bộ, không phải chi phí.",
  };
}

// ───────────────────────── PLN-01
const LEAD_STATES = ["DRAFTING", "NEEDS_REVISION", "EXECUTING", "PAUSED_ADJUSTMENT", "DEFERRED"];
export async function changePlanLead(db: Db, a: { actorRef: string; planId: string; newLeadId: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (typeof a.reason !== "string" || a.reason.trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  return db.tx(async (t) => {
    const [p] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1 FOR UPDATE`, [a.planId]);
    if (!p) throw new LumiError("NOT_FOUND", 404);
    if (!LEAD_STATES.includes(p.status)) throw new LumiError("INVALID_TRANSITION", 409, { status: p.status, note: "Không đổi trưởng kế hoạch khi đang chờ duyệt (quyết định gắn với phiên bản) hoặc đã đóng" });
    if (p.lead_assistant_id === a.newLeadId) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["trưởng mới trùng trưởng hiện tại"] });
    const [n] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE' AND connection_state='VERIFIED'`, [a.newLeadId]);
    if (!n) throw new LumiError("NOT_FOUND", 404, { what: "trưởng mới (phải đang hoạt động và đã kiểm tra kết nối thật)" });
    const [member] = await t.query<any>(`SELECT 1 FROM lumi_project_members m JOIN lumi_goals g ON g.project_id=m.project_id WHERE g.id=$1 AND m.assistant_id=$2`, [p.goal_id, n.id]);
    if (!member) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["trưởng mới chưa thuộc dự án của kế hoạch"] });
    await t.query(`UPDATE lumi_plans SET lead_assistant_id=$2,updated_at=$3 WHERE id=$1`, [p.id, n.id, iso(a.now)]);
    await t.query(`INSERT INTO lumi_plan_lead_history(plan_id,from_assistant_id,to_assistant_id,reason,by,at) VALUES ($1,$2,$3,$4,$5,$6)`, [p.id, p.lead_assistant_id, n.id, a.reason.trim(), a.actorRef, iso(a.now)]);
    await enqueueNotify(t, `notify:lead:${p.id}:${iso(a.now)}`, { type: "PLAN_LEAD_CHANGED", plan: p.code, to: n.slug }, a.now);
    await audit(t, "plan.lead_changed", a.actorRef, { planId: p.id, to: n.slug }, a.now);
    return { plan: { id: p.id, code: p.code, lead_assistant_id: n.id }, note: "Việc đang chạy giữ nguyên người thực hiện; trưởng mới tổng hợp từ lượt kế tiếp. Trưởng kế hoạch không tự duyệt kế hoạch của mình." };
  });
}
export async function leadHistory(db: Db, planId: string) {
  return db.query<any>(`SELECT h.at,h.reason,h.by,f.slug AS from_slug,n.slug AS to_slug FROM lumi_plan_lead_history h LEFT JOIN lumi_assistants f ON f.id=h.from_assistant_id JOIN lumi_assistants n ON n.id=h.to_assistant_id WHERE h.plan_id=$1 ORDER BY h.at DESC`, [planId]);
}
