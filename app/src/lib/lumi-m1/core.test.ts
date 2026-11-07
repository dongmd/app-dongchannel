/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface (typed at the boundary in TDD 14.9) */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import {
  LumiError, parseIntake, missingExecConfig, setDispatchEnabled, setFlag, createDraft, patchDraft, confirmDraft, processOutbox, claimOutbox,
  finishOutbox, ackRun, reap, submitOutput, decide, startRun, adoptLateOutput, cancelTask, acceptHumanTask, discardLateOutput,
  type Db, type HermesPort, type NotifyPort,
} from "./core";

const T0 = new Date("2026-11-06T08:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const OWNER = "1001", ADMIN = "1002", VIEWER = "1003", STRANGER = "9999";

class FakeHermes implements HermesPort {
  calls: any[] = [];
  next: any[] = [];
  tools: string[] | null = ["outputs.submit"];
  async readProfileTools() { return this.tools; }
  async dispatch(run: any) {
    this.calls.push(run);
    const n = this.next.shift() ?? { kind: "accepted", sessionRef: "sess-1" };
    if (n.kind === "throw") throw new Error("socket hang up");
    return n;
  }
}
const okNotify: NotifyPort = { send: async () => {} };
const badNotify: NotifyPort = { send: async () => { throw new Error("telegram down"); } };

async function world(opts: { configured?: boolean } = {}) {
  const { db, pg } = await freshDb();
  const h = new FakeHermes();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  await db.query(`INSERT INTO profiles(slug,name,type,status) VALUES ('lumitest','Bot thử','bot','active')`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('test-offer-us','Test offer US','AFFILIATE') RETURNING id`);
  const [asst] = await db.query<any>(
    `INSERT INTO lumi_assistants(slug,name,kind,hermes_profile,connection_state,execution_level,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day)
     VALUES ('lumitest','Lumi Test','SPECIALIST','lumitest','VERIFIED',0,'["outputs.submit"]',600,30,2,3,2,10) RETURNING id`);
  if (opts.configured !== false) await setDispatchEnabled(db, h, OWNER, asst.id, true, T0);
  return { db, pg, h, projectId: proj.id as string, asstId: asst.id as string };
}
async function newTask(w: Awaited<ReturnType<typeof world>>, key = "telegram:lumitest:1:1", now = T0) {
  const d = await createDraft(w.db, { sourceKey: key, channel: "TELEGRAM", actorRef: OWNER, assistantId: w.asstId, text: "Giao việc: soạn 3 mẫu quảng cáo cho Test offer US, giao cho lumitest", ttlSeconds: 900, now });
  assert.ok("draft" in d);
  const c = await confirmDraft(w.db, OWNER, (d as any).draft.id, now);
  return { draftId: (d as any).draft.id as string, task: c.task as any, c };
}
async function runOf(db: Db, taskId: string) {
  return (await db.query<any>(`SELECT * FROM lumi_task_runs WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [taskId]))[0];
}
async function drain(w: Awaited<ReturnType<typeof world>>, now: Date, notify: NotifyPort = okNotify, worker = "w1") {
  const out = [];
  for (let i = 0; i < 10; i++) { const r = await processOutbox(w.db, { hermes: w.h, notify }, worker, now); if (!r) break; out.push(r); }
  return out;
}
const rejects = async (p: Promise<unknown>, code: string, status?: number) => {
  await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code && (status === undefined || e.status === status), `expected ${code}`);
};

describe("M1 parse / config (pure)", () => {
  it("parseIntake: chỉ lệnh rõ ràng mới là giao việc; thiếu dự án/người nhận được báo", () => {
    const ps = [{ id: "p1", name: "Test offer US" }], as = [{ id: "a1", name: "Lumi Test", slug: "lumitest" }];
    assert.equal(parseIntake("hôm nay trời đẹp", ps, as).isTask, false);
    const ok = parseIntake("Giao việc: soạn mẫu cho Test offer US giao cho lumitest", ps, as);
    assert.deepEqual([ok.isTask, ok.projectId, ok.assigneeId, ok.missing], [true, "p1", "a1", []]);
    assert.deepEqual(parseIntake("/viec: làm gì đó", ps, as).missing, ["project", "assignee"]);
  });
  it("missingExecConfig liệt kê đúng trường thiếu, và công cụ lạ", () => {
    assert.ok(missingExecConfig({}).includes("run_deadline_seconds") && missingExecConfig({}).includes("tool_allowlist"));
    assert.deepEqual(missingExecConfig({ run_deadline_seconds: 1, ack_deadline_seconds: 1, max_run_failures: 1, max_transport_attempts: 1, max_revision_rounds: 1, max_runs_per_day: 1, tool_allowlist: ["x"] }), ["tool_allowlist(unknown_tool)"]);
  });
});

