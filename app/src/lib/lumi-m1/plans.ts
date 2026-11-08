/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-01 — goal → Plan & Cost (versioned) → approval → tasks + budget commitments → internal execution → reports (TDD 14.11.B).
 *
 * Design rules (every one has a test):
 *  - A plan decision binds to (plan, version, content_hash) and is one lumi_approvals row (kind PLAN). Replays are `already_processed`.
 *  - Approval is ONE transaction: decision + budget + tasks + commitments + runs. Any failure (e.g. NO_BUDGET) rolls all of it back.
 *  - The ledger is append-only; counters on lumi_budgets are a projection updated in the SAME transaction (ledgerToBudget() proves it).
 *  - Unknown cost is NULL / source UNKNOWN, never 0. AI cost per run is not measurable yet, so every finished run books an UNKNOWN entry.
 *  - Task completion, plan completion and goal closure are three different facts. Only the owner closes a goal.
 *  - Nothing here calls a model. Bot-authored plan content is stored as data and never executed.
 */
import { createHash } from "node:crypto";
import { LumiError, activity, audit, cancelTask, enqueueNotify, flag, missingExecConfig, requireRole, type Db } from "./core";
import { createTaskInTx } from "./core-web";
import { contentHash, planBodyExample, validatePlanBody, type PlanBody } from "./plan-schema";

const iso = (d: Date) => d.toISOString();
const uuidFromKey = (k: string) => { const h = createHash("sha256").update(k).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const hermesModeNow = () => (process.env.LUMI_HERMES_MODE === "ssh" ? "ssh (Hermes thật qua SSH)" : "simulated (ADAPTER GIẢ)");
const N = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const OPEN_RUN = ["PENDING", "DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"];
const DONE_RUN = ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "ABANDONED", "STOPPED_CAP"];
const LIVE_PLAN = ["DRAFTING", "PENDING_APPROVAL", "NEEDS_REVISION", "DEFERRED", "EXECUTING", "PAUSED_ADJUSTMENT"];
const END_PLAN = ["REJECTED", "CANCELLED", "DONE", "PARTIAL_DONE"];

export const AI_COST_LIMIT_NOTE = "Chi phí AI chưa đo theo lượt. Trần ngân sách chỉ giới hạn các khoản được ghi vào sổ; không thay thế hạn mức ở tài khoản nhà cung cấp.";

// ───────────────────────── configuration and gating
export interface PlanLimits { maxTasks: number | null; versionTtlHours: number | null }
export function planLimits(env: Record<string, string | undefined> = process.env): PlanLimits {
  const mt = Number(env.LUMI_PLAN_MAX_TASKS);
  const ttl = Number(env.LUMI_PLAN_VERSION_TTL_HOURS);
  return { maxTasks: Number.isInteger(mt) && mt > 0 ? mt : null, versionTtlHours: Number.isFinite(ttl) && ttl > 0 ? ttl : null };
}
export async function plansEnabled(db: Db): Promise<boolean> { return (await flag(db, "plans_enabled")) && (await flag(db, "m1_enabled")); }
async function requirePlans(db: Db) {
  if (!(await flag(db, "m1_enabled"))) throw new LumiError("M1_DISABLED", 409);
  if (!(await flag(db, "plans_enabled"))) throw new LumiError("PLANS_DISABLED", 409);
}

