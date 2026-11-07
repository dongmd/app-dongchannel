/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-02 (ORG-02, OFC-02, OFC-04, EXE-01) — evidence class A: PGlite + the real migrations. Hermes is faked; nothing calls a model.
 * Proves the rules (who may do what, what resets the connection, what archiving keeps and moves), NOT a real connection to Hermes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError, claimOutbox, processOutbox, setDispatchEnabled, type HermesPort, type NotifyPort } from "./core";
import { createTask } from "./core-web";
import { archiveAssistant, createAssistant, listAssistants, requestVerify, updateAssistant, validateAssistantInput, type AssistantInput } from "./assistants";

const T0 = new Date("2026-11-07T08:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const okNotify: NotifyPort = { send: async () => {} };
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
class FakeHermes implements HermesPort {
  constructor(public tools: string[] | null = ["knowledge.context", "outputs.submit"]) {}
  async readProfileTools() { return this.tools; }
  async dispatch() { return { kind: "accepted" as const, sessionRef: "sim" }; }
}
const LIMITS = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 2, maxRunsPerDay: 20 };
const input = (over: Partial<AssistantInput> = {}): AssistantInput => ({
  slug: "tro-ly-a", name: "Trợ lý A", roleLabel: "Nghiên cứu", toolAllowlist: ["knowledge.context", "outputs.submit"], limits: LIMITS, hermesProfile: "tro-ly-a", ...over,
});

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án thử','AFFILIATE') RETURNING id`);
  return { db, projectId: proj.id as string };
}
const mk = async (w: Awaited<ReturnType<typeof world>>, over: Partial<AssistantInput> = {}, key = "create-key-0001") => (await createAssistant(w.db, { actorRef: OWNER, key, input: input(over), now: T0 })).assistant;