describe("M1 intake → xác nhận → Postgres (real PostgreSQL engine, real migrations)", () => {
  it("1/2: tin giao việc → nháp; gửi lại cùng source_key không tạo nháp/việc thứ hai; xác nhận lặp chỉ một việc", async () => {
    const w = await world();
    const a = await createDraft(w.db, { sourceKey: "telegram:lumitest:1:1", channel: "TELEGRAM", actorRef: OWNER, text: "Giao việc: soạn quảng cáo Test offer US cho lumitest", ttlSeconds: 900, now: T0 });
    const b = await createDraft(w.db, { sourceKey: "telegram:lumitest:1:1", channel: "TELEGRAM", actorRef: OWNER, text: "Giao việc: soạn quảng cáo Test offer US cho lumitest", ttlSeconds: 900, now: at(5) });
    assert.equal((a as any).created, true); assert.equal((b as any).created, false); assert.equal((a as any).draft.id, (b as any).draft.id);
    const id = (a as any).draft.id;
    const c1 = await confirmDraft(w.db, OWNER, id, at(10)); const c2 = await confirmDraft(w.db, OWNER, id, at(11));
    assert.equal(c1.alreadyProcessed, false); assert.equal(c2.alreadyProcessed, true); assert.equal(c1.task.id, c2.task.id);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks WHERE source_key='telegram:lumitest:1:1'`))[0].n, 1);
    assert.equal(c1.task.status, "QUEUED");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_task_runs`))[0].n, 1);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM audit_events WHERE action='intake.confirmed'`))[0].n, 1);
  });
  it("5: người không được phép không tạo/xác nhận/duyệt được; ADMIN khác không xác nhận hộ nháp của Chủ", async () => {
    const w = await world();
    await rejects(createDraft(w.db, { sourceKey: "x1", channel: "TELEGRAM", actorRef: STRANGER, text: "Giao việc: a Test offer US lumitest", ttlSeconds: 900, now: T0 }), "FORBIDDEN", 403);
    await rejects(createDraft(w.db, { sourceKey: "x2", channel: "TELEGRAM", actorRef: VIEWER, text: "Giao việc: a Test offer US lumitest", ttlSeconds: 900, now: T0 }), "FORBIDDEN");
    const { draftId, task } = await newTask(w);
    await rejects(confirmDraft(w.db, ADMIN, draftId, at(1)), "FORBIDDEN");
    await rejects(confirmDraft(w.db, STRANGER, draftId, at(1)), "FORBIDDEN");
    // a stranger reusing someone's source_key cannot read the draft either
    await rejects(createDraft(w.db, { sourceKey: "telegram:lumitest:1:1", channel: "TELEGRAM", actorRef: ADMIN, text: "Giao việc: a Test offer US lumitest", ttlSeconds: 900, now: T0 }), "FORBIDDEN");
    // approve: only OWNER
    await w.db.query(`UPDATE tasks SET status='WAITING_REVIEW' WHERE id=$1`, [task.id]);
    const run = await runOf(w.db, task.id);
    await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING' WHERE id=$1`, [run.id]);
    const sub = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "v1", idempotencyKey: "k1", now: at(20) }).catch((e) => e);
    // task was forced to WAITING_REVIEW without output; submitting must refuse rather than corrupt
    assert.ok(sub instanceof LumiError);
    for (const who of [ADMIN, VIEWER, STRANGER]) await rejects(decide(w.db, { actorRef: who, outputId: "00000000-0000-0000-0000-000000000000", decision: "APPROVE", channel: "WEB", now: at(30) }), "FORBIDDEN");
  });
  it("hết hạn / sửa nháp có phiên bản / thiếu trường", async () => {
    const w = await world();
    const a: any = await createDraft(w.db, { sourceKey: "k-exp", channel: "TELEGRAM", actorRef: OWNER, text: "Giao việc: làm gì đó", ttlSeconds: 60, now: T0 });
    assert.deepEqual(a.draft.missing, ["project", "assignee"]);
    await rejects(confirmDraft(w.db, OWNER, a.draft.id, at(1)), "VALIDATION_ERROR", 400);
    await rejects(patchDraft(w.db, OWNER, a.draft.id, 7, { projectId: w.projectId }, at(2)), "STALE_VERSION", 409);
    const p1 = await patchDraft(w.db, OWNER, a.draft.id, 1, { projectId: w.projectId, assigneeId: w.asstId }, at(3));
    assert.equal(p1.version, 2); assert.deepEqual(p1.missing, []);
    await rejects(confirmDraft(w.db, OWNER, a.draft.id, at(61)), "GONE", 410);
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_intake_drafts WHERE id=$1`, [a.draft.id]))[0].state, "EXPIRED");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks WHERE source_key='k-exp'`))[0].n, 0);
  });
  it("cấu hình thiếu chặn kích hoạt (422, nêu trường); bot chưa bật → việc chờ kết nối, không có lần chạy", async () => {
    const w = await world({ configured: false });
    await w.db.query(`UPDATE lumi_assistants SET run_deadline_seconds=NULL, max_revision_rounds=NULL WHERE id=$1`, [w.asstId]);
    await assert.rejects(setDispatchEnabled(w.db, w.h, OWNER, w.asstId, true, T0), (e: any) => e.code === "CONFIG_INCOMPLETE" && e.status === 422 && e.data.missing.includes("run_deadline_seconds") && e.data.missing.includes("max_revision_rounds"));
    const { task } = await newTask(w);
    assert.equal(task.status, "WAITING_ASSISTANT");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_task_runs`))[0].n, 0);
  });
  it("kích hoạt kiểm khả năng thật của profile: vượt allowlist hoặc không đọc được → từ chối", async () => {
    const w = await world({ configured: false });
    w.h.tools = ["outputs.submit", "terminal"];
    await assert.rejects(setDispatchEnabled(w.db, w.h, OWNER, w.asstId, true, T0), (e: any) => e.code === "PROFILE_EXCEEDS_ALLOWLIST" && e.data.extra[0] === "terminal");
    w.h.tools = null;
    await rejects(setDispatchEnabled(w.db, w.h, OWNER, w.asstId, true, T0), "PROFILE_TOOLS_UNKNOWN");
    await rejects(setDispatchEnabled(w.db, w.h, ADMIN, w.asstId, true, T0), "FORBIDDEN");
  });
});

describe("M1 dispatch → bot chạy → nộp → sửa → duyệt", () => {
  it("3 + luồng chính: dispatch, ack, nộp v1, yêu cầu sửa, v2, duyệt; max_run_failures=1 không chặn vòng sửa", async () => {
    const w = await world();
    await w.db.query(`UPDATE lumi_assistants SET max_run_failures=1 WHERE id=$1`, [w.asstId]);
    const { task } = await newTask(w);
    assert.deepEqual((await drain(w, at(1))).map((x) => x.outcome), ["accepted"]);
    assert.equal(w.h.calls.length, 1);
    const run = await runOf(w.db, task.id);
    assert.equal(run.state, "DISPATCHED");
    await ackRun(w.db, "lumitest", run.id, at(2), "sess-1");
    await rejects(ackRun(w.db, "someoneelse", run.id, at(2)), "FORBIDDEN");
    const s1 = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "bản 1", idempotencyKey: "k1", now: at(10) });
    assert.equal(s1.output.version, 1);
    const dup = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "bản 1", idempotencyKey: "k1", now: at(11) });
    assert.equal(dup.alreadyProcessed, true);
    await rejects(submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "khác", idempotencyKey: "k-other", now: at(12) }), "STALE_VERSION");
    await rejects(submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:intruder", content: "x", idempotencyKey: "k9", now: at(12) }), "FORBIDDEN");
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [task.id]))[0].status, "WAITING_REVIEW");
    await rejects(decide(w.db, { actorRef: OWNER, outputId: s1.output.id, decision: "REVISE", channel: "WEB", now: at(20) }), "VALIDATION_ERROR");
    await decide(w.db, { actorRef: OWNER, outputId: s1.output.id, decision: "REVISE", reason: "thêm ví dụ", channel: "TELEGRAM_HERMES", now: at(21) });
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [task.id]))[0].status, "REVISION_REQUESTED");
    await rejects(startRun(w.db, { actorRef: VIEWER, taskId: task.id, mode: "REVISION", expectedStatus: "REVISION_REQUESTED", now: at(22) }), "FORBIDDEN");
    await startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "REVISION", expectedStatus: "REVISION_REQUESTED", instruction: "thêm ví dụ", now: at(22) });
    await drain(w, at(23)); const run2 = await runOf(w.db, task.id);
    assert.equal(run2.run_kind, "REVISION"); assert.equal(run2.attempt_no, 2);
    await ackRun(w.db, "lumitest", run2.id, at(24));
    const s2 = await submitOutput(w.db, { taskId: task.id, runId: run2.id, actorRef: "bot:lumitest", content: "bản 2", idempotencyKey: "k2", now: at(30) });
    assert.equal(s2.output.version, 2);
    // approval races / replays / stale version
    await rejects(decide(w.db, { actorRef: OWNER, outputId: s1.output.id, decision: "APPROVE", channel: "WEB", now: at(31) }), "ALREADY_DECIDED", 409); // v1 already decided differently
    const a1 = await decide(w.db, { actorRef: OWNER, outputId: s2.output.id, decision: "APPROVE", channel: "WEB", now: at(32) });
    const a2 = await decide(w.db, { actorRef: OWNER, outputId: s2.output.id, decision: "APPROVE", channel: "TELEGRAM_HERMES", now: at(33) });
    assert.equal(a1.alreadyProcessed, false); assert.equal(a2.alreadyProcessed, true);
    await rejects(decide(w.db, { actorRef: OWNER, outputId: s2.output.id, decision: "REJECT", reason: "đổi ý", channel: "WEB", now: at(34) }), "ALREADY_DECIDED");
    const [t] = await w.db.query<any>(`SELECT status,review_status,revision_round FROM tasks WHERE id=$1`, [task.id]);
    assert.deepEqual([t.status, t.review_status, t.revision_round], ["COMPLETED", "APPROVED", 1]);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_approvals WHERE object_id=$1`, [s2.output.id]))[0].n, 1);
  });

  it("vòng sửa có giới hạn riêng (REVISION_LIMIT) và retry lỗi có giới hạn riêng (RETRY_LIMIT)", async () => {
    const w = await world();
    await w.db.query(`UPDATE lumi_assistants SET max_revision_rounds=1, max_run_failures=1 WHERE id=$1`, [w.asstId]);
    const { task } = await newTask(w); await drain(w, at(1));
    let run = await runOf(w.db, task.id); await ackRun(w.db, "lumitest", run.id, at(2));
    let s = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "1", idempotencyKey: "a", now: at(3) });
    await decide(w.db, { actorRef: OWNER, outputId: s.output.id, decision: "REVISE", reason: "sửa lần 1", channel: "WEB", now: at(4) });
    await startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "REVISION", expectedStatus: "REVISION_REQUESTED", now: at(5) });
    await drain(w, at(6)); run = await runOf(w.db, task.id); await ackRun(w.db, "lumitest", run.id, at(7));
    s = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "2", idempotencyKey: "b", now: at(8) });
    await decide(w.db, { actorRef: OWNER, outputId: s.output.id, decision: "REVISE", reason: "sửa lần 2", channel: "WEB", now: at(9) });
    await assert.rejects(startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "REVISION", expectedStatus: "REVISION_REQUESTED", now: at(10) }), (e: any) => e.code === "REVISION_LIMIT");
    await startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "REVISION", expectedStatus: "REVISION_REQUESTED", forceOverLimit: true, now: at(10) });
    // now fail the run: 1 failure allowed -> retry refused
    await drain(w, at(11)); run = await runOf(w.db, task.id); await ackRun(w.db, "lumitest", run.id, at(12));
    await reap(w.db, at(12 + 601));
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [task.id]))[0].status, "FAILED");
    await assert.rejects(startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "RETRY", expectedStatus: "FAILED", now: at(700) }), (e: any) => e.code === "RETRY_LIMIT");
    await startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "REASSIGN", expectedStatus: "FAILED", instruction: "giao lại với chỉ dẫn mới", now: at(700) }); // explicit human decision still possible
  });

  it("việc giao cho người thật: nhận → nộp → duyệt; người khác không nộp được", async () => {
    const w = await world();
    const [t] = await w.db.query<any>(`INSERT INTO tasks(code,profile_slug,title,status,project_id,owner_kind,owner_actor_ref) VALUES ('DL-900','owner','Việc của PM','QUEUED',$1,'HUMAN',$2) RETURNING id`, [w.projectId, ADMIN]);
    await rejects(acceptHumanTask(w.db, OWNER, t.id, at(1)), "FORBIDDEN");
    await acceptHumanTask(w.db, ADMIN, t.id, at(2));
    await rejects(submitOutput(w.db, { taskId: t.id, actorRef: OWNER, content: "x", idempotencyKey: "h1", now: at(3) }), "FORBIDDEN");
    const s = await submitOutput(w.db, { taskId: t.id, actorRef: ADMIN, content: "xong", idempotencyKey: "h1", now: at(4) });
    await decide(w.db, { actorRef: OWNER, outputId: s.output.id, decision: "APPROVE", channel: "WEB", now: at(5) });
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [t.id]))[0].status, "COMPLETED");
  });
});