/** OWNER switch. Enabling needs m1_enabled and the configured task limit (no default number is invented). */
export async function setPlansEnabled(db: Db, actorRef: string, value: boolean, now: Date, limits: PlanLimits = planLimits()) {
  await requireRole(db, actorRef, ["OWNER"]);
  if (value) {
    const miss: string[] = [];
    if (!(await flag(db, "m1_enabled"))) miss.push("m1_enabled");
    if (limits.maxTasks === null) miss.push("LUMI_PLAN_MAX_TASKS");
    if (miss.length) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: miss });
  }
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('plans_enabled',$1::jsonb,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,set_by=EXCLUDED.set_by,set_at=EXCLUDED.set_at`, [JSON.stringify(value), actorRef, iso(now)]);
  await audit(db, "flag.plans_enabled", actorRef, { value }, now);
}

async function auditPlan(t: Db, action: string, actor: string, planId: string, data: Record<string, unknown>, now: Date) {
  await audit(t, action, actor, { planId, ...data }, now);
}

// ───────────────────────── goals
export interface NewGoal { actorRef: string; key: string; title: string; outcome: string; projectId: string; metrics?: unknown; constraints?: unknown; maxLoss?: number; currency?: string; periodStart?: Date; periodEnd?: Date; now: Date }
export async function createGoal(db: Db, a: NewGoal) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad: string[] = [];
  if (!a.key || a.key.length < 8) bad.push("Idempotency-Key");
  if (!a.title || a.title.trim().length < 3 || a.title.length > 200) bad.push("title(3..200)");
  if (!a.outcome || a.outcome.trim().length < 3) bad.push("outcome");
  if ((a.maxLoss === undefined) !== (a.currency === undefined)) bad.push("max_loss+currency(together)");
  if (a.maxLoss !== undefined && !(a.maxLoss >= 0)) bad.push("max_loss(>=0)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: bad });
  await requirePlans(db);
  const key = `web:${a.key}`;
  return db.tx(async (t) => {
    const prior = await t.query<any>(`SELECT * FROM lumi_goals WHERE source_key=$1`, [key]);
    if (prior[0]) return { goal: prior[0], alreadyProcessed: true as const };
    const [p] = await t.query<any>(`SELECT id FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [a.projectId]);
    if (!p) throw new LumiError("NOT_FOUND", 404, { what: "project" });
    const [g] = await t.query<any>(
      `INSERT INTO lumi_goals (code,title,outcome,metrics,constraints,max_loss,currency,period_start,period_end,project_id,source_key,created_by,created_at)
       VALUES ('GL-'||lpad(nextval('lumi_goal_code_seq')::text,3,'0'),$1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [a.title.trim(), a.outcome.trim(), JSON.stringify(a.metrics ?? {}), JSON.stringify(a.constraints ?? {}), a.maxLoss ?? null, a.currency ?? null, a.periodStart ? iso(a.periodStart) : null, a.periodEnd ? iso(a.periodEnd) : null, a.projectId, key, a.actorRef, iso(a.now)],
    );
    await audit(t, "goal.created", a.actorRef, { goalId: g.id, code: g.code }, a.now);
    return { goal: g, alreadyProcessed: false as const };
  });
}

export async function closeGoal(db: Db, a: { actorRef: string; goalId: string; result: string; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (!["ACHIEVED", "NOT_ACHIEVED", "INSUFFICIENT_DATA", "ABANDONED"].includes(a.result)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["result"] });
  const note = (a.note ?? "").trim();
  // The system never decides that a business goal was met; when the owner says so, the evidence is theirs and must be written down.
  if ((a.result === "ACHIEVED" || a.result === "NOT_ACHIEVED") && note.length < 10) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["note(>=10, nêu bằng chứng)"] });
  return db.tx(async (t) => {
    const [g] = await t.query<any>(`SELECT * FROM lumi_goals WHERE id=$1 FOR UPDATE`, [a.goalId]);
    if (!g) throw new LumiError("NOT_FOUND", 404);
    if (g.status === "CLOSED") {
      if (g.result === a.result) return { goal: g, alreadyProcessed: true as const };
      throw new LumiError("ALREADY_DECIDED", 409, { result: g.result });
    }
    if (g.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { status: g.status });
    const live = await t.query<any>(`SELECT code,status FROM lumi_plans WHERE goal_id=$1 AND status = ANY($2::text[])`, [a.goalId, LIVE_PLAN]);
    if (live.length) throw new LumiError("PLAN_LIVE", 409, { plans: live.map((p: any) => `${p.code}:${p.status}`) });
    const [u] = await t.query<any>(`UPDATE lumi_goals SET status='CLOSED',result=$2,close_note=$3,closed_by=$4,closed_at=$5 WHERE id=$1 RETURNING *`, [a.goalId, a.result, note || null, a.actorRef, iso(a.now)]);
    await audit(t, "goal.closed", a.actorRef, { goalId: a.goalId, result: a.result }, a.now);
    return { goal: u, alreadyProcessed: false as const };
  });
}

// ───────────────────────── plan creation and the planning task
function planningInstruction(goal: any, plan: any, lead: any, limits: PlanLimits, round: number, extra?: string): string {
  const lines = [
    `Lập Plan & Cost cho mục tiêu ${goal.code}: ${goal.title}. (Kế hoạch ${plan.code}, lần ${round}.)`,
    `Kết quả mong muốn: ${goal.outcome}`,
    goal.max_loss !== null && goal.max_loss !== undefined ? `Mức lỗ tối đa Chủ chấp nhận: ${goal.max_loss} ${goal.currency}.` : "Chủ chưa đặt mức lỗ tối đa (không tự đặt thay Chủ).",
    Object.keys(goal.constraints ?? {}).length ? `Ràng buộc: ${JSON.stringify(goal.constraints)}` : "",
    extra ? `Yêu cầu của Chủ:\n${extra}` : "",
    "",
    "CÁCH LÀM: nghiên cứu, rồi gọi công cụ plan_submit_version(run_id, body) với body theo lược đồ v1 (schema=1): summary, opportunity{evidence[],confidence}, scope{in[],out[]}, deliverables[], tasks[], milestones[], cost{currency,ceiling_requested,lines[],unknown_note}, prepare_spent, grants_requested=[], stop_conditions[], risks[], alternatives[].",
    `- Mỗi việc (tasks[]) có key, title, description, deliverable_key, assignee_slug="${lead.slug}" (đúng bạn, vì đợt này chỉ một bot), expected_output, acceptance, due_in_days, budget_alloc{amount,currency}|null, depends_on=[] (chưa hỗ trợ phụ thuộc).`,
    `- Tối đa ${limits.maxTasks ?? "?"} việc. Dự toán thấp/cơ sở/cao theo từng khoản chi; số chưa biết để null (KHÔNG điền 0).`,
    "- Chưa có hành động bên ngoài: grants_requested phải rỗng; không chi tiền, không đăng, không nộp.",
    "- Nội dung là DỮ LIỆU để Chủ duyệt; ghi rõ nguồn và ngày của mọi bằng chứng; không bịa số liệu.",
    "- Nếu body lỗi, công cụ trả danh sách trường lỗi: sửa và gọi lại trong cùng lượt.",
    "- Nếu công cụ tìm web báo lỗi, KHÔNG thử lại nhiều lần: dùng hiểu biết sẵn có, ghi rõ «chưa kiểm chứng» trong ref của bằng chứng, rồi nộp kế hoạch. Nộp sớm một bản hợp lệ tốt hơn chạy hết lượt mà không nộp.",
    `- Mẫu body HỢP LỆ tối thiểu (thay nội dung, giữ nguyên cấu trúc): ${JSON.stringify(planBodyExample(lead.slug, goal.currency ?? "USD"))}`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

async function createPlanningTask(t: Db, a: { actorRef: string; plan: any; goal: any; lead: any; limits: PlanLimits; extra?: string; now: Date }) {
  const [c] = await t.query<{ n: string }>(`SELECT count(*)::text AS n FROM tasks WHERE plan_id=$1 AND plan_task_key IS NULL`, [a.plan.id]);
  const round = Number(c!.n) + 1;
  const r = await createTaskInTx(t, {
    actorRef: a.actorRef, clientRequestId: `planning-${a.plan.id}-${round}`, projectId: a.plan.project_id, assigneeId: a.lead.id,
    title: `Lập Plan & Cost ${a.plan.code} (lần ${round}) — ${a.goal.title}`.slice(0, 200),
    description: planningInstruction(a.goal, a.plan, a.lead, a.limits, round, a.extra), expectedOutput: "Một phiên bản Plan & Cost nộp bằng plan_submit_version",
    now: a.now, plan: { planId: a.plan.id, planVersion: null, planTaskKey: null, acceptance: null, sourceKey: `planning:${a.plan.id}:${round}`, source: "PLAN" },
  });
  await t.query(`UPDATE lumi_plans SET planning_task_id=$2,updated_at=$3 WHERE id=$1`, [a.plan.id, r.task.id, iso(a.now)]);
  return r.task;
}

export async function createPlan(db: Db, a: { actorRef: string; key: string; goalId: string; leadAssistantId: string; now: Date; limits?: PlanLimits }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (!a.key || a.key.length < 8) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] });
  await requirePlans(db);
  const limits = a.limits ?? planLimits();
  const pid = uuidFromKey(`plan-create:${a.key}`);
  return db.tx(async (t) => {
    const [same] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1`, [pid]);
    if (same) return { plan: same, alreadyProcessed: true as const };
    const [g] = await t.query<any>(`SELECT * FROM lumi_goals WHERE id=$1 FOR UPDATE`, [a.goalId]);
    if (!g) throw new LumiError("NOT_FOUND", 404, { what: "goal" });
    if (g.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { goal_status: g.status });
    const existing = await t.query<any>(`SELECT * FROM lumi_plans WHERE goal_id=$1 AND status = ANY($2::text[])`, [a.goalId, LIVE_PLAN]);
    if (existing[0]) throw new LumiError("PLAN_EXISTS", 409, { plan: existing[0].code, status: existing[0].status });
    const [proj] = await t.query<any>(`SELECT * FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [g.project_id]);
    if (!proj) throw new LumiError("PROJECT_NOT_ACTIVE", 409);
    const [lead] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1 AND status='ACTIVE'`, [a.leadAssistantId]);
    if (!lead) throw new LumiError("NOT_FOUND", 404, { what: "assistant" });
    const miss = missingExecConfig(lead);
    if (miss.length) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: miss });
    if (lead.connection_state !== "VERIFIED" || !lead.dispatch_enabled) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: ["assistant_ready(connected+dispatch_enabled)"] });
    const [plan] = await t.query<any>(
      `INSERT INTO lumi_plans (id,code,goal_id,project_id,lead_assistant_id,created_by,created_at,updated_at) VALUES ($6,'PL-'||lpad(nextval('lumi_plan_code_seq')::text,3,'0'),$1,$2,$3,$4,$5,$5) RETURNING *`,
      [g.id, g.project_id, lead.id, a.actorRef, iso(a.now), pid],
    );
    await t.query(`INSERT INTO lumi_budgets (plan_id,kind) VALUES ($1,'PREPARE')`, [plan.id]); // record-only: no ceiling (TDD 14.11.B.7)
    const task = await createPlanningTask(t, { actorRef: a.actorRef, plan, goal: g, lead, limits, now: a.now });
    await auditPlan(t, "plan.created", a.actorRef, plan.id, { goalId: g.id, code: plan.code }, a.now);
    return { plan: { ...plan, planning_task_id: task.id }, task, alreadyProcessed: false as const };
  });
}

// ───────────────────────── bot side: plan_submit_version
function leadReadyMap(lead: any): Map<string, boolean> {
  const ready = lead.status === "ACTIVE" && lead.connection_state === "VERIFIED" && lead.dispatch_enabled === true;
  return new Map([[lead.slug, ready]]);
}

/** Tasks of the approved version that may no longer be changed: started, or already holding an output. */
async function taskLockMap(t: Db, planId: string): Promise<Map<string, { id: string; locked: boolean; row: any }>> {
  const rows = await t.query<any>(
    `SELECT k.*, (SELECT count(*) FROM lumi_task_runs r WHERE r.task_id=k.id AND r.state <> 'PENDING')::int AS started, (SELECT count(*) FROM lumi_task_outputs o WHERE o.task_id=k.id)::int AS outs
       FROM tasks k WHERE k.plan_id=$1 AND k.plan_task_key IS NOT NULL`, [planId]);
  const m = new Map<string, { id: string; locked: boolean; row: any }>();
  for (const k of rows) m.set(k.plan_task_key, { id: k.id, row: k, locked: k.started > 0 || k.outs > 0 || !["QUEUED", "WAITING_ASSISTANT", "CAPTURED"].includes(k.status) });
  return m;
}
function sameTask(row: any, nt: PlanBody["tasks"][number]): boolean {
  const alloc = N(row.alloc_amount);
  const want = nt.budget_alloc?.amount ?? null;
  return row.title === nt.title.trim() && (row.expected_output ?? "") === nt.expected_output && (row.acceptance ?? "") === nt.acceptance && (alloc ?? null) === want;
}

