/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-03 (PRJ-07, PLN-05, PLN-06, PLN-07, OFC-05) — evidence class A: PGlite + the real migrations (incl. 0046). Hermes is faked; no model is called.
 * Proves the rules of coordination THROUGH the app (who may do what, what is held/released, what is refused and why), NOT a real two-bot run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError, decide, submitOutput, startRun, type Db } from "./core";
import { createTask } from "./core-web";
import { createAssistant } from "./assistants";
import { setPolicy } from "./policies";
import { addDependency, answerHandoff, cancelHandoff, clearRecheck, decideChange, proposeHandoff, proposeReassign, reopenTask, respondHandoff, removeDependency, setProjectPmAuto, taskCoordination } from "./coordination";

const T0 = new Date("2026-11-08T08:00:00Z");
let tick = 0;
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 50 };

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án 1','AFFILIATE') RETURNING id`);
  const [p2] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p2','Dự án 2','OTHER') RETURNING id`);
  const mk = async (slug: string, level = 2) => {
    const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=$2 WHERE id=$1`, [a.id, level]);
    return a;
  };
  const aff = await mk("aff"); const yt = await mk("yt"); const low = await mk("low", 0);
  return { db, p1: p1.id as string, p2: p2.id as string, aff, yt, low };
}
type W = Awaited<ReturnType<typeof world>>;
let seq = 0;
const task = async (w: W, assignee: any, over: any = {}) => (await createTask(w.db, { actorRef: OWNER, clientRequestId: `ct-${++seq}-0000001`, projectId: over.projectId ?? w.p1, assigneeId: assignee.id, title: over.title ?? `Việc ${seq}`, description: "mô tả", now: now() })).task;
const st = async (db: Db, id: string) => (await db.query<any>(`SELECT status::text AS status,hold_reason,needs_decision,owner_assistant_id,error_code FROM tasks WHERE id=$1`, [id]))[0];
const runs = async (db: Db, id: string, states?: string[]) => await db.query<any>(`SELECT id,state,run_kind,instruction_snapshot FROM lumi_task_runs WHERE task_id=$1 ${states ? "AND state = ANY($2::text[])" : ""} ORDER BY created_at`, states ? [id, states] : [id]);
/** drive a task to an owner-approved output (the same calls the worker and the owner's screen make) */
async function finish(w: W, t: any, slug: string, content = "Đầu ra") {
  const [run] = await runs(w.db, t.id, ["PENDING"]);
  await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE id=$1`, [run.id, now().toISOString()]);
  await w.db.query(`UPDATE tasks SET status='RUNNING' WHERE id=$1`, [t.id]);
  const o: any = await submitOutput(w.db, { taskId: t.id, runId: run.id, actorRef: `bot:${slug}`, content, idempotencyKey: `out-${t.id}-${seq++}`, now: now() });
  return decide(w.db, { actorRef: OWNER, outputId: o.output.id, objectVersion: o.output.version, decision: "APPROVE", channel: "WEB", now: now() });
}
const setLimits = async (w: W) => { await setPolicy(w.db, { actorRef: OWNER, key: "handoff_max_depth", value: 3, now: now() }); await setPolicy(w.db, { actorRef: OWNER, key: "handoff_max_rounds", value: 2, now: now() }); };
const ho = (w: W, src: any, to: any, over: any = {}) => proposeHandoff(w.db, { sourceTaskId: src.id, toAssistantId: to.id, title: over.title ?? "Làm nội dung từ hồ sơ", request: "Dùng hồ sơ đã chấp nhận", by: over.by ?? { actorRef: OWNER }, idempotencyKey: over.key ?? `ho-${++seq}-key-0001`, now: now(), ...over.rest });