describe("M1 outbox: lease, lỗi theo loại, không gửi lại mù", () => {
  it("worker cũ mất thuê không ghi đè worker mới (epoch)", async () => {
    const w = await world(); await newTask(w);
    const a = await claimOutbox(w.db, "A", 10, at(0)); assert.ok(a);
    assert.equal(await claimOutbox(w.db, "B", 10, at(5)), null); // still leased
    const b = await claimOutbox(w.db, "B", 10, at(11)); assert.ok(b); assert.equal(b!.lease_epoch, a!.lease_epoch + 1);
    assert.equal(await finishOutbox(w.db, a!, { to: "DONE" }, at(12)), false); // stale worker refused
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_outbox WHERE id=$1`, [a!.id]))[0].state, "LEASED");
    assert.equal(await finishOutbox(w.db, b!, { to: "DONE" }, at(12)), true);
    assert.equal(await finishOutbox(w.db, b!, { to: "DEAD", error: "late" }, at(13)), false);
  });

  it("DISPATCH lỗi tạm thời → thử lại → hết lượt: run FAILED + việc FAILED; TELEGRAM lỗi KHÔNG đổi việc", async () => {
    const w = await world(); const { task } = await newTask(w);
    w.h.next = [{ kind: "rejected", transient: true, message: "502" }, { kind: "rejected", transient: true, message: "502" }, { kind: "rejected", transient: true, message: "502" }];
    assert.equal((await drain(w, at(1)))[0]!.outcome, "retry");
    assert.equal((await runOf(w.db, task.id)).state, "PENDING"); // back to pending, safe to resend: Hermes certainly did not accept
    assert.equal((await drain(w, at(500)))[0]!.outcome, "retry");
    assert.equal((await drain(w, at(1000)))[0]!.outcome, "dead"); // max_transport_attempts = 3
    assert.equal((await runOf(w.db, task.id)).error_code, "DISPATCH_FAILED");
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [task.id]))[0].status, "FAILED");

    // second task: a failed notification must leave a WAITING_REVIEW task alone
    const w2 = await world(); const t2 = (await newTask(w2)).task; await drain(w2, at(1));
    const r = await runOf(w2.db, t2.id); await ackRun(w2.db, "lumitest", r.id, at(2));
    await submitOutput(w2.db, { taskId: t2.id, runId: r.id, actorRef: "bot:lumitest", content: "ok", idempotencyKey: "n1", now: at(3) });
    for (const t of [10, 100, 400, 800, 1600, 3200]) await drain(w2, at(t), badNotify);
    const ob = (await w2.db.query<any>(`SELECT state,attempts,last_error FROM lumi_outbox WHERE kind='TELEGRAM_NOTIFY'`))[0];
    assert.equal(ob.state, "DEAD"); assert.match(ob.last_error, /telegram down/);
    assert.equal((await w2.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [t2.id]))[0].status, "WAITING_REVIEW");
  });

  it("4: kết quả không chắc (exception/timeout) → DISPATCH_UNCERTAIN, KHÔNG gửi lại; quá hạn ack cũng thành UNCERTAIN; ack muộn cứu được", async () => {
    const w = await world(); const { task } = await newTask(w);
    w.h.next = [{ kind: "throw" }];
    assert.equal((await drain(w, at(1)))[0]!.outcome, "uncertain");
    assert.equal((await drain(w, at(5000))).length, 0); assert.equal(w.h.calls.length, 1); // no blind resend
    const run = await runOf(w.db, task.id); assert.equal(run.state, "DISPATCH_UNCERTAIN");
    const [t] = await w.db.query<any>(`SELECT status,needs_decision FROM tasks WHERE id=$1`, [task.id]); assert.deepEqual([t.status, t.needs_decision], ["QUEUED", true]);
    await rejects(startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "REASSIGN", expectedStatus: "QUEUED", instruction: "gửi lại", now: at(6) }), "RUN_ACTIVE");
    await ackRun(w.db, "lumitest", run.id, at(7)); // reconciliation: Hermes did start it
    assert.equal((await runOf(w.db, task.id)).state, "RUNNING");

    const w2 = await world(); const t2 = (await newTask(w2)).task; await drain(w2, at(1)); // accepted but never acked
    assert.equal((await runOf(w2.db, t2.id)).state, "DISPATCHED");
    assert.deepEqual(await reap(w2.db, at(40)), { uncertain: 1, timedOut: 0 });
    assert.equal((await runOf(w2.db, t2.id)).state, "DISPATCH_UNCERTAIN");
  });

  it("dispatch_paused / emergency_stop chặn gửi (hoãn, không đốt lượt thử); chạm trần số lần chạy/ngày", async () => {
    const w = await world(); const { task } = await newTask(w);
    await setFlag(w.db, OWNER, "emergency_stop", true, at(0));
    assert.equal((await drain(w, at(1)))[0]!.outcome, "deferred"); assert.equal(w.h.calls.length, 0);
    assert.equal((await w.db.query<any>(`SELECT attempts FROM lumi_outbox WHERE kind='DISPATCH_RUN'`))[0].attempts, 0);
    await setFlag(w.db, OWNER, "emergency_stop", false, at(2));
    await w.db.query(`UPDATE lumi_assistants SET dispatch_paused=true WHERE id=$1`, [w.asstId]);
    assert.equal((await drain(w, at(40)))[0]!.outcome, "deferred");
    await w.db.query(`UPDATE lumi_assistants SET dispatch_paused=false WHERE id=$1`, [w.asstId]);
    assert.equal((await drain(w, at(80)))[0]!.outcome, "accepted"); assert.equal(w.h.calls.length, 1);
    await w.db.query(`UPDATE lumi_assistants SET max_runs_per_day=1`);
    await cancelTask(w.db, OWNER, task.id, "dừng để thử", at(90));
    const second = await newTask(w, "telegram:lumitest:2:2", at(100)).catch((e) => e);
    assert.ok(second instanceof LumiError && second.code === "DAILY_CAP");
  });
});

describe("M1 kết quả muộn (TDD 8.7)", () => {
  async function failedTask() {
    const w = await world(); const { task } = await newTask(w); await drain(w, at(1));
    const run = await runOf(w.db, task.id); await ackRun(w.db, "lumitest", run.id, at(2));
    await reap(w.db, at(2 + 601));
    return { w, task, run };
  }
  it("lưu kiểm toán ≠ dùng làm đầu ra; Chủ dùng → WAITING_REVIEW; lặp idempotent; bot không được dùng", async () => {
    const { w, task, run } = await failedTask();
    assert.equal((await runOf(w.db, task.id)).state, "TIMED_OUT");
    const late = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "kết quả muộn", idempotencyKey: "late1", now: at(700) });
    assert.equal(late.late, true);
    let [t] = await w.db.query<any>(`SELECT status,current_output_id FROM tasks WHERE id=$1`, [task.id]);
    assert.deepEqual([t.status, t.current_output_id], ["FAILED", null]); // task NOT reopened
    await rejects(adoptLateOutput(w.db, { actorRef: "bot:lumitest", taskId: task.id, outputId: late.output.id, expectedStatus: "FAILED", now: at(710) }), "FORBIDDEN");
    await rejects(adoptLateOutput(w.db, { actorRef: ADMIN, taskId: task.id, outputId: late.output.id, expectedStatus: "FAILED", now: at(710) }), "FORBIDDEN");
    await rejects(adoptLateOutput(w.db, { actorRef: OWNER, taskId: task.id, outputId: late.output.id, expectedStatus: "RUNNING", now: at(710) }), "STALE_VERSION");
    const ok = await adoptLateOutput(w.db, { actorRef: OWNER, taskId: task.id, outputId: late.output.id, expectedStatus: "FAILED", now: at(711) });
    const again = await adoptLateOutput(w.db, { actorRef: OWNER, taskId: task.id, outputId: late.output.id, expectedStatus: "FAILED", now: at(712) });
    assert.equal(ok.alreadyProcessed, false); assert.equal(again.alreadyProcessed, true);
    [t] = await w.db.query<any>(`SELECT status,current_output_id FROM tasks WHERE id=$1`, [task.id]);
    assert.deepEqual([t.status, t.current_output_id], ["WAITING_REVIEW", late.output.id]);
    assert.ok((await w.db.query<any>(`SELECT 1 FROM audit_events WHERE action='output.adopted_late'`)).length === 1);
  });
  it("không dùng được khi có lần chạy mới đang hoạt động (RUN_ACTIVE); không mở lại việc đã hủy/hoàn thành", async () => {
    const { w, task, run } = await failedTask();
    const late = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "muộn", idempotencyKey: "L", now: at(700) });
    await startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "RETRY", expectedStatus: "FAILED", now: at(701) });
    await rejects(adoptLateOutput(w.db, { actorRef: OWNER, taskId: task.id, outputId: late.output.id, expectedStatus: "QUEUED", now: at(702) }), "INVALID_TRANSITION");
    await cancelTask(w.db, OWNER, task.id, "hủy việc", at(703));
    const late2 = await submitOutput(w.db, { taskId: task.id, runId: run.id, actorRef: "bot:lumitest", content: "muộn 2", idempotencyKey: "L2", now: at(800) });
    assert.equal(late2.late, true);
    await rejects(adoptLateOutput(w.db, { actorRef: OWNER, taskId: task.id, outputId: late2.output.id, expectedStatus: "CANCELLED", now: at(801) }), "INVALID_TRANSITION");
    assert.equal((await w.db.query<any>(`SELECT status FROM tasks WHERE id=$1`, [task.id]))[0].status, "CANCELLED");
    await discardLateOutput(w.db, OWNER, late2.output.id);
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_task_outputs WHERE id=$1`, [late2.output.id]))[0].state, "DISCARDED");
    // RUN_ACTIVE exactly: failed task + an open run
    const f = await failedTask();
    const l = await submitOutput(f.w.db, { taskId: f.task.id, runId: f.run.id, actorRef: "bot:lumitest", content: "m", idempotencyKey: "LL", now: at(700) });
    await f.w.db.query(`INSERT INTO lumi_task_runs(task_id,attempt_no,assistant_id,run_kind,state,dispatch_key) VALUES ($1,9,$2,'RETRY','PENDING','run:manual')`, [f.task.id, f.w.asstId]);
    await rejects(adoptLateOutput(f.w.db, { actorRef: OWNER, taskId: f.task.id, outputId: l.output.id, expectedStatus: "FAILED", now: at(701) }), "RUN_ACTIVE");
  });
  it("việc đã hoàn thành: kết quả muộn của run cũ chỉ được lưu", async () => {
    const w = await world(); const { task } = await newTask(w); await drain(w, at(1));
    const r1 = await runOf(w.db, task.id); await ackRun(w.db, "lumitest", r1.id, at(2));
    await w.db.query(`UPDATE lumi_task_runs SET state='ABANDONED' WHERE id=$1`, [r1.id]); // app stopped waiting (Hermes may still run)
    assert.equal((await w.db.query<any>(`SELECT remote_stop_state FROM lumi_task_runs WHERE id=$1`, [r1.id]))[0].remote_stop_state, "NONE");
    await w.db.query(`UPDATE tasks SET status='FAILED' WHERE id=$1`, [task.id]);
    await startRun(w.db, { actorRef: OWNER, taskId: task.id, mode: "REASSIGN", expectedStatus: "FAILED", instruction: "chạy lại", now: at(10) });
    await drain(w, at(11)); const r2 = await runOf(w.db, task.id); await ackRun(w.db, "lumitest", r2.id, at(12));
    const s = await submitOutput(w.db, { taskId: task.id, runId: r2.id, actorRef: "bot:lumitest", content: "chính", idempotencyKey: "m1", now: at(13) });
    await decide(w.db, { actorRef: OWNER, outputId: s.output.id, decision: "APPROVE", channel: "WEB", now: at(14) });
    const stale = await submitOutput(w.db, { taskId: task.id, runId: r1.id, actorRef: "bot:lumitest", content: "đến muộn", idempotencyKey: "m0", now: at(20) });
    assert.equal(stale.late, true);
    const [t] = await w.db.query<any>(`SELECT status,current_output_id FROM tasks WHERE id=$1`, [task.id]);
    assert.deepEqual([t.status, t.current_output_id], ["COMPLETED", s.output.id]);
  });
});