export async function submitPlanVersion(db: Db, a: { runId: string; botSlug: string; body: unknown; now: Date; limits?: PlanLimits }) {
  const limits = a.limits ?? planLimits();
  await requirePlans(db);
  if (limits.maxTasks === null) throw new LumiError("CONFIG_INCOMPLETE", 422, { missing: ["LUMI_PLAN_MAX_TASKS"] });
  const maxTasks = limits.maxTasks;
  return db.tx(async (t) => {
    const [run] = await t.query<any>(`SELECT r.*, s.slug, k.id AS task_id FROM lumi_task_runs r JOIN lumi_assistants s ON s.id=r.assistant_id JOIN tasks k ON k.id=r.task_id WHERE r.id=$1 FOR UPDATE OF r`, [a.runId]);
    if (!run || run.slug !== a.botSlug) throw new LumiError("NOT_FOUND", 404);
    const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE planning_task_id=$1 FOR UPDATE`, [run.task_id]);
    if (!plan) throw new LumiError("NOT_FOUND", 404, { what: "plan_for_run" });
    const dup = await t.query<any>(`SELECT * FROM lumi_plan_versions WHERE plan_id=$1 AND submitted_run_id=$2`, [plan.id, a.runId]);
    if (dup[0]) return { version: dup[0], alreadyProcessed: true as const };
    if (!OPEN_RUN.slice(1).includes(run.state)) throw new LumiError("RUN_NOT_OPEN", 409, { run_state: run.state });
    if (plan.lead_assistant_id !== run.assistant_id) throw new LumiError("NOT_LEAD", 403);
    if (!["DRAFTING", "NEEDS_REVISION", "PENDING_APPROVAL", "EXECUTING", "PAUSED_ADJUSTMENT", "DEFERRED"].includes(plan.status)) throw new LumiError("PLAN_CLOSED", 409, { plan_status: plan.status });
    const [lead] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [plan.lead_assistant_id]);
    const v = validatePlanBody(a.body, { maxTasks, assistants: leadReadyMap(lead) });
    const errors = [...v.errors];
    const body = v.body;
    if (v.ok && body) {
      // After approval, started tasks are locked and the ceiling may not fall below what is already used (TDD 14.11.B.4).
      if (plan.approved_version !== null) {
        const locks = await taskLockMap(t, plan.id);
        const [bud] = await t.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [plan.id]);
        const byKey = new Map(body.tasks.map((x) => [x.key, x]));
        for (const [key, lk] of locks) {
          const nt = byKey.get(key);
          if (lk.locked) {
            if (!nt) errors.push(`tasks.${key}(TASK_LOCKED:cannot_remove)`);
            else {
              const [al] = await t.query<any>(`SELECT coalesce(sum(amount),0) AS a FROM lumi_ledger_entries WHERE task_id=$1 AND entry_type='COMMIT'`, [lk.id]);
              if (!sameTask({ ...lk.row, alloc_amount: al.a }, nt)) errors.push(`tasks.${key}(TASK_LOCKED:cannot_change)`);
            }
          }
        }
        if (bud && v.ceiling !== undefined && v.ceiling < Number(bud.actual) + Number(bud.committed) - 1e-9) errors.push("cost.ceiling_requested(CEILING_BELOW_USED)");
        if (bud && v.currency && bud.currency !== v.currency) errors.push("cost.currency(must_equal_budget_currency)");
      }
    }
    if (errors.length || !v.ok || !body) throw new LumiError("VALIDATION_ERROR", 400, { errors });
    const ver = plan.current_version + 1;
    await t.query(`UPDATE lumi_plan_versions SET state='SUPERSEDED' WHERE plan_id=$1 AND state='SUBMITTED'`, [plan.id]);
    const expires = limits.versionTtlHours ? iso(new Date(a.now.getTime() + limits.versionTtlHours * 3600_000)) : null;
    const [row] = await t.query<any>(
      `INSERT INTO lumi_plan_versions (plan_id,version,body,content_hash,ceiling_amount,currency,est_low,est_base,est_high,submitted_by,submitted_run_id,submitted_at,expires_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [plan.id, ver, JSON.stringify(body), v.hash, v.ceiling, v.currency, v.est?.low ?? null, v.est?.base ?? null, v.est?.high ?? null, `bot:${a.botSlug}`, a.runId, iso(a.now), expires],
    );
    const nextStatus = ["DRAFTING", "NEEDS_REVISION", "DEFERRED"].includes(plan.status) ? "PENDING_APPROVAL" : plan.status;
    await t.query(`UPDATE lumi_plans SET current_version=$2,status=$3,updated_at=$4 WHERE id=$1`, [plan.id, ver, nextStatus, iso(a.now)]);
    // The planning run and task are finished by submitting: the plan itself is the deliverable and the owner decides it as kind PLAN.
    await t.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',finished_at=$2,started_at=coalesce(started_at,$2) WHERE id=$1`, [a.runId, iso(a.now)]);
    await t.query(`UPDATE tasks SET status='COMPLETED',completed_at=$2,updated_at=$2,needs_decision=false WHERE id=$1 AND status IN ('QUEUED','RUNNING')`, [run.task_id, iso(a.now)]);
    await activity(t, run.task_id, "plan.version_submitted", a.now, { planId: plan.id, version: ver });
    await auditPlan(t, "plan.version_submitted", `bot:${a.botSlug}`, plan.id, { version: ver, hash: v.hash }, a.now);
    await enqueueNotify(t, `notify:plan:${plan.id}:${ver}`, { type: "PLAN_READY", planCode: plan.code, version: ver }, a.now);
    return { version: row, alreadyProcessed: false as const };
  });
}

// ───────────────────────── ledger primitives (append-only; counters updated in the same transaction)
interface Entry { budgetId: string; planId: string; taskId?: string | null; runId?: string | null; type: "CEILING" | "COMMIT" | "RELEASE" | "ACTUAL" | "ADJUST"; category: string; amount: number | null; currency: string | null; source: string; key: string; note?: string; actor: string; now: Date; refId?: string | null }