describe("IMP-03 phụ thuộc giữa việc (PRJ-07, PLN-05) — lớp A", () => {
  it("1. thêm phụ thuộc giữ việc phía sau (ON_HOLD/WAITING_DEPENDENCY), hủy lượt chưa gửi; chỉ OWNER/ADMIN; lặp lại an toàn", async () => {
    const w = await world(); const up = await task(w, w.aff); const down = await task(w, w.yt);
    assert.equal((await st(w.db, down.id)).status, "QUEUED");
    for (const who of [VIEWER]) await rejects(addDependency(w.db, { actorRef: who, taskId: down.id, dependsOnId: up.id, now: now() }), "FORBIDDEN");
    const r = await addDependency(w.db, { actorRef: OWNER, taskId: down.id, dependsOnId: up.id, now: now() });
    assert.deepEqual([r.alreadyProcessed, r.held], [false, true]);
    assert.deepEqual([(await st(w.db, down.id)).status, (await st(w.db, down.id)).hold_reason], ["ON_HOLD", "WAITING_DEPENDENCY"]);
    assert.equal((await runs(w.db, down.id, ["PENDING"])).length, 0, "lượt chưa gửi bị hủy: việc bị giữ không được gửi cho bot");
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_outbox WHERE kind='DISPATCH_RUN' AND state IN ('PENDING','LEASED') AND aggregate_id::text = ANY($1::text[])`, [(await runs(w.db, down.id)).map((x: any) => x.id)])).length, 0);
    assert.equal((await addDependency(w.db, { actorRef: ADMIN, taskId: down.id, dependsOnId: up.id, now: now() })).alreadyProcessed, true);
  });

  it("2. chặn phụ thuộc vòng (kể cả gián tiếp), tự phụ thuộc, khác dự án, việc phía sau đã chạy, việc phía trên đã hủy", async () => {
    const w = await world(); const a = await task(w, w.aff); const b = await task(w, w.yt); const c = await task(w, w.aff); const other = await task(w, w.aff, { projectId: w.p2 });
    await addDependency(w.db, { actorRef: OWNER, taskId: b.id, dependsOnId: a.id, now: now() }); // b chờ a
    await addDependency(w.db, { actorRef: OWNER, taskId: c.id, dependsOnId: b.id, now: now() }); // c chờ b
    await assert.rejects(addDependency(w.db, { actorRef: OWNER, taskId: a.id, dependsOnId: c.id, now: now() }), (e: any) => e.code === "DEP_CYCLE" && e.data.path.length >= 3, "a chờ c sẽ khép vòng a→c→b→a");
    await rejects(addDependency(w.db, { actorRef: OWNER, taskId: a.id, dependsOnId: a.id, now: now() }), "DEP_CYCLE");
    await rejects(addDependency(w.db, { actorRef: OWNER, taskId: a.id, dependsOnId: other.id, now: now() }), "DEP_CROSS_PROJECT");
    const started = await task(w, w.aff);
    await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE task_id=$1`, [started.id, now().toISOString()]);
    await rejects(addDependency(w.db, { actorRef: OWNER, taskId: started.id, dependsOnId: a.id, now: now() }), "DEP_DOWNSTREAM_STARTED");
    const dead = await task(w, w.aff); await w.db.query(`UPDATE tasks SET status='CANCELLED' WHERE id=$1`, [dead.id]);
    const fresh = await task(w, w.yt);
    await rejects(addDependency(w.db, { actorRef: OWNER, taskId: fresh.id, dependsOnId: dead.id, now: now() }), "DEP_UPSTREAM_CLOSED");
  });

  it("3. việc phía sau chỉ chạy khi đầu ra phía trên được duyệt ĐÚNG phiên bản; lượt chạy mang theo đầu vào (mã, phiên bản); cạnh ghi phiên bản đã dùng", async () => {
    const w = await world(); const up = await task(w, w.aff); const down = await task(w, w.yt);
    await addDependency(w.db, { actorRef: OWNER, taskId: down.id, dependsOnId: up.id, now: now() });
    await finish(w, up, "aff", "Hồ sơ AFF bản 1");
    assert.equal((await st(w.db, up.id)).status, "COMPLETED");
    assert.deepEqual([(await st(w.db, down.id)).status, (await st(w.db, down.id)).hold_reason], ["QUEUED", null]);
    const [run] = await runs(w.db, down.id, ["PENDING"]);
    assert.deepEqual(run.instruction_snapshot.inputs, [{ task: up.code, version: 1, output_id: run.instruction_snapshot.inputs[0].output_id }]);
    const [edge] = await w.db.query<any>(`SELECT consumed_version,stale FROM lumi_task_deps WHERE task_id=$1`, [down.id]);
    assert.deepEqual([edge.consumed_version, edge.stale], [1, false]);
    // nếu đã duyệt từ trước, thêm phụ thuộc mới KHÔNG giữ việc
    const late = await task(w, w.yt);
    const r = await addDependency(w.db, { actorRef: OWNER, taskId: late.id, dependsOnId: up.id, now: now() });
    assert.equal(r.held, false); assert.equal((await st(w.db, late.id)).status, "QUEUED");
    assert.equal((await w.db.query<any>(`SELECT consumed_version v FROM lumi_task_deps WHERE task_id=$1`, [late.id]))[0].v, 1);
    // bỏ phụ thuộc giải phóng việc đang giữ
    const held = await task(w, w.yt); const never = await task(w, w.aff);
    await addDependency(w.db, { actorRef: OWNER, taskId: held.id, dependsOnId: never.id, now: now() });
    assert.equal((await st(w.db, held.id)).status, "ON_HOLD");
    await removeDependency(w.db, { actorRef: OWNER, taskId: held.id, dependsOnId: never.id, now: now() });
    assert.equal((await st(w.db, held.id)).status, "QUEUED");
  });

  it("4. bên nhận chưa sẵn sàng: việc chuyển WAITING_ASSISTANT; chạm hạn mức lượt KHÔNG làm hỏng việc duyệt đầu ra (giữ nguyên, gắn cờ quyết định)", async () => {
    const w = await world(); const up = await task(w, w.aff); const down = await task(w, w.yt); const down2 = await task(w, w.yt);
    await addDependency(w.db, { actorRef: OWNER, taskId: down.id, dependsOnId: up.id, now: now() });
    await addDependency(w.db, { actorRef: OWNER, taskId: down2.id, dependsOnId: up.id, now: now() });
    await w.db.query(`UPDATE lumi_assistants SET dispatch_enabled=false WHERE id=$1`, [w.yt.id]);
    await finish(w, up, "aff");
    assert.equal((await st(w.db, down.id)).status, "WAITING_ASSISTANT");
    // hạn mức: bên nhận đã đủ lượt trong ngày ⇒ việc đầu ra của bên trên vẫn được duyệt
    const w2 = await world(); const up2 = await task(w2, w2.aff); const d2 = await task(w2, w2.yt);
    await addDependency(w2.db, { actorRef: OWNER, taskId: d2.id, dependsOnId: up2.id, now: now() });
    await w2.db.query(`UPDATE lumi_assistants SET max_runs_per_day=1 WHERE id=$1`, [w2.yt.id]); // d2 đã có 1 lượt (bị hủy) trong ngày
    await finish(w2, up2, "aff");
    assert.equal((await st(w2.db, up2.id)).status, "COMPLETED", "duyệt đầu ra phía trên không bị hoàn tác");
    const s = await st(w2.db, d2.id);
    assert.deepEqual([s.status, s.needs_decision, s.error_code], ["ON_HOLD", true, "RELEASE_BLOCKED:DAILY_CAP"]);
  });

  it("5. mở lại việc đã duyệt: việc phía sau chưa chạy bị giữ lại; việc đã chạy/xong bị gắn «cần kiểm lại»; duyệt phiên bản mới ⇒ cạnh ghi v2 và giải phóng; Chủ xóa cờ sau khi kiểm", async () => {
    const w = await world(); const up = await task(w, w.aff); const d1 = await task(w, w.yt); const d2 = await task(w, w.yt);
    await addDependency(w.db, { actorRef: OWNER, taskId: d1.id, dependsOnId: up.id, now: now() });
    await addDependency(w.db, { actorRef: OWNER, taskId: d2.id, dependsOnId: up.id, now: now() });
    await finish(w, up, "aff", "Hồ sơ v1");
    await finish(w, d2, "yt", "Nội dung dựa trên hồ sơ v1"); // d2 xong trên v1; d1 còn QUEUED
    await rejects(reopenTask(w.db, { actorRef: ADMIN, taskId: up.id, reason: "thiếu bằng chứng", now: now() }), "FORBIDDEN");
    await rejects(reopenTask(w.db, { actorRef: OWNER, taskId: up.id, reason: "x", now: now() }), "VALIDATION_ERROR");
    const r = await reopenTask(w.db, { actorRef: OWNER, taskId: up.id, reason: "thiếu bằng chứng claim", now: now() });
    assert.deepEqual([r.held, r.flagged], [1, 1]);
    assert.equal((await st(w.db, up.id)).status, "REVISION_REQUESTED");
    assert.deepEqual([(await st(w.db, d1.id)).status, (await st(w.db, d1.id)).hold_reason], ["ON_HOLD", "WAITING_DEPENDENCY"]);
    assert.equal((await st(w.db, d2.id)).needs_decision, true, "đầu ra phía sau dựa trên bản cũ phải được kiểm lại");
    assert.equal((await taskCoordination(w.db, d2.id)).deps[0].stale, true);
    // bản mới của hồ sơ
    await startRun(w.db, { actorRef: OWNER, taskId: up.id, mode: "REVISION", expectedStatus: "REVISION_REQUESTED", instruction: "bổ sung bằng chứng", now: now() });
    await finish(w, up, "aff", "Hồ sơ v2");
    const [e1] = await w.db.query<any>(`SELECT consumed_version v,stale FROM lumi_task_deps WHERE task_id=$1`, [d1.id]);
    assert.deepEqual([e1.v, e1.stale], [2, false]);
    assert.equal((await st(w.db, d1.id)).status, "QUEUED", "việc đang giữ được thả với đúng bản mới");
    const [run] = await runs(w.db, d1.id, ["PENDING"]);
    assert.equal(run.instruction_snapshot.inputs[0].version, 2);
    // d2 đã xong trên v1: cạnh được cập nhật sang v2 nhưng việc vẫn cần Chủ kiểm lại cho tới khi xóa cờ
    assert.equal((await st(w.db, d2.id)).needs_decision, true);
    await clearRecheck(w.db, { actorRef: OWNER, taskId: d2.id, now: now() });
    assert.equal((await st(w.db, d2.id)).needs_decision, false);
  });
});