describe("M1 ràng buộc CSDL (không dựa vào ứng dụng)", () => {
  it("hai lần chạy mở cho một việc, trùng source_key, từ chối không lý do, đầu ra trùng phiên bản đều bị chặn bởi PostgreSQL", async () => {
    const w = await world(); const { task } = await newTask(w);
    await assert.rejects(w.db.query(`INSERT INTO lumi_task_runs(task_id,attempt_no,run_kind,dispatch_key) VALUES ($1,2,'RETRY','run:dup')`, [task.id]), /lumi_runs_one_open_per_task/);
    await assert.rejects(w.db.query(`INSERT INTO tasks(code,profile_slug,title,source_key) VALUES ('DL-X','unassigned','t','telegram:lumitest:1:1')`), /tasks_source_key_uq/);
    const [o] = await w.db.query<any>(`INSERT INTO lumi_task_outputs(task_id,version,content,submitted_by,idempotency_key) VALUES ($1,1,'c','bot:x','i1') RETURNING id`, [task.id]);
    await assert.rejects(w.db.query(`INSERT INTO lumi_task_outputs(task_id,version,content,submitted_by,idempotency_key) VALUES ($1,1,'c','bot:x','i2')`, [task.id]), /lumi_outputs_task_version_uq/);
    await assert.rejects(w.db.query(`INSERT INTO lumi_approvals(kind,object_id,object_version,decision,decided_by,channel) VALUES ('OUTPUT',$1,1,'REJECT','1001','WEB')`, [o.id]), /lumi_approvals_reason_chk/);
    await w.db.query(`INSERT INTO lumi_approvals(kind,object_id,object_version,decision,decided_by,channel) VALUES ('OUTPUT',$1,1,'APPROVE','1001','WEB')`, [o.id]);
    await assert.rejects(w.db.query(`INSERT INTO lumi_approvals(kind,object_id,object_version,decision,reason,decided_by,channel) VALUES ('OUTPUT',$1,1,'REJECT','không đồng ý','1001','WEB')`, [o.id]), /lumi_approvals_final_uq/);
  });
  it("tương thích bản cũ (mô phỏng): ghi/đọc `tasks` kiểu cũ vẫn chạy trên schema mới; giá trị enum mới chỉ khi bật", async () => {
    const w = await world();
    // exactly the column set the previous release writes (see src/lib/db/schema/tasks.ts at commit 808d83f)
    await w.db.query(`INSERT INTO profiles(slug,name,type,status) VALUES ('default','Default','bot','active')`); // seeded by scripts/seed in real deployments
    await w.db.query(`INSERT INTO tasks(code,profile_slug,title,type,status,review_status,priority) VALUES ('AFF-0001','default','legacy','research','IMPORTED','NONE',0)`);
    const [t] = await w.db.query<any>(`SELECT id,code,profile_slug,title,status,review_status,priority,started_at,completed_at,created_at,updated_at FROM tasks WHERE code='AFF-0001'`);
    assert.equal(t.status, "IMPORTED");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks WHERE status IN ('ON_HOLD','WAITING_ASSISTANT')`))[0].n, 0);
  });
});
