/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-01 — evidence class B (TDD 14.9): a REAL PostgreSQL server process, many real connections, the real migrations 0000..0044.
 * Proves what PGlite cannot: concurrent approvals/ledger writes/ticks across genuinely separate sessions, and the HTTP contract
 * (`handle()`) incl. roles. Hermes is simulated; no model is called; this is NOT class C (real integration) and says nothing about
 * business results.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { setDispatchEnabled, type Db } from "./core";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { handleRpc, MCP_TOOLS } from "./mcp";
import { ledgerToBudget } from "./economics";
import { planTick, setPlansEnabled } from "./plans";

let srv: PgServer;
let db: Db;
let clock = new Date("2026-11-07T08:00:00Z");
const tick = (sec: number) => { clock = new Date(clock.getTime() + sec * 1000); return clock; };
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });
let hermes = new SimulatedHermes();
const ctx = (): ApiCtx => ({ db, hermes, now: () => clock });
async function call(name: string, principal: Principal | null, o: { params?: Record<string, string>; body?: any; key?: string } = {}) {
  return handle(name, ctx(), { principal, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });
}
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

const bodyOf = (slug: string) => ({
  schema: 1, summary: "Thử một hướng affiliate cho nhóm khách X: nghiên cứu offer rồi lập kế hoạch nội dung.",
  opportunity: { evidence: [{ claim: "Có nhu cầu tìm kiếm ổn định", ref: "https://example.test/a", as_of: "2026-11-01" }], confidence: "LOW" },
  scope: { in: ["Nghiên cứu offer"], out: ["Chạy quảng cáo"] },
  deliverables: [{ key: "dossier", title: "Hồ sơ offer", acceptance: "Có ít nhất 3 offer có nguồn" }],
  tasks: [
    { key: "t1", title: "Nghiên cứu offer", description: "Tìm và so sánh offer", deliverable_key: "dossier", assignee_slug: slug, expected_output: "Hồ sơ offer", acceptance: "≥ 3 offer có nguồn", due_in_days: 3, budget_alloc: { amount: 30, currency: "USD" }, depends_on: [] },
    { key: "t2", title: "Tóm tắt khuyến nghị", description: "Viết khuyến nghị", deliverable_key: "dossier", assignee_slug: slug, expected_output: "Bản tóm tắt", acceptance: "Nêu rõ điểm chưa kiểm chứng", due_in_days: 5, budget_alloc: { amount: 20, currency: "USD" }, depends_on: [] },
  ],
  milestones: [{ key: "m1", after_task_key: "t1", label: "Xong nghiên cứu" }],
  cost: { currency: "USD", ceiling_requested: 100, lines: [{ category: "TOOL", low: 5, base: 10, high: 20, source: "ESTIMATED", as_of: "2026-11-07", confidence: "MEDIUM" }], unknown_note: "Chi phí AI chưa đo" },
  prepare_spent: { amount: null, note: "chưa đo" }, grants_requested: [], stop_conditions: ["Dừng nếu không có offer đủ bằng chứng"], risks: [], alternatives: [],
});

