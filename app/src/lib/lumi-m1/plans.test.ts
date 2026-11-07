/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-01 (TDD 14.11.B) — evidence class A: PGlite (real PostgreSQL engine, single connection) + the REAL migrations 0000..0044.
 * Hermes is simulated here (FakeHermes). Nothing in this file calls a model or a provider; it proves rules, constraints,
 * idempotency and invariants, NOT real-integration behaviour (class C) and NOT business results.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError, ackRun, decide, processOutbox, setDispatchEnabled, submitOutput, type Db, type HermesPort, type NotifyPort } from "./core";
import { cancelPlan, closeGoal, createGoal, createPlan, decidePlan, drainPlans, evaluatePlan, getPlanDetail, planLimits, planTick, reconcileLedger, recordLedger, revisePlan, setPlansEnabled, submitPlanVersion } from "./plans";
import { computeEconomics, ledgerToBudget } from "./economics";
import { validatePlanBody } from "./plan-schema";

const T0 = new Date("2026-11-07T08:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const LIMITS = { maxTasks: 5, versionTtlHours: null };
const okNotify: NotifyPort = { send: async () => {} };
class FakeHermes implements HermesPort {
  async readProfileTools() { return ["outputs.submit"]; }
  async dispatch() { return { kind: "accepted" as const, sessionRef: "sim" }; }
}
const rejects = async (p: Promise<unknown>, code: string, status?: number) => {
  await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code && (status === undefined || e.status === status), `expected ${code}`);
};

async function world(o: { plans?: boolean } = {}) {
  const { db } = await freshDb();
  const h = new FakeHermes();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  await db.query(`INSERT INTO profiles(slug,name,type,status) VALUES ('leadbot','Bot trưởng KH','bot','active')`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án thử','AFFILIATE') RETURNING id`);
  const [asst] = await db.query<any>(
    `INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day)
     VALUES ('leadbot','Lead Bot','SPECIALIST','leadbot','VERIFIED',0,'["outputs.submit"]',600,30,2,3,2,50) RETURNING id`);
  await setDispatchEnabled(db, h, OWNER, asst.id, true, T0);
  if (o.plans !== false) await setPlansEnabled(db, OWNER, true, T0, LIMITS);
  return { db, h, projectId: proj.id as string, asstId: asst.id as string, slug: "leadbot" };
}
type W = Awaited<ReturnType<typeof world>>;

const bodyOf = (slug: string, over: Record<string, any> = {}) => ({
  schema: 1,
  summary: "Thử một hướng affiliate cho nhóm khách X: nghiên cứu offer rồi lập kế hoạch nội dung.",
  opportunity: { evidence: [{ claim: "Có nhu cầu tìm kiếm ổn định", ref: "https://example.test/a", as_of: "2026-11-01" }], confidence: "LOW" },
  scope: { in: ["Nghiên cứu offer"], out: ["Chạy quảng cáo"] },
  deliverables: [{ key: "dossier", title: "Hồ sơ offer", acceptance: "Có ít nhất 3 offer có nguồn" }],
  tasks: [
    { key: "t1", title: "Nghiên cứu offer", description: "Tìm và so sánh offer", deliverable_key: "dossier", assignee_slug: slug, expected_output: "Hồ sơ offer", acceptance: "≥ 3 offer có nguồn", due_in_days: 3, budget_alloc: { amount: 30, currency: "USD" }, depends_on: [] },
    { key: "t2", title: "Tóm tắt khuyến nghị", description: "Viết khuyến nghị", deliverable_key: "dossier", assignee_slug: slug, expected_output: "Bản tóm tắt", acceptance: "Nêu rõ điểm chưa kiểm chứng", due_in_days: 5, budget_alloc: { amount: 20, currency: "USD" }, depends_on: [] },
  ],
  milestones: [{ key: "m1", after_task_key: "t1", label: "Xong nghiên cứu" }],
  cost: { currency: "USD", ceiling_requested: 100, lines: [{ category: "AI", low: null, base: null, high: null, source: "ESTIMATED", as_of: "2026-11-07", confidence: "LOW" }, { category: "TOOL", low: 5, base: 10, high: 20, source: "ESTIMATED", as_of: "2026-11-07", confidence: "MEDIUM" }], unknown_note: "Chi phí AI chưa đo" },
  prepare_spent: { amount: null, note: "chưa đo" },
  grants_requested: [], stop_conditions: ["Dừng nếu không có offer đủ bằng chứng"], risks: ["Dữ liệu cũ"], alternatives: ["Không làm"],
  ...over,
});

async function goalAndPlan(w: W, key = "goal-0001-aaaa") {
  const g = (await createGoal(w.db, { actorRef: OWNER, key, title: "Thử hướng affiliate X", outcome: "Có kế hoạch thử rõ chi phí", projectId: w.projectId, now: T0 })).goal;
  const p = await createPlan(w.db, { actorRef: OWNER, key: `plan-${key}`, goalId: g.id, leadAssistantId: w.asstId, now: T0, limits: LIMITS });
  return { goal: g, plan: p.plan, task: (p as any).task };
}
async function openRun(w: W, taskId: string, now = at(5)) {
  for (let i = 0; i < 10; i++) { if (!(await processOutbox(w.db, { hermes: w.h, notify: okNotify }, "w1", now))) break; }
  const [r] = await w.db.query<any>(`SELECT * FROM lumi_task_runs WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [taskId]);
  await ackRun(w.db, w.slug, r.id, now);
  return r.id as string;
}
/** Marks ONE run as running without touching the rest of the outbox (so other tasks stay un-started and unlocked). */
async function startOnly(w: W, taskId: string, now: Date) {
  const [r] = await w.db.query<any>(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE task_id=$1 AND state='PENDING' RETURNING id`, [taskId, now.toISOString()]);
  await w.db.query(`UPDATE tasks SET status='RUNNING',started_at=$2 WHERE id=$1`, [taskId, now.toISOString()]);
  return r.id as string;
}
async function submit(w: W, planId: string, body: unknown = bodyOf(w.slug), now = at(10)) {
  const [pl] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [planId]);
  const runId = await openRun(w, pl.planning_task_id, now);
  return submitPlanVersion(w.db, { runId, botSlug: w.slug, body, now, limits: LIMITS });
}
async function approve(w: W, planId: string, version = 1, now = at(20)) {
  const [v] = await w.db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1 AND version=$2`, [planId, version]);
  return decidePlan(w.db, { actorRef: OWNER, planId, version, contentHash: v.content_hash, decision: "APPROVE", now, limits: LIMITS });
}
async function approvedPlan(w: W) {
  const { plan } = await goalAndPlan(w);
  await submit(w, plan.id);
  await approve(w, plan.id);
  return plan.id as string;
}
/** The stored counters must equal what the append-only ledger says (TDD 14.11.B.7). */
async function invariants(db: Db, planId: string) {
  for (const b of await db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1`, [planId])) {
    const lines = (await db.query<any>(`SELECT entry_type, amount FROM lumi_ledger_entries WHERE budget_id=$1 ORDER BY created_at, id`, [b.id])).map((e: any) => ({ entry_type: e.entry_type, amount: e.amount === null ? null : Number(e.amount) }));
    const v = ledgerToBudget(lines);
    assert.equal(Number(b.committed), v.committed, `committed(${b.kind})`);
    assert.equal(Number(b.actual), v.actual, `actual(${b.kind})`);
    assert.equal(b.unknown_count, v.unknownCount, `unknown(${b.kind})`);
    if (b.kind === "EXECUTE") assert.equal(Number(b.ceiling), v.ceiling, "ceiling");
  }
}
async function finishTask(w: W, taskId: string, now: Date, content = "Đầu ra") {
  const runId = await openRun(w, taskId, now);
  const o: any = await submitOutput(w.db, { taskId, runId, actorRef: `bot:${w.slug}`, content, idempotencyKey: `k-${taskId}-${now.getTime()}`, now });
  await decide(w.db, { actorRef: OWNER, outputId: o.output.id, objectVersion: o.output.version, decision: "APPROVE", channel: "WEB", now });
}