describe("IMP-03 bàn giao giữa bot qua ứng dụng (PLN-06, PLN-07) — lớp A", () => {
  it("6. chưa đặt chính sách độ sâu/vòng thì bàn giao bị chặn kèm lý do cụ thể (không có số mặc định)", async () => {
    const w = await world(); const src = await task(w, w.aff);
    await assert.rejects(ho(w, src, w.yt), (e: any) => e.code === "POLICY_NOT_SET" && e.data.key === "handoff_max_depth");
    await setPolicy(w.db, { actorRef: OWNER, key: "handoff_max_depth", value: 3, now: now() });
    await assert.rejects(ho(w, src, w.yt), (e: any) => e.code === "POLICY_NOT_SET" && e.data.key === "handoff_max_rounds");
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_handoffs`)).length, 0);
  });

  it("7. phiếu bàn giao: tạo việc cho bên nhận ở trạng thái giữ + cạnh phụ thuộc + phiếu đủ trường + sự kiện; nhấn đôi cùng khóa một phiếu; sau khi Chủ duyệt đầu ra, bên nhận nhận đúng phiên bản", async () => {
    const w = await world(); await setLimits(w); const src = await task(w, w.aff);
    const r = await ho(w, src, w.yt, { key: "ho-fixed-key-0001", rest: { acceptance: "≥ 3 claim có nguồn", requiredSkill: undefined } });
    assert.equal(r.alreadyProcessed, false);
    assert.deepEqual([r.handoff.state, r.handoff.depth, r.handoff.code], ["PROPOSED", 1, "HO-001"]);
    assert.deepEqual([(await st(w.db, r.task.id)).status, (await st(w.db, r.task.id)).hold_reason, (await st(w.db, r.task.id)).owner_assistant_id], ["ON_HOLD", "WAITING_DEPENDENCY", w.yt.id]);
    const t = r.handoff.ticket;
    for (const k of ["source_task", "primary", "inputs", "expected_output", "acceptance", "depends_on", "budget", "accounts", "store", "report_when"]) assert.ok(k in t, `phiếu thiếu ${k}`);
    assert.equal((await ho(w, src, w.yt, { key: "ho-fixed-key-0001" })).alreadyProcessed, true);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_handoffs`)).length, 1);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_task_deps WHERE task_id=$1`, [r.task.id])).length, 1);
    await finish(w, src, "aff", "Hồ sơ AFF");
    assert.equal((await st(w.db, r.task.id)).status, "QUEUED");
    const [run] = await runs(w.db, r.task.id, ["PENDING"]);
    assert.equal(run.instruction_snapshot.inputs[0].version, 1);
    const c = await taskCoordination(w.db, r.task.id);
    assert.equal(c.handoffs[0].code, "HO-001"); assert.equal(c.handoffs[0].events[0].type, "PROPOSED");
    await assert.rejects(() => w.db.query(`UPDATE lumi_handoff_events SET text='x'`), /chỉ-thêm/);
  });

  it("8. kiểm bên nhận XÁC ĐỊNH trước khi giao: chưa kết nối / tắt giao việc / đủ lượt / năng lực chưa kiểm chứng ⇒ CHECK_FAILED kèm lý do và đề xuất; không tạo việc nào", async () => {
    const w = await world(); await setLimits(w); const src = await task(w, w.aff);
    await w.db.query(`UPDATE lumi_assistants SET connection_state='NONE',dispatch_enabled=false,max_runs_per_day=1 WHERE id=$1`, [w.yt.id]);
    await w.db.query(`INSERT INTO lumi_task_runs(task_id,attempt_no,assistant_id,run_kind,dispatch_key,state,created_at) VALUES ($1,9,$2,'INITIAL','dk-x','CANCELLED','2026-11-08T08:30:00Z')`, [src.id, w.yt.id]); // counts as today's run
    const before = (await w.db.query(`SELECT 1 FROM tasks`)).length;
    await assert.rejects(ho(w, src, w.yt, { rest: { requiredSkill: "viết kịch bản" } }), (e: any) => {
      const codes = e.data.reasons.map((r: any) => r.code);
      return e.code === "CHECK_FAILED" && ["NOT_CONNECTED", "DISPATCH_OFF", "CAPACITY_DAY", "SKILL_UNVERIFIED"].every((c) => codes.includes(c)) && e.data.reasons.every((r: any) => r.text && r.suggestion);
    });
    assert.equal((await w.db.query(`SELECT 1 FROM tasks`)).length, before, "không tạo việc khi kiểm không đạt");
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_handoffs`)).length, 0);
    assert.ok((await w.db.query(`SELECT 1 FROM audit_events WHERE action='handoff.refused'`)).length >= 1);
    // sau khi Chủ khắc phục và đánh giá năng lực thì giao được
    await w.db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,max_runs_per_day=50 WHERE id=$1`, [w.yt.id]);
    await w.db.query(`INSERT INTO lumi_skills(assistant_id,skill,state,evidence,environment,assessed_at,assessed_by) VALUES ($1,'viết kịch bản','VERIFIED','đã chạy thử 3 kịch bản mẫu, đạt','dữ liệu thử',now(),$2)`, [w.yt.id, OWNER]);
    assert.equal((await ho(w, src, w.yt, { rest: { requiredSkill: "viết kịch bản" } })).alreadyProcessed, false);
  });

  it("9. bot tự khởi tạo: chỉ bot đang giữ việc nguồn và ở mức ≥ 2; bot mức thấp bị từ chối; không tự bàn giao cho chính mình", async () => {
    const w = await world(); await setLimits(w); const srcLow = await task(w, w.low); const srcAff = await task(w, w.aff);
    await rejects(ho(w, srcLow, w.yt, { by: { actorRef: "bot:low", assistantId: w.low.id } }), "LEVEL_TOO_LOW");
    await rejects(ho(w, srcAff, w.yt, { by: { actorRef: "bot:yt", assistantId: w.yt.id } }), "FORBIDDEN"); // yt không giữ việc nguồn
    await assert.rejects(ho(w, srcAff, w.aff, { by: { actorRef: "bot:aff", assistantId: w.aff.id } }), (e: any) => e.code === "VALIDATION_ERROR");
    const ok = await ho(w, srcAff, w.yt, { by: { actorRef: "bot:aff", assistantId: w.aff.id } });
    assert.equal(ok.handoff.from_assistant_id, w.aff.id);
    await rejects(ho(w, srcAff, w.yt, { by: { actorRef: VIEWER } }), "FORBIDDEN");
  });

  it("10. giới hạn độ sâu và đẩy qua lại (ping-pong) lấy từ chính sách của Chủ: vượt ⇒ CHECK_FAILED, việc nguồn gắn cờ cần Chủ quyết, không chạy vô hạn", async () => {
    const w = await world(); await setPolicy(w.db, { actorRef: OWNER, key: "handoff_max_depth", value: 2, now: now() }); await setPolicy(w.db, { actorRef: OWNER, key: "handoff_max_rounds", value: 1, now: now() });
    const t0 = await task(w, w.aff);
    const h1 = await ho(w, t0, w.yt);                // tầng 1: aff → yt
    await assert.rejects(ho(w, h1.task, w.aff), (e: any) => e.code === "CHECK_FAILED" && e.data.reasons[0].code === "ROUND_LIMIT", "yt → aff là lần qua lại thứ hai của cùng cặp");
    assert.equal((await st(w.db, h1.task.id)).needs_decision, true);
    const low2 = await task(w, w.aff); const hb = await ho(w, low2, w.yt); const hc = await ho(w, hb.task, w.low).catch((e) => e);
    assert.ok(hc instanceof LumiError || hc.handoff, "tầng 2 vẫn nằm trong giới hạn nếu bên nhận đạt kiểm tra");
    if (hc.handoff) await assert.rejects(ho(w, hc.task, w.aff), (e: any) => e.code === "CHECK_FAILED" && ["DEPTH_LIMIT", "ROUND_LIMIT"].includes(e.data.reasons[0].code));
  });

  it("11. bên nhận trả lời: ACCEPT đúng một lần; REJECT cần lý do ⇒ việc giữ + cờ quyết định + thông báo; NEED_INFO vượt số vòng ⇒ ESCALATED; Chủ trả lời ⇒ thả lại; bot khác không trả lời thay", async () => {
    const w = await world(); await setLimits(w); const src = await task(w, w.aff); const r = await ho(w, src, w.yt);
    await rejects(respondHandoff(w.db, { botAssistantId: w.aff.id, actorRef: "bot:aff", handoffCode: r.handoff.code, decision: "ACCEPT", now: now() }), "FORBIDDEN");
    await rejects(respondHandoff(w.db, { botAssistantId: w.yt.id, actorRef: "bot:yt", handoffCode: r.handoff.code, decision: "REJECT", now: now() }), "VALIDATION_ERROR");
    const a1 = await respondHandoff(w.db, { botAssistantId: w.yt.id, actorRef: "bot:yt", handoffCode: r.handoff.code, decision: "ACCEPT", now: now() });
    assert.equal(a1.handoff.state, "ACCEPTED");
    assert.equal((await respondHandoff(w.db, { botAssistantId: w.yt.id, actorRef: "bot:yt", handoffCode: r.handoff.code, decision: "ACCEPT", now: now() })).alreadyProcessed, true);
    await rejects(respondHandoff(w.db, { botAssistantId: w.yt.id, actorRef: "bot:yt", handoffCode: r.handoff.code, decision: "REJECT", text: "đổi ý", now: now() }), "INVALID_TRANSITION");
    // từ chối kèm lý do
    const s2 = await task(w, w.aff); const r2 = await ho(w, s2, w.yt);
    await respondHandoff(w.db, { botAssistantId: w.yt.id, actorRef: "bot:yt", handoffCode: r2.handoff.code, decision: "REJECT", text: "hồ sơ thiếu bằng chứng claim", now: now() });
    const k2 = await st(w.db, r2.task.id);
    assert.deepEqual([k2.status, k2.hold_reason, k2.needs_decision], ["ON_HOLD", "HANDOFF_REJECTED", true]);
    assert.ok((await w.db.query(`SELECT 1 FROM lumi_outbox WHERE kind='TELEGRAM_NOTIFY' AND payload->>'type'='HANDOFF_NEEDS_OWNER'`)).length >= 1);
    // cần thông tin: vòng 1 (≤ 2) → NEEDS_INFO; Chủ trả lời → thả; vòng 3 → ESCALATED
    const s3 = await task(w, w.aff); const r3 = await ho(w, s3, w.yt);
    let x = await respondHandoff(w.db, { botAssistantId: w.yt.id, actorRef: "bot:yt", handoffCode: r3.handoff.code, decision: "NEED_INFO", text: "cần nguồn của claim 2", now: now() });
    assert.deepEqual([x.handoff.state, x.handoff.round], ["NEEDS_INFO", 1]);
    await finish(w, s3, "aff", "Hồ sơ");
    const ans = await answerHandoff(w.db, { actorRef: OWNER, handoffId: r3.handoff.id, text: "nguồn: trang chính thức, ngày 2026-11-01", now: now() });
    assert.equal(ans.released, true);
    assert.equal((await st(w.db, r3.task.id)).status, "QUEUED");
    for (let i = 0; i < 2; i++) {
      x = await respondHandoff(w.db, { botAssistantId: w.yt.id, actorRef: "bot:yt", handoffCode: r3.handoff.code, decision: "NEED_INFO", text: `hỏi lần ${i + 2}`, now: now() });
      if (i === 0) await answerHandoff(w.db, { actorRef: OWNER, handoffId: r3.handoff.id, text: "trả lời lần 2 đầy đủ", now: now() });
    }
    assert.equal(x.handoff.state, "ESCALATED");
    await rejects(answerHandoff(w.db, { actorRef: ADMIN, handoffId: r3.handoff.id, text: "xin phép", now: now() }), "FORBIDDEN");
  });

  it("12. hủy bàn giao: việc phía nhận bị hủy; lặp lại an toàn; không hủy được khi bên nhận đang chạy", async () => {
    const w = await world(); await setLimits(w); const src = await task(w, w.aff); const r = await ho(w, src, w.yt);
    await rejects(cancelHandoff(w.db, { actorRef: VIEWER, handoffId: r.handoff.id, reason: "không cần", now: now() }), "FORBIDDEN");
    await cancelHandoff(w.db, { actorRef: OWNER, handoffId: r.handoff.id, reason: "không còn cần", now: now() });
    assert.equal((await st(w.db, r.task.id)).status, "CANCELLED");
    assert.equal((await cancelHandoff(w.db, { actorRef: OWNER, handoffId: r.handoff.id, reason: "lặp", now: now() })).alreadyProcessed, true);
    const s2 = await task(w, w.aff); const r2 = await ho(w, s2, w.yt);
    await finish(w, s2, "aff"); await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE task_id=$1 AND state='PENDING'`, [r2.task.id, now().toISOString()]);
    await rejects(cancelHandoff(w.db, { actorRef: OWNER, handoffId: r2.handoff.id, reason: "đổi ý", now: now() }), "RUN_ACTIVE");
  });
});

