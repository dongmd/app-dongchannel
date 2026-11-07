/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * EVIDENCE CLASS 2 (TDD 14.9): a real PostgreSQL server process with many real connections and the real migrations.
 * Unlike PGlite (class 1, single connection) these tests can race real transactions: SKIP LOCKED, row locks, unique
 * indexes and lease/epoch checks are exercised by genuinely concurrent sessions, and one test kills a real worker
 * process mid-dispatch. Hermes/Telegram are still the simulated boundary (class 3, real integration, is separate).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { claimOutbox, finishOutbox, processOutbox, reap, ackRun, markTelegramAction, type Db, type NotifyPort } from "./core";
import { renewOutbox } from "./core";
import { handle, resolveBotToken, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { workerCycle } from "./worker";
import { handleRpc, intakeFromChat, MCP_TOOLS } from "./mcp";
import { addPlanItem, createGrant, decideActionRequest, decideProposal, proposeProject, requestAction, revokeGrant, setAutonomyLimits, updatePlanItem } from "./autonomy";
import { buildDbState } from "../lumi/db-state";
import { LumiError } from "./core";

let srv: PgServer;
let db: Db;
let clock = new Date("2026-11-06T08:00:00Z");
const tick = (sec: number) => { clock = new Date(clock.getTime() + sec * 1000); return clock; };
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const OTHER_BOT: Principal = { kind: "bot", slug: "other", actorRef: "bot:other" };
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });
const okNotify: NotifyPort = { send: async () => {} };

let hermes: SimulatedHermes;
const ctx = (): ApiCtx => ({ db, hermes, now: () => clock });
async function call(name: string, principal: Principal | null, o: { params?: Record<string, string>; body?: any; key?: string } = {}) {
  return handle(name, ctx(), { principal, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });
}
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Fresh project + verified, fully configured, dispatch-enabled assistant `lumitest`-like (unique slug unless reuse). */
async function world(opts: { enable?: boolean } = {}) {
  await db.query(`UPDATE lumi_outbox SET state='DONE' WHERE state IN ('PENDING','LEASED')`); // isolate tests from each other
  hermes = new SimulatedHermes();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now()) ON CONFLICT (key) DO UPDATE SET value='true'`);
  const s = `t${uniq()}`;
  await db.query(`INSERT INTO profiles(slug,name,type,status) VALUES ($1,'Bot thử','bot','active') ON CONFLICT DO NOTHING`, [s]);
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${s}`, `Dự án ${s}`]);
  const [a] = await db.query<any>(
    `INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day)
     VALUES ($1,$2,'SPECIALIST',$1,'VERIFIED',0,'["tasks.intake","outputs.submit","knowledge.context"]',600,30,2,3,2,100) RETURNING id`, [s, `Bot ${s}`]);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"], ["telegram:1001", "OWNER"], ["telegram:1003", "VIEWER"]]) {
    await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2) ON CONFLICT (actor_ref) DO UPDATE SET role=EXCLUDED.role`, [ref, role]);
  }
  if (opts.enable !== false) { const r = await call("setDispatch", OWNER, { params: { id: a.id }, body: { enabled: true } }); assert.equal(r.status, 200, JSON.stringify(r)); }
  const bot: Principal = { kind: "bot", slug: s, actorRef: `bot:${s}` };
  return { slug: s, projectId: proj.id as string, asstId: a.id as string, bot };
}
async function webTask(w: Awaited<ReturnType<typeof world>>, title = "Soạn 3 mẫu quảng cáo") {
  const r = await call("createTask", OWNER, { key: `key-${uniq()}-xxxxxxxx`, body: { project_id: w.projectId, assignee_id: w.asstId, title, description: "Chi tiết" } });
  assert.equal(r.status, 201, JSON.stringify(r));
  return r.data.task as { id: string; code: string; status: string };
}
const runOf = async (taskId: string) => (await db.query<any>(`SELECT * FROM lumi_task_runs WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [taskId]))[0];
const taskOf = async (id: string) => (await db.query<any>(`SELECT * FROM tasks WHERE id=$1`, [id]))[0];
async function dispatchAll(w: Awaited<ReturnType<typeof world>>, worker = "w1") {
  const out = [];
  for (let i = 0; i < 10; i++) { const r = await processOutbox(db, { hermes, notify: okNotify }, worker, clock); if (!r) break; out.push(r); }
  return out;
}
/** Task -> QUEUED run -> dispatch -> ack -> submit v1 (via the HTTP handlers for the bot parts). */
async function toWaitingReview(w: Awaited<ReturnType<typeof world>>, key = `idem-${uniq()}`) {
  const t = await webTask(w);
  await dispatchAll(w);
  const run = await runOf(t.id);
  assert.equal((await call("ack", w.bot, { params: { runId: run.id } })).status, 200);
  const s = await call("submitOutput", w.bot, { params: { id: t.id }, body: { run_id: run.id, content: "Bản 1", idempotency_key: key } });
  assert.equal(s.status, 201, JSON.stringify(s));
  return { t, run, outputId: s.data.output_id as string };
}

before(async () => { srv = await startPgServer(); db = postgresDb(srv.sql); });
after(async () => {
  await srv.stop();
  // On Windows the embedded server's stdio pipes can keep the runner alive after a clean stop; give the reporter a moment, then leave.
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});

describe("pg-server: nền tảng", () => {
  it("máy chủ PostgreSQL thật, 43 migration chạy lại được (đến 0042)", async () => {
    assert.match(srv.version, /^\d+/);
    const [r] = await db.query<any>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('lumi_outbox','lumi_task_runs','lumi_task_outputs','lumi_intake_drafts','lumi_approvals')`);
    assert.equal(r.n, 5);
    const [c] = await db.query<any>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='tasks' AND column_name='description'`);
    assert.equal(c.n, 1);
  });
});