/** Inserts first (the UNIQUE key makes a concurrent duplicate wait, then no-op), then moves the counter. Returns false for a replay. */
async function book(t: Db, e: Entry): Promise<boolean> {
  const ins = await t.query<any>(
    `INSERT INTO lumi_ledger_entries (budget_id,plan_id,task_id,run_id,entry_type,category,amount,currency,source,ref_entry_id,idempotency_key,note,occurred_at,recorded_by,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [e.budgetId, e.planId, e.taskId ?? null, e.runId ?? null, e.type, e.category, e.amount, e.currency, e.source, e.refId ?? null, e.key, e.note ?? null, iso(e.now), e.actor],
  );
  if (!ins[0]) return false;
  const a = e.amount;
  if (e.type === "COMMIT") {
    const u = await t.query(`UPDATE lumi_budgets SET committed=committed+$2 WHERE id=$1 AND state='ACTIVE' AND ceiling IS NOT NULL AND ceiling-actual-committed-reserve >= $2 RETURNING id`, [e.budgetId, a]);
    if (!u.length) throw new LumiError("NO_BUDGET", 409, { amount: a, task: e.taskId ?? null });
  } else if (e.type === "RELEASE") {
    await t.query(`UPDATE lumi_budgets SET committed=GREATEST(committed-$2,0) WHERE id=$1`, [e.budgetId, a]);
  } else if (e.type === "ACTUAL") {
    if (a === null) await t.query(`UPDATE lumi_budgets SET unknown_count=unknown_count+1 WHERE id=$1`, [e.budgetId]);
    else await t.query(`UPDATE lumi_budgets SET actual=actual+$2 WHERE id=$1`, [e.budgetId, a]);
  } else if (e.type === "ADJUST") {
    await t.query(`UPDATE lumi_budgets SET actual=GREATEST(actual+$2,0) WHERE id=$1`, [e.budgetId, a]);
  } else if (e.type === "CEILING") {
    await t.query(`UPDATE lumi_budgets SET ceiling=$2,currency=coalesce(currency,$3) WHERE id=$1`, [e.budgetId, a, e.currency]);
  }
  return true;
}

async function openCommit(t: Db, taskId: string): Promise<{ id: string; open: number } | null> {
  const rows = await t.query<any>(`SELECT id, entry_type, amount FROM lumi_ledger_entries WHERE task_id=$1 AND entry_type IN ('COMMIT','RELEASE') ORDER BY created_at`, [taskId]);
  let open = 0; let id: string | null = null;
  for (const r of rows) { if (r.entry_type === "COMMIT") { open += Number(r.amount); id = r.id; } else open -= Number(r.amount); }
  return open > 1e-9 && id ? { id, open: r6(open) } : null;
}
async function releaseTask(t: Db, plan: any, budget: any, taskId: string, tag: string, now: Date, actor: string) {
  const oc = await openCommit(t, taskId);
  if (!oc) return false;
  return book(t, { budgetId: budget.id, planId: plan.id, taskId, type: "RELEASE", category: "OTHER", amount: oc.open, currency: budget.currency, source: "ESTIMATED", key: `release:${taskId}:${tag}`, note: tag, actor, now, refId: oc.id });
}

// ───────────────────────── approval → materialization
async function materialize(t: Db, plan: any, ver: any, actor: string, now: Date) {
  const body: PlanBody = ver.body;
  let [budget] = await t.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE' FOR UPDATE`, [plan.id]);
  const ceiling = Number(ver.ceiling_amount);
  if (!budget) {
    [budget] = await t.query<any>(`INSERT INTO lumi_budgets (plan_id,kind,currency,ceiling) VALUES ($1,'EXECUTE',$2,$3) RETURNING *`, [plan.id, ver.currency, ceiling]);
    await book(t, { budgetId: budget.id, planId: plan.id, type: "CEILING", category: "OTHER", amount: ceiling, currency: ver.currency, source: "MANUAL", key: `ceiling:${plan.id}:${ver.version}`, note: `Trần theo phiên bản ${ver.version} do Chủ duyệt`, actor, now });
  } else {
    if (budget.currency !== ver.currency) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["currency(must_equal_budget_currency)"] });
    if (Math.abs(Number(budget.ceiling) - ceiling) > 1e-9) {
      if (ceiling < Number(budget.actual) + Number(budget.committed) + Number(budget.reserve) - 1e-9) throw new LumiError("CEILING_BELOW_USED", 409, { ceiling, actual: Number(budget.actual), committed: Number(budget.committed) });
      await book(t, { budgetId: budget.id, planId: plan.id, type: "CEILING", category: "OTHER", amount: ceiling, currency: ver.currency, source: "MANUAL", key: `ceiling:${plan.id}:${ver.version}`, note: `Trần đổi theo phiên bản ${ver.version}`, actor, now });
    }
  }
  [budget] = await t.query<any>(`SELECT * FROM lumi_budgets WHERE id=$1`, [budget.id]);
  const [lead] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [plan.lead_assistant_id]);
  const locks = await taskLockMap(t, plan.id);
  const wanted = new Set(body.tasks.map((x) => x.key));
  // Removed tasks first (releases commitments), so a re-allocation inside the same version can use the freed budget.
  for (const [key, lk] of locks) {
    if (wanted.has(key)) continue;
    if (lk.locked) throw new LumiError("TASK_LOCKED", 409, { task: key });
    if (!["COMPLETED", "CANCELLED"].includes(lk.row.status)) await cancelTask(t, actor, lk.id, `Bị bỏ trong phiên bản ${ver.version} của kế hoạch`, now);
    await releaseTask(t, plan, budget, lk.id, `v${ver.version}-removed`, now, actor);
  }
  for (const nt of body.tasks) {
    const days = nt.due_in_days;
    const due = days ? iso(new Date(now.getTime() + days * 86400_000)) : undefined;
    const description = `${nt.description}\n\nTiêu chí đạt: ${nt.acceptance}\n(Việc ${nt.key} của kế hoạch ${plan.code} v${ver.version}. Hoàn tất khi nộp đầu ra cuối bằng outputs_submit; Chủ duyệt đầu ra.)`.trim();
    const alloc = nt.budget_alloc?.amount ?? null;
    const lk = locks.get(nt.key);
    if (lk) {
      if (lk.locked) continue; // identical by construction (validated at submit); a divergence was rejected there
      const cur = await openCommit(t, lk.id);
      const curAmt = cur ? cur.open : 0;
      await t.query(`UPDATE tasks SET title=$2,description=$3,expected_output=$4,acceptance=$5,due_at=$6,updated_at=$7 WHERE id=$1`, [lk.id, nt.title, description, nt.expected_output, nt.acceptance, due ?? null, iso(now)]);
      await t.query(`UPDATE lumi_task_runs SET instruction_snapshot=$2::jsonb WHERE task_id=$1 AND state='PENDING'`, [lk.id, JSON.stringify({ text: description, title: nt.title, expected_output: nt.expected_output, due: due ?? null })]);
      if (Math.abs((alloc ?? 0) - curAmt) > 1e-9) {
        await releaseTask(t, plan, budget, lk.id, `v${ver.version}-realloc`, now, actor);
        if (alloc && alloc > 0) await book(t, { budgetId: budget.id, planId: plan.id, taskId: lk.id, type: "COMMIT", category: "OTHER", amount: alloc, currency: ver.currency, source: "ESTIMATED", key: `commit:${lk.id}:${ver.version}`, note: `Phân bổ theo phiên bản ${ver.version}`, actor, now });
      }
      continue;
    }
    const r = await createTaskInTx(t, {
      actorRef: actor, clientRequestId: `plan-${plan.id}-${nt.key}`, projectId: plan.project_id, assigneeId: lead.id, title: nt.title, description, due, expectedOutput: nt.expected_output, now,
      plan: { planId: plan.id, planVersion: ver.version, planTaskKey: nt.key, acceptance: nt.acceptance, sourceKey: `plan:${plan.id}:${nt.key}`, source: "PLAN" },
    });
    if (alloc && alloc > 0) await book(t, { budgetId: budget.id, planId: plan.id, taskId: r.task.id, type: "COMMIT", category: "OTHER", amount: alloc, currency: ver.currency, source: "ESTIMATED", key: `commit:${r.task.id}:${ver.version}`, note: `Phân bổ theo phiên bản ${ver.version}`, actor, now });
  }
}