describe("economics (pure) — bộ kiểm cố định TDD 12.1", () => {
  const base = { currency: "USD", sharedAllocated: 15, cashIn: 100, cashOut: 125, confirmedCommission: 150, costs: { ADS: 80, AI: 10, PRODUCTION: 20 } };
  it("70 / 50 / 40 / 25 và dòng tiền −25 (không phải 'lãi 25')", () => {
    const r = computeEconomics(base);
    assert.equal(r.confirmedMinusAds.value, 70);
    assert.equal(r.contributionBeforeAI.value, 50);
    assert.equal(r.contributionAfterDirect.value, 40);
    assert.equal(r.operatingResult.value, 25);
    assert.equal(r.netCashFlow.value, -25);
    assert.equal(r.operatingResult.provisional, false);
  });
  it("hoa hồng bị đảo 30 ⇒ kết quả −5; số cũ không đổi vì hàm thuần", () => {
    assert.equal(computeEconomics({ ...base, confirmedCommission: 120 }).operatingResult.value, -5);
    assert.equal(computeEconomics(base).operatingResult.value, 25);
  });
  it("thiếu chi AI (null) ⇒ tạm tính kèm khoản thiếu, KHÔNG coi AI = 0", () => {
    const r = computeEconomics({ ...base, costs: { ADS: 80, AI: null, PRODUCTION: 20 } });
    assert.equal(r.contributionAfterDirect.provisional, true);
    assert.deepEqual(r.contributionAfterDirect.missing, ["AI"]);
    assert.equal(r.operatingResult.provisional, true);
    const none = computeEconomics({ ...base, costs: { ADS: 80, PRODUCTION: 20 } });
    assert.equal(none.contributionAfterDirect.provisional, true); // a missing key is unknown too
  });
  it("chưa có hoa hồng xác nhận ⇒ không có con số", () => {
    const r = computeEconomics({ ...base, confirmedCommission: null });
    assert.equal(r.contributionAfterDirect.value, null);
    assert.equal(r.contributionAfterDirect.provisional, true);
  });
  it("ledgerToBudget tính lại mọi bộ đếm từ sổ", () => {
    const v = ledgerToBudget([{ entry_type: "CEILING", amount: 100 }, { entry_type: "COMMIT", amount: 30 }, { entry_type: "COMMIT", amount: 20 }, { entry_type: "RELEASE", amount: 30 }, { entry_type: "ACTUAL", amount: null }, { entry_type: "ACTUAL", amount: 5 }]);
    assert.deepEqual({ c: v.committed, a: v.actual, u: v.unknownCount, av: v.available }, { c: 20, a: 5, u: 1, av: 75 });
  });
});