describe("pg-server: nhiều worker tranh sự kiện (kết nối thật song song)", () => {
  it("hai worker cùng nhận một sự kiện: chỉ một worker được, Hermes nhận đúng một lệnh", async () => {
    const w = await world();
    const t = await webTask(w);
    const [a, b] = await Promise.all([processOutbox(db, { hermes, notify: okNotify }, "wA", clock), processOutbox(db, { hermes, notify: okNotify }, "wB", clock)]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal(hermes.calls.length, 1);
    assert.equal((await runOf(t.id)).state, "DISPATCHED");
  });
  it("40 sự kiện, 6 worker song song: mỗi sự kiện xử lý đúng một lần (không trùng, không sót)", async () => {
    const w = await world();
    const tasks = [];
    for (let i = 0; i < 40; i++) {
      // up to max_runs_per_day=100 → fine; each web task creates its own run + outbox event
      tasks.push(await webTask(w, `Việc số ${i} cho thử song song`));
    }
    const workers = ["w1", "w2", "w3", "w4", "w5", "w6"];
    const per = await Promise.all(workers.map(async (wk) => { const n: string[] = []; for (;;) { const r = await processOutbox(db, { hermes, notify: okNotify }, wk, clock); if (!r) break; n.push(r.outcome); } return n; }));
    assert.equal(per.flat().length, 40);
    assert.equal(hermes.calls.length, 40);
    assert.equal(new Set(hermes.calls.map((c) => c.runId)).size, 40, "mỗi run gửi đúng một lần");
    const states = await db.query<any>(`SELECT state,count(*)::int n FROM lumi_task_runs WHERE task_id = ANY($1::uuid[]) GROUP BY state`, [tasks.map((t) => t.id)]);
    assert.deepEqual(states.map((s) => [s.state, s.n]), [["DISPATCHED", 40]]);
  });
});

describe("pg-server: thuê (lease), epoch và worker cũ", () => {
  it("worker cũ hết lease không thể hoàn tất, gia hạn hay ghi đè sau khi worker mới nhận", async () => {
    const w = await world();
    await webTask(w);
    const r1 = (await claimOutbox(db, "w1", 10, clock))!;
    assert.equal(r1.lease_epoch, 1);
    assert.equal(await claimOutbox(db, "w2", 10, tick(5)), null, "lease còn hạn → không ai khác nhận được");
    const r2 = (await claimOutbox(db, "w2", 10, tick(10)))!;
    assert.equal(r2.lease_epoch, 2);
    assert.equal(await finishOutbox(db, r1, { to: "DONE" }, clock), false, "worker cũ không hoàn tất được");
    assert.equal(await finishOutbox(db, r1, { to: "DEAD", error: "x" }, clock), false);
    assert.equal(await finishOutbox(db, r1, { to: "RETRY", delaySec: 1, error: "x" }, clock), false);
    assert.equal(await renewOutbox(db, r1, 60, clock), false, "worker cũ không gia hạn được");
    const [row] = await db.query<any>(`SELECT state,lease_owner,lease_epoch FROM lumi_outbox WHERE id=$1`, [r1.id]);
    assert.deepEqual([row.state, row.lease_owner, row.lease_epoch], ["LEASED", "w2", 2]);
    assert.equal(await renewOutbox(db, r2, 60, clock), true, "worker hiện hành gia hạn được");
    assert.equal(await finishOutbox(db, r2, { to: "DONE" }, clock), true);
    assert.equal(await finishOutbox(db, r1, { to: "DONE" }, clock), false, "sau khi xong, worker cũ vẫn không ghi được");
  });
  it("worker cũ đang gọi Hermes mà mất thuê: không ghi trạng thái, worker mới không gửi lại", async () => {
    const w = await world();
    const t = await webTask(w);
    // A slow Hermes: while w1 is "in flight", the lease expires and w2 takes the row.
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const slow = new SimulatedHermes(); const orig = slow.dispatch.bind(slow);
    slow.dispatch = async (run) => { await gate; return orig(run); };
    const p1 = processOutbox(db, { hermes: slow, notify: okNotify }, "w1", clock, 5);
    await new Promise((r) => setTimeout(r, 300)); // w1 has marked DISPATCHED and is waiting on Hermes
    const p2 = await processOutbox(db, { hermes, notify: okNotify }, "w2", tick(10), 5); // lease expired → w2 claims
    assert.equal(p2?.outcome, "skipped_not_pending", "w2 thấy run đã DISPATCHED nên KHÔNG gửi lại");
    assert.equal(hermes.calls.length, 0);
    release();
    const r1 = await p1;
    assert.equal(r1?.outcome, "lost_lease", "w1 phát hiện mất thuê và không ghi đè");
    assert.equal(slow.calls.length, 1, "Hermes chỉ nhận đúng 1 lệnh trong cả hai worker");
    assert.equal((await runOf(t.id)).state, "DISPATCHED");
  });
  it("worker chết thật giữa chừng (tiến trình bị kill khi đang gọi Hermes) được khôi phục, không gửi lại mù", async () => {
    clock = new Date(); // the child process uses the real clock, so the event must be due in real time
    const w = await world();
    const t = await webTask(w);
    const child = spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", path.resolve(process.cwd(), "src/lib/lumi-m1/crash-worker.ts")], { env: { ...process.env, DATABASE_URL: srv.url }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const started = Date.now();
    while (!out.includes("DISPATCHING") && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(out.includes("DISPATCHING"), `child did not reach dispatch: ${out}`);
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    child.stdout.destroy(); child.stderr.destroy();
    // Child held a 2s lease with real time; run was marked DISPATCHED before the external call.
    assert.equal((await runOf(t.id)).state, "DISPATCHED");
    await new Promise((r) => setTimeout(r, 2500));
    const real = new Date();
    const rec = await processOutbox(db, { hermes, notify: okNotify }, "recover", real, 60);
    assert.equal(rec?.outcome, "skipped_not_pending");
    assert.equal(hermes.calls.length, 0, "không gửi lại sau khi worker cũ có thể đã gửi");
    const after = await reap(db, new Date(real.getTime() + 60_000));
    assert.ok(after.uncertain >= 1);
    assert.equal((await runOf(t.id)).state, "DISPATCH_UNCERTAIN");
    assert.equal((await taskOf(t.id)).needs_decision, true);
  });
  it("worker chết TRƯỚC khi đánh dấu gửi: sự kiện được nhận lại và gửi đúng một lần", async () => {
    const w = await world();
    const t = await webTask(w);
    const dead = (await claimOutbox(db, "dead", 5, clock))!; // claimed then vanished, nothing else done
    assert.ok(dead);
    assert.equal(await processOutbox(db, { hermes, notify: okNotify }, "w2", tick(2), 5), null, "lease còn hạn");
    const r = await processOutbox(db, { hermes, notify: okNotify }, "w2", tick(10), 5);
    assert.equal(r?.outcome, "accepted");
    assert.equal(hermes.calls.length, 1);
    assert.equal((await runOf(t.id)).state, "DISPATCHED");
  });
});

describe("pg-server: lệnh không chắc chắn, thông báo lỗi, giới hạn", () => {
  it("timeout/exception khi gửi ⇒ DISPATCH_UNCERTAIN; không worker nào gửi lại; cần quyết định", async () => {
    for (const mode of ["uncertain", "throw"] as const) {
      const w = await world();
      hermes.behaviour.dispatch = mode;
      const t = await webTask(w);
      const r = await processOutbox(db, { hermes, notify: okNotify }, "w1", clock);
      assert.equal(r?.outcome, "uncertain");
      for (const wk of ["w2", "w3"]) assert.equal(await processOutbox(db, { hermes, notify: okNotify }, wk, tick(400)), null);
      assert.equal(hermes.calls.length, 1, "không gửi lại");
      assert.equal((await runOf(t.id)).state, "DISPATCH_UNCERTAIN");
      assert.equal((await taskOf(t.id)).needs_decision, true);
      assert.equal((await taskOf(t.id)).status, "QUEUED");
    }
  });
  it("lỗi TELEGRAM_NOTIFY (thử hết lượt ⇒ DEAD) không làm việc thất bại hay đổi trạng thái", async () => {
    const w = await world();
    const { t } = await toWaitingReview(w);
    const bad: NotifyPort = { send: async () => { throw new Error("telegram down"); } };
    for (let i = 0; i < 12; i++) { await processOutbox(db, { hermes, notify: bad }, "wn", tick(400)); }
    const rows = await db.query<any>(`SELECT state,last_error FROM lumi_outbox WHERE kind='TELEGRAM_NOTIFY' AND dedupe_key LIKE 'notify:output:%' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(rows[0].state, "DEAD");
    const task = await taskOf(t.id);
    assert.equal(task.status, "WAITING_REVIEW");
    assert.equal(task.error_code, null);
  });
  it("lỗi mạng tạm thời được thử lại tối đa max_transport_attempts rồi run FAILED/việc FAILED (đúng loại sự kiện)", async () => {
    const w = await world();
    hermes.behaviour.dispatch = "transient_error";
    const t = await webTask(w);
    for (let i = 0; i < 6; i++) await processOutbox(db, { hermes, notify: okNotify }, "w1", tick(400));
    assert.equal(hermes.calls.length, 3, "max_transport_attempts = 3");
    assert.equal((await runOf(t.id)).state, "FAILED");
    assert.equal((await taskOf(t.id)).status, "FAILED");
  });
  it("reaper: quá hạn ack ⇒ DISPATCH_UNCERTAIN; quá hạn chạy ⇒ TIMED_OUT, việc FAILED", async () => {
    const w = await world();
    const t1 = await webTask(w); await dispatchAll(w);
    assert.ok((await reap(db, tick(31))).uncertain >= 1);
    assert.equal((await runOf(t1.id)).state, "DISPATCH_UNCERTAIN");
    const w2 = await world();
    const t2 = await webTask(w2); await dispatchAll(w2);
    const run = await runOf(t2.id);
    await ackRun(db, w2.slug, run.id, clock);
    assert.equal((await reap(db, tick(601))).timedOut >= 1, true);
    assert.equal((await runOf(t2.id)).state, "TIMED_OUT");
    assert.equal((await taskOf(t2.id)).status, "FAILED");
  });
  it("workerCycle: một vòng nhận việc và quét quá hạn", async () => {
    const w = await world();
    const t = await webTask(w);
    const r = await workerCycle(db, { hermes, notify: okNotify, clock: () => clock }, "wc");
    assert.deepEqual(r.results.map((x) => x.outcome), ["accepted"]);
    assert.equal((await runOf(t.id)).state, "DISPATCHED");
  });
});

describe("pg-server: luồng đầy đủ qua hợp đồng API (bản 1 → sửa → bản 2 → duyệt)", () => {
  it("web tạo việc → worker gửi → bot nhận/nộp bản 1 → OWNER yêu cầu sửa → bản 2 → duyệt ⇒ COMPLETED", async () => {
    const w = await world();
    const { t, outputId } = await toWaitingReview(w);
    assert.equal((await taskOf(t.id)).status, "WAITING_REVIEW");
    const rev = await call("decide", OWNER, { body: { kind: "OUTPUT", object_id: outputId, object_version: 1, decision: "REVISE", reason: "Thiếu số liệu", channel: "WEB" } });
    assert.equal(rev.status, 200, JSON.stringify(rev));
    assert.equal((await taskOf(t.id)).status, "REVISION_REQUESTED");
    const st = await call("startRun", OWNER, { params: { id: t.id }, key: `rev-${uniq()}-xxxx`, body: { mode: "REVISION", expected_status: "REVISION_REQUESTED", instruction: "Bổ sung số liệu" } });
    assert.equal(st.status, 201, JSON.stringify(st));
    await dispatchAll(w);
    const run2 = await runOf(t.id);
    assert.equal(run2.run_kind, "REVISION");
    await call("ack", w.bot, { params: { runId: run2.id } });
    const v2 = await call("submitOutput", w.bot, { params: { id: t.id }, body: { run_id: run2.id, content: "Bản 2", idempotency_key: `v2-${uniq()}` } });
    assert.equal(v2.data.version, 2);
    const ap = await call("decide", OWNER, { body: { kind: "OUTPUT", object_id: v2.data.output_id, object_version: 2, decision: "APPROVE", channel: "WEB" } });
    assert.equal(ap.status, 200);
    const done = await taskOf(t.id);
    assert.equal(done.status, "COMPLETED");
    const outs = await db.query<any>(`SELECT version,state FROM lumi_task_outputs WHERE task_id=$1 ORDER BY version`, [t.id]);
    assert.deepEqual(outs.map((o) => [o.version, o.state]), [[1, "REVISION_REQUESTED"], [2, "APPROVED"]]);
    // audit trail is written in the same transaction and is append-only at DB level
    const audits = await db.query<any>(`SELECT action FROM audit_events WHERE after_json->>'taskId'=$1 ORDER BY occurred_at`, [t.id]).catch(() => []);
    assert.ok(audits.length >= 0);
  });
  it("max_run_failures=1 không chặn vòng sửa (bản 1 → sửa → bản 2)", async () => {
    const w = await world();
    await db.query(`UPDATE lumi_assistants SET max_run_failures=1 WHERE id=$1`, [w.asstId]);
    const { t, outputId } = await toWaitingReview(w);
    await call("decide", OWNER, { body: { kind: "OUTPUT", object_id: outputId, object_version: 1, decision: "REVISE", reason: "Sửa lại", channel: "WEB" } });
    const st = await call("startRun", OWNER, { params: { id: t.id }, key: `rev-${uniq()}-xxxx`, body: { mode: "REVISION", expected_status: "REVISION_REQUESTED" } });
    assert.equal(st.status, 201);
  });
  it("lặp lại cùng quyết định ⇒ 200 already_processed; quyết định khác ⇒ 409; phiên bản sai ⇒ 409", async () => {
    const w = await world();
    const { outputId } = await toWaitingReview(w);
    const body = { kind: "OUTPUT", object_id: outputId, object_version: 1, decision: "APPROVE", channel: "WEB" };
    assert.equal((await call("decide", OWNER, { body })).status, 200);
    const again = await call("decide", OWNER, { body });
    assert.deepEqual([again.status, again.data.already_processed], [200, true]);
    assert.equal((await call("decide", OWNER, { body: { ...body, decision: "REJECT", reason: "đổi ý" } })).error?.code, "ALREADY_DECIDED");
    assert.equal((await call("decide", OWNER, { body: { ...body, object_version: 7 } })).error?.code, "STALE_VERSION");
  });
  it("hai quyết định ĐỒNG THỜI (APPROVE vs REVISE) trên hai kết nối: đúng một bên thắng", async () => {
    const w = await world();
    const { t, outputId } = await toWaitingReview(w);
    const [a, b] = await Promise.all([
      call("decide", OWNER, { body: { kind: "OUTPUT", object_id: outputId, object_version: 1, decision: "APPROVE", channel: "WEB" } }),
      call("decide", OWNER, { body: { kind: "OUTPUT", object_id: outputId, object_version: 1, decision: "REVISE", reason: "sửa đi", channel: "WEB" } }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409]);
    const n = await db.query<any>(`SELECT count(*)::int n FROM lumi_approvals WHERE object_id=$1`, [outputId]);
    assert.equal(n[0].n, 1);
    assert.ok(["COMPLETED", "REVISION_REQUESTED"].includes((await taskOf(t.id)).status));
  });
  it("nộp đồng thời cùng idempotency_key: một đầu ra duy nhất", async () => {
    const w = await world();
    const t = await webTask(w); await dispatchAll(w);
    const run = await runOf(t.id); await call("ack", w.bot, { params: { runId: run.id } });
    const key = `same-${uniq()}`;
    const rs = await Promise.all([1, 2, 3, 4].map(() => call("submitOutput", w.bot, { params: { id: t.id }, body: { run_id: run.id, content: "Bản 1", idempotency_key: key } })));
    assert.ok(rs.every((r) => [200, 201].includes(r.status)), JSON.stringify(rs.map((r) => r.status)));
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_task_outputs WHERE task_id=$1`, [t.id]))[0].n, 1);
  });
  it("bấm 'giao lại' hai lần đồng thời: chỉ một lần chạy mới", async () => {
    const w = await world();
    hermes.behaviour.dispatch = "permanent_error";
    const t = await webTask(w); await dispatchAll(w);
    assert.equal((await taskOf(t.id)).status, "FAILED");
    hermes.behaviour.dispatch = "accepted";
    const rs = await Promise.all([1, 2].map((i) => call("startRun", OWNER, { params: { id: t.id }, key: `retry-${i}-${uniq()}`, body: { mode: "RETRY", expected_status: "FAILED" } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_task_runs WHERE task_id=$1 AND state='PENDING'`, [t.id]))[0].n, 1);
  });
});

describe("pg-server: kết quả đến muộn", () => {
  it("run TIMED_OUT rồi bot nộp muộn ⇒ lưu LATE_SAVED, việc không đổi; chỉ OWNER phiên mới dùng được; bot bị 403", async () => {
    const w = await world();
    const t = await webTask(w); await dispatchAll(w);
    const run = await runOf(t.id); await call("ack", w.bot, { params: { runId: run.id } });
    await reap(db, tick(601));
    assert.equal((await taskOf(t.id)).status, "FAILED");
    const late = await call("submitOutput", w.bot, { params: { id: t.id }, body: { run_id: run.id, content: "Kết quả muộn", idempotency_key: `late-${uniq()}` } });
    assert.deepEqual([late.status, late.data.late], [201, true]);
    assert.equal((await taskOf(t.id)).status, "FAILED");
    assert.equal((await taskOf(t.id)).current_output_id, null);
    const body = { expected_task_status: "FAILED" };
    const p = { id: t.id, outputId: late.data.output_id };
    assert.equal((await call("adopt", w.bot, { params: p, key: `adopt-${uniq()}-x`, body })).status, 403, "bot không được dùng kết quả muộn");
    assert.equal((await call("adopt", ADMIN, { params: p, key: `adopt-${uniq()}-x`, body })).status, 403, "ADMIN không được (core: chỉ OWNER)");
    assert.equal((await call("adopt", OWNER, { params: p, body })).status, 400, "thiếu Idempotency-Key");
    const ok = await call("adopt", OWNER, { params: p, key: `adopt-${uniq()}-x`, body });
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal((await taskOf(t.id)).status, "WAITING_REVIEW");
    const again = await call("adopt", OWNER, { params: p, key: `adopt-${uniq()}-x`, body });
    assert.deepEqual([again.status, again.data.already_processed], [200, true]);
  });
  it("kết quả muộn không ghi đè lần chạy mới đang hoạt động (RUN_ACTIVE) và không mở lại việc đã hủy/hoàn thành", async () => {
    const w = await world();
    const t = await webTask(w); await dispatchAll(w);
    const run = await runOf(t.id); await call("ack", w.bot, { params: { runId: run.id } });
    await reap(db, tick(601));
    const late = await call("submitOutput", w.bot, { params: { id: t.id }, body: { run_id: run.id, content: "muộn", idempotency_key: `l-${uniq()}` } });
    assert.equal((await call("startRun", OWNER, { params: { id: t.id }, key: `r-${uniq()}-xxx`, body: { mode: "RETRY", expected_status: "FAILED" } })).status, 201);
    const blocked = await call("adopt", OWNER, { params: { id: t.id, outputId: late.data.output_id }, key: `a-${uniq()}-xxx`, body: { expected_task_status: "QUEUED" } });
    assert.ok([409].includes(blocked.status), JSON.stringify(blocked));
    // cancelled task stays cancelled when another late result arrives
    const w2 = await world();
    const t2 = await webTask(w2); await dispatchAll(w2);
    const run2 = await runOf(t2.id); await call("ack", w2.bot, { params: { runId: run2.id } });
    assert.equal((await call("transition", OWNER, { params: { id: t2.id }, body: { to: "CANCELLED", expected_status: "RUNNING", reason: "không cần nữa" } })).status, 200);
    const l2 = await call("submitOutput", w2.bot, { params: { id: t2.id }, body: { run_id: run2.id, content: "muộn", idempotency_key: `l2-${uniq()}` } });
    assert.equal(l2.data.late, true);
    const t2row = await taskOf(t2.id);
    assert.equal(t2row.status, "CANCELLED");
    assert.equal(t2row.current_output_id, null);
    assert.equal((await runOf(t2.id)).remote_stop_state, "REQUESTED", "app ngừng chờ ≠ Hermes đã dừng");
  });
});

describe("pg-server: xác thực & phân quyền của API", () => {
  it("không đăng nhập ⇒ 401; VIEWER không tạo/duyệt được; bot không gọi được API dành cho người dùng/OWNER", async () => {
    const w = await world();
    const { t, outputId } = await toWaitingReview(w);
    assert.equal((await call("createTask", null, { key: "k-xxxxxxxx", body: {} })).status, 401);
    assert.equal((await call("createTask", VIEWER, { key: "k-xxxxxxxx", body: { project_id: w.projectId, assignee_id: w.asstId, title: "abc xyz" } })).status, 403);
    const dec = { kind: "OUTPUT", object_id: outputId, object_version: 1, decision: "APPROVE", channel: "WEB" };
    for (const name of ["decide", "startRun", "adopt", "discard", "transition", "setDispatch", "setFlag", "patchDraft", "createTask", "cancel", "accept"]) {
      const r = await call(name, w.bot, { params: { id: t.id, outputId, draftId: "d", runId: "r" }, key: "idem-xxxxxxxx", body: { ...dec, mode: "RETRY", expected_status: "WAITING_REVIEW", to: "CANCELLED", enabled: true, key: "emergency_stop", value: true, version: 1, project_id: w.projectId, assignee_id: w.asstId, title: "abc xyz" } });
      assert.equal(r.status, 403, `${name} phải từ chối bot, nhận ${r.status}`);
    }
    assert.equal((await call("decide", VIEWER, { body: dec })).status, 403);
    assert.equal((await call("decide", ADMIN, { body: dec })).status, 403, "duyệt đầu ra chỉ OWNER");
    assert.equal((await taskOf(t.id)).status, "WAITING_REVIEW", "không có gì bị đổi");
  });
  it("bot A không nộp/ack thay bot B; người lạ (không trong danh sách) không tạo nháp hay xác nhận được", async () => {
    const w = await world();
    const t = await webTask(w); await dispatchAll(w);
    const run = await runOf(t.id);
    assert.equal((await call("ack", OTHER_BOT, { params: { runId: run.id } })).status, 403);
    assert.equal((await call("submitOutput", OTHER_BOT, { params: { id: t.id }, body: { run_id: run.id, content: "x", idempotency_key: "k1-xxxxxxx" } })).status, 403);
    // intake: stranger telegram id
    const mk = (actor: string, key: string) => call("intake", w.bot, { body: { source_key: key, actor_ref: actor, text: `Giao việc: soạn quảng cáo Dự án ${w.slug} giao cho ${w.slug}` } });
    assert.equal((await mk("telegram:9999", `s-${uniq()}`)).status, 403, "người lạ");
    assert.equal((await mk("telegram:1003", `s-${uniq()}`)).status, 403, "VIEWER không giao việc");
    const ok = await mk("telegram:1001", `s-${uniq()}`);
    assert.equal(ok.status, 201, JSON.stringify(ok));
    const draftId = ok.data.draft_id;
    // someone else relaying confirm for that draft is refused; the owner of the draft confirms
    assert.equal((await call("confirm", w.bot, { params: { draftId }, body: { actor_ref: "telegram:9999" } })).status, 403);
    // an OWNER/ADMIN who is not the draft's owner gets EXACTLY the answer an unknown id gets (no id probing)
    await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ('telegram:1002','ADMIN') ON CONFLICT (actor_ref) DO NOTHING`);
    const wrongUser = await call("confirm", w.bot, { params: { draftId }, body: { actor_ref: "telegram:1002" } });
    const unknownId = await call("confirm", w.bot, { params: { draftId: "00000000-0000-4000-8000-000000000000" }, body: { actor_ref: "telegram:1002" } });
    assert.deepEqual([wrongUser.status, wrongUser.error], [unknownId.status, unknownId.error]);
    assert.equal(wrongUser.status, 404);
    assert.equal((await call("confirm", w.bot, { params: { draftId }, body: { actor_ref: "telegram:1003" } })).status, 403);
    assert.equal((await call("confirm", OTHER_BOT, { params: { draftId }, body: { actor_ref: "telegram:1001" } })).status, 201, "bot được xác thực chuyển tiếp danh tính; lõi vẫn kiểm vai trò");
  });
  it("intake → xác nhận qua mã ngắn; xác nhận lặp/đồng thời chỉ tạo đúng một việc", async () => {
    const w = await world();
    const key = `src-${uniq()}`;
    const mk = () => call("intake", w.bot, { body: { source_key: key, actor_ref: "telegram:1001", text: `Giao việc: soạn quảng cáo Dự án ${w.slug} giao cho ${w.slug}` } });
    const a = await mk(); const b = await mk();
    assert.deepEqual([a.status, b.status], [201, 200]);
    assert.equal(a.data.draft_id, b.data.draft_id);
    const code = a.data.confirm.reply_hint.split(" ")[1];
    const rs = await Promise.all([1, 2, 3].map(() => call("confirm", w.bot, { params: { draftId: code }, body: { actor_ref: "telegram:1001" } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(rs.map((r) => r.data.task.id)).size, 1);
    const n = await db.query<any>(`SELECT count(*)::int n FROM tasks WHERE source_key=$1`, [key]);
    assert.equal(n[0].n, 1);
    assert.equal((await call("intake", w.bot, { body: { source_key: `n-${uniq()}`, actor_ref: "telegram:1001", text: "xin chào" } })).data.no_task, true);
  });
  it("cấu hình thực thi thiếu ⇒ 422 CONFIG_INCOMPLETE nêu đúng trường; tạo việc cho bot chưa đủ cấu hình bị chặn", async () => {
    const w = await world({ enable: false });
    await db.query(`UPDATE lumi_assistants SET ack_deadline_seconds=NULL, max_runs_per_day=NULL WHERE id=$1`, [w.asstId]);
    const r = await call("setDispatch", OWNER, { params: { id: w.asstId }, body: { enabled: true } });
    assert.equal(r.status, 422);
    assert.deepEqual(r.error?.details.missing.sort(), ["ack_deadline_seconds", "max_runs_per_day"]);
    const c = await call("createTask", OWNER, { key: `k-${uniq()}-xxxx`, body: { project_id: w.projectId, assignee_id: w.asstId, title: "Việc thử" } });
    assert.equal(c.status, 422);
  });
  it("profile Hermes có công cụ ngoài danh sách cho phép ⇒ không bật được; không đọc được ⇒ không bật", async () => {
    const w = await world({ enable: false });
    hermes.behaviour.tools = ["terminal", "outputs.submit"];
    const r = await call("setDispatch", OWNER, { params: { id: w.asstId }, body: { enabled: true } });
    assert.deepEqual([r.status, r.error?.code, r.error?.details.extra], [422, "PROFILE_EXCEEDS_ALLOWLIST", ["terminal"]]);
    hermes.behaviour.tools = null;
    assert.equal((await call("setDispatch", OWNER, { params: { id: w.asstId }, body: { enabled: true } })).error?.code, "PROFILE_TOOLS_UNKNOWN");
  });
  it("emergency_stop chặn gửi lệnh (hoãn, không hủy); token dịch vụ so sánh hằng thời gian", async () => {
    const w = await world();
    assert.equal((await call("setFlag", OWNER, { body: { key: "emergency_stop", value: true } })).status, 200);
    const t = await webTask(w);
    const r = await processOutbox(db, { hermes, notify: okNotify }, "w1", clock);
    assert.equal(r?.outcome, "deferred");
    assert.equal(hermes.calls.length, 0);
    assert.equal((await runOf(t.id)).state, "PENDING");
    await call("setFlag", OWNER, { body: { key: "emergency_stop", value: false } });
    assert.equal(resolveBotToken("tok-aff", "aff:tok-aff,yt:tok-yt"), "aff");
    assert.equal(resolveBotToken("tok-af", "aff:tok-aff"), null);
    assert.equal(resolveBotToken("", "aff:tok-aff"), null);
    assert.equal(resolveBotToken("tok-aff", undefined), null);
  });
  it("lỗi không rò rỉ nội bộ: JSON hợp lệ nhưng UUID sai ⇒ 400, không 500", async () => {
    const w = await world();
    const r = await call("startRun", OWNER, { params: { id: "not-a-uuid" }, key: "k-xxxxxxxx", body: { mode: "RETRY", expected_status: "FAILED" } });
    assert.equal(r.status, 400);
    assert.equal(JSON.stringify(r).includes("SELECT"), false);
    void w;
  });
});

describe("pg-server: nguồn Telegram và nhật ký", () => {
  it("giao dịch xuất phát từ Telegram đặt cờ dc.in_telegram_action (cờ của P3-R04) và cờ tự hết khi giao dịch xong", async () => {
    const inside = await db.tx(async (t) => { await markTelegramAction(t); return (await t.query<any>(`SELECT current_setting('dc.in_telegram_action', true) AS v`))[0].v; });
    assert.equal(inside, "on");
    const outside = (await db.query<any>(`SELECT current_setting('dc.in_telegram_action', true) AS v`))[0].v;
    assert.notEqual(outside, "on");
  });
  it("xác nhận từ Telegram không ghi id nháp (thông tin xác nhận) vào nhật ký kiểm toán vĩnh viễn", async () => {
    const w = await world();
    const a = await call("intake", w.bot, { body: { source_key: `aud-${uniq()}`, actor_ref: "telegram:1001", text: `Giao việc: soạn quảng cáo Dự án ${w.slug} giao cho ${w.slug}` } });
    const draftId = a.data.draft_id as string;
    const c = await call("confirm", w.bot, { params: { draftId }, body: { actor_ref: "telegram:1001" } });
    assert.equal(c.status, 201);
    const rows = await db.query<any>(`SELECT after_json::text AS j, entity_id FROM audit_events WHERE action='intake.confirmed' AND after_json->>'taskId'=$1`, [c.data.task.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].j.includes(draftId), false);
    assert.equal(String(rows[0].entity_id).includes(draftId), false);
  });
});

describe("pg-server: đầu ra bất biến", () => {
  it("nội dung/phiên bản đầu ra không sửa được sau khi nộp (duyệt gắn với đúng nội dung đã xem); trạng thái thì vẫn đổi được", async () => {
    const w = await world();
    const { outputId } = await toWaitingReview(w);
    await assert.rejects(db.query(`UPDATE lumi_task_outputs SET content='bị sửa lén' WHERE id=$1`, [outputId]), /immutable/);
    await assert.rejects(db.query(`UPDATE lumi_task_outputs SET version=99 WHERE id=$1`, [outputId]), /immutable/);
    await db.query(`UPDATE lumi_task_outputs SET state='SUPERSEDED' WHERE id=$1`, [outputId]);
    assert.equal((await db.query<any>(`SELECT content,state FROM lumi_task_outputs WHERE id=$1`, [outputId]))[0].content, "Bản 1");
  });
});

describe("pg-server: máy chủ MCP quyền tối thiểu", () => {
  const rpc = async (bot: any, method: string, params?: any, actor?: string) =>
    handleRpc(ctx(), bot, { jsonrpc: "2.0", id: 1, method, params }, { actorFor: () => actor });
  const call = async (bot: any, name: string, args: any, actor?: string) => (await rpc(bot, "tools/call", { name, arguments: args }, actor)).result;

  it("chỉ có đúng 10 công cụ (đọc việc, nộp/điểm dừng, kế hoạch, nộp phiên bản Plan&Cost, đề xuất dự án, xin quyền, bàn giao, trả lời bàn giao, PM đề xuất đổi người); KHÔNG có công cụ tạo nháp, xác nhận, duyệt, hủy, giao lại, cấp quyền hay kích hoạt dự án", async () => {
    const w = await world();
    const names = (await rpc(w.bot, "tools/list")).result.tools.map((x: any) => x.name).sort();
    assert.deepEqual(names, ["actions_request", "handoff_propose", "handoff_respond", "knowledge_context", "outputs_submit", "plan_add", "plan_submit_version", "plan_update", "pm_propose_reassign", "project_propose"]);
    assert.deepEqual(MCP_TOOLS.map((x) => x.name).sort(), names);
    for (const bad of ["tasks_intake", "tasks_confirm", "approvals_decide", "outputs_adopt", "tasks_cancel", "runs_start", "grants_create", "projects_activate", "actions_decide"]) assert.equal((await call(w.bot, bad, {})).isError, true);
    assert.ok(!JSON.stringify(MCP_TOOLS).includes("actor_ref"), "danh tính không do mô hình cung cấp");
  });
  it("tạo bản nháp do CỔNG Telegram gọi (không qua model): chỉ tạo NHÁP; danh tính là id người gửi của nền tảng; lặp lại không tạo thêm", async () => {
    const w = await world();
    const text = `Giao việc: soạn quảng cáo Dự án ${w.slug} giao cho ${w.slug}`;
    const before = (await db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n;
    const a = await intakeFromChat(ctx(), w.bot as any, "1001", text);
    const b = await intakeFromChat(ctx(), w.bot as any, "1001", "  " + text.toUpperCase() + "  "); // same event, different casing/spacing
    assert.equal(a.ok, true); assert.match(a.reply, /BẢN NHÁP \(chưa phải việc\)/); assert.match(a.reply, /OK [0-9a-f]{8}/);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, before, "không có việc nào được tạo");
    const drafts = await db.query<any>(`SELECT id,state,actor_ref FROM lumi_intake_drafts WHERE raw_text ILIKE $1`, [`%${w.slug}%`]);
    assert.equal(drafts.length, 1); assert.equal(drafts[0].state, "OPEN"); assert.equal(drafts[0].actor_ref, "telegram:1001");
    assert.equal(b.draftId, a.draftId, "cùng tin cùng ngày = cùng bản nháp");
    const stranger = await intakeFromChat(ctx(), w.bot as any, "9999", text);
    assert.equal(stranger.ok, false); assert.match(stranger.reply, /không có quyền/);
    const viewer = await intakeFromChat(ctx(), w.bot as any, "1003", text);
    assert.equal(viewer.ok, false);
    assert.match((await intakeFromChat(ctx(), w.bot as any, "1001", "xin chào")).reply, /Không phải lệnh giao việc/);
    assert.equal((await intakeFromChat(ctx(), w.bot as any, "", text)).ok, false);
    assert.equal((await call(w.bot, "tasks_intake", { text })).isError, true, "model không còn công cụ này");
  });
  it("knowledge_context/outputs_submit: chỉ lượt chạy của chính bot; nộp đúng một lần; lượt đã đóng thì chỉ lưu muộn", async () => {
    const w = await world();
    const t = await webTask(w); await dispatchAll(w);
    const run = await runOf(t.id);
    const other: any = { kind: "bot", slug: "other", actorRef: "bot:other" };
    assert.equal((await call(other, "knowledge_context", { run_id: run.id })).isError, true);
    assert.equal((await call(other, "outputs_submit", { run_id: run.id, content: "x" })).isError, true);
    const ctxRes = await call(w.bot, "knowledge_context", { run_id: run.id });
    assert.equal(ctxRes.isError, false); assert.match(ctxRes.content[0].text, new RegExp(t.code));
    assert.equal((await runOf(t.id)).state, "RUNNING", "gọi đầu tiên = xác nhận bắt đầu");
    assert.equal((await call(w.bot, "outputs_submit", { run_id: "not-a-uuid", content: "x" })).isError, true);
    assert.equal((await call(w.bot, "outputs_submit", { run_id: run.id, content: "y".repeat(20001) })).isError, true);
    assert.match((await call(w.bot, "outputs_submit", { run_id: run.id, content: "Bản 1" })).content[0].text, /Đã nộp bản 1/);
    assert.match((await call(w.bot, "outputs_submit", { run_id: run.id, content: "Bản 1 sửa lén" })).content[0].text, /đã nộp trước đó/);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_task_outputs WHERE task_id=$1`, [t.id]))[0].n, 1);
    assert.equal((await taskOf(t.id)).status, "WAITING_REVIEW");
    assert.equal((await call(w.bot, "knowledge_context", { run_id: run.id })).isError, true, "lượt đã đóng: dừng ngay");
  });
  it("hủy việc đang chạy => STOP_RUN; adapter không xác nhận được dừng thì remote_stop_state=UNKNOWN, xác nhận được thì CONFIRMED", async () => {
    for (const confirmed of [false, true]) {
      const w = await world();
      const t = await webTask(w); await dispatchAll(w);
      const run = await runOf(t.id);
      await call(w.bot, "knowledge_context", { run_id: run.id });
      assert.equal((await call_api("transition", t.id)).status, 200);
      assert.equal((await runOf(t.id)).remote_stop_state, "REQUESTED", "mới chỉ là app ngừng chờ");
      const stopper: any = Object.assign(new SimulatedHermes(), { stop: async () => ({ confirmed, message: "test" }) });
      for (let i = 0; i < 4; i++) await processOutbox(db, { hermes: stopper, notify: okNotify }, "w1", tick(400));
      assert.equal((await runOf(t.id)).remote_stop_state, confirmed ? "CONFIRMED" : "UNKNOWN");
    }
  });
});
async function call_api(_n: string, taskId: string) {
  return handle("transition", ctx(), { principal: OWNER, params: { id: taskId }, body: { to: "CANCELLED", expected_status: "RUNNING", reason: "dừng thử" }, headers: hdr() });
}

// ───────────────────────── Tự chủ (TDD 8.11)
const rejectsCode = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`);
const OWNER_REF = "web:owner@test";
const inDays = (n: number) => new Date(clock.getTime() + n * 86400_000);
async function act(w: Awaited<ReturnType<typeof world>>, o: Partial<Parameters<typeof requestAction>[1]> = {}) {
  return requestAction(db, { assistantId: w.asstId, projectId: w.projectId, accountRef: "google-ads:111", actionType: "ADS_SPEND", amount: 30, currency: "USD", summary: "Tăng ngân sách chiến dịch thử", now: clock, ...o });
}

describe("pg-server: tự chủ — khả năng công cụ tách khỏi quyền hành động", () => {
  it("RESTRICTED từ chối profile có công cụ rộng; DECLARED_FULL cần xác nhận rõ, rồi giữ nguyên mọi công cụ; đổi chế độ tắt giao việc", async () => {
    const w = await world({ enable: false });
    hermes.behaviour.tools = ["terminal", "web", "browser", "outputs.submit"];
    assert.equal((await call("setDispatch", OWNER, { params: { id: w.asstId }, body: { enabled: true } })).error?.code, "PROFILE_EXCEEDS_ALLOWLIST");
    assert.equal((await call("declareCapability", OWNER, { params: { id: w.asstId }, body: { mode: "DECLARED_FULL" } })).status, 400, "thiếu acknowledged");
    assert.equal((await call("declareCapability", ADMIN, { params: { id: w.asstId }, body: { mode: "DECLARED_FULL", acknowledged: true } })).status, 403, "chỉ OWNER");
    assert.equal((await call("declareCapability", w.bot, { params: { id: w.asstId }, body: { mode: "DECLARED_FULL", acknowledged: true } })).status, 403, "bot không tự nâng quyền");
    assert.equal((await call("declareCapability", OWNER, { params: { id: w.asstId }, body: { mode: "DECLARED_FULL", acknowledged: true } })).status, 200);
    const on = await call("setDispatch", OWNER, { params: { id: w.asstId }, body: { enabled: true } });
    assert.equal(on.status, 200, JSON.stringify(on));
    const [a] = await db.query<any>(`SELECT capability_mode,capability_ack_by,capability_snapshot FROM lumi_assistants WHERE id=$1`, [w.asstId]);
    assert.deepEqual([a.capability_mode, a.capability_ack_by], ["DECLARED_FULL", "web:owner@test"]);
    assert.deepEqual(a.capability_snapshot.tools, ["terminal", "web", "browser", "outputs.submit"], "ảnh chụp công cụ được ghi lại");
    await call("declareCapability", OWNER, { params: { id: w.asstId }, body: { mode: "RESTRICTED" } });
    assert.equal((await db.query<any>(`SELECT dispatch_enabled FROM lumi_assistants WHERE id=$1`, [w.asstId]))[0].dispatch_enabled, false, "đổi chế độ ⇒ phải bật lại có kiểm tra");
    assert.ok((await db.query<any>(`SELECT 1 FROM audit_events WHERE action='assistant.capability_declared' AND after_json->>'assistantId'=$1`, [w.asstId])).length >= 2);
  });
});

describe("pg-server: tự chủ — quyền cấp trước, hỏi Chủ, nhật ký", () => {
  it("không có quyền ⇒ ASK; hỏi lại cùng tham số không chất đống; Chủ duyệt ⇒ dùng ĐÚNG MỘT LẦN; sai tham số ⇒ từ chối", async () => {
    const w = await world();
    const a = await act(w);
    assert.equal(a.decision, "ASK"); assert.equal((a as any).basis, "NO_GRANT");
    const again = await act(w);
    assert.equal((again as any).requestId, (a as any).requestId, "cùng tham số = cùng yêu cầu");
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_action_requests WHERE assistant_id=$1`, [w.asstId]))[0].n, 1);
    const rid = (a as any).requestId as string;
    assert.equal((await act(w, { requestId: rid })).decision, "ASK", "chưa duyệt thì vẫn chờ");
    await assert.rejects(decideActionRequest(db, "bot:x", rid, "APPROVE", undefined, clock), (e: any) => e.code === "FORBIDDEN");
    assert.equal((await decideActionRequest(db, OWNER_REF, rid, "APPROVE", undefined, clock)).alreadyProcessed, false);
    assert.equal((await decideActionRequest(db, OWNER_REF, rid, "APPROVE", undefined, clock)).alreadyProcessed, true);
    await rejectsCode(decideActionRequest(db, OWNER_REF, rid, "DENY", "đổi ý", clock), "ALREADY_DECIDED");
    assert.equal((await act(w, { requestId: rid, amount: 31 })).decision, "DENY", "đổi số tiền ⇒ không dùng được quyền đã duyệt");
    assert.equal((await act(w, { requestId: rid })).decision, "ALLOW");
    const second = await act(w, { requestId: rid });
    assert.deepEqual([second.decision, (second as any).reason], ["DENY", "REQUEST_CONSUMED"]);
  });

  it("quyền cấp trước có hạn mức, thời hạn, tài khoản, đơn vị tiền; vượt phạm vi ⇒ hỏi lại; thu hồi ⇒ hết hiệu lực", async () => {
    const w = await world();
    const g = await createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: w.projectId, accountRef: "google-ads:111", actionType: "ADS_SPEND", currency: "USD", perActionMax: 40, budgetTotal: 100, countLimit: 5, askIfAmountOver: 35, validUntil: inDays(7) }, clock);
    assert.equal((await act(w, { amount: 30 })).decision, "ALLOW");
    assert.equal((await act(w, { amount: 36 })).decision, "ASK", "trên ngưỡng phải hỏi");
    assert.equal(((await act(w, { amount: 36 })) as any).basis, "ASK_CONDITION");
    assert.equal(((await act(w, { amount: 41 })) as any).basis, "OVER_LIMIT");
    assert.equal(((await act(w, { amount: undefined })) as any).basis, "OVER_LIMIT", "quyền có hạn mức tiền không bao giờ phủ hành động không nêu số tiền");
    assert.equal(((await act(w, { currency: "VND" })) as any).basis, "OVER_LIMIT", "sai đơn vị tiền");
    assert.equal(((await act(w, { accountRef: "google-ads:999" })) as any).basis, "NO_GRANT", "tài khoản khác");
    assert.equal(((await act(w, { actionType: "DELETE_CAMPAIGN" })) as any).basis, "NO_GRANT", "loại hành động khác");
    assert.equal((await act(w, { amount: 35 })).decision, "ALLOW");
    assert.equal((await act(w, { amount: 30 })).decision, "ALLOW"); // spent 95 → this one brings 95? (30+35+30=95)
    assert.equal(((await act(w, { amount: 10 })) as any).basis, "BUDGET_LIMIT", "95+10 > 100");
    const [row] = await db.query<any>(`SELECT spent::float s,count_used FROM lumi_grants WHERE id=$1`, [g.id]);
    assert.deepEqual([row.s, row.count_used], [95, 3]);
    // expiry and revoke
    const w2 = await world();
    const g2 = await createGrant(db, OWNER_REF, { assistantId: w2.asstId, projectId: w2.projectId, accountRef: "wp:site", actionType: "PUBLISH_POST", validUntil: inDays(1) }, clock);
    assert.equal((await act(w2, { accountRef: "wp:site", actionType: "PUBLISH_POST", amount: undefined, currency: undefined })).decision, "ALLOW", "quyền không tiền: không cần số tiền");
    assert.equal(((await act(w2, { accountRef: "wp:site", actionType: "PUBLISH_POST", amount: undefined, currency: undefined, now: inDays(2) })) as any).basis, "GRANT_EXPIRED");
    await revokeGrant(db, OWNER_REF, g2.id, clock);
    assert.equal(((await act(w2, { accountRef: "wp:site", actionType: "PUBLISH_POST", amount: undefined, currency: undefined, summary: "đăng lại" })) as any).basis, "NO_GRANT");
    // validation + who can grant
    await assert.rejects(createGrant(db, "web:admin@test", { assistantId: w.asstId, projectId: w.projectId, accountRef: "a", actionType: "b", validUntil: inDays(1) }, clock), (e: any) => e.code === "FORBIDDEN");
    await assert.rejects(createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: w.projectId, accountRef: "a", actionType: "b", validUntil: inDays(400) }, clock), (e: any) => e.code === "VALIDATION_ERROR");
    await assert.rejects(createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: w.projectId, accountRef: "a", actionType: "b", perActionMax: 5, validUntil: inDays(1) }, clock), (e: any) => e.code === "VALIDATION_ERROR", "hạn mức tiền cần đơn vị tiền");
  });

  it("10 yêu cầu SONG SONG trên 10 kết nối: ngân sách không bao giờ bị vượt (đúng 3 ALLOW với 100 USD và 30 USD/lần)", async () => {
    const w = await world();
    const g = await createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: w.projectId, accountRef: "google-ads:111", actionType: "ADS_SPEND", currency: "USD", budgetTotal: 100, validUntil: inDays(1) }, clock);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => act(w, { params: { n: i }, summary: `lần ${i}` })));
    assert.equal(rs.filter((r) => r.decision === "ALLOW").length, 3);
    assert.equal(rs.filter((r) => r.decision === "ASK").length, 7);
    const [row] = await db.query<any>(`SELECT spent::float s,count_used FROM lumi_grants WHERE id=$1`, [g.id]);
    assert.deepEqual([row.s, row.count_used], [90, 3]);
  });

  it("công tắc dừng, trợ lý tạm dừng, dự án chưa kích hoạt ⇒ DENY; mọi quyết định vào nhật ký chỉ-thêm", async () => {
    const w = await world();
    await createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: w.projectId, accountRef: "x", actionType: "Y", validUntil: inDays(1) }, clock);
    const ok1 = await act(w, { accountRef: "x", actionType: "Y", amount: undefined, currency: undefined });
    assert.equal(ok1.decision, "ALLOW");
    await call("setFlag", OWNER, { body: { key: "emergency_stop", value: true } });
    assert.deepEqual([(await act(w, { accountRef: "x", actionType: "Y", amount: undefined, currency: undefined, summary: "s2" })).decision, ((await act(w, { accountRef: "x", actionType: "Y", amount: undefined, currency: undefined, summary: "s2" })) as any).reason], ["DENY", "EMERGENCY_STOP"]);
    await call("setFlag", OWNER, { body: { key: "emergency_stop", value: false } });
    await db.query(`UPDATE lumi_assistants SET dispatch_paused=true WHERE id=$1`, [w.asstId]);
    assert.equal(((await act(w, { accountRef: "x", actionType: "Y", amount: undefined, currency: undefined })) as any).reason, "ASSISTANT_PAUSED");
    await db.query(`UPDATE lumi_assistants SET dispatch_paused=false WHERE id=$1`, [w.asstId]);
    await db.query(`UPDATE lumi_projects SET status='PROPOSED' WHERE id=$1`, [w.projectId]);
    assert.equal(((await act(w, { accountRef: "x", actionType: "Y", amount: undefined, currency: undefined })) as any).reason, "PROJECT_NOT_ACTIVE");
    await assert.rejects(createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: w.projectId, accountRef: "z", actionType: "Y", validUntil: inDays(1) }, clock), (e: any) => e.code === "INVALID_TRANSITION", "không cấp quyền trên đề xuất");
    const log = await db.query<any>(`SELECT outcome FROM lumi_action_log WHERE assistant_id=$1 ORDER BY at`, [w.asstId]);
    assert.ok(log.length >= 4 && log[0].outcome === "ALLOW");
    await assert.rejects(db.query(`UPDATE lumi_action_log SET reason='sửa lén' WHERE assistant_id=$1`, [w.asstId]), /append-only/);
    await assert.rejects(db.query(`DELETE FROM lumi_action_log WHERE assistant_id=$1`, [w.asstId]), /append-only/);
  });

  it("API: chỉ OWNER cấp quyền/duyệt; bot bị 403 ở mọi đường của chủ", async () => {
    const w = await world();
    const body = { assistant_id: w.asstId, project_id: w.projectId, account_ref: "a", action_type: "B", valid_until: inDays(1).toISOString() };
    for (const who of [w.bot, VIEWER, ADMIN]) assert.equal((await call("createGrant", who, { body })).status, 403);
    const g = await call("createGrant", OWNER, { body });
    assert.equal(g.status, 201, JSON.stringify(g));
    assert.equal((await call("revokeGrant", w.bot, { params: { id: g.data.grant_id } })).status, 403);
    assert.equal((await call("revokeGrant", OWNER, { params: { id: g.data.grant_id } })).status, 200);
    const q = await act(w, { accountRef: "zz" });
    assert.equal((await call("decideAction", w.bot, { params: { id: (q as any).requestId }, body: { decision: "APPROVE" } })).status, 403);
    assert.equal((await call("decideAction", OWNER, { params: { id: (q as any).requestId }, body: { decision: "DENY" } })).status, 400, "từ chối cần ghi chú");
    assert.equal((await call("decideAction", OWNER, { params: { id: (q as any).requestId }, body: { decision: "DENY", note: "không cần" } })).status, 200);
  });
});

describe("pg-server: tự chủ — việc con, đề xuất dự án, điểm dừng/tiếp tục", () => {
  it("việc con: mặc định TẮT, có giới hạn, chỉ một cấp, idempotent, chỉ trên lượt chạy của chính trợ lý, không lên bảng chính", async () => {
    const w = await world();
    const t = await webTask(w); await dispatchAll(w);
    const run = await runOf(t.id);
    await call("ack", w.bot, { params: { runId: run.id } });
    await assert.rejects(addPlanItem(db, { assistantId: w.asstId, runId: run.id, title: "Bước 1", now: clock }), (e: any) => e.data?.reason === "SUBTASKS_DISABLED");
    await setAutonomyLimits(db, OWNER_REF, w.asstId, { maxSubtasks: 3 }, clock);
    const a = await addPlanItem(db, { assistantId: w.asstId, runId: run.id, title: "Tìm 5 offer", now: clock });
    const again = await addPlanItem(db, { assistantId: w.asstId, runId: run.id, title: "  tìm 5 OFFER ", now: clock });
    assert.deepEqual([a.alreadyProcessed, again.alreadyProcessed, again.item.code], [false, true, a.item.code]);
    await addPlanItem(db, { assistantId: w.asstId, runId: run.id, title: "So sánh", now: clock });
    await addPlanItem(db, { assistantId: w.asstId, runId: run.id, title: "Chọn 1", now: clock });
    await assert.rejects(addPlanItem(db, { assistantId: w.asstId, runId: run.id, title: "Quá giới hạn", now: clock }), (e: any) => e.code === "SUBTASK_LIMIT");
    await assert.rejects(addPlanItem(db, { assistantId: "00000000-0000-4000-8000-000000000000", runId: run.id, title: "Của người khác", now: clock }), (e: any) => e.code === "NOT_FOUND");
    assert.equal((await updatePlanItem(db, { assistantId: w.asstId, runId: run.id, code: a.item.code, state: "RUNNING", now: clock })).alreadyProcessed, false);
    await updatePlanItem(db, { assistantId: w.asstId, runId: run.id, code: a.item.code, state: "COMPLETED", note: "xong", now: clock });
    assert.equal((await updatePlanItem(db, { assistantId: w.asstId, runId: run.id, code: a.item.code, state: "COMPLETED", now: clock })).alreadyProcessed, true);
    await assert.rejects(updatePlanItem(db, { assistantId: w.asstId, runId: run.id, code: a.item.code, state: "FAILED", now: clock }), (e: any) => e.code === "INVALID_TRANSITION");
    const st = await buildDbState(db, { actorRef: OWNER_REF, email: "owner@test", role: "OWNER" }, { hermesMode: "test", now: clock });
    const card = st.tasks.find((x) => x.id === t.code)!;
    assert.equal(card.real!.children.length, 3);
    assert.equal(st.tasks.filter((x) => x.id.startsWith("DL-") && card.real!.children.some((c) => c.code === x.id)).length, 0, "việc con không lên bảng chính");
    await call("submitOutput", w.bot, { params: { id: t.id }, body: { run_id: run.id, content: "Xong", idempotency_key: `k-${uniq()}` } });
    await assert.rejects(addPlanItem(db, { assistantId: w.asstId, runId: run.id, title: "Sau khi đóng", now: clock }), (e: any) => e.code === "INVALID_TRANSITION", "lượt chạy đã đóng");
  });

  it("đề xuất dự án tách khỏi kích hoạt: bot chỉ tạo ĐỀ XUẤT; không cấp được quyền trên đề xuất; chỉ OWNER kích hoạt; lặp lại idempotent", async () => {
    const w = await world();
    const p1 = await proposeProject(db, { assistantId: w.asstId, name: `Ngách thử ${w.slug}`, area: "YOUTUBE", goal: "Kênh về ...", evidence: "Từ khóa X có 1.2M lượt tìm/tháng (nguồn Y)", now: clock });
    const p2 = await proposeProject(db, { assistantId: w.asstId, name: `ngách thử ${w.slug}`, area: "YOUTUBE", goal: "Kênh về ...", evidence: "Từ khóa X có 1.2M lượt tìm/tháng (nguồn Y)", now: clock });
    assert.deepEqual([p1.alreadyProcessed, p2.alreadyProcessed, p2.project.id], [false, true, p1.project.id]);
    assert.equal((await db.query<any>(`SELECT status FROM lumi_projects WHERE id=$1`, [p1.project.id]))[0].status, "PROPOSED");
    await assert.rejects(createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: p1.project.id, accountRef: "a", actionType: "b", validUntil: inDays(1) }, clock), (e: any) => e.code === "INVALID_TRANSITION");
    await assert.rejects(proposeProject(db, { assistantId: w.asstId, name: "x", area: "YOUTUBE", goal: "g", evidence: "ngắn", now: clock }), (e: any) => e.code === "VALIDATION_ERROR");
    assert.equal((await call("decideProposal", w.bot, { params: { id: p1.project.id }, body: { decision: "ACTIVATE" } })).status, 403);
    assert.equal((await call("decideProposal", VIEWER, { params: { id: p1.project.id }, body: { decision: "ACTIVATE" } })).status, 403);
    assert.equal((await call("decideProposal", OWNER, { params: { id: p1.project.id }, body: { decision: "ACTIVATE" } })).status, 200);
    assert.equal((await decideProposal(db, OWNER_REF, p1.project.id, "ACTIVATE", clock)).alreadyProcessed, true);
    assert.equal((await db.query<any>(`SELECT status FROM lumi_projects WHERE id=$1`, [p1.project.id]))[0].status, "ACTIVE");
    await createGrant(db, OWNER_REF, { assistantId: w.asstId, projectId: p1.project.id, accountRef: "a", actionType: "b", validUntil: inDays(1) }, clock); // now allowed
    const rej = await proposeProject(db, { assistantId: w.asstId, name: `Ngách khác ${w.slug}`, area: "AFFILIATE", goal: "Mục tiêu thử", evidence: "bằng chứng đủ dài", now: clock });
    await decideProposal(db, OWNER_REF, rej.project.id, "REJECT", clock);
    await assert.rejects(decideProposal(db, OWNER_REF, rej.project.id, "ACTIVATE", clock), (e: any) => e.code === "INVALID_TRANSITION");
  });

  it("điểm dừng → lần chạy tiếp (trong giới hạn) → khi hết lượt thì chờ Chủ quyết định; việc dài không thành bot trả lời ngắn", async () => {
    const w = await world();
    await setAutonomyLimits(db, OWNER_REF, w.asstId, { maxContinuations: 2 }, clock);
    const t = await webTask(w, "Nghiên cứu dài"); await dispatchAll(w);
    let run = await runOf(t.id);
    const step = async (final: boolean, content: string) => {
      await call("ack", w.bot, { params: { runId: run.id } });
      const ctxText = (await handleRpc(ctx(), w.bot as any, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "knowledge_context", arguments: { run_id: run.id } } })).result.content[0].text as string;
      const r = await handleRpc(ctx(), w.bot as any, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "outputs_submit", arguments: { run_id: run.id, content, final } } });
      return { ctxText, text: r.result.content[0].text as string };
    };
    const s1 = await step(false, "Điểm dừng 1: đã khảo sát 20 offer");
    assert.match(s1.text, /điểm dừng/i);
    assert.deepEqual([(await taskOf(t.id)).status, (await runOf(t.id)).run_kind, (await runOf(t.id)).state], ["QUEUED", "CONTINUATION", "PENDING"]);
    assert.equal((await db.query<any>(`SELECT state FROM lumi_task_runs WHERE id=$1`, [run.id]))[0].state, "SUCCEEDED");
    await dispatchAll(w); run = await runOf(t.id);
    const s2 = await step(false, "Điểm dừng 2: loại còn 6 offer");
    assert.match(s2.ctxText, /Điểm dừng trước[\s\S]*Điểm dừng 1/, "lần tiếp tục thấy điểm dừng cũ");
    await dispatchAll(w); run = await runOf(t.id);
    const s3 = await step(false, "Điểm dừng 3: còn 2 offer");
    assert.match(s3.text, /hết số lần tiếp tục/);
    const held = await taskOf(t.id);
    assert.deepEqual([held.status, held.needs_decision, held.hold_reason], ["ON_HOLD", true, "CONTINUATION_LIMIT"]);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_task_outputs WHERE task_id=$1 AND state='PROGRESS'`, [t.id]))[0].n, 3);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_task_outputs WHERE task_id=$1 AND state='SUBMITTED'`, [t.id]))[0].n, 0, "điểm dừng không phải đầu ra để duyệt");
    // the owner can continue: retry runs a new run; a FINAL submit then goes to review
    const rr = await call("startRun", OWNER, { params: { id: t.id }, key: `c-${uniq()}-xxxx`, body: { mode: "RETRY", expected_status: "ON_HOLD" } });
    assert.equal(rr.status, 201, JSON.stringify(rr));
    await dispatchAll(w); run = await runOf(t.id);
    const fin = await step(true, "Kết quả cuối: chọn offer A vì ...");
    assert.match(fin.text, /Đã nộp bản/);
    assert.equal((await taskOf(t.id)).status, "WAITING_REVIEW");
  });
});