export type PlanDecision = "APPROVE" | "REVISE" | "REJECT" | "DEFER" | "RESUME";
export async function decidePlan(db: Db, a: { actorRef: string; planId: string; version: number; contentHash: string; decision: PlanDecision; reason?: string; now: Date; limits?: PlanLimits }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (!["APPROVE", "REVISE", "REJECT", "DEFER", "RESUME"].includes(a.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
  if (["REVISE", "REJECT"].includes(a.decision) && (a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  await requirePlans(db);
  const limits = a.limits ?? planLimits();
  const out = await db.tx(async (t): Promise<{ expired: true } | { alreadyProcessed: boolean; plan: any; decision: PlanDecision }> => {
    const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1 FOR UPDATE`, [a.planId]);
    if (!plan) throw new LumiError("NOT_FOUND", 404);
    const [ver] = await t.query<any>(`SELECT * FROM lumi_plan_versions WHERE plan_id=$1 AND version=$2 FOR UPDATE`, [a.planId, a.version]);
    if (!ver) throw new LumiError("NOT_FOUND", 404, { what: "version" });
    const final = a.decision === "APPROVE" || a.decision === "REVISE" || a.decision === "REJECT";
    if (final) {
      const prior = await t.query<any>(`SELECT * FROM lumi_approvals WHERE kind='PLAN' AND object_id=$1 AND object_version=$2`, [a.planId, a.version]);
      if (prior[0]) {
        if (prior[0].decision === a.decision) return { alreadyProcessed: true, plan, decision: a.decision };
        throw new LumiError("ALREADY_DECIDED", 409, { decision: prior[0].decision });
      }
    }
    if (ver.content_hash !== a.contentHash) throw new LumiError("STALE_VERSION", 409, { reason: "content_hash" });
    if (ver.state === "EXPIRED") return { expired: true };
    if (ver.expires_at && new Date(ver.expires_at) <= a.now && ver.state === "SUBMITTED") {
      await t.query(`UPDATE lumi_plan_versions SET state='EXPIRED' WHERE id=$1`, [ver.id]);
      if (["PENDING_APPROVAL", "DEFERRED"].includes(plan.status)) await t.query(`UPDATE lumi_plans SET status='NEEDS_REVISION',updated_at=$2 WHERE id=$1`, [plan.id, iso(a.now)]);
      return { expired: true };
    }
    if (ver.state !== "SUBMITTED" || ver.version !== plan.current_version) throw new LumiError("STALE_VERSION", 409, { version_state: ver.state, current_version: plan.current_version });
    if (END_PLAN.includes(plan.status)) throw new LumiError("PLAN_CLOSED", 409, { plan_status: plan.status });
    const [goal] = await t.query<any>(`SELECT * FROM lumi_goals WHERE id=$1`, [plan.goal_id]);

    if (a.decision === "DEFER") {
      if (plan.status !== "PENDING_APPROVAL") throw new LumiError("INVALID_TRANSITION", 409, { plan_status: plan.status });
      await t.query(`UPDATE lumi_plans SET status='DEFERRED',updated_at=$2 WHERE id=$1`, [plan.id, iso(a.now)]);
      await auditPlan(t, "plan.deferred", a.actorRef, plan.id, { version: a.version }, a.now);
      return { alreadyProcessed: false, plan: { ...plan, status: "DEFERRED" }, decision: a.decision };
    }
    if (a.decision === "RESUME") {
      if (plan.status !== "DEFERRED") throw new LumiError("INVALID_TRANSITION", 409, { plan_status: plan.status });
      await t.query(`UPDATE lumi_plans SET status='PENDING_APPROVAL',updated_at=$2 WHERE id=$1`, [plan.id, iso(a.now)]);
      await auditPlan(t, "plan.resumed", a.actorRef, plan.id, { version: a.version }, a.now);
      return { alreadyProcessed: false, plan: { ...plan, status: "PENDING_APPROVAL" }, decision: a.decision };
    }
    if (goal.status !== "ACTIVE") throw new LumiError("INVALID_TRANSITION", 409, { goal_status: goal.status });
    const first = plan.approved_version === null;
    await t.query(`INSERT INTO lumi_approvals (kind,object_id,object_version,scope_ref,decision,reason,decided_by,channel,decided_at) VALUES ('PLAN',$1,$2,$3,$4,$5,$6,'WEB',$7)`, [plan.id, a.version, plan.code, a.decision, a.reason?.trim() ?? null, a.actorRef, iso(a.now)]);
    let status = plan.status;
    if (a.decision === "APPROVE") {
      const [proj] = await t.query<any>(`SELECT status FROM lumi_projects WHERE id=$1`, [plan.project_id]);
      if (proj?.status !== "ACTIVE") throw new LumiError("PROJECT_NOT_ACTIVE", 409);
      await t.query(`UPDATE lumi_plan_versions SET state='SUPERSEDED' WHERE plan_id=$1 AND state='APPROVED'`, [plan.id]);
      await t.query(`UPDATE lumi_plan_versions SET state='APPROVED' WHERE id=$1`, [ver.id]);
      status = "EXECUTING"; // set BEFORE creating tasks/runs so nothing is created against a paused plan
      await t.query(`UPDATE lumi_plans SET status='EXECUTING',approved_version=$2,updated_at=$3 WHERE id=$1`, [plan.id, a.version, iso(a.now)]);
      await materialize(t, { ...plan, status }, ver, a.actorRef, a.now);
    } else {
      await t.query(`UPDATE lumi_plan_versions SET state='REJECTED' WHERE id=$1`, [ver.id]);
      if (a.decision === "REJECT") status = first ? "REJECTED" : plan.status;
      else {
        status = first ? "NEEDS_REVISION" : plan.status;
        const [lead] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [plan.lead_assistant_id]);
        if (first) await t.query(`UPDATE lumi_plans SET status='NEEDS_REVISION' WHERE id=$1`, [plan.id]);
        await createPlanningTask(t, { actorRef: a.actorRef, plan: { ...plan }, goal, lead, limits, extra: `Chủ yêu cầu sửa phiên bản ${a.version}: ${a.reason!.trim()}\n\nBản trước (v${a.version}):\n${JSON.stringify(ver.body)}`, now: a.now });
      }
      await t.query(`UPDATE lumi_plans SET status=$2,updated_at=$3 WHERE id=$1`, [plan.id, status, iso(a.now)]);
    }
    await auditPlan(t, `plan.${a.decision.toLowerCase()}`, a.actorRef, plan.id, { version: a.version, hash: ver.content_hash }, a.now);
    await evaluatePlan(t, plan.id, a.now, { hermesMode: hermesModeNow() });
    const [after] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1`, [plan.id]);
    return { alreadyProcessed: false, plan: after, decision: a.decision };
  });
  if ("expired" in out) throw new LumiError("GONE", 410);
  return out;
}

export async function cancelPlan(db: Db, a: { actorRef: string; planId: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  await requirePlans(db);
  return db.tx(async (t) => {
    const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1 FOR UPDATE`, [a.planId]);
    if (!plan) throw new LumiError("NOT_FOUND", 404);
    if (plan.status === "CANCELLED") return { plan, alreadyProcessed: true as const };
    if (END_PLAN.includes(plan.status)) throw new LumiError("INVALID_TRANSITION", 409, { plan_status: plan.status });
    await t.query(`UPDATE lumi_plans SET status='CANCELLED',cancel_reason=$2,updated_at=$3 WHERE id=$1`, [plan.id, a.reason.trim(), iso(a.now)]);
    await t.query(`UPDATE lumi_plan_versions SET state='SUPERSEDED' WHERE plan_id=$1 AND state='SUBMITTED'`, [plan.id]);
    const open = await t.query<any>(`SELECT id FROM tasks WHERE plan_id=$1 AND status NOT IN ('COMPLETED','CANCELLED')`, [plan.id]);
    for (const k of open) await cancelTask(t, a.actorRef, k.id, `Kế hoạch ${plan.code} bị hủy: ${a.reason.trim()}`, a.now);
    await auditPlan(t, "plan.cancelled", a.actorRef, plan.id, { reason: a.reason.trim() }, a.now);
    await evaluatePlan(t, plan.id, a.now, { hermesMode: hermesModeNow() });
    const [after] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1`, [plan.id]);
    return { plan: after, alreadyProcessed: false as const };
  });
}

/** Owner asks the lead bot to amend an approved (or expired/deferred) plan: a new planning task; the running tasks keep running. */
export async function revisePlan(db: Db, a: { actorRef: string; planId: string; instruction: string; now: Date; limits?: PlanLimits }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.instruction ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["instruction"] });
  await requirePlans(db);
  const limits = a.limits ?? planLimits();
  return db.tx(async (t) => {
    const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1 FOR UPDATE`, [a.planId]);
    if (!plan) throw new LumiError("NOT_FOUND", 404);
    if (!["EXECUTING", "PAUSED_ADJUSTMENT", "NEEDS_REVISION"].includes(plan.status)) throw new LumiError("INVALID_TRANSITION", 409, { plan_status: plan.status });
    if (plan.planning_task_id) {
      const [pt] = await t.query<any>(`SELECT status FROM tasks WHERE id=$1`, [plan.planning_task_id]);
      if (pt && !["COMPLETED", "CANCELLED", "FAILED"].includes(pt.status)) throw new LumiError("PLANNING_OPEN", 409);
    }
    const [goal] = await t.query<any>(`SELECT * FROM lumi_goals WHERE id=$1`, [plan.goal_id]);
    const [lead] = await t.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [plan.lead_assistant_id]);
    const [cur] = await t.query<any>(`SELECT body, version FROM lumi_plan_versions WHERE plan_id=$1 AND version=coalesce($2::int,$3::int)`, [plan.id, plan.approved_version, plan.current_version]);
    const task = await createPlanningTask(t, { actorRef: a.actorRef, plan, goal, lead, limits, extra: `Chủ yêu cầu sửa kế hoạch: ${a.instruction.trim()}\n\nBản hiện hành (v${cur?.version}):\n${JSON.stringify(cur?.body ?? {})}\nLưu ý: việc đã chạy/đã có đầu ra bị KHÓA (giữ nguyên title, acceptance, phân bổ; không bỏ); trần không được thấp hơn phần đã dùng và cam kết.`, now: a.now });
    await auditPlan(t, "plan.revise_requested", a.actorRef, plan.id, { taskId: task.id }, a.now);
    return { plan, task };
  });
}

// ───────────────────────── manual ledger entries (owner) and reconciliation
export async function recordLedger(db: Db, a: { actorRef: string; planId: string; key: string; category: string; amount: number; currency: string; source: string; budgetKind?: "EXECUTE" | "PREPARE"; taskId?: string; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad: string[] = [];
  if (!a.key || a.key.length < 8) bad.push("Idempotency-Key");
  if (!["TOOL", "ADS", "PRODUCTION", "ASSET", "OUTSOURCE", "FEE", "COORD", "SHARED", "OTHER", "AI"].includes(a.category)) bad.push("category");
  if (!(typeof a.amount === "number" && a.amount >= 0 && Number.isFinite(a.amount))) bad.push("amount(>=0)");
  if (!["MANUAL", "PROVIDER_STATEMENT"].includes(a.source)) bad.push("source(MANUAL|PROVIDER_STATEMENT)");
  if (!/^[A-Z]{3,5}$/.test(a.currency ?? "")) bad.push("currency");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: bad });
  await requirePlans(db);
  return db.tx(async (t) => {
    const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1 FOR UPDATE`, [a.planId]);
    if (!plan) throw new LumiError("NOT_FOUND", 404);
    const kind = a.budgetKind ?? "EXECUTE";
    const [b] = await t.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1 AND kind=$2 FOR UPDATE`, [a.planId, kind]);
    if (!b) throw new LumiError("NOT_FOUND", 404, { what: "budget", kind });
    if (b.currency && b.currency !== a.currency) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`currency(must_be_${b.currency})`] });
    if (!b.currency) await t.query(`UPDATE lumi_budgets SET currency=$2 WHERE id=$1`, [b.id, a.currency]);
    if (a.taskId) {
      const [k] = await t.query<any>(`SELECT id FROM tasks WHERE id=$1 AND plan_id=$2`, [a.taskId, a.planId]);
      if (!k) throw new LumiError("NOT_FOUND", 404, { what: "task" });
    }
    const created = await book(t, { budgetId: b.id, planId: a.planId, taskId: a.taskId ?? null, type: "ACTUAL", category: a.category, amount: a.amount, currency: a.currency, source: a.source, key: `manual:${a.key}`, note: a.note, actor: a.actorRef, now: a.now });
    if (created) await auditPlan(t, "ledger.recorded", a.actorRef, a.planId, { category: a.category, amount: a.amount, currency: a.currency, source: a.source }, a.now);
    await evaluatePlan(t, a.planId, a.now, { hermesMode: hermesModeNow() }); // overrun ⇒ PAUSED_ADJUSTMENT
    return { created };
  });
}

export async function reconcileLedger(db: Db, a: { actorRef: string; planId: string; entryIds: string[]; reconciliationKey: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (!a.reconciliationKey || a.reconciliationKey.trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reconciliation_key"] });
  if (!a.entryIds?.length) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["entry_ids"] });
  return db.tx(async (t) => {
    const r = await t.query<any>(`UPDATE lumi_ledger_entries SET reconciliation='RECONCILED',reconciliation_key=$3,reconciled_by=$4,reconciled_at=$5 WHERE plan_id=$1 AND id = ANY($2::uuid[]) AND entry_type='ACTUAL' AND amount IS NOT NULL AND reconciliation='UNRECONCILED' RETURNING id`, [a.planId, a.entryIds, a.reconciliationKey.trim(), a.actorRef, iso(a.now)]);
    if (r.length) await auditPlan(t, "ledger.reconciled", a.actorRef, a.planId, { count: r.length, key: a.reconciliationKey.trim() }, a.now);
    return { reconciled: r.length };
  });
}

// ───────────────────────── evaluation (called by the worker tick and after every owner decision)
export interface EvalOpts { hermesMode: string }
export async function evaluatePlan(t: Db, planId: string, now: Date, opts: EvalOpts) {
  const [plan] = await t.query<any>(`SELECT * FROM lumi_plans WHERE id=$1 FOR UPDATE`, [planId]);
  if (!plan) return;
  const actor = "system:plan-tick";
  const budgets = await t.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1`, [planId]);
  const prep = budgets.find((b: any) => b.kind === "PREPARE");
  const exec = budgets.find((b: any) => b.kind === "EXECUTE");

  // 1. versions that outlived their expiry
  const exp = await t.query<any>(`UPDATE lumi_plan_versions SET state='EXPIRED' WHERE plan_id=$1 AND state='SUBMITTED' AND expires_at IS NOT NULL AND expires_at <= $2 RETURNING version`, [planId, iso(now)]);
  if (exp.length && ["PENDING_APPROVAL", "DEFERRED"].includes(plan.status)) await t.query(`UPDATE lumi_plans SET status='NEEDS_REVISION',updated_at=$2 WHERE id=$1`, [planId, iso(now)]);

  // 2. every finished run is a cost event whose AI cost is unknown: book it (lượt lỗi và vòng sửa vẫn vào sổ)
  const runs = await t.query<any>(
    `SELECT r.id AS run_id, k.id AS task_id, (k.plan_task_key IS NULL) AS planning
       FROM lumi_task_runs r JOIN tasks k ON k.id=r.task_id
      WHERE k.plan_id=$1 AND r.state = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM lumi_ledger_entries e WHERE e.idempotency_key = 'run:' || r.id::text)`, [planId, DONE_RUN]);
  for (const r of runs) {
    const b = r.planning ? prep : exec;
    if (!b) continue;
    await book(t, { budgetId: b.id, planId, taskId: r.task_id, runId: r.run_id, type: "ACTUAL", category: "AI", amount: null, currency: b.currency, source: "UNKNOWN", key: `run:${r.run_id}`, note: "Chi phí AI của lượt chạy chưa đo được", actor, now });
  }

  // 3. release commitments of tasks that ended
  if (exec) {
    const ended = await t.query<any>(`SELECT id FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL AND status IN ('COMPLETED','CANCELLED')`, [planId]);
    for (const k of ended) await releaseTask(t, plan, exec, k.id, "ended", now, actor);
  }

  // 4. overrun ⇒ paused for adjustment (not a technical failure)
  const [eb] = exec ? await t.query<any>(`SELECT * FROM lumi_budgets WHERE id=$1`, [exec.id]) : [];
  if (eb && plan.status === "EXECUTING" && Number(eb.ceiling) - Number(eb.actual) - Number(eb.committed) - Number(eb.reserve) < -1e-9) {
    await t.query(`UPDATE lumi_plans SET status='PAUSED_ADJUSTMENT',updated_at=$2 WHERE id=$1`, [planId, iso(now)]);
    plan.status = "PAUSED_ADJUSTMENT";
    await auditPlan(t, "plan.paused_budget", actor, planId, { available: Number(eb.ceiling) - Number(eb.actual) - Number(eb.committed) }, now);
    await enqueueNotify(t, `notify:planpause:${planId}:${Math.round(Number(eb.actual) * 100)}`, { type: "PLAN_PAUSED", planCode: plan.code }, now);
  } else if (eb && plan.status === "PAUSED_ADJUSTMENT" && Number(eb.ceiling) - Number(eb.actual) - Number(eb.committed) - Number(eb.reserve) >= -1e-9) {
    await t.query(`UPDATE lumi_plans SET status='EXECUTING',updated_at=$2 WHERE id=$1`, [planId, iso(now)]);
    plan.status = "EXECUTING";
  }

  // 5. phase reports at approved milestones whose task ended
  if (plan.approved_version !== null) {
    const [av] = await t.query<any>(`SELECT body FROM lumi_plan_versions WHERE plan_id=$1 AND version=$2`, [planId, plan.approved_version]);
    for (const m of (av?.body?.milestones ?? []) as { key: string; after_task_key: string; label: string }[]) {
      const [k] = await t.query<any>(`SELECT status FROM tasks WHERE plan_id=$1 AND plan_task_key=$2`, [planId, m.after_task_key]);
      if (k && ["COMPLETED", "CANCELLED"].includes(k.status)) await writeReport(t, plan, "PHASE", m.key, `phase:${planId}:${m.key}`, now, opts);
    }
  }

  // 6. plan completion (only when nothing is still open and no amendment is waiting)
  if (["EXECUTING", "PAUSED_ADJUSTMENT"].includes(plan.status) && plan.approved_version !== null) {
    const tasks = await t.query<any>(`SELECT status FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [planId]);
    const pending = await t.query<any>(`SELECT 1 FROM lumi_plan_versions WHERE plan_id=$1 AND state='SUBMITTED'`, [planId]);
    let planningOpen = false;
    if (plan.planning_task_id) { const [pt] = await t.query<any>(`SELECT status FROM tasks WHERE id=$1`, [plan.planning_task_id]); planningOpen = !!pt && !["COMPLETED", "CANCELLED", "FAILED"].includes(pt.status); }
    if (tasks.length && tasks.every((k: any) => ["COMPLETED", "CANCELLED"].includes(k.status)) && !pending.length && !planningOpen) {
      const done = tasks.filter((k: any) => k.status === "COMPLETED").length;
      const status = done === tasks.length ? "DONE" : done > 0 ? "PARTIAL_DONE" : "CANCELLED";
      await t.query(`UPDATE lumi_plans SET status=$2,cancel_reason=CASE WHEN $2='CANCELLED' THEN 'Mọi việc bị hủy' ELSE cancel_reason END,updated_at=$3 WHERE id=$1`, [planId, status, iso(now)]);
      plan.status = status;
      await auditPlan(t, "plan.completed", actor, planId, { status, done, total: tasks.length }, now);
      await enqueueNotify(t, `notify:plandone:${planId}`, { type: "PLAN_DONE", planCode: plan.code, status }, now);
    }
  }

  // 7. final report for ended plans; a late booking after the report creates a superseding report, never an edit
  if (END_PLAN.includes(plan.status) && plan.status !== "REJECTED" && plan.approved_version !== null) {
    const [last] = await t.query<any>(`SELECT id,content_hash FROM lumi_reports WHERE plan_id=$1 AND kind='FINAL' ORDER BY created_at DESC, id DESC LIMIT 1`, [planId]);
    await writeReport(t, plan, "FINAL", null, null, now, opts, last ?? null);
  }
}

async function buildReportBody(t: Db, plan: any, kind: "PHASE" | "FINAL", milestone: string | null, opts: EvalOpts) {
  const [goal] = await t.query<any>(`SELECT * FROM lumi_goals WHERE id=$1`, [plan.goal_id]);
  const tasks = await t.query<any>(
    `SELECT k.id,k.code,k.plan_task_key AS key,k.title,k.status,k.acceptance,a.name AS assignee,
            (SELECT coalesce(sum(CASE WHEN entry_type='COMMIT' THEN amount ELSE 0 END),0) FROM lumi_ledger_entries e WHERE e.task_id=k.id) AS committed_total,
            o.version AS out_version, o.state AS out_state
       FROM tasks k LEFT JOIN lumi_assistants a ON a.id=k.owner_assistant_id LEFT JOIN lumi_task_outputs o ON o.id=k.current_output_id
      WHERE k.plan_id=$1 AND k.plan_task_key IS NOT NULL ORDER BY k.created_at`, [plan.id]);
  const [ver] = plan.approved_version !== null ? await t.query<any>(`SELECT body,content_hash,version FROM lumi_plan_versions WHERE plan_id=$1 AND version=$2`, [plan.id, plan.approved_version]) : [];
  const budgets = await t.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1`, [plan.id]);
  const entries = await t.query<any>(`SELECT budget_id,category,amount,source,reconciliation,entry_type FROM lumi_ledger_entries WHERE plan_id=$1`, [plan.id]);
  const byCat: Record<string, { known: number; unknown: number }> = {};
  let rec = 0, unrec = 0;
  for (const e of entries) {
    if (e.entry_type !== "ACTUAL" && e.entry_type !== "ADJUST") continue;
    const c = (byCat[e.category] ??= { known: 0, unknown: 0 });
    if (e.amount === null) c.unknown += 1; else { c.known = r6(c.known + Number(e.amount)); if (e.reconciliation === "RECONCILED") rec += 1; else unrec += 1; }
  }
  const view = (b: any) => b ? { ceiling: N(b.ceiling), currency: b.currency, committed_open: N(b.committed), actual_known: N(b.actual), unknown_count: b.unknown_count, available: b.ceiling === null ? null : r6(Number(b.ceiling) - Number(b.actual) - Number(b.committed) - Number(b.reserve)) } : null;
  const total = tasks.length, completed = tasks.filter((k: any) => k.status === "COMPLETED").length, cancelled = tasks.filter((k: any) => k.status === "CANCELLED").length;
  const deliverables = ((ver?.body?.deliverables ?? []) as any[]).map((d) => {
    const ts = tasks.filter((k: any) => (ver.body.tasks as any[]).find((x) => x.key === k.key)?.deliverable_key === d.key);
    return { key: d.key, title: d.title, acceptance: d.acceptance, task_keys: ts.map((k: any) => k.key), all_completed: ts.length > 0 && ts.every((k: any) => k.status === "COMPLETED") };
  });
  return {
    kind, milestone,
    goal: { code: goal.code, title: goal.title, outcome: goal.outcome, status: goal.status, result: goal.result },
    plan: { code: plan.code, status: plan.status, approved_version: plan.approved_version, content_hash: ver?.content_hash ?? null },
    completion: { tasks_total: total, completed, cancelled, open: total - completed - cancelled },
    tasks: tasks.map((k: any) => ({ key: k.key, code: k.code, title: k.title, status: k.status, assignee: k.assignee, committed_total: N(k.committed_total), output: k.out_version ? { version: k.out_version, state: k.out_state } : null })),
    deliverables,
    ledger: { execute: view(budgets.find((b: any) => b.kind === "EXECUTE")), prepare: view(budgets.find((b: any) => b.kind === "PREPARE")), by_category: byCat, reconciled: rec, unreconciled: unrec },
    // Three different facts, never merged: a finished plan says nothing about whether the business goal was reached.
    business: { status: "NOT_ASSESSED", note: "Chưa có dữ liệu kinh doanh được đối soát; kết quả mục tiêu do Chủ chốt khi đóng mục tiêu." },
    limits: [AI_COST_LIMIT_NOTE, "Nội dung kế hoạch do bot lập, chưa được kiểm chứng sự thật; Chủ duyệt không thay cho kiểm chứng.", "Dự toán là ước tính của bot."],
    data_sources: { ai_cost: "UNKNOWN", revenue: "NONE", plan_content: "BOT_AUTHORED_UNVERIFIED", hermes_mode: opts.hermesMode },
  };
}

async function writeReport(t: Db, plan: any, kind: "PHASE" | "FINAL", milestone: string | null, key: string | null, now: Date, opts: EvalOpts, last: { id: string; content_hash: string } | null = null) {
  const body = await buildReportBody(t, plan, kind, milestone, opts);
  const hash = createHash("sha256").update(JSON.stringify({ ...body, data_sources: { ...body.data_sources, hermes_mode: "" } })).digest("hex");
  if (kind === "PHASE") {
    const ins = await t.query(`INSERT INTO lumi_reports (plan_id,kind,milestone_key,body,data_basis,content_hash,idempotency_key,created_at) VALUES ($1,'PHASE',$2,$3::jsonb,$4::jsonb,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [plan.id, milestone, JSON.stringify(body), JSON.stringify({ as_of: iso(now) }), hash, key, iso(now)]);
    return ins[0] ?? null;
  }
  if (last && last.content_hash === hash) return null; // nothing changed since the last final report
  const k = last ? `final:${plan.id}:${hash.slice(0, 12)}` : `final:${plan.id}:1`;
  const ins = await t.query(`INSERT INTO lumi_reports (plan_id,kind,supersedes_report_id,body,data_basis,content_hash,idempotency_key,created_at) VALUES ($1,'FINAL',$2,$3::jsonb,$4::jsonb,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [plan.id, last?.id ?? null, JSON.stringify(body), JSON.stringify({ as_of: iso(now) }), hash, k, iso(now)]);
  return ins[0] ?? null;
}

/** Worker hook. No-op unless plans_enabled; per-plan failures are isolated. Catches up automatically after the flag was off (idempotent keys). */
export async function planTick(db: Db, now: Date, opts: EvalOpts): Promise<{ evaluated: number; failed: number } | { skipped: true }> {
  if (!(await plansEnabled(db))) return { skipped: true };
  const ids = await db.query<{ id: string }>(
    `SELECT p.id FROM lumi_plans p
      WHERE p.status = ANY($1::text[])
         OR EXISTS (SELECT 1 FROM tasks k JOIN lumi_task_runs r ON r.task_id=k.id WHERE k.plan_id=p.id AND r.state = ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM lumi_ledger_entries e WHERE e.idempotency_key='run:'||r.id::text))
         OR (p.status IN ('DONE','PARTIAL_DONE','CANCELLED') AND p.approved_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lumi_reports x WHERE x.plan_id=p.id AND x.kind='FINAL'))`,
    [LIVE_PLAN, DONE_RUN]);
  let failed = 0;
  for (const p of ids) {
    try { await db.tx((t) => evaluatePlan(t, p.id, now, opts)); } catch { failed += 1; }
  }
  return { evaluated: ids.length - failed, failed };
}

/** Rollback step (TDD 14.11.B.10): stop new plan activity and pause executing plans; never deletes data. */
export async function drainPlans(db: Db, actorRef: string, now: Date) {
  return db.tx(async (t) => {
    await t.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('plans_enabled','false'::jsonb,$1,$2) ON CONFLICT (key) DO UPDATE SET value='false'::jsonb,set_by=EXCLUDED.set_by,set_at=EXCLUDED.set_at`, [actorRef, iso(now)]);
    const paused = await t.query<any>(`UPDATE lumi_plans SET status='PAUSED_ADJUSTMENT',updated_at=$1 WHERE status='EXECUTING' RETURNING id`, [iso(now)]);
    const [o] = await t.query<{ n: number }>(`SELECT count(*)::int AS n FROM lumi_task_runs r JOIN tasks k ON k.id=r.task_id WHERE k.plan_id IS NOT NULL AND r.state IN ('DISPATCHED','DISPATCH_UNCERTAIN','RUNNING')`);
    await audit(t, "plans.drain", actorRef, { paused: paused.length, inFlight: o!.n }, now);
    return { plansPaused: paused.length, inFlightRuns: o!.n };
  });
}

// ───────────────────────── read models (UI and API)
export async function listGoals(db: Db) {
  return db.query<any>(
    `SELECT g.id,g.code,g.title,g.outcome,g.status,g.result,g.close_note,g.max_loss,g.currency,g.created_at,g.closed_at,p.name AS project_name,p.id AS project_id,
            (SELECT json_build_object('id',x.id,'code',x.code,'status',x.status,'current_version',x.current_version,'approved_version',x.approved_version)
               FROM lumi_plans x WHERE x.goal_id=g.id ORDER BY (x.status = ANY($1::text[])) DESC, x.created_at DESC LIMIT 1) AS plan
       FROM lumi_goals g JOIN lumi_projects p ON p.id=g.project_id ORDER BY g.created_at DESC LIMIT 100`, [LIVE_PLAN]);
}

export async function getPlanDetail(db: Db, planId: string) {
  const [plan] = await db.query<any>(`SELECT p.*, a.name AS lead_name, a.slug AS lead_slug FROM lumi_plans p JOIN lumi_assistants a ON a.id=p.lead_assistant_id WHERE p.id=$1`, [planId]);
  if (!plan) return null;
  const [goal] = await db.query<any>(`SELECT * FROM lumi_goals WHERE id=$1`, [plan.goal_id]);
  const versions = await db.query<any>(`SELECT id,version,state,body,content_hash,ceiling_amount,currency,est_low,est_base,est_high,submitted_by,submitted_at,expires_at FROM lumi_plan_versions WHERE plan_id=$1 ORDER BY version DESC`, [planId]);
  const tasks = await db.query<any>(
    `SELECT k.id,k.code,k.plan_task_key AS key,k.plan_version,k.title,k.status,k.needs_decision,k.acceptance,k.updated_at,a.name AS assignee,o.version AS out_version,o.state AS out_state,
            (SELECT coalesce(sum(CASE WHEN e.entry_type='COMMIT' THEN e.amount ELSE -e.amount END),0) FROM lumi_ledger_entries e WHERE e.task_id=k.id AND e.entry_type IN ('COMMIT','RELEASE')) AS committed_open
       FROM tasks k LEFT JOIN lumi_assistants a ON a.id=k.owner_assistant_id LEFT JOIN lumi_task_outputs o ON o.id=k.current_output_id WHERE k.plan_id=$1 ORDER BY k.created_at`, [planId]);
  const budgets = await db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1`, [planId]);
  const ledger = await db.query<any>(`SELECT id,budget_id,task_id,run_id,entry_type,category,amount,currency,source,reconciliation,reconciliation_key,note,occurred_at,recorded_by FROM lumi_ledger_entries WHERE plan_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200`, [planId]);
  const reports = await db.query<any>(`SELECT id,kind,milestone_key,supersedes_report_id,body,created_at FROM lumi_reports WHERE plan_id=$1 ORDER BY created_at DESC`, [planId]);
  const approvals = await db.query<any>(`SELECT object_version,decision,reason,decided_by,decided_at FROM lumi_approvals WHERE kind='PLAN' AND object_id=$1 ORDER BY decided_at`, [planId]);
  const planningTask = plan.planning_task_id ? (await db.query<any>(`SELECT t.id,t.code,t.status,t.error_code,(SELECT state FROM lumi_task_runs r WHERE r.task_id=t.id ORDER BY attempt_no DESC LIMIT 1) AS run_state,t.updated_at,(SELECT slug FROM lumi_projects pr WHERE pr.id=t.project_id) AS project_slug FROM tasks t WHERE t.id=$1`, [plan.planning_task_id]))[0] ?? null : null;
  return { plan, goal, versions, tasks, budgets, ledger, reports, approvals, planningTask, limits: { ai_cost_note: AI_COST_LIMIT_NOTE } };
}

/** Company screen: goals + what is needed to create one (projects, ready assistants) + feature flags. */
export async function companyOverview(db: Db) {
  const goals = await listGoals(db);
  const projects = await db.query<any>(`SELECT id,name FROM lumi_projects WHERE status='ACTIVE' ORDER BY name`);
  const assistants = await db.query<any>(`SELECT id,slug,name,(connection_state='VERIFIED' AND dispatch_enabled AND status='ACTIVE') AS ready FROM lumi_assistants WHERE status='ACTIVE' ORDER BY name`);
  const limits = planLimits();
  return { goals, projects, assistants, flags: { plans_enabled: await flag(db, "plans_enabled"), m1_enabled: await flag(db, "m1_enabled") }, config: { max_tasks: limits.maxTasks, version_ttl_hours: limits.versionTtlHours } };
}

/** Plan versions waiting for the owner (feeds "Chờ duyệt" and the sidebar count). */
export async function pendingPlans(db: Db) {
  return db.query<any>(
    `SELECT p.id AS plan_id, p.code, v.version, g.title AS goal_title, v.submitted_at
       FROM lumi_plans p JOIN lumi_plan_versions v ON v.plan_id=p.id AND v.version=p.current_version AND v.state='SUBMITTED'
       JOIN lumi_goals g ON g.id=p.goal_id WHERE p.status IN ('PENDING_APPROVAL','EXECUTING','PAUSED_ADJUSTMENT','DEFERRED') ORDER BY v.submitted_at`);
}


/** Every REFUSED plan submission is recorded (the refusal itself rolls back nothing else): the owner sees how many tries the bot made and which sections failed. */
export async function recordPlanRejection(db: Db, a: { runId: string; errors: string[]; now: Date }) {
  const [r] = await db.query<any>(`SELECT r.task_id, x.slug FROM lumi_task_runs r JOIN lumi_assistants x ON x.id=r.assistant_id WHERE r.id=$1`, [a.runId]);
  if (!r) return;
  await audit(db, "plan.submit_rejected", `bot:${r.slug}`, { taskId: r.task_id, runId: a.runId, errors: a.errors.slice(0, 40) }, a.now);
}

export { contentHash };
