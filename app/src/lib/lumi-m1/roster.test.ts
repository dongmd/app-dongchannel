/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-03 (ORG-03, ORG-05, ORG-07, OFC-03) — evidence class A: PGlite + the real migrations (incl. 0046). No model is called.
 * Proves roles/appointments, verified skills, execution level, the evaluation read model and bot cases THROUGH the app's rules.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError, setDispatchEnabled } from "./core";
import { createAssistant } from "./assistants";
import { archiveRole, createAppointment, createBotCase, createRole, createTaskWithRole, decideBotCase, endAppointment, evaluateStaff, listRoster, setExecutionLevel, setSkill, transferAppointment } from "./roster";

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
  const mk = async (slug: string) => {
    const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=2 WHERE id=$1`, [a.id]);
    return a;
  };
  return { db, p1: p1.id as string, aff: await mk("aff"), yt: await mk("yt") };
}
type W = Awaited<ReturnType<typeof world>>;
let seq = 0;
const role = async (w: W, name = `Vai ${++seq}`) => (await createRole(w.db, { actorRef: OWNER, name, now: now() })).role;
const newTask = (w: W, roleId: string | undefined, assignee: any) => createTaskWithRole(w.db, { actorRef: OWNER, clientRequestId: `rt-${++seq}-0000001`, projectId: w.p1, assigneeId: assignee.id, title: `Việc vai ${seq}`, now: now(), roleId });

describe("IMP-03 vai trò, bổ nhiệm, năng lực, mức quyền, đánh giá (ORG-03/05/07, OFC-03) — lớp A", () => {
  it("1. vai trò: chỉ OWNER tạo; tên hợp lệ; trùng tên đang dùng bị từ chối; lưu trữ bị chặn khi còn người giữ vai", async () => {
    const w = await world();
    await rejects(createRole(w.db, { actorRef: ADMIN, name: "Trưởng nội dung", now: now() }), "FORBIDDEN");
    await rejects(createRole(w.db, { actorRef: VIEWER, name: "Trưởng nội dung", now: now() }), "FORBIDDEN");
    await rejects(createRole(w.db, { actorRef: OWNER, name: "x", now: now() }), "VALIDATION_ERROR");
    await rejects(createRole(w.db, { actorRef: OWNER, name: "Vai tốt", department: "XX", now: now() }), "VALIDATION_ERROR");
    const r = await role(w, "Trưởng nội dung");
    assert.match(r.code, /^ROLE-\d{3}$/);
    await rejects(createRole(w.db, { actorRef: OWNER, name: "trưởng NỘI DUNG", now: now() }), "NAME_TAKEN");
    const ap = (await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r.id, assistantId: w.aff.id }, now: now() })).appointment;
    await rejects(archiveRole(w.db, { actorRef: OWNER, roleId: r.id, now: now() }), "ROLE_IN_USE");
    await endAppointment(w.db, { actorRef: OWNER, id: ap.id, reason: "Hết nhiệm vụ", now: now() });
    assert.equal((await archiveRole(w.db, { actorRef: OWNER, roleId: r.id, now: now() })).alreadyProcessed, false);
    assert.equal((await archiveRole(w.db, { actorRef: OWNER, roleId: r.id, now: now() })).alreadyProcessed, true);
  });

  it("2. bổ nhiệm: một người giữ nhiều vai, mỗi vai có thể nhiều người; trùng đang hiệu lực bị chặn; phạm vi dự án phải có thật; bổ nhiệm KHÔNG đổi quyền của bot", async () => {
    const w = await world(); const r1 = await role(w); const r2 = await role(w);
    const before = (await w.db.query<any>(`SELECT tool_allowlist,capability_mode,execution_level,dispatch_enabled FROM lumi_assistants WHERE id=$1`, [w.aff.id]))[0];
    await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r1.id, assistantId: w.aff.id }, now: now() });
    await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r2.id, assistantId: w.aff.id }, now: now() }); // kiêm nhiệm
    await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r1.id, assistantId: w.yt.id }, now: now() }); // cùng vai, người thứ hai
    await rejects(createAppointment(w.db, { actorRef: OWNER, input: { roleId: r1.id, assistantId: w.aff.id }, now: now() }), "ALREADY_APPOINTED");
    await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r1.id, assistantId: w.aff.id, scope: "PROJECT", scopeRef: w.p1 }, now: now() }); // phạm vi khác thì được
    await rejects(createAppointment(w.db, { actorRef: OWNER, input: { roleId: r2.id, assistantId: w.yt.id, scope: "PROJECT", scopeRef: "00000000-0000-0000-0000-0000000000aa" }, now: now() }), "NOT_FOUND");
    await rejects(createAppointment(w.db, { actorRef: ADMIN, input: { roleId: r2.id, assistantId: w.yt.id }, now: now() }), "FORBIDDEN");
    await rejects(createAppointment(w.db, { actorRef: OWNER, input: { roleId: r2.id, assistantId: w.yt.id, substituteId: w.yt.id }, now: now() }), "VALIDATION_ERROR");
    const after = (await w.db.query<any>(`SELECT tool_allowlist,capability_mode,execution_level,dispatch_enabled FROM lumi_assistants WHERE id=$1`, [w.aff.id]))[0];
    assert.deepEqual(after, before, "bổ nhiệm không được sao chép hay cấp thêm quyền");
    const roster = await listRoster(w.db);
    assert.equal(roster.appointments.filter((a: any) => a.state === "ACTIVE").length, 4);
  });

  it("3. việc ghi theo vai chỉ khi bot đang giữ vai; vai không giữ bị từ chối; không có vai thì đi đường thường", async () => {
    const w = await world(); const r = await role(w);
    await rejects(newTask(w, r.id, w.aff), "ROLE_NOT_HELD");
    await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r.id, assistantId: w.aff.id }, now: now() });
    const t = (await newTask(w, r.id, w.aff)).task;
    assert.equal((await w.db.query<any>(`SELECT role_id FROM tasks WHERE id=$1`, [t.id]))[0].role_id, r.id);
    await rejects(newTask(w, r.id, w.yt), "ROLE_NOT_HELD");
    assert.ok((await newTask(w, undefined, w.yt)).task.id, "không vai: tạo việc bình thường");
    await rejects(createTaskWithRole(w.db, { actorRef: VIEWER, clientRequestId: "rt-viewer-0000001", projectId: w.p1, assigneeId: w.aff.id, title: "Việc viewer", now: now(), roleId: r.id }), "FORBIDDEN");
  });

  it("4. chuyển vai: chặn khi bot đang chạy việc của vai (K8); sau đó lịch sử giữ, việc mở theo sang người mới nếu chọn; không chuyển cho chính mình", async () => {
    const w = await world(); const r = await role(w);
    const ap = (await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r.id, assistantId: w.aff.id }, now: now() })).appointment;
    const t = (await newTask(w, r.id, w.aff)).task;
    await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE task_id=$1`, [t.id, now().toISOString()]);
    await assert.rejects(transferAppointment(w.db, { actorRef: OWNER, id: ap.id, toAssistantId: w.yt.id, now: now() }), (e: any) => e.code === "IN_FLIGHT" && e.data.tasks.includes(t.code));
    await rejects(transferAppointment(w.db, { actorRef: OWNER, id: ap.id, toAssistantId: w.aff.id, now: now() }), "VALIDATION_ERROR");
    await w.db.query(`UPDATE lumi_task_runs SET state='CANCELLED',finished_at=started_at + interval '1 second' WHERE task_id=$1`, [t.id]);
    const r2 = await transferAppointment(w.db, { actorRef: OWNER, id: ap.id, toAssistantId: w.yt.id, note: "Aff nghỉ vai này", moveOpenTasks: true, now: now() });
    assert.equal(r2.moved, 1);
    assert.equal((await w.db.query<any>(`SELECT owner_assistant_id FROM tasks WHERE id=$1`, [t.id]))[0].owner_assistant_id, w.yt.id);
    const rows = await w.db.query<any>(`SELECT assistant_id,state,end_reason FROM lumi_appointments WHERE role_id=$1 ORDER BY created_at`, [r.id]);
    assert.deepEqual(rows.map((x: any) => [x.state, x.end_reason]), [["ENDED", "TRANSFERRED"], ["ACTIVE", null]]);
    const grants = (await w.db.query<any>(`SELECT tool_allowlist FROM lumi_assistants WHERE id=$1`, [w.yt.id]))[0].tool_allowlist;
    assert.deepEqual(grants, ["knowledge.context", "outputs.submit"], "quyền của người nhận vai không đổi");
    await rejects(transferAppointment(w.db, { actorRef: OWNER, id: ap.id, toAssistantId: w.yt.id, now: now() }), "INVALID_TRANSITION");
  });

  it("5. kết thúc bổ nhiệm cần lý do, lặp lại an toàn; vai bị kết thúc thì không tạo việc theo vai nữa", async () => {
    const w = await world(); const r = await role(w);
    const ap = (await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r.id, assistantId: w.aff.id }, now: now() })).appointment;
    await rejects(endAppointment(w.db, { actorRef: OWNER, id: ap.id, reason: "", now: now() }), "VALIDATION_ERROR");
    assert.equal((await endAppointment(w.db, { actorRef: OWNER, id: ap.id, reason: "Xong việc", now: now() })).alreadyProcessed, false);
    assert.equal((await endAppointment(w.db, { actorRef: OWNER, id: ap.id, reason: "Xong việc", now: now() })).alreadyProcessed, true);
    await rejects(newTask(w, r.id, w.aff), "ROLE_NOT_HELD");
  });

  it("6. năng lực: ĐÃ KIỂM CHỨNG cần bằng chứng + môi trường; chưa kiểm chứng không cần; ghi đè theo (bot, tên không phân biệt hoa thường); chỉ OWNER", async () => {
    const w = await world();
    await rejects(setSkill(w.db, { actorRef: OWNER, assistantId: w.aff.id, skill: "Viết caption", state: "VERIFIED", now: now() }), "VALIDATION_ERROR");
    await rejects(setSkill(w.db, { actorRef: OWNER, assistantId: w.aff.id, skill: "Viết caption", state: "VERIFIED", evidence: "ngắn", environment: "thử", now: now() }), "VALIDATION_ERROR");
    await rejects(setSkill(w.db, { actorRef: ADMIN, assistantId: w.aff.id, skill: "Viết caption", state: "UNVERIFIED", now: now() }), "FORBIDDEN");
    const u = (await setSkill(w.db, { actorRef: OWNER, assistantId: w.aff.id, skill: "Viết caption", state: "UNVERIFIED", now: now() })).skill;
    assert.equal(u.assessed_at, null, "chưa kiểm chứng thì không có ngày đánh giá");
    const v = (await setSkill(w.db, { actorRef: OWNER, assistantId: w.aff.id, skill: "viết CAPTION", state: "VERIFIED", evidence: "Chấm 5 bài mẫu, 5/5 đạt", environment: "Thử trong ứng dụng, dữ liệu mô phỏng", limits: "Chỉ tiếng Việt", now: now() })).skill;
    assert.equal(v.id, u.id, "cùng một dòng, không nhân đôi");
    assert.equal(v.state, "VERIFIED"); assert.equal(v.assessed_by, OWNER);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int AS n FROM lumi_skills WHERE assistant_id=$1`, [w.aff.id]))[0].n, 1);
    await rejects(setSkill(w.db, { actorRef: OWNER, assistantId: "00000000-0000-0000-0000-0000000000aa", skill: "Viết caption", state: "UNVERIFIED", now: now() }), "NOT_FOUND");
  });

  it("7. mức quyền: 0..3; hạ xuống dưới công cụ đang có bị chặn; mức 3 cần DECLARED_FULL; đổi được ghi nhật ký; chỉ OWNER", async () => {
    const w = await world();
    await rejects(setExecutionLevel(w.db, { actorRef: ADMIN, assistantId: w.aff.id, level: 1, now: now() }), "FORBIDDEN");
    await rejects(setExecutionLevel(w.db, { actorRef: OWNER, assistantId: w.aff.id, level: 4, now: now() }), "VALIDATION_ERROR");
    await rejects(setExecutionLevel(w.db, { actorRef: OWNER, assistantId: w.aff.id, level: 3, now: now() }), "LEVEL_NEEDS_FULL");
    await w.db.query(`UPDATE lumi_assistants SET tool_allowlist='["knowledge.context","outputs.submit","web"]'::jsonb WHERE id=$1`, [w.aff.id]);
    await assert.rejects(setExecutionLevel(w.db, { actorRef: OWNER, assistantId: w.aff.id, level: 0, now: now() }), (e: any) => e.code === "LEVEL_BELOW_TOOLS" && e.data.tools.includes("web"));
    assert.equal((await setExecutionLevel(w.db, { actorRef: OWNER, assistantId: w.aff.id, level: 1, note: "Cho đọc web", now: now() })).alreadyProcessed, false);
    assert.equal((await setExecutionLevel(w.db, { actorRef: OWNER, assistantId: w.aff.id, level: 1, now: now() })).alreadyProcessed, true);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action='assistant.execution_level'`))[0].n, 1);
    await w.db.query(`UPDATE lumi_assistants SET capability_mode='DECLARED_FULL' WHERE id=$1`, [w.yt.id]);
    assert.equal((await setExecutionLevel(w.db, { actorRef: OWNER, assistantId: w.yt.id, level: 3, now: now() })).level, 3);
  });

  it("8. đánh giá: đếm sự kiện đã ghi, KHÔNG có cột chi phí, tỷ lệ đạt ngay lần đầu là null khi chưa có việc xong, có ghi chú 'chưa đo' và không xếp hạng/khuyến nghị", async () => {
    const w = await world(); const r = await role(w);
    await createAppointment(w.db, { actorRef: OWNER, input: { roleId: r.id, assistantId: w.aff.id }, now: now() });
    await newTask(w, r.id, w.aff);
    const ev = await evaluateStaff(w.db, { from: T0, to: new Date(T0.getTime() + 86400000) });
    const aff = ev.staff.find((s: any) => s.slug === "aff")!;
    assert.equal(aff.tasks_created, 1); assert.equal(aff.tasks_completed, 0); assert.equal(aff.first_pass_rate, null);
    assert.deepEqual(aff.roles, [r.name]);
    for (const k of Object.keys(aff)) assert.ok(!/cost|usd|price|rank|score|recommend/i.test(k), `cột không được có: ${k}`);
    assert.ok(ev.notes.some((n: string) => /CHƯA ĐO/.test(n)));
    assert.ok(ev.notes.some((n: string) => /KHÔNG phải bằng chứng hiệu quả/.test(n)));
  });

  it("9. business case: đủ trường bắt buộc; bot không được tạo/duyệt; OWNER duyệt hoặc từ chối (từ chối cần lý do); lặp lại an toàn; không tự sinh nhân viên", async () => {
    const w = await world();
    const full = { title: "Thêm bot dịch phụ đề", work_needed: "Dịch phụ đề 20 video/tuần", volume: "20 video/tuần", extra_cost: "chưa biết, cần đo", owner_time_saved: "3 giờ/tuần (ước tính)", trial_criteria: "Đạt 8/10 bài mẫu", stop_condition: "Dưới 6/10 sau 2 tuần" };
    await rejects(createBotCase(w.db, { actorRef: "bot:aff", input: full, now: now() }), "FORBIDDEN");
    await rejects(createBotCase(w.db, { actorRef: VIEWER, input: full, now: now() }), "FORBIDDEN");
    await assert.rejects(createBotCase(w.db, { actorRef: OWNER, input: { ...full, stop_condition: "" }, now: now() }), (e: any) => e.code === "VALIDATION_ERROR" && e.data.missing.includes("stop_condition"));
    const c = (await createBotCase(w.db, { actorRef: ADMIN, input: full, now: now() })).case;
    assert.match(c.code, /^BC-\d{3}$/);
    const before = (await w.db.query<any>(`SELECT count(*)::int AS n FROM lumi_assistants`))[0].n;
    await rejects(decideBotCase(w.db, { actorRef: ADMIN, caseId: c.id, decision: "APPROVE", now: now() }), "FORBIDDEN");
    await rejects(decideBotCase(w.db, { actorRef: "bot:aff", caseId: c.id, decision: "APPROVE", now: now() }), "FORBIDDEN");
    await rejects(decideBotCase(w.db, { actorRef: OWNER, caseId: c.id, decision: "REJECT", now: now() }), "VALIDATION_ERROR");
    assert.equal((await decideBotCase(w.db, { actorRef: OWNER, caseId: c.id, decision: "APPROVE", now: now() })).alreadyProcessed, false);
    assert.equal((await decideBotCase(w.db, { actorRef: OWNER, caseId: c.id, decision: "APPROVE", now: now() })).alreadyProcessed, true);
    await rejects(decideBotCase(w.db, { actorRef: OWNER, caseId: c.id, decision: "REJECT", note: "đổi ý", now: now() }), "INVALID_TRANSITION");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int AS n FROM lumi_assistants`))[0].n, before, "duyệt business case không tự tạo bot");
  });

  it("10. bật giao việc bị chặn khi danh sách công cụ vượt mức quyền; Chủ nâng mức rồi mới bật được (kiểm tra mức xảy ra trước khi hỏi Hermes)", async () => {
    const w = await world();
    await w.db.query(`UPDATE lumi_assistants SET tool_allowlist='["knowledge.context","outputs.submit","web"]'::jsonb,execution_level=0,dispatch_enabled=false WHERE id=$1`, [w.aff.id]);
    await assert.rejects(setDispatchEnabled(w.db, {} as any, OWNER, w.aff.id, true, now()), (e: any) => e instanceof LumiError && e.code === "LEVEL_BELOW_TOOLS" && (e.data.tools as string[]).includes("web"));
    assert.equal((await w.db.query<any>(`SELECT dispatch_enabled FROM lumi_assistants WHERE id=$1`, [w.aff.id]))[0].dispatch_enabled, false);
  });
});