async function world() {
  await db.query(`UPDATE lumi_outbox SET state='DONE' WHERE state IN ('PENDING','LEASED')`);
  hermes = new SimulatedHermes();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now()) ON CONFLICT (key) DO UPDATE SET value='true'`);
  const s = `t${uniq()}`;
  await db.query(`INSERT INTO profiles(slug,name,type,status) VALUES ($1,'Bot thử','bot','active') ON CONFLICT DO NOTHING`, [s]);
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${s}`, `Dự án ${s}`]);
  const [a] = await db.query<any>(
    `INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day)
     VALUES ($1,$2,'SPECIALIST',$1,'VERIFIED',0,'["tasks.intake","outputs.submit","knowledge.context"]',600,30,2,3,2,500) RETURNING id`, [s, `Bot ${s}`]);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2) ON CONFLICT (actor_ref) DO UPDATE SET role=EXCLUDED.role`, [ref, role]);
  await setDispatchEnabled(db, hermes, "web:owner@test", a.id, true, clock);
  await setPlansEnabled(db, "web:owner@test", true, clock, { maxTasks: 5, versionTtlHours: null });
  const bot: Principal = { kind: "bot", slug: s, actorRef: `bot:${s}` };
  return { slug: s, projectId: proj.id as string, asstId: a.id as string, bot };
}
type W = Awaited<ReturnType<typeof world>>;

async function goalPlanSubmitted(w: W) {
  const g = await call("createGoal", OWNER, { key: `goal-${uniq()}-xxxx`, body: { title: "Thử hướng X", outcome: "Có kế hoạch thử", project_id: w.projectId } });
  assert.equal(g.status, 201, JSON.stringify(g));
  const p = await call("createPlan", OWNER, { key: `plan-${uniq()}-xxxx`, body: { goal_id: g.data.goal.id, lead_assistant_id: w.asstId } });
  assert.equal(p.status, 201, JSON.stringify(p));
  const planId = p.data.plan.id as string;
  const [pl] = await db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [planId]);
  const [run] = await db.query<any>(`UPDATE lumi_task_runs SET state='RUNNING',started_at='${clock.toISOString()}',acked_at='${clock.toISOString()}' WHERE task_id=$1 AND state='PENDING' RETURNING id`, [pl.planning_task_id]);
  const rpc = await handleRpc(ctx(), w.bot as any, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plan_submit_version", arguments: { run_id: run.id, body: bodyOf(w.slug) } } });
  assert.ok(!rpc.result.isError, JSON.stringify(rpc));
  const [v] = await db.query<any>(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1 AND version=1`, [planId]);
  return { goalId: g.data.goal.id as string, planId, hash: v.content_hash as string, runId: run.id as string };
}
async function invariants(planId: string) {
  for (const b of await db.query<any>(`SELECT * FROM lumi_budgets WHERE plan_id=$1`, [planId])) {
    const lines = (await db.query<any>(`SELECT entry_type, amount FROM lumi_ledger_entries WHERE budget_id=$1 ORDER BY created_at, id`, [b.id])).map((e: any) => ({ entry_type: e.entry_type, amount: e.amount === null ? null : Number(e.amount) }));
    const v = ledgerToBudget(lines);
    assert.equal(Number(b.committed), v.committed, `committed ${b.kind}`);
    assert.equal(Number(b.actual), v.actual, `actual ${b.kind}`);
    assert.equal(b.unknown_count, v.unknownCount, `unknown ${b.kind}`);
  }
}

before(async () => { process.env.LUMI_PLAN_MAX_TASKS = "5"; srv = await startPgServer(); db = postgresDb(srv.sql); });
after(async () => {
  await srv.stop();
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref(); // same convention as the other PG test files: do not let a lingering handle keep the runner alive
});