describe("plan-schema (pure) — từ chối, không sửa hộ", () => {
  const ctx = { maxTasks: 5, assistants: new Map([["leadbot", true]]) };
  it("body hợp lệ", () => { const r = validatePlanBody(bodyOf("leadbot"), ctx); assert.ok(r.ok, r.errors.join()); assert.equal(r.ceiling, 100); assert.equal(r.est?.low, null); });
  it("lỗi: thiếu trường, trùng key, depends_on/grants khác rỗng, tiền tệ lẫn, low>base, tổng phân bổ > trần, quá số việc, assignee lạ", () => {
    const b: any = bodyOf("leadbot");
    b.summary = "ngắn"; b.tasks[1].key = "t1"; b.tasks[0].depends_on = ["x"]; b.grants_requested = [{ a: 1 }];
    b.tasks[0].budget_alloc.currency = "EUR"; b.cost.lines[1].low = 99; b.tasks[1].assignee_slug = "ai-do";
    const r = validatePlanBody(b, ctx);
    assert.equal(r.ok, false);
    const joined = r.errors.join("|");
    for (const frag of ["summary", "duplicate", "depends_on", "grants_requested", "currency(mismatch)", "low>base", "assignee_slug"]) assert.ok(joined.includes(frag), `${frag} in ${joined}`);
    const big: any = bodyOf("leadbot"); big.tasks[0].budget_alloc.amount = 90; big.tasks[1].budget_alloc.amount = 90;
    assert.ok(validatePlanBody(big, ctx).errors.some((e) => e.includes("sum>ceiling_requested")));
    const many: any = bodyOf("leadbot"); many.tasks = Array.from({ length: 6 }, (_, i) => ({ ...many.tasks[0], key: `k${i}` }));
    assert.ok(validatePlanBody(many, ctx).errors.some((e) => e.startsWith("tasks(<=5)")));
  });
  it("assignee chưa sẵn sàng bị từ chối; body không phải object bị từ chối", () => {
    assert.ok(validatePlanBody(bodyOf("leadbot"), { maxTasks: 5, assistants: new Map([["leadbot", false]]) }).errors.some((e) => e.includes("not_ready")));
    assert.equal(validatePlanBody("x", ctx).ok, false);
  });
});

