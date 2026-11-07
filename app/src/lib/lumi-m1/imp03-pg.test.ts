/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-03 — evidence class B (TDD 14.9): a REAL PostgreSQL server process, many real connections, the real migrations 0000..0046.
 * Proves the HTTP contract by role, concurrent handoffs/acceptances/dependency changes/appointments, and the three new MCP tools across genuinely
 * separate sessions. Hermes is simulated; no model is called.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { decide, submitOutput, type Db } from "./core";
import { createTask } from "./core-web";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { handleRpc } from "./mcp";
import { SimulatedHermes } from "./hermes-port";
import { createAssistant } from "./assistants";
import { setPolicy } from "./policies";
import { addDependency, proposeHandoff, respondHandoff } from "./coordination";
import { createAppointment, createRole, transferAppointment } from "./roster";

let srv: PgServer; let db: Db;
let tick = 0;
const T0 = new Date("2026-11-08T08:00:00Z");
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const BOT: Principal = { kind: "bot", slug: "x", actorRef: "bot:x" };
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });
const ctx = (): ApiCtx => ({ db, hermes: new SimulatedHermes(), now });
const call = (name: string, p: Principal | null, o: { params?: Record<string, string>; body?: any; key?: string } = {}) => handle(name, ctx(), { principal: p, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 200 };
const OWNER_REF = "web:owner@test";

async function world() {
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${uniq()}`, `Dự án ${uniq()}`]);
  const mk = async (tag: string, level = 2) => {
    const slug = `${tag}-${uniq()}`.slice(0, 20);
    const a = (await createAssistant(db, { actorRef: OWNER_REF, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=$2 WHERE id=$1`, [a.id, level]);
    return a;
  };
  return { p: proj.id as string, aff: await mk("aff"), yt: await mk("yt") };
}
type W = Awaited<ReturnType<typeof world>>;
const task = async (w: W, assignee: any) => (await createTask(db, { actorRef: OWNER_REF, clientRequestId: `ct-${uniq()}-00000001`, projectId: w.p, assigneeId: assignee.id, title: `Việc ${uniq()}`, description: "mô tả", now: now() })).task;
const open = async (taskId: string) => (await db.query<any>(`SELECT id,state FROM lumi_task_runs WHERE task_id=$1 AND state IN ('PENDING','DISPATCHED','DISPATCH_UNCERTAIN','RUNNING') ORDER BY created_at`, [taskId]));
/** drive the pending run of a task to an owner-approved output (same calls the worker and the owner's screen make) */
async function finish(t: any, slug: string) {
  const [run] = await db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1 AND state IN ('PENDING','RUNNING')`, [t.id]);
  await db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=now(),acked_at=now() WHERE id=$1`, [run.id]);
  await db.query(`UPDATE tasks SET status='RUNNING' WHERE id=$1`, [t.id]);
  const o: any = await submitOutput(db, { taskId: t.id, runId: run.id, actorRef: `bot:${slug}`, content: "Đầu ra", idempotencyKey: `out-${t.id}`, now: now() });
  await decide(db, { actorRef: OWNER_REF, outputId: o.output.id, objectVersion: o.output.version, decision: "APPROVE", channel: "WEB", now: now() });
}
const rpc = (bot: any, name: string, args: any) => handleRpc(ctx(), bot, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).then((r: any) => r.result);

before(async () => {
  srv = await startPgServer(); db = postgresDb(srv.sql);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  await setPolicy(db, { actorRef: OWNER_REF, key: "handoff_max_depth", value: 3, now: now() });
  await setPolicy(db, { actorRef: OWNER_REF, key: "handoff_max_rounds", value: 2, now: now() });
});
after(async () => {
  await srv.stop();
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});