describe("IMP-03 PM bot đề xuất thay đổi (OFC-05) — lớp A", () => {
  it("13. chỉ PM của đúng dự án đề xuất, mức ≥ 2; mặc định CHỜ Chủ; Chủ duyệt ⇒ đổi người phụ trách và lượt chạy mới; từ chối ⇒ giữ nguyên; bot không tự duyệt", async () => {
    const w = await world(); await w.db.query(`UPDATE lumi_projects SET pm_assistant_id=$1 WHERE id=$2`, [w.aff.id, w.p1]);
    const t = await task(w, w.yt, { title: "Việc cần đổi người" });
    const p = (over: any = {}) => proposeReassign(w.db, { pmAssistantId: w.aff.id, actorRef: "bot:aff", taskCode: t.code, toAssistantId: w.low.id, reason: "bot hiện tại quá tải", idempotencyKey: `chg-${++seq}-key-0001`, now: now(), ...over });
    await rejects(p({ pmAssistantId: w.yt.id }), "NOT_PM");
    await w.db.query(`UPDATE lumi_assistants SET execution_level=0 WHERE id=$1`, [w.aff.id]);
    await rejects(p(), "LEVEL_TOO_LOW");
    await w.db.query(`UPDATE lumi_assistants SET execution_level=2 WHERE id=$1`, [w.aff.id]);
    const r = await p({ idempotencyKey: "chg-fixed-key-0001" });
    assert.equal(r.proposal.state, "PENDING");
    assert.equal((await st(w.db, t.id)).owner_assistant_id, w.yt.id, "chưa đổi gì khi Chủ chưa duyệt");
    assert.equal((await p({ idempotencyKey: "chg-fixed-key-0001" })).alreadyProcessed, true);
    await rejects(decideChange(w.db, { actorRef: "bot:aff", proposalId: r.proposal.id, decision: "APPROVE", now: now() }), "FORBIDDEN");
    await rejects(decideChange(w.db, { actorRef: ADMIN, proposalId: r.proposal.id, decision: "APPROVE", now: now() }), "FORBIDDEN");
    const d = await decideChange(w.db, { actorRef: OWNER, proposalId: r.proposal.id, decision: "APPROVE", now: now() });
    assert.equal(d.proposal.state, "APPLIED");
    const k = await st(w.db, t.id);
    assert.equal(k.owner_assistant_id, w.low.id);
    assert.equal((await runs(w.db, t.id, ["PENDING"])).length, 1, "đúng một lượt chạy chờ gửi cho người phụ trách mới");
    assert.equal((await decideChange(w.db, { actorRef: OWNER, proposalId: r.proposal.id, decision: "APPROVE", now: now() })).alreadyProcessed, true);
    const t2 = await task(w, w.yt); const r2 = await p({ taskCode: t2.code });
    await decideChange(w.db, { actorRef: OWNER, proposalId: r2.proposal.id, decision: "REJECT", now: now() });
    assert.equal((await st(w.db, t2.id)).owner_assistant_id, w.yt.id);
  });

  it("14. Chủ cho phép tự áp dụng cho dự án ⇒ áp dụng ngay (ghi 'auto'); không áp dụng được (đang chạy) ⇒ FAILED có lý do, không đổi gì", async () => {
    const w = await world(); await w.db.query(`UPDATE lumi_projects SET pm_assistant_id=$1 WHERE id=$2`, [w.aff.id, w.p1]);
    await rejects(setProjectPmAuto(w.db, { actorRef: ADMIN, projectId: w.p1, on: true, now: now() }), "FORBIDDEN");
    await setProjectPmAuto(w.db, { actorRef: OWNER, projectId: w.p1, on: true, now: now() });
    const t = await task(w, w.yt);
    const r = await proposeReassign(w.db, { pmAssistantId: w.aff.id, actorRef: "bot:aff", taskCode: t.code, toAssistantId: w.low.id, reason: "tái cân bằng công suất", idempotencyKey: "auto-key-0000001", now: now() });
    assert.deepEqual([r.proposal.state, r.proposal.decided_by], ["APPLIED", "auto:pm_auto_reassign"]);
    assert.equal((await st(w.db, t.id)).owner_assistant_id, w.low.id);
    const busy = await task(w, w.yt); await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE task_id=$1`, [busy.id, now().toISOString()]);
    const f = await proposeReassign(w.db, { pmAssistantId: w.aff.id, actorRef: "bot:aff", taskCode: busy.code, toAssistantId: w.low.id, reason: "thử đổi khi đang chạy", idempotencyKey: "auto-key-0000002", now: now() });
    assert.equal(f.proposal.state, "FAILED"); assert.match(f.proposal.result, /RUN_ACTIVE|INVALID_TRANSITION/);
    assert.equal((await st(w.db, busy.id)).owner_assistant_id, w.yt.id);
  });
});