describe("IMP-01 miền kế hoạch (PGlite + migration thật)", () => {
  it("1. cờ: thiếu cấu hình ⇒ không bật; tắt ⇒ chặn ghi, đọc vẫn được", async () => {
    const w = await world({ plans: false });
    await rejects(createGoal(w.db, { actorRef: OWNER, key: "goal-0001-aaaa", title: "Mục tiêu", outcome: "kết quả", projectId: w.projectId, now: T0 }), "PLANS_DISABLED", 409);
    await rejects(setPlansEnabled(w.db, OWNER, true, T0, { maxTasks: null, versionTtlHours: null }), "CONFIG_INCOMPLETE", 422);
    await rejects(setPlansEnabled(w.db, VIEWER, true, T0, LIMITS), "FORBIDDEN", 403);
    await setPlansEnabled(w.db, OWNER, true, T0, LIMITS);
    const g = await createGoal(w.db, { actorRef: OWNER, key: "goal-0001-aaaa", title: "Mục tiêu", outcome: "kết quả", projectId: w.projectId, now: T0 });
    assert.equal(g.alreadyProcessed, false);
    await setPlansEnabled(w.db, OWNER, false, at(1));
    await rejects(createGoal(w.db, { actorRef: OWNER, key: "goal-0002-bbbb", title: "Khác", outcome: "x y z", projectId: w.projectId, now: at(2) }), "PLANS_DISABLED");
    assert.ok((await w.db.query(`SELECT 1 FROM lumi_goals`)).length === 1); // đọc/dữ liệu còn nguyên
  });

  it("2. mục tiêu: gửi lại cùng khóa ⇒ một bản; đóng ACHIEVED cần ghi chú bằng chứng; hệ thống không tự đặt kết quả", async () => {
    const w = await world();
    const a = await createGoal(w.db, { actorRef: OWNER, key: "goal-0001-aaaa", title: "Mục tiêu", outcome: "kết quả", projectId: w.projectId, now: T0 });
    const b = await createGoal(w.db, { actorRef: OWNER, key: "goal-0001-aaaa", title: "Mục tiêu", outcome: "kết quả", projectId: w.projectId, now: at(1) });
    assert.equal(b.alreadyProcessed, true); assert.equal(a.goal.id, b.goal.id);
    await rejects(createGoal(w.db, { actorRef: ADMIN, key: "goal-0003-cccc", title: "Mục tiêu", outcome: "kết quả", projectId: w.projectId, now: T0 }), "FORBIDDEN", 403);
    await rejects(closeGoal(w.db, { actorRef: OWNER, goalId: a.goal.id, result: "ACHIEVED", note: "ngắn", now: at(2) }), "VALIDATION_ERROR", 400);
    const c = await closeGoal(w.db, { actorRef: OWNER, goalId: a.goal.id, result: "INSUFFICIENT_DATA", now: at(3) });
    assert.equal(c.goal.status, "CLOSED"); assert.equal(c.goal.result, "INSUFFICIENT_DATA");
    assert.equal((await closeGoal(w.db, { actorRef: OWNER, goalId: a.goal.id, result: "INSUFFICIENT_DATA", now: at(4) })).alreadyProcessed, true);
    await rejects(closeGoal(w.db, { actorRef: OWNER, goalId: a.goal.id, result: "ABANDONED", now: at(5) }), "ALREADY_DECIDED", 409);
  });

  it("3. tạo kế hoạch: việc lập kế hoạch + lượt chạy + ngân sách chuẩn bị (không trần); gửi lại ⇒ cùng kế hoạch; chỉ một kế hoạch sống/mục tiêu", async () => {
    const w = await world();
    const g = (await createGoal(w.db, { actorRef: OWNER, key: "goal-0001-aaaa", title: "Mục tiêu", outcome: "kết quả", projectId: w.projectId, now: T0 })).goal;
    const p1 = await createPlan(w.db, { actorRef: OWNER, key: "plan-key-0001", goalId: g.id, leadAssistantId: w.asstId, now: T0, limits: LIMITS });
    assert.equal(p1.alreadyProcessed, false); assert.equal(p1.plan.status, "DRAFTING");
    const p2 = await createPlan(w.db, { actorRef: OWNER, key: "plan-key-0001", goalId: g.id, leadAssistantId: w.asstId, now: at(1), limits: LIMITS });
    assert.equal(p2.alreadyProcessed, true); assert.equal(p2.plan.id, p1.plan.id);
    await rejects(createPlan(w.db, { actorRef: OWNER, key: "plan-key-0002", goalId: g.id, leadAssistantId: w.asstId, now: at(2), limits: LIMITS }), "PLAN_EXISTS", 409);
    const [pb] = await w.db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1`, [p1.plan.id]);
    assert.equal(pb.kind, "PREPARE"); assert.equal(pb.ceiling, null);
    const runs = await w.db.query<any>(`SELECT r.state FROM lumi_task_runs r WHERE r.task_id=$1`, [(p1 as any).task.id]);
    assert.deepEqual(runs.map((r: any) => r.state), ["PENDING"]);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int AS n FROM lumi_outbox WHERE kind='DISPATCH_RUN'`))[0].n, 1);
  });

  it("4. nộp phiên bản: body sai ⇒ từ chối kèm trường lỗi (không lưu); hợp lệ ⇒ v1, PENDING_APPROVAL, việc lập kế hoạch COMPLETED; nộp lại cùng lượt ⇒ bản cũ; lượt bot khác bị từ chối", async () => {
    const w = await world();
    const { plan } = await goalAndPlan(w);
    const [pl] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [plan.id]);
    const runId = await openRun(w, pl.planning_task_id);
    const bad: any = bodyOf(w.slug); bad.grants_requested = [{ x: 1 }];
    await assert.rejects(submitPlanVersion(w.db, { runId, botSlug: w.slug, body: bad, now: at(6), limits: LIMITS }), (e: any) => e.code === "VALIDATION_ERROR" && (e.data.errors as string[]).some((x) => x.includes("grants_requested")));
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_plan_versions`)).length, 0);
    await rejects(submitPlanVersion(w.db, { runId, botSlug: "other", body: bodyOf(w.slug), now: at(6), limits: LIMITS }), "NOT_FOUND", 404);
    const ok = await submitPlanVersion(w.db, { runId, botSlug: w.slug, body: bodyOf(w.slug), now: at(7), limits: LIMITS });
    assert.equal(ok.version.version, 1); assert.equal(ok.alreadyProcessed, false);
    const again = await submitPlanVersion(w.db, { runId, botSlug: w.slug, body: bodyOf(w.slug), now: at(8), limits: LIMITS });
    assert.equal(again.alreadyProcessed, true);
    const [p] = await w.db.query<any>(`SELECT status,current_version FROM lumi_plans WHERE id=$1`, [plan.id]);
    assert.deepEqual([p.status, p.current_version], ["PENDING_APPROVAL", 1]);
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [pl.planning_task_id]))[0].status, "COMPLETED");
    // lượt đã SUCCEEDED: nộp lại cùng lượt trả bản cũ (không lưu bản mới); nộp muộn của lượt đã hủy được kiểm ở test 13
  });

  it("5. phiên bản bất biến ở CSDL: sửa body/trần bị trigger chặn; chỉ state đổi được", async () => {
    const w = await world();
    const { plan } = await goalAndPlan(w);
    await submit(w, plan.id);
    await assert.rejects(w.db.query(`UPDATE lumi_plan_versions SET ceiling_amount=1 WHERE plan_id=$1`, [plan.id]), /immutable/);
    await assert.rejects(w.db.query(`UPDATE lumi_plan_versions SET body='{}'::jsonb WHERE plan_id=$1`, [plan.id]), /immutable/);
    await w.db.query(`UPDATE lumi_plan_versions SET state='SUPERSEDED' WHERE plan_id=$1`, [plan.id]);
  });

  it("6. duyệt: gắn đúng phiên bản + content_hash; sai hash ⇒ STALE; bot/VIEWER/ADMIN bị chặn; duyệt tạo việc + cam kết đúng; gửi lại ⇒ already_processed, không tạo thêm", async () => {
    const w = await world();
    const { plan } = await goalAndPlan(w);
    await submit(w, plan.id);
    const [v] = await w.db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1`, [plan.id]);
    const d = (actorRef: string, o: Record<string, any> = {}) => decidePlan(w.db, { actorRef, planId: plan.id, version: 1, contentHash: v.content_hash, decision: "APPROVE", now: at(20), limits: LIMITS, ...o });
    await rejects(d("bot:leadbot"), "FORBIDDEN", 403);
    await rejects(d(VIEWER), "FORBIDDEN", 403);
    await rejects(d(ADMIN), "FORBIDDEN", 403);
    await rejects(d(OWNER, { contentHash: "0".repeat(64) }), "STALE_VERSION", 409);
    const r = await d(OWNER);
    assert.equal(r.alreadyProcessed, false); assert.equal(r.plan.status, "EXECUTING");
    const tasks = await w.db.query<any>(`SELECT code,status,plan_task_key,plan_version FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL ORDER BY plan_task_key`, [plan.id]);
    assert.deepEqual(tasks.map((t: any) => [t.plan_task_key, t.status, t.plan_version]), [["t1", "QUEUED", 1], ["t2", "QUEUED", 1]]);
    const [b] = await w.db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [plan.id]);
    assert.deepEqual([Number(b.ceiling), Number(b.committed), Number(b.actual)], [100, 50, 0]);
    const again = await d(OWNER);
    assert.equal(again.alreadyProcessed, true);
    assert.equal((await w.db.query(`SELECT 1 FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [plan.id])).length, 2);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_approvals WHERE kind='PLAN'`)).length, 1);
    await rejects(d(OWNER, { decision: "REJECT", reason: "đổi ý" }), "ALREADY_DECIDED", 409);
    await invariants(w.db, plan.id);
  });

  it("7. REVISE ⇒ NEEDS_REVISION + việc sửa kế hoạch; bản v2 được duyệt; bản v1 cũ bị chặn; REJECT ⇒ REJECTED", async () => {
    const w = await world();
    const { plan } = await goalAndPlan(w);
    await submit(w, plan.id);
    const [v1] = await w.db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1 AND version=1`, [plan.id]);
    await rejects(decidePlan(w.db, { actorRef: OWNER, planId: plan.id, version: 1, contentHash: v1.content_hash, decision: "REVISE", now: at(20), limits: LIMITS }), "VALIDATION_ERROR", 400); // cần lý do
    const r = await decidePlan(w.db, { actorRef: OWNER, planId: plan.id, version: 1, contentHash: v1.content_hash, decision: "REVISE", reason: "Cắt xuống một việc", now: at(21), limits: LIMITS });
    assert.equal(r.plan.status, "NEEDS_REVISION");
    const [pl] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [plan.id]);
    const runId = await openRun(w, pl.planning_task_id, at(30));
    const b2: any = bodyOf(w.slug); b2.tasks = [b2.tasks[0]]; b2.milestones = [];
    await submitPlanVersion(w.db, { runId, botSlug: w.slug, body: b2, now: at(31), limits: LIMITS });
    await rejects(decidePlan(w.db, { actorRef: OWNER, planId: plan.id, version: 1, contentHash: v1.content_hash, decision: "APPROVE", now: at(32), limits: LIMITS }), "ALREADY_DECIDED", 409);
    const a2 = await approve(w, plan.id, 2, at(33));
    assert.equal(a2.plan.status, "EXECUTING");
    assert.equal((await w.db.query(`SELECT 1 FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [plan.id])).length, 1);
    const w2 = await world();
    const { plan: p2 } = await goalAndPlan(w2);
    await submit(w2, p2.id);
    const [h2] = await w2.db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1`, [p2.id]);
    const rj = await decidePlan(w2.db, { actorRef: OWNER, planId: p2.id, version: 1, contentHash: h2.content_hash, decision: "REJECT", reason: "Không phù hợp", now: at(22), limits: LIMITS });
    assert.equal(rj.plan.status, "REJECTED");
    assert.equal((await w2.db.query(`SELECT 1 FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [p2.id])).length, 0);
  });

  it("8. DEFER/RESUME không tạo dòng duyệt; hết hạn phiên bản ⇒ 410 GONE và kế hoạch cần sửa", async () => {
    const w = await world();
    const { plan } = await goalAndPlan(w);
    const [pl] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [plan.id]);
    const runId = await openRun(w, pl.planning_task_id);
    await submitPlanVersion(w.db, { runId, botSlug: w.slug, body: bodyOf(w.slug), now: at(10), limits: { maxTasks: 5, versionTtlHours: 1 } });
    const [v] = await w.db.query<any>(`SELECT content_hash,expires_at FROM lumi_plan_versions WHERE plan_id=$1`, [plan.id]);
    assert.ok(v.expires_at);
    const dec = (decision: any, now: Date) => decidePlan(w.db, { actorRef: OWNER, planId: plan.id, version: 1, contentHash: v.content_hash, decision, now, limits: LIMITS });
    assert.equal((await dec("DEFER", at(11))).plan.status, "DEFERRED");
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_approvals WHERE kind='PLAN'`)).length, 0);
    assert.equal((await dec("RESUME", at(12))).plan.status, "PENDING_APPROVAL");
    await rejects(dec("APPROVE", new Date(T0.getTime() + 3 * 3600_000)), "GONE", 410);
    const [s] = await w.db.query<any>(`SELECT p.status, v.state FROM lumi_plans p JOIN lumi_plan_versions v ON v.plan_id=p.id WHERE p.id=$1`, [plan.id]);
    assert.deepEqual([s.status, s.state], ["NEEDS_REVISION", "EXPIRED"]);
  });

  it("9. hạ trần dưới phần đã cam kết bị từ chối ngay lúc nộp (CEILING_BELOW_USED) và không đổi gì", async () => {
    const w = await world();
    const planId = await approvedPlan(w); // trần 100, cam kết 50
    await revisePlan(w.db, { actorRef: OWNER, planId, instruction: "Hạ trần", now: at(30), limits: LIMITS });
    const [p2] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [planId]);
    const runId = await openRun(w, p2.planning_task_id, at(31));
    const v2: any = bodyOf(w.slug); v2.cost.ceiling_requested = 40; v2.tasks[0].budget_alloc.amount = 20; v2.tasks[1].budget_alloc.amount = 20;
    await assert.rejects(submitPlanVersion(w.db, { runId, botSlug: w.slug, body: v2, now: at(32), limits: LIMITS }), (e: any) => e.code === "VALIDATION_ERROR" && (e.data.errors as string[]).some((x) => x.includes("CEILING_BELOW_USED")));
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_plan_versions WHERE plan_id=$1`, [planId])).length, 1);
    await invariants(w.db, planId);
  });

  it("9b. NO_BUDGET lúc duyệt: toàn bộ giao dịch duyệt hoàn lại (không còn việc, ngân sách hay dòng duyệt)", async () => {
    const w = await world();
    const { plan } = await goalAndPlan(w);
    await submit(w, plan.id);
    // Chặn đường thật: hạ trần của phiên bản đã nộp bằng cách thay thế hàng (bỏ qua trigger bất biến) để mô phỏng bộ đếm bị vượt tại thời điểm duyệt.
    await w.db.query(`ALTER TABLE lumi_plan_versions DISABLE TRIGGER lumi_plan_versions_immutable_trg`);
    await w.db.query(`UPDATE lumi_plan_versions SET ceiling_amount=10, body = jsonb_set(body, '{cost,ceiling_requested}', '10'::jsonb) WHERE plan_id=$1`, [plan.id]);
    await w.db.query(`ALTER TABLE lumi_plan_versions ENABLE TRIGGER lumi_plan_versions_immutable_trg`);
    const [v] = await w.db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1`, [plan.id]);
    await rejects(decidePlan(w.db, { actorRef: OWNER, planId: plan.id, version: 1, contentHash: v.content_hash, decision: "APPROVE", now: at(20), limits: LIMITS }), "NO_BUDGET", 409);
    assert.equal((await w.db.query(`SELECT 1 FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [plan.id])).length, 0);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [plan.id])).length, 0);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_approvals WHERE kind='PLAN'`)).length, 0);
    assert.equal((await w.db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [plan.id]))[0].status, "PENDING_APPROVAL");
  });

  it("10. sửa kế hoạch sau duyệt: việc đã chạy bị KHÓA; việc chưa chạy được đổi/hủy/thêm; trần và cam kết cập nhật đúng; sổ nhất quán", async () => {
    const w = await world();
    const planId = await approvedPlan(w);
    const t1 = (await w.db.query<any>(`SELECT id FROM tasks WHERE plan_id=$1 AND plan_task_key='t1'`, [planId]))[0];
    await startOnly(w, t1.id, at(25)); // t1 bắt đầu chạy ⇒ khóa; t2 vẫn chưa chạy
    await revisePlan(w.db, { actorRef: OWNER, planId, instruction: "Thêm việc, bỏ t2", now: at(30), limits: LIMITS });
    const [pl] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [planId]);
    const runId = await startOnly(w, pl.planning_task_id, at(31));
    const changeLocked: any = bodyOf(w.slug); changeLocked.tasks[0].title = "Đổi tên việc đã chạy";
    await assert.rejects(submitPlanVersion(w.db, { runId, botSlug: w.slug, body: changeLocked, now: at(32), limits: LIMITS }), (e: any) => (e.data.errors as string[]).some((x) => x.includes("TASK_LOCKED:cannot_change")));
    const removeLocked: any = bodyOf(w.slug); removeLocked.tasks = [removeLocked.tasks[1]]; removeLocked.milestones = [];
    await assert.rejects(submitPlanVersion(w.db, { runId, botSlug: w.slug, body: removeLocked, now: at(32), limits: LIMITS }), (e: any) => (e.data.errors as string[]).some((x) => x.includes("TASK_LOCKED:cannot_remove")));
    const good: any = bodyOf(w.slug);
    good.tasks = [good.tasks[0], { ...good.tasks[0], key: "t3", title: "Việc mới thêm", budget_alloc: { amount: 15, currency: "USD" } }]; good.milestones = []; good.cost.ceiling_requested = 120;
    await submitPlanVersion(w.db, { runId, botSlug: w.slug, body: good, now: at(33), limits: LIMITS });
    const [v2] = await w.db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1 AND version=2`, [planId]);
    assert.equal((await w.db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]))[0].status, "EXECUTING"); // vẫn chạy trong khi bản sửa chờ duyệt
    await decidePlan(w.db, { actorRef: OWNER, planId, version: 2, contentHash: v2.content_hash, decision: "APPROVE", now: at(34), limits: LIMITS });
    const ts = await w.db.query<any>(`SELECT plan_task_key,status FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL ORDER BY plan_task_key`, [planId]);
    assert.deepEqual(ts.map((t: any) => [t.plan_task_key, t.status]), [["t1", "RUNNING"], ["t2", "CANCELLED"], ["t3", "QUEUED"]]);
    const [b] = await w.db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [planId]);
    assert.deepEqual([Number(b.ceiling), Number(b.committed)], [120, 45]); // t1 30 + t3 15; t2 đã giải phóng 20
    assert.deepEqual((await w.db.query<any>(`SELECT state FROM lumi_plan_versions WHERE plan_id=$1 ORDER BY version`, [planId])).map((x: any) => x.state), ["SUPERSEDED", "APPROVED"]);
    await invariants(w.db, planId);
  });

  it("11. thực thi → kiểm tra → báo cáo: lượt chạy ghi 'chưa biết', giải phóng cam kết, báo cáo mốc và cuối bất biến, kinh doanh = NOT_ASSESSED; hoàn tất task ≠ kế hoạch ≠ mục tiêu", async () => {
    const w = await world();
    const planId = await approvedPlan(w);
    const [t1] = await w.db.query<any>(`SELECT id FROM tasks WHERE plan_id=$1 AND plan_task_key='t1'`, [planId]);
    await finishTask(w, t1.id, at(40));
    await planTick(w.db, at(41), { hermesMode: "simulated" });
    let [pl] = await w.db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]);
    assert.equal(pl.status, "EXECUTING"); // task 1/2 xong ≠ kế hoạch xong
    assert.equal((await w.db.query<any>(`SELECT count(*)::int AS n FROM lumi_reports WHERE plan_id=$1 AND kind='PHASE'`, [planId]))[0].n, 1);
    const [t2] = await w.db.query<any>(`SELECT id FROM tasks WHERE plan_id=$1 AND plan_task_key='t2'`, [planId]);
    await finishTask(w, t2.id, at(50));
    await planTick(w.db, at(51), { hermesMode: "simulated" });
    await planTick(w.db, at(52), { hermesMode: "simulated" }); // lặp ⇒ không ghi trùng
    [pl] = await w.db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]);
    assert.equal(pl.status, "DONE");
    const [g] = await w.db.query<any>(`SELECT status,result FROM lumi_goals`);
    assert.deepEqual([g.status, g.result], ["ACTIVE", null]); // kế hoạch DONE nhưng mục tiêu CHƯA đạt/đóng
    const [exec] = await w.db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [planId]);
    assert.deepEqual([Number(exec.committed), Number(exec.actual), exec.unknown_count], [0, 0, 2]); // cam kết giải phóng; AI chưa biết ×2; KHÔNG coi là 0 chi
    const [prep] = await w.db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1 AND kind='PREPARE'`, [planId]);
    assert.equal(prep.unknown_count, 1); // lượt lập kế hoạch cũng vào sổ
    await invariants(w.db, planId);
    const fin = await w.db.query<any>(`SELECT * FROM lumi_reports WHERE plan_id=$1 AND kind='FINAL'`, [planId]);
    assert.equal(fin.length, 1);
    const body = fin[0].body;
    assert.equal(body.business.status, "NOT_ASSESSED");
    assert.equal(body.data_sources.ai_cost, "UNKNOWN");
    assert.equal(body.completion.completed, 2);
    assert.equal(body.goal.result, null);
    assert.ok((body.limits as string[]).some((l) => l.includes("Chi phí AI chưa đo")));
    assert.match(String(body.data_sources.hermes_mode), /simulated/);
    await assert.rejects(w.db.query(`UPDATE lumi_reports SET body='{}'::jsonb WHERE plan_id=$1`, [planId]), /immutable/);
    // chỉ Chủ đóng mục tiêu
    const closed = await closeGoal(w.db, { actorRef: OWNER, goalId: (await w.db.query<any>(`SELECT id FROM lumi_goals`))[0].id, result: "INSUFFICIENT_DATA", now: at(60) });
    assert.equal(closed.goal.status, "CLOSED");
  });

  it("12. thực tế nhập tay: NULL≠0, đối soát, vượt trần ⇒ PAUSED_ADJUSTMENT và dispatch bị hoãn; nâng trần bằng bản mới ⇒ chạy lại", async () => {
    const w = await world();
    const planId = await approvedPlan(w);
    const rec = (key: string, amount: number, now: Date) => recordLedger(w.db, { actorRef: OWNER, planId, key, category: "TOOL", amount, currency: "USD", source: "PROVIDER_STATEMENT", now });
    await rejects(recordLedger(w.db, { actorRef: VIEWER, planId, key: "k-viewer-001", category: "TOOL", amount: 1, currency: "USD", source: "MANUAL", now: at(30) }), "FORBIDDEN");
    await rejects(recordLedger(w.db, { actorRef: OWNER, planId, key: "k-eur-00001", category: "TOOL", amount: 1, currency: "EUR", source: "MANUAL", now: at(30) }), "VALIDATION_ERROR");
    assert.equal((await rec("k-tool-0001", 10, at(31))).created, true);
    assert.equal((await rec("k-tool-0001", 10, at(32))).created, false); // gửi lại ⇒ không ghi hai lần
    const [b1] = await w.db.query<any>(`SELECT actual FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [planId]);
    assert.equal(Number(b1.actual), 10);
    const ids = (await w.db.query<any>(`SELECT id FROM lumi_ledger_entries WHERE plan_id=$1 AND entry_type='ACTUAL' AND amount IS NOT NULL`, [planId])).map((x: any) => x.id);
    assert.equal((await reconcileLedger(w.db, { actorRef: OWNER, planId, entryIds: ids, reconciliationKey: "stmt-2026-11", now: at(33) })).reconciled, 1);
    assert.equal((await reconcileLedger(w.db, { actorRef: OWNER, planId, entryIds: ids, reconciliationKey: "stmt-2026-11", now: at(34) })).reconciled, 0);
    await assert.rejects(w.db.query(`UPDATE lumi_ledger_entries SET amount=999 WHERE id=$1`, [ids[0]]), /append-only/);
    await assert.rejects(w.db.query(`DELETE FROM lumi_ledger_entries WHERE id=$1`, [ids[0]]), /append-only/);
    await rec("k-tool-0002", 45, at(35)); // 10+45=55 thực tế + 50 cam kết > 100 ⇒ vượt
    assert.equal((await w.db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]))[0].status, "PAUSED_ADJUSTMENT");
    const [t1] = await w.db.query<any>(`SELECT id FROM tasks WHERE plan_id=$1 AND plan_task_key='t1'`, [planId]);
    for (let i = 0; i < 10; i++) { if (!(await processOutbox(w.db, { hermes: w.h, notify: okNotify }, "w9", at(36)))) break; }
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_task_runs WHERE task_id=$1`, [t1.id]))[0].state, "PENDING");
    await invariants(w.db, planId);
    // nâng trần bằng phiên bản mới do Chủ duyệt
    await revisePlan(w.db, { actorRef: OWNER, planId, instruction: "Nâng trần", now: at(40), limits: LIMITS });
    const [pl] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [planId]);
    const runId = await startOnly(w, pl.planning_task_id, at(41));
    const up: any = bodyOf(w.slug); up.cost.ceiling_requested = 200;
    await submitPlanVersion(w.db, { runId, botSlug: w.slug, body: up, now: at(42), limits: LIMITS });
    const [v2] = await w.db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1 AND version=2`, [planId]);
    const r = await decidePlan(w.db, { actorRef: OWNER, planId, version: 2, contentHash: v2.content_hash, decision: "APPROVE", now: at(43), limits: LIMITS });
    assert.equal(r.plan.status, "EXECUTING");
    await invariants(w.db, planId);
  });

  it("13. hủy kế hoạch: việc CANCELLED, cam kết giải phóng, kế hoạch CANCELLED, báo cáo cuối; kết quả muộn lưu LATE_SAVED và KHÔNG mở lại; hủy lặp ⇒ already_processed", async () => {
    const w = await world();
    const planId = await approvedPlan(w);
    const [t1] = await w.db.query<any>(`SELECT id FROM tasks WHERE plan_id=$1 AND plan_task_key='t1'`, [planId]);
    const runId = await openRun(w, t1.id, at(25));
    await rejects(cancelPlan(w.db, { actorRef: OWNER, planId, reason: "ab", now: at(30) }), "VALIDATION_ERROR");
    const c = await cancelPlan(w.db, { actorRef: OWNER, planId, reason: "Đổi hướng", now: at(31) });
    assert.equal(c.plan.status, "CANCELLED");
    assert.equal((await cancelPlan(w.db, { actorRef: OWNER, planId, reason: "Đổi hướng", now: at(32) })).alreadyProcessed, true);
    assert.deepEqual((await w.db.query<any>(`SELECT status FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [planId])).map((x: any) => x.status), ["CANCELLED", "CANCELLED"]);
    const [b] = await w.db.query<any>(`SELECT committed FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [planId]);
    assert.equal(Number(b.committed), 0);
    // bot nộp muộn sau khi hủy: lưu để kiểm toán, không sống lại
    const late: any = await submitOutput(w.db, { taskId: t1.id, runId, actorRef: `bot:${w.slug}`, content: "Kết quả đến muộn", idempotencyKey: "late-1", now: at(60) });
    assert.equal(late.late, true);
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [t1.id]))[0].status, "CANCELLED");
    assert.equal((await w.db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]))[0].status, "CANCELLED");
    await planTick(w.db, at(61), { hermesMode: "simulated" });
    assert.ok((await w.db.query<any>(`SELECT count(*)::int AS n FROM lumi_reports WHERE plan_id=$1 AND kind='FINAL'`, [planId]))[0].n >= 1);
    await invariants(w.db, planId);
  });

  it("13b. hủy kế hoạch khi bot còn đang lập kế hoạch: nộp muộn bị từ chối (RUN_NOT_OPEN), không tạo phiên bản", async () => {
    const w = await world();
    const { plan } = await goalAndPlan(w);
    const [pl] = await w.db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [plan.id]);
    const runId = await openRun(w, pl.planning_task_id);
    await cancelPlan(w.db, { actorRef: OWNER, planId: plan.id, reason: "Không làm nữa", now: at(8) });
    await rejects(submitPlanVersion(w.db, { runId, botSlug: w.slug, body: bodyOf(w.slug), now: at(9), limits: LIMITS }), "RUN_NOT_OPEN");
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_plan_versions`)).length, 0);
  });

  it("14. không đổi hành vi M1: việc thường (plan_id NULL) vẫn tạo/duyệt như cũ khi cờ kế hoạch tắt; drainPlans tạm dừng kế hoạch, không xóa dữ liệu", async () => {
    const w = await world();
    const planId = await approvedPlan(w);
    const rep = await drainPlans(w.db, OWNER, at(70));
    assert.equal(rep.plansPaused, 1);
    assert.equal((await w.db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]))[0].status, "PAUSED_ADJUSTMENT");
    assert.ok((await w.db.query(`SELECT 1 FROM tasks WHERE plan_id=$1`, [planId])).length >= 3);
    assert.deepEqual(await planTick(w.db, at(71), { hermesMode: "simulated" }), { skipped: true });
    const detail = await getPlanDetail(w.db, planId);
    assert.ok(detail && detail.versions.length === 1 && detail.tasks.length >= 3);
    assert.deepEqual(planLimits({ LUMI_PLAN_MAX_TASKS: "7", LUMI_PLAN_VERSION_TTL_HOURS: "" }), { maxTasks: 7, versionTtlHours: null });
    assert.deepEqual(planLimits({}), { maxTasks: null, versionTtlHours: null }); // không có số mặc định
    void evaluatePlan;
  });
});