describe("IMP-01 trên PostgreSQL server thật", () => {
  it("1. hợp đồng HTTP: bot 403 ở mọi route của Chủ; VIEWER/ADMIN chỉ đọc; không đăng nhập 401; thiếu Idempotency-Key 400", async () => {
    const w = await world();
    const { goalId, planId, hash } = await goalPlanSubmitted(w);
    const writes: [string, any][] = [
      ["createGoal", { body: { title: "Thử", outcome: "kết quả", project_id: w.projectId }, key: "k-aaaaaaaa" }],
      ["closeGoal", { params: { id: goalId }, body: { result: "INSUFFICIENT_DATA" } }],
      ["createPlan", { body: { goal_id: goalId, lead_assistant_id: w.asstId }, key: "k-bbbbbbbb" }],
      ["decidePlan", { params: { id: planId }, body: { version: 1, content_hash: hash, decision: "APPROVE" } }],
      ["revisePlan", { params: { id: planId }, body: { instruction: "sửa" } }],
      ["cancelPlan", { params: { id: planId }, body: { reason: "không làm" } }],
      ["recordLedger", { params: { id: planId }, body: { category: "TOOL", amount: 1, currency: "USD", source: "MANUAL" }, key: "k-cccccccc" }],
      ["reconcileLedger", { params: { id: planId }, body: { entry_ids: [goalId], reconciliation_key: "stmt-1" } }],
    ];
    for (const [name, o] of writes) {
      assert.equal((await call(name, w.bot, o)).status, 403, `bot ${name}`);
      assert.equal((await call(name, VIEWER, o)).status, 403, `viewer ${name}`);
      assert.equal((await call(name, ADMIN, o)).status, 403, `admin ${name}`);
      assert.equal((await call(name, null, o)).status, 401, `anon ${name}`);
    }
    for (const who of [VIEWER, ADMIN, OWNER]) {
      assert.equal((await call("listGoals", who)).status, 200);
      assert.equal((await call("planDetail", who, { params: { id: planId } })).status, 200);
    }
    assert.equal((await call("listGoals", w.bot)).status, 403);
    assert.equal((await call("createGoal", OWNER, { body: { title: "Thử", outcome: "kết quả", project_id: w.projectId } })).status, 400); // thiếu Idempotency-Key
    assert.equal((await call("setFlag", OWNER, { body: { key: "plans_enabled", value: true } })).status, 200);
    assert.equal((await call("setFlag", VIEWER, { body: { key: "plans_enabled", value: true } })).status, 403);
    // không có dòng duyệt nào được tạo bởi các lần bị từ chối
    assert.equal((await db.query(`SELECT 1 FROM lumi_approvals WHERE kind='PLAN' AND object_id=$1`, [planId])).length, 0);
  });

  it("2. MCP: tools/list có plan_submit_version; body sai trả danh sách trường lỗi (isError), không lưu; lượt của bot khác bị từ chối", async () => {
    const w = await world();
    assert.ok(MCP_TOOLS.some((t) => t.name === "plan_submit_version"));
    const g = await call("createGoal", OWNER, { key: `goal-${uniq()}-xxxx`, body: { title: "Thử hướng X", outcome: "Có kế hoạch thử", project_id: w.projectId } });
    const p = await call("createPlan", OWNER, { key: `plan-${uniq()}-xxxx`, body: { goal_id: g.data.goal.id, lead_assistant_id: w.asstId } });
    const [pl] = await db.query<any>(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [p.data.plan.id]);
    const [run] = await db.query<any>(`UPDATE lumi_task_runs SET state='RUNNING',started_at='${clock.toISOString()}' WHERE task_id=$1 AND state='PENDING' RETURNING id`, [pl.planning_task_id]);
    const bad: any = bodyOf(w.slug); bad.grants_requested = [{ x: 1 }]; bad.tasks[0].depends_on = ["t2"];
    const r = await handleRpc(ctx(), w.bot as any, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "plan_submit_version", arguments: { run_id: run.id, body: bad } } });
    assert.equal(r.result.isError, true);
    const msg = r.result.content[0].text as string;
    assert.ok(msg.includes("grants_requested") && msg.includes("depends_on"), msg);
    assert.equal((await db.query(`SELECT 1 FROM lumi_plan_versions`)).length >= 0, true);
    assert.equal((await db.query(`SELECT 1 FROM lumi_plan_versions WHERE plan_id=$1`, [p.data.plan.id])).length, 0);
    assert.match(msg, /grants_requested.*cần/, "mỗi lỗi kèm giải thích cần gì");
    const rej = await db.query<any>(`SELECT after_json FROM audit_events WHERE action='plan.submit_rejected' AND after_json->>'runId'=$1`, [run.id]);
    assert.equal(rej.length, 1, "lần nộp bị từ chối được ghi lại để hiển thị checklist");
    assert.ok((rej[0].after_json.errors as string[]).some((x) => x.startsWith("grants_requested")));
    const other = await handleRpc(ctx(), { kind: "bot", slug: "khac", actorRef: "bot:khac" } as any, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "plan_submit_version", arguments: { run_id: run.id, body: bodyOf(w.slug) } } });
    assert.equal(other.result.isError, true);
    const ok = await handleRpc(ctx(), w.bot as any, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "plan_submit_version", arguments: { run_id: run.id, body: bodyOf(w.slug) } } });
    assert.ok(!ok.result.isError, JSON.stringify(ok));
    assert.equal((await db.query(`SELECT 1 FROM lumi_plan_versions WHERE plan_id=$1`, [p.data.plan.id])).length, 1);
  });

  it("3. mục tiêu: 6 yêu cầu song song cùng khóa ⇒ đúng một mục tiêu", async () => {
    const w = await world();
    const key = `goal-par-${uniq()}`;
    const rs = await Promise.all(Array.from({ length: 6 }, () => call("createGoal", OWNER, { key, body: { title: "Song song", outcome: "kết quả", project_id: w.projectId } })));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 201), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(new Set(rs.map((r) => r.data.goal.id)).size, 1);
    assert.equal((await db.query(`SELECT 1 FROM lumi_goals WHERE source_key=$1`, [`web:${key}`])).length, 1);
  });

  it("4. duyệt song song ×6 cùng phiên bản ⇒ đúng MỘT bộ việc và một dòng duyệt; còn lại already_processed; sổ nhất quán", async () => {
    const w = await world();
    const { planId, hash } = await goalPlanSubmitted(w);
    const rs = await Promise.all(Array.from({ length: 6 }, () => call("decidePlan", OWNER, { params: { id: planId }, body: { version: 1, content_hash: hash, decision: "APPROVE" } })));
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => [r.status, r.error?.code])));
    assert.equal(rs.filter((r) => !r.data.already_processed).length, 1);
    assert.equal((await db.query(`SELECT 1 FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL`, [planId])).length, 2);
    assert.equal((await db.query(`SELECT 1 FROM lumi_approvals WHERE kind='PLAN' AND object_id=$1`, [planId])).length, 1);
    const [b] = await db.query<any>(`SELECT committed,ceiling FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [planId]);
    assert.deepEqual([Number(b.committed), Number(b.ceiling)], [50, 100]);
    assert.equal((await db.query(`SELECT 1 FROM lumi_ledger_entries WHERE plan_id=$1 AND entry_type='COMMIT'`, [planId])).length, 2);
    await invariants(planId);
  });

  it("5. APPROVE ∥ REVISE ∥ REJECT đồng thời cùng phiên bản ⇒ đúng một bên thắng, các bên kia 409; trạng thái nhất quán với bên thắng", async () => {
    const w = await world();
    const { planId, hash } = await goalPlanSubmitted(w);
    const d = (decision: string) => call("decidePlan", OWNER, { params: { id: planId }, body: { version: 1, content_hash: hash, decision, reason: "lý do đủ dài" } });
    const rs = await Promise.all([d("APPROVE"), d("REVISE"), d("REJECT"), d("APPROVE")]);
    const oks = rs.filter((r) => r.status === 200 && !r.data.already_processed);
    assert.equal(oks.length, 1, JSON.stringify(rs.map((r) => [r.status, r.error?.code])));
    const winner = oks[0]!.data.decision as string;
    assert.ok(rs.every((r) => r.status === 200 || r.error?.code === "ALREADY_DECIDED"));
    const [ap] = await db.query<any>(`SELECT decision FROM lumi_approvals WHERE kind='PLAN' AND object_id=$1`, [planId]);
    assert.equal(ap.decision, winner);
    const [pl] = await db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]);
    assert.equal(pl.status, winner === "APPROVE" ? "EXECUTING" : winner === "REVISE" ? "NEEDS_REVISION" : "REJECTED");
    await invariants(planId);
  });

  it("6. sổ: 8 khoản khác khóa song song + 6 lần gửi trùng một khóa ⇒ tổng đúng, không ghi hai lần; vượt trần ⇒ PAUSED_ADJUSTMENT; bất biến giữ", async () => {
    const w = await world();
    const { planId, hash } = await goalPlanSubmitted(w);
    await call("decidePlan", OWNER, { params: { id: planId }, body: { version: 1, content_hash: hash, decision: "APPROVE" } });
    const rec = (key: string, amount: number) => call("recordLedger", OWNER, { params: { id: planId }, key, body: { category: "TOOL", amount, currency: "USD", source: "PROVIDER_STATEMENT" } });
    const par = await Promise.all([...Array.from({ length: 8 }, (_, i) => rec(`par-key-${i}-${planId.slice(0, 6)}`, 5)), ...Array.from({ length: 6 }, () => rec(`dup-key-${planId.slice(0, 6)}`, 5))]);
    assert.ok(par.every((r) => r.status === 200 || r.status === 201), JSON.stringify(par.map((r) => [r.status, r.error?.code])));
    const [b] = await db.query<any>(`SELECT actual FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [planId]);
    assert.equal(Number(b.actual), 45); // 8×5 + 1×5
    assert.equal((await db.query(`SELECT 1 FROM lumi_ledger_entries WHERE plan_id=$1 AND entry_type='ACTUAL' AND amount IS NOT NULL`, [planId])).length, 9);
    await invariants(planId);
    assert.equal((await db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]))[0].status, "EXECUTING"); // 45 + 50 cam kết = 95 ≤ 100
    const over = await rec(`over-key-${planId.slice(0, 6)}`, 20); // 65 + 50 = 115 > 100
    assert.ok(over.status === 200 || over.status === 201, JSON.stringify(over));
    await invariants(planId);
    assert.equal((await db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]))[0].status, "PAUSED_ADJUSTMENT");
    // việc của kế hoạch tạm dừng không được gửi cho bot
    const before = hermes.calls.length;
    for (let i = 0; i < 10; i++) { const r = await (await import("./core")).processOutbox(db, { hermes, notify: { send: async () => {} } }, "wp", tick(1)); if (!r) break; }
    const sentTasks = await db.query<any>(`SELECT r.state FROM lumi_task_runs r JOIN tasks k ON k.id=r.task_id WHERE k.plan_id=$1 AND k.plan_task_key IS NOT NULL`, [planId]);
    assert.ok(sentTasks.every((x: any) => x.state === "PENDING"), JSON.stringify(sentTasks));
    assert.equal(hermes.calls.length, before);
  });

  it("7. planTick song song ×4 trên lượt đã kết thúc ⇒ mỗi lượt đúng một khoản 'chưa biết'; chạy lại không ghi thêm; báo cáo cuối đúng một bản", async () => {
    const w = await world();
    const { planId, hash } = await goalPlanSubmitted(w);
    await call("decidePlan", OWNER, { params: { id: planId }, body: { version: 1, content_hash: hash, decision: "APPROVE" } });
    // hai việc kết thúc: một hoàn tất bằng đường M1 thật (đầu ra → duyệt), một bị hủy
    const tasks = await db.query<any>(`SELECT id,plan_task_key FROM tasks WHERE plan_id=$1 AND plan_task_key IS NOT NULL ORDER BY plan_task_key`, [planId]);
    const { submitOutput, decide } = await import("./core");
    for (const t of tasks) await db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at='${clock.toISOString()}',acked_at='${clock.toISOString()}' WHERE task_id=$1 AND state='PENDING'`, [t.id]);
    const [r1] = await db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [tasks[0].id]);
    await db.query(`UPDATE tasks SET status='RUNNING' WHERE id=$1`, [tasks[0].id]);
    const o: any = await submitOutput(db, { taskId: tasks[0].id, runId: r1.id, actorRef: w.bot.actorRef, content: "Đầu ra", idempotencyKey: "k1", now: tick(5) });
    await decide(db, { actorRef: OWNER.actorRef, outputId: o.output.id, objectVersion: 1, decision: "APPROVE", channel: "WEB", now: tick(6) });
    await call("transition", OWNER, { params: { id: tasks[1].id }, body: { to: "CANCELLED", expected_status: "QUEUED", reason: "không cần" } });
    const ticks = await Promise.all(Array.from({ length: 4 }, () => planTick(db, tick(10), { hermesMode: "simulated" })));
    assert.ok(ticks.every((t) => "evaluated" in t || "skipped" in t), JSON.stringify(ticks));
    await planTick(db, tick(11), { hermesMode: "simulated" });
    const runsDone = await db.query<any>(`SELECT r.id FROM lumi_task_runs r JOIN tasks k ON k.id=r.task_id WHERE k.plan_id=$1 AND r.state IN ('SUCCEEDED','CANCELLED','FAILED','TIMED_OUT')`, [planId]);
    const booked = await db.query<any>(`SELECT idempotency_key FROM lumi_ledger_entries WHERE plan_id=$1 AND idempotency_key LIKE 'run:%'`, [planId]);
    assert.equal(booked.length, runsDone.length);
    assert.equal(new Set(booked.map((x: any) => x.idempotency_key)).size, booked.length);
    await invariants(planId);
    const [pl] = await db.query<any>(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]);
    assert.equal(pl.status, "PARTIAL_DONE");
    assert.equal((await db.query(`SELECT 1 FROM lumi_reports WHERE plan_id=$1 AND kind='FINAL'`, [planId])).length, 1);
    const [bud] = await db.query<any>(`SELECT committed FROM lumi_budgets WHERE plan_id=$1 AND kind='EXECUTE'`, [planId]);
    assert.equal(Number(bud.committed), 0);
  });
});