describe("IMP-03 trên PostgreSQL server thật", () => {
  it("1. hợp đồng HTTP theo vai trò: bot 403 ở mọi route mới; VIEWER/ADMIN không ghi các thao tác của Chủ; chưa đăng nhập 401; đọc được cho người đăng nhập", async () => {
    const w = await world(); const t1 = await task(w, w.aff); const t2 = await task(w, w.aff);
    const role = (await createRole(db, { actorRef: OWNER_REF, name: `Vai ${uniq()}`, now: now() })).role;
    const ownerOnly: [string, any][] = [
      ["createRole", { body: { name: "Vai thử nghiệm" } }],
      ["archiveRole", { params: { id: role.id }, body: {} }],
      ["createAppointment", { body: { role_id: role.id, assistant_id: w.aff.id } }],
      ["setSkill", { params: { id: w.aff.id }, body: { skill: "Viết", state: "UNVERIFIED" } }],
      ["setExecutionLevel", { params: { id: w.aff.id }, body: { level: 1 } }],
      ["setPmAuto", { params: { id: w.p }, body: { on: true } }],
      ["reopenTask", { params: { id: t1.id }, body: { reason: "đổi đầu vào" } }],
      ["clearRecheck", { params: { id: t1.id }, body: {} }],
      ["decideChange", { params: { id: "00000000-0000-0000-0000-000000000001" }, body: { decision: "APPROVE" } }],
      ["decideBotCase", { params: { id: "00000000-0000-0000-0000-000000000001" }, body: { decision: "APPROVE" } }],
    ];
    for (const [name, o] of ownerOnly) {
      assert.equal((await call(name, BOT, o)).status, 403, `bot ${name}`);
      assert.equal((await call(name, VIEWER, o)).status, 403, `viewer ${name}`);
      assert.equal((await call(name, ADMIN, o)).status, 403, `admin ${name}`);
      assert.equal((await call(name, null, o)).status, 401, `anon ${name}`);
    }
    // dependencies / handoff cancel: OWNER or ADMIN; never VIEWER or a bot
    for (const [name, o] of [["addDependency", { params: { id: t1.id }, body: { depends_on_task_id: t2.id } }], ["createBotCase", { body: {} }]] as [string, any][]) {
      assert.equal((await call(name, BOT, o)).status, 403, `bot ${name}`);
      assert.equal((await call(name, VIEWER, o)).status, 403, `viewer ${name}`);
      assert.equal((await call(name, null, o)).status, 401, `anon ${name}`);
    }
    assert.equal((await call("addDependency", ADMIN, { params: { id: t1.id }, body: { depends_on_task_id: t2.id } })).status, 201);
    for (const who of [VIEWER, ADMIN, OWNER]) {
      assert.equal((await call("listRoster", who)).status, 200);
      assert.equal((await call("listChanges", who)).status, 200);
      assert.equal((await call("taskCoordination", who, { params: { id: t1.id } })).status, 200);
      assert.equal((await call("evaluateStaff", who, { body: { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" } })).status, 200);
    }
    for (const r of ["listRoster", "listChanges"]) assert.equal((await call(r, BOT)).status, 403, `bot ${r}`);
    const ev = await call("evaluateStaff", OWNER, { body: { from: "2026-12-01T00:00:00Z", to: "2026-11-01T00:00:00Z" } });
    assert.equal(ev.status, 400);
    const bad = await call("proposeHandoff", OWNER, { params: { id: t1.id }, body: { to_assistant_id: w.yt.id, title: "Làm gì đó", request: "Yêu cầu" } });
    assert.equal(bad.status, 400, "thiếu Idempotency-Key");
  });

  it("2. 6 yêu cầu bàn giao CÙNG khóa từ 6 kết nối ⇒ đúng một bàn giao và một việc nhận; khác khóa nhưng cùng người gửi ⇒ mỗi bàn giao một việc riêng", async () => {
    const w = await world(); const src = await task(w, w.aff);
    const key = `ho-${uniq()}-same`;
    const same = await Promise.all(Array.from({ length: 6 }, () => call("proposeHandoff", OWNER, { params: { id: src.id }, key, body: { to_assistant_id: w.yt.id, title: "Làm nội dung", request: "Dùng hồ sơ đã chấp nhận" } })));
    assert.ok(same.every((r) => r.status === 201 || r.status === 200), JSON.stringify(same.map((r) => [r.status, r.error?.code])));
    assert.equal(new Set(same.map((r) => r.data.handoff.id)).size, 1);
    assert.equal(same.filter((r) => r.status === 201).length, 1, "đúng một yêu cầu tạo mới");
    assert.equal((await db.query(`SELECT 1 FROM lumi_handoffs WHERE source_task_id=$1`, [src.id])).length, 1);
    const [h] = await db.query<any>(`SELECT * FROM lumi_handoffs WHERE source_task_id=$1`, [src.id]);
    assert.equal((await db.query<any>(`SELECT status::text AS s,hold_reason FROM tasks WHERE id=$1`, [h.new_task_id]))[0].s, "ON_HOLD");
    assert.equal((await open(h.new_task_id)).length, 0, "việc nhận bị giữ: chưa có lượt chạy nào");
  });

  it("3. nhiều bên cùng trả lời một bàn giao: ACCEPT đồng thời ⇒ một sự kiện; sau đó REJECT bị từ chối; việc nhận được giải phóng đúng MỘT lần khi đầu ra phía trên được duyệt", async () => {
    const w = await world(); const src = await task(w, w.aff);
    const r = (await proposeHandoff(db, { sourceTaskId: src.id, toAssistantId: w.yt.id, title: "Làm nội dung", request: "Dùng hồ sơ", by: { actorRef: OWNER_REF }, idempotencyKey: `ho-${uniq()}-k1`, now: now() }));
    const ho = r.handoff; const rt = r.task;
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => respondHandoff(db, { botAssistantId: w.yt.id, actorRef: `bot:${w.yt.slug}`, handoffCode: ho.code, decision: "ACCEPT", now: now() })));
    assert.ok(rs.every((x) => x.status === "fulfilled"), JSON.stringify(rs.filter((x) => x.status === "rejected")));
    assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM lumi_handoff_events WHERE handoff_id=$1 AND event_type='ACCEPTED'`, [ho.id]))[0].n, 1);
    await assert.rejects(respondHandoff(db, { botAssistantId: w.yt.id, actorRef: `bot:${w.yt.slug}`, handoffCode: ho.code, decision: "REJECT", text: "đổi ý", now: now() }), (e: any) => e.code === "INVALID_TRANSITION");
    await assert.rejects(respondHandoff(db, { botAssistantId: w.aff.id, actorRef: `bot:${w.aff.slug}`, handoffCode: ho.code, decision: "ACCEPT", now: now() }), (e: any) => e.code === "FORBIDDEN");
    await finish(src, w.aff.slug);
    assert.equal((await open(rt.id)).length, 1, "việc nhận có đúng một lượt chạy sau khi đầu ra phía trên được duyệt");
    const outId = (await db.query<any>(`SELECT current_output_id FROM tasks WHERE id=$1`, [src.id]))[0].current_output_id;
    await Promise.allSettled([1, 2, 3].map(() => decide(db, { actorRef: OWNER_REF, outputId: outId, objectVersion: 1, decision: "APPROVE", channel: "WEB", now: now() })));
    assert.equal((await open(rt.id)).length, 1, "duyệt lặp lại không tạo lượt chạy thứ hai");
  });

  it("4. phụ thuộc đồng thời: hai việc phía trên được duyệt cùng lúc ⇒ việc phía sau đúng MỘT lượt chạy; 3 cạnh khép vòng gửi cùng lúc ⇒ đúng một cạnh bị DEP_CYCLE", async () => {
    const w = await world(); const u1 = await task(w, w.aff); const u2 = await task(w, w.aff); const d = await task(w, w.yt);
    await addDependency(db, { actorRef: OWNER_REF, taskId: d.id, dependsOnId: u1.id, now: now() });
    await addDependency(db, { actorRef: OWNER_REF, taskId: d.id, dependsOnId: u2.id, now: now() });
    await Promise.all([finish(u1, w.aff.slug), finish(u2, w.aff.slug)]);
    assert.equal((await open(d.id)).length, 1, JSON.stringify(await open(d.id)));
    const a = await task(w, w.aff); const b = await task(w, w.aff); const c = await task(w, w.aff);
    const res = await Promise.allSettled([
      addDependency(db, { actorRef: OWNER_REF, taskId: a.id, dependsOnId: b.id, now: now() }),
      addDependency(db, { actorRef: OWNER_REF, taskId: b.id, dependsOnId: c.id, now: now() }),
      addDependency(db, { actorRef: OWNER_REF, taskId: c.id, dependsOnId: a.id, now: now() }),
    ]);
    const okN = res.filter((x) => x.status === "fulfilled").length;
    const cyc = res.filter((x) => x.status === "rejected" && (x as any).reason?.code === "DEP_CYCLE").length;
    assert.deepEqual([okN, cyc], [2, 1], JSON.stringify(res.map((x) => x.status === "rejected" ? (x as any).reason?.code : "ok")));
    assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM lumi_task_deps WHERE task_id = ANY($1::uuid[])`, [[a.id, b.id, c.id]]))[0].n, 2, "không có vòng trong DB");
  });

  it("5. bổ nhiệm đồng thời: 6 yêu cầu cùng (vai, bot, phạm vi) ⇒ đúng một ACTIVE, còn lại ALREADY_APPOINTED; chuyển vai đồng thời ⇒ đúng một bản mới", async () => {
    const w = await world();
    const role = (await createRole(db, { actorRef: OWNER_REF, name: `Vai đua ${uniq()}`, now: now() })).role;
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => createAppointment(db, { actorRef: OWNER_REF, input: { roleId: role.id, assistantId: w.aff.id }, now: now() })));
    assert.equal(rs.filter((x) => x.status === "fulfilled").length, 1);
    assert.ok(rs.filter((x) => x.status === "rejected").every((x) => (x as any).reason?.code === "ALREADY_APPOINTED"), JSON.stringify(rs.map((x) => x.status === "rejected" ? (x as any).reason?.code : "ok")));
    const ap = (rs.find((x) => x.status === "fulfilled") as any).value.appointment;
    const tr = await Promise.allSettled(Array.from({ length: 4 }, () => transferAppointment(db, { actorRef: OWNER_REF, id: ap.id, toAssistantId: w.yt.id, now: now() })));
    assert.equal(tr.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(tr.map((x) => x.status === "rejected" ? (x as any).reason?.code : "ok")));
    assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM lumi_appointments WHERE role_id=$1 AND state='ACTIVE'`, [role.id]))[0].n, 1);
  });

  it("6. công cụ MCP: bàn giao qua ứng dụng (bot nhận phải trả lời trong lượt của việc được giao); bot mức thấp bị từ chối; lượt của bot khác không dùng được; PM đề xuất đổi người", async () => {
    const w = await world();
    const slug = `low-${uniq()}`.slice(0, 20);
    const low = (await createAssistant(db, { actorRef: OWNER_REF, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=0 WHERE id=$1`, [low.id]);
    const running = async (t: any) => { const [r] = await open(t.id); await db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=now(),acked_at=now() WHERE id=$1`, [r.id]); return r.id as string; };
    const bot = (a: any): any => ({ kind: "bot", slug: a.slug, actorRef: `bot:${a.slug}` });
    const src = await task(w, w.aff); const srcRun = await running(src);
    const args = { run_id: srcRun, to: w.yt.slug, title: "Làm nội dung", request: "Dùng hồ sơ đã chấp nhận" };
    const foreign = await rpc(bot(w.yt), "handoff_propose", args);
    assert.equal(foreign.isError, true); assert.match(foreign.content[0].text, /Không tìm thấy lượt chạy/);
    const ok1 = await rpc(bot(w.aff), "handoff_propose", args);
    assert.equal(ok1.isError, false, ok1.content[0].text); assert.match(ok1.content[0].text, /HO-\d+/);
    assert.match((await rpc(bot(w.aff), "handoff_propose", args)).content[0].text, /đã tạo trước đó/);
    assert.equal((await db.query(`SELECT 1 FROM lumi_handoffs WHERE source_task_id=$1`, [src.id])).length, 1);
    const [h] = await db.query<any>(`SELECT * FROM lumi_handoffs WHERE source_task_id=$1`, [src.id]);
    const lowTask = await task(w, low); const lowRun = await running(lowTask);
    const denied = await rpc(bot(low), "handoff_propose", { ...args, run_id: lowRun });
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /LEVEL_TOO_LOW/);
    // the sender finishes and the owner approves => the receiver's run opens; only the receiver, only inside that run, may answer
    await finish(src, w.aff.slug);
    const recvRun = await running({ id: h.new_task_id });
    const other = await task(w, w.aff); const otherRun = await running(other);
    assert.equal((await rpc(bot(w.aff), "handoff_respond", { run_id: otherRun, handoff_code: h.code, decision: "ACCEPT" })).isError, true, "bot khác / lượt khác không trả lời được");
    assert.equal((await rpc(bot(w.yt), "handoff_respond", { run_id: recvRun, handoff_code: h.code, decision: "REJECT" })).isError, true, "REJECT cần lý do");
    const yes = await rpc(bot(w.yt), "handoff_respond", { run_id: recvRun, handoff_code: h.code, decision: "ACCEPT" });
    assert.equal(yes.isError, false, yes.content[0].text);
    assert.equal((await db.query<any>(`SELECT state FROM lumi_handoffs WHERE id=$1`, [h.id]))[0].state, "ACCEPTED");
    // PM proposals: only the PM of the project; the owner decides
    await db.query(`UPDATE lumi_projects SET pm_assistant_id=$2 WHERE id=$1`, [w.p, w.aff.id]);
    const tk = await task(w, w.yt); const tkRun = await running(tk);
    const pmRun = await running(await task(w, w.aff));
    const prop = await rpc(bot(w.aff), "pm_propose_reassign", { run_id: pmRun, task_code: tk.code, to: w.aff.slug, reason: "Aff đang rảnh" });
    assert.equal(prop.isError, false, prop.content[0].text);
    assert.equal((await db.query<any>(`SELECT state FROM lumi_change_proposals WHERE task_id=$1`, [tk.id]))[0].state, "PENDING");
    assert.equal((await db.query<any>(`SELECT owner_assistant_id FROM tasks WHERE id=$1`, [tk.id]))[0].owner_assistant_id, w.yt.id, "chưa đổi người khi Chủ chưa duyệt");
    const notPm = await rpc(bot(w.yt), "pm_propose_reassign", { run_id: tkRun, task_code: tk.code, to: w.aff.slug, reason: "Thử" });
    assert.equal(notPm.isError, true); assert.match(notPm.content[0].text, /NOT_PM/);
  });
});