describe("IMP-02 trợ lý: tạo, sửa, lưu trữ, kiểm tra kết nối (lớp A)", () => {
  it("1. kiểm hợp lệ liệt kê mọi trường sai; chỉ OWNER ghi; ADMIN/VIEWER bị từ chối", async () => {
    const bad = validateAssistantInput({ slug: "Sai Slug", name: "x", roleLabel: "", toolAllowlist: ["terminal"], limits: { ...LIMITS, maxRunsPerDay: 0, maxTransportAttempts: 9 } }, false);
    for (const f of ["slug", "name", "roleLabel", "toolAllowlist", "limits.maxRunsPerDay", "limits.maxTransportAttempts"]) assert.ok(bad.some((b) => b.startsWith(f)), `thiếu lỗi cho ${f}: ${bad.join(" | ")}`);
    const w = await world();
    for (const who of [ADMIN, VIEWER]) await rejects(createAssistant(w.db, { actorRef: who, key: "create-key-0002", input: input(), now: T0 }), "FORBIDDEN");
    await rejects(createAssistant(w.db, { actorRef: OWNER, key: "short", input: input(), now: T0 }), "VALIDATION_ERROR");
    await rejects(createAssistant(w.db, { actorRef: OWNER, key: "create-key-0003", input: input({ slug: "BAD SLUG" }), now: T0 }), "VALIDATION_ERROR");
  });

  it("2. tạo: hồ sơ ở trạng thái CHƯA kết nối, giao việc TẮT; trùng mã/tên/profile bị chặn; nhấn đôi cùng khóa không tạo hai; không có bí mật", async () => {
    const w = await world();
    const a = await mk(w);
    assert.deepEqual([a.connection_state, a.dispatch_enabled, a.capability_mode, a.status], ["NONE", false, "RESTRICTED", "ACTIVE"]);
    assert.equal((await w.db.query(`SELECT 1 FROM profiles WHERE slug='tro-ly-a'`)).length, 1);
    const again = await createAssistant(w.db, { actorRef: OWNER, key: "create-key-0001", input: input(), now: at(5) });
    assert.equal(again.alreadyProcessed, true); assert.equal(again.assistant.id, a.id);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_assistants`)).length, 1);
    await rejects(createAssistant(w.db, { actorRef: OWNER, key: "create-key-0009", input: input({ name: "khác", hermesProfile: "profile-khac" }), now: T0 }), "SLUG_TAKEN");
    await rejects(createAssistant(w.db, { actorRef: OWNER, key: "create-key-0010", input: input({ slug: "tro-ly-b", name: "TRỢ LÝ a", hermesProfile: "profile-b" }), now: T0 }), "NAME_TAKEN");
    await rejects(createAssistant(w.db, { actorRef: OWNER, key: "create-key-0011", input: input({ slug: "tro-ly-c", name: "Trợ lý C" }), now: T0 }), "PROFILE_TAKEN");
    const cols = Object.keys(a).join(",");
    assert.ok(!/token|secret|password|api_key/i.test(cols), `cột nhạy cảm trong hồ sơ: ${cols}`);
    // không có profile: vẫn tạo được hồ sơ (chưa gắn Hermes); yêu cầu kiểm tra bị từ chối rõ ràng
    const b = await mk(w, { slug: "tro-ly-d", name: "Trợ lý D", hermesProfile: null }, "create-key-0012");
    await rejects(requestVerify(w.db, { actorRef: OWNER, id: b.id, now: T0 }), "CONFIG_INCOMPLETE");
  });

  it("3. sửa: đổi tên/giới hạn không đụng kết nối; đổi profile hoặc công cụ đặt lại 'đã kết nối' và TẮT giao việc; không đổi mã; trùng tên bị chặn", async () => {
    const w = await world(); const h = new FakeHermes();
    const a = await mk(w); const b = await mk(w, { slug: "tro-ly-b", name: "Trợ lý B", hermesProfile: "tro-ly-b" }, "create-key-0020");
    await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(1) });
    await processOutbox(w.db, { hermes: h, notify: okNotify }, "w", at(2));
    await setDispatchEnabled(w.db, h, OWNER, a.id, true, at(3));
    let row = (await w.db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]))[0];
    assert.deepEqual([row.connection_state, row.dispatch_enabled], ["VERIFIED", true]);
    const r1 = await updateAssistant(w.db, { actorRef: OWNER, id: a.id, patch: { name: "Trợ lý A (mới)", limits: { ...LIMITS, maxRunsPerDay: 5 } }, now: at(10) });
    assert.equal(r1.connectionReset, false);
    row = (await w.db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]))[0];
    assert.deepEqual([row.name, row.max_runs_per_day, row.connection_state, row.dispatch_enabled], ["Trợ lý A (mới)", 5, "VERIFIED", true]);
    const r2 = await updateAssistant(w.db, { actorRef: OWNER, id: a.id, patch: { toolAllowlist: ["knowledge.context", "outputs.submit", "web"] }, now: at(11) });
    assert.equal(r2.connectionReset, true);
    row = (await w.db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]))[0];
    assert.deepEqual([row.connection_state, row.dispatch_enabled, row.connection_checked_at], ["NONE", false, null]);
    await rejects(updateAssistant(w.db, { actorRef: OWNER, id: a.id, patch: { slug: "doi-ma" } as any, now: at(12) }), "VALIDATION_ERROR");
    await rejects(updateAssistant(w.db, { actorRef: OWNER, id: a.id, patch: { name: "trợ lý b" }, now: at(13) }), "NAME_TAKEN");
    await rejects(updateAssistant(w.db, { actorRef: OWNER, id: b.id, patch: { hermesProfile: "tro-ly-a" }, now: at(14) }), "PROFILE_TAKEN");
    await rejects(updateAssistant(w.db, { actorRef: VIEWER, id: a.id, patch: { name: "x y" }, now: at(15) }), "FORBIDDEN");
  });

  it("4. kiểm tra kết nối THẬT chỉ do worker thực hiện: đạt ⇒ VERIFIED; công cụ vượt/thiếu/không đọc được ⇒ FAILED + lý do + TẮT giao việc; bấm đúp = một yêu cầu", async () => {
    const w = await world(); const a = await mk(w);
    await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(1) });
    const dbl = await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(2) }); // second click while the first is still unprocessed
    assert.equal(dbl.alreadyPending, true);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_outbox WHERE kind='VERIFY_ASSISTANT'`)).length, 1);
    // nothing but the worker can mark VERIFIED: the row is still NONE until it runs
    assert.equal((await w.db.query<any>(`SELECT connection_state FROM lumi_assistants WHERE id=$1`, [a.id]))[0].connection_state, "NONE");
    // a worker scoped to ANOTHER assistant does not claim it
    assert.equal(await claimOutbox(w.db, "w-other", 60, at(3), ["khac"]), null);
    const r = await processOutbox(w.db, { hermes: new FakeHermes(), notify: okNotify, slugs: ["tro-ly-a"] }, "w", at(4));
    assert.equal(r?.outcome, "verified");
    let row = (await w.db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]))[0];
    assert.deepEqual([row.connection_state, row.connection_error], ["VERIFIED", null]); assert.ok(row.connection_checked_at);
    await setDispatchEnabled(w.db, new FakeHermes(), OWNER, a.id, true, at(5));
    // asking again right after it ran (e.g. after fixing the configuration) is a NEW request, not swallowed by a time window
    const again = await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(6) });
    assert.equal(again.alreadyPending, false);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_outbox WHERE kind='VERIFY_ASSISTANT'`)).length, 2);
    assert.equal((await processOutbox(w.db, { hermes: new FakeHermes(), notify: okNotify }, "w", at(7)))?.outcome, "verified");
    // profile now exposes a tool outside the allowlist ⇒ FAILED and dispatch is switched OFF
    await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(100) });
    assert.equal((await processOutbox(w.db, { hermes: new FakeHermes(["knowledge.context", "outputs.submit", "terminal"]), notify: okNotify }, "w", at(101)))?.outcome, "verify_failed");
    row = (await w.db.query<any>(`SELECT * FROM lumi_assistants WHERE id=$1`, [a.id]))[0];
    assert.equal(row.connection_state, "FAILED"); assert.match(row.connection_error, /PROFILE_EXCEEDS_ALLOWLIST: terminal/); assert.equal(row.dispatch_enabled, false);
    for (const [tools, re] of [[null, /PROFILE_TOOLS_UNKNOWN/], [["outputs.submit"], /MISSING_TOOLS: knowledge.context/]] as const) {
      await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(200 + (tools === null ? 0 : 100)) });
      await processOutbox(w.db, { hermes: new FakeHermes(tools as any), notify: okNotify }, "w", at(201 + (tools === null ? 0 : 100)));
      assert.match((await w.db.query<any>(`SELECT connection_error FROM lumi_assistants WHERE id=$1`, [a.id]))[0].connection_error, re);
    }
    assert.ok((await w.db.query(`SELECT 1 FROM audit_events WHERE action='assistant.verified'`)).length >= 4);
  });

  it("5. chế độ thật: bật giao việc dựa vào kết quả kiểm tra GẦN của worker (web không chạm được Hermes); kết quả cũ hoặc chưa kiểm ⇒ bị từ chối", async () => {
    const w = await world(); const a = await mk(w); const unreachable = new FakeHermes(null);
    const WEEK = 7 * 24 * 3600_000;
    await rejects(setDispatchEnabled(w.db, unreachable, OWNER, a.id, true, at(1), { trustVerifiedWithinMs: WEEK }), "CONFIG_INCOMPLETE"); // not verified yet
    await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(2) });
    await processOutbox(w.db, { hermes: new FakeHermes(), notify: okNotify }, "w", at(3));
    await setDispatchEnabled(w.db, unreachable, OWNER, a.id, true, at(4), { trustVerifiedWithinMs: WEEK }); // verified seconds ago ⇒ allowed without reading Hermes
    await setDispatchEnabled(w.db, unreachable, OWNER, a.id, false, at(5));
    await rejects(setDispatchEnabled(w.db, unreachable, OWNER, a.id, true, new Date(T0.getTime() + 8 * 24 * 3600_000), { trustVerifiedWithinMs: WEEK }), "PROFILE_TOOLS_UNKNOWN"); // stale
  });

  it("6. lưu trữ: việc mở về Chủ, việc xong giữ nguyên người phụ trách; lịch sử còn; lượt chưa gửi bị hủy; chạy dở hoặc kế hoạch sống thì chặn; lặp lại an toàn", async () => {
    const w = await world(); const h = new FakeHermes(); const a = await mk(w);
    await requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(1) }); await processOutbox(w.db, { hermes: h, notify: okNotify }, "w", at(2));
    await setDispatchEnabled(w.db, h, OWNER, a.id, true, at(3));
    const t1 = (await createTask(w.db, { actorRef: OWNER, clientRequestId: "arch-task-0001", projectId: w.projectId, assigneeId: a.id, title: "Việc đang chờ chạy", now: at(10) })).task;
    const t2 = (await createTask(w.db, { actorRef: OWNER, clientRequestId: "arch-task-0002", projectId: w.projectId, assigneeId: a.id, title: "Việc đã xong", now: at(11) })).task;
    await w.db.query(`UPDATE tasks SET status='COMPLETED' WHERE id=$1`, [t2.id]);
    // a run in flight blocks the archive
    await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE task_id=$1`, [t1.id, at(12).toISOString()]);
    await rejects(archiveAssistant(w.db, { actorRef: OWNER, id: a.id, now: at(20) }), "IN_FLIGHT");
    await w.db.query(`UPDATE lumi_task_runs SET state='PENDING',started_at=NULL,acked_at=NULL WHERE task_id=$1`, [t1.id]);
    await rejects(archiveAssistant(w.db, { actorRef: VIEWER, id: a.id, now: at(20) }), "FORBIDDEN");
    const r = await archiveAssistant(w.db, { actorRef: OWNER, id: a.id, now: at(30) });
    assert.deepEqual([r.alreadyProcessed, r.transferred], [false, 1]);
    const k1 = (await w.db.query<any>(`SELECT owner_kind,owner_actor_ref,owner_assistant_id,status::text AS status FROM tasks WHERE id=$1`, [t1.id]))[0];
    assert.deepEqual([k1.owner_kind, k1.owner_actor_ref, k1.owner_assistant_id, k1.status], ["HUMAN", OWNER, null, "CAPTURED"]);
    const k2 = (await w.db.query<any>(`SELECT owner_kind,owner_assistant_id FROM tasks WHERE id=$1`, [t2.id]))[0];
    assert.deepEqual([k2.owner_kind, k2.owner_assistant_id], ["BOT", a.id]); // finished work keeps its assignee
    assert.equal((await w.db.query<any>(`SELECT name,status,dispatch_enabled FROM lumi_assistants WHERE id=$1`, [a.id]))[0].status, "ARCHIVED");
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_task_runs WHERE assistant_id=$1 AND state='CANCELLED'`, [a.id])).length, 2); // both tasks' not-yet-sent runs
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_outbox WHERE kind='DISPATCH_RUN' AND state IN ('PENDING','LEASED')`)).length, 0);
    assert.ok((await w.db.query(`SELECT 1 FROM task_activities WHERE event_type='task.owner_changed_on_archive' AND task_id=$1`, [t1.id])).length === 1);
    assert.equal((await archiveAssistant(w.db, { actorRef: OWNER, id: a.id, now: at(40) })).alreadyProcessed, true);
    await rejects(updateAssistant(w.db, { actorRef: OWNER, id: a.id, patch: { name: "Tên khác" }, now: at(41) }), "INVALID_TRANSITION");
    await rejects(requestVerify(w.db, { actorRef: OWNER, id: a.id, now: at(42) }), "INVALID_TRANSITION");
    // the name of an archived assistant can be reused; the list still shows it (history)
    await mk(w, { slug: "tro-ly-moi", name: "Trợ lý A", hermesProfile: "tro-ly-moi" }, "create-key-0030");
    const list = await listAssistants(w.db);
    assert.deepEqual(list.map((x: any) => [x.slug, x.status]).sort(), [["tro-ly-a", "ARCHIVED"], ["tro-ly-moi", "ACTIVE"]]);
  });

  it("7. kế hoạch đang sống của trợ lý trưởng chặn lưu trữ", async () => {
    const w = await world(); const a = await mk(w);
    const [g] = await w.db.query<any>(`INSERT INTO lumi_goals(code,title,outcome,project_id,created_by,source_key) VALUES ('GL-9','Mục tiêu','Kết quả',$1,$2,'goal-test-9') RETURNING id`, [w.projectId, OWNER]);
    await w.db.query(`INSERT INTO lumi_plans(code,goal_id,project_id,lead_assistant_id,status,created_by) VALUES ('PL-9',$1,$2,$3,'EXECUTING',$4)`, [g.id, w.projectId, a.id, OWNER]);
    await rejects(archiveAssistant(w.db, { actorRef: OWNER, id: a.id, now: at(1) }), "PLAN_LIVE");
  });
});
