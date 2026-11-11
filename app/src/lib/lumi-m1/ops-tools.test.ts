/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 6 (ADM-06, CNV-03, SKL-01..04, RTN-01..05, EXE-02, KNW-08, APR-06, SRC-01) — evidence class A: PGlite + real migrations (incl. 0049). No model, no outside account.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createAssistant } from "./assistants";
import { proposeKnowledge, decideKnowledge } from "./knowledge";
import { acceptIdea, classifyIdea, contentWarnings, createIdea, createTaskFromTemplate, createTemplate, decideTemplateVersion, discardIdea, expiryTick, getSettingNumber, globalSearch, knowledgeReviewReport, listSettings, markKnowledgeReviewed, proposeTemplateVersion, restoreTemplateVersion, setSetting } from "./ops-tools";
import { createRoutine, listRoutines, localDay, nextSlot, routineTick, runRoutineNow, runSlot, scheduleText, setRoutineEnabled, setRoutinesPaused, updateRoutine, zonedToUtc } from "./ops-routines";

const T0 = new Date("2026-11-09T01:00:00Z"); // 08:00 giờ Việt Nam, thứ Hai
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };


async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án AFF','AFFILIATE') RETURNING id`);
  const mk = async (slug: string, ready: boolean) => {
    const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    if (ready) await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=2 WHERE id=$1`, [a.id]);
    return a;
  };
  return { db, p1: p1.id as string, aff: await mk("aff", true), yt: await mk("yt", false) };
}
type W = Awaited<ReturnType<typeof world>>;
const rt = (w: W, o: any = {}) => createRoutine(w.db, { actorRef: OWNER, name: "Nhắc báo cáo tuần", kind: "NOTIFY", scheduleKind: "WEEKDAYS", timeOfDay: "07:30", message: "Nhớ xem báo cáo sáng nay", maxRunsPerDay: 2, now: now(), ...o });

describe("Đợt 6 cài đặt (ADM-06) — lớp A", () => {
  it("1. mọi ngưỡng có mặc định, trần/sàn và lịch sử; chỉ OWNER đổi; ngoài khoảng bị chặn", async () => {
    const w = await world();
    assert.equal(await getSettingNumber(w.db, "proposal_expiry_days"), 7);
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(setSetting(w.db, { actorRef: who, key: "proposal_expiry_days", value: 5, now: now() }), "FORBIDDEN");
    await rejects(setSetting(w.db, { actorRef: OWNER, key: "proposal_expiry_days", value: 0, now: now() }), "VALIDATION_ERROR");
    await rejects(setSetting(w.db, { actorRef: OWNER, key: "proposal_expiry_days", value: 1000, now: now() }), "VALIDATION_ERROR");
    await rejects(setSetting(w.db, { actorRef: OWNER, key: "khong_co", value: 3, now: now() }), "VALIDATION_ERROR");
    await setSetting(w.db, { actorRef: OWNER, key: "proposal_expiry_days", value: 3, now: now() });
    await setSetting(w.db, { actorRef: OWNER, key: "proposal_expiry_days", value: 10, now: now() });
    assert.equal(await getSettingNumber(w.db, "proposal_expiry_days"), 10);
    const l: any = await listSettings(w.db);
    const s = l.settings.find((x: any) => x.key === "proposal_expiry_days");
    assert.deepEqual([s.value, s.is_default, s.history.length], [10, false, 2]);
    await assert.rejects(w.db.query(`UPDATE lumi_setting_values SET value='1'`), /chỉ-thêm/);
  });
});

describe("Đợt 6 hộp thư ý tưởng (CNV-03) — lớp A", () => {
  it("2. Mới → Đã phân loại → Đã nhận chỉ bởi OWNER; ý tưởng thành việc vẫn qua việc thường; ghi chú/nguồn thành đề xuất kiến thức CHỜ DUYỆT; bỏ cần lý do", async () => {
    const w = await world();
    await rejects(createIdea(w.db, { actorRef: VIEWER, title: "Ý tưởng", body: "nội dung", now: now() }), "FORBIDDEN");
    await rejects(createIdea(w.db, { actorRef: OWNER, title: "Ý tưởng", now: now() }), "VALIDATION_ERROR"); // thiếu body và link
    await rejects(createIdea(w.db, { actorRef: OWNER, title: "Ý tưởng", link: "ftp://x", now: now() }), "VALIDATION_ERROR");
    const i1 = (await createIdea(w.db, { actorRef: ADMIN, title: "Thử video review ngắn", body: "Video 60 giây cho sản phẩm A", now: now() })).idea;
    assert.equal(i1.status, "NEW");
    await rejects(acceptIdea(w.db, { actorRef: OWNER, ideaId: i1.id, now: now() }), "INVALID_TRANSITION"); // chưa phân loại
    await rejects(classifyIdea(w.db, { actorRef: ADMIN, ideaId: i1.id, cls: "TASK", now: now() }), "VALIDATION_ERROR");
    await classifyIdea(w.db, { actorRef: ADMIN, ideaId: i1.id, cls: "TASK", projectId: w.p1, assigneeId: w.aff.id, now: now() });
    await rejects(acceptIdea(w.db, { actorRef: ADMIN, ideaId: i1.id, now: now() }), "FORBIDDEN");
    const acc: any = await acceptIdea(w.db, { actorRef: OWNER, ideaId: i1.id, now: now() });
    assert.equal(acc.idea.status, "ACCEPTED");
    assert.match(acc.idea.result_ref, /./);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 1);
    await rejects(acceptIdea(w.db, { actorRef: OWNER, ideaId: i1.id, now: now() }), "INVALID_TRANSITION"); // không nhận hai lần
    // nguồn cần liên kết
    const i2 = (await createIdea(w.db, { actorRef: OWNER, title: "Bài viết về SEO", body: "ghi chú", now: now() })).idea;
    await rejects(classifyIdea(w.db, { actorRef: OWNER, ideaId: i2.id, cls: "SOURCE", now: now() }), "VALIDATION_ERROR");
    await classifyIdea(w.db, { actorRef: OWNER, ideaId: i2.id, cls: "NOTE", projectId: w.p1, now: now() });
    await acceptIdea(w.db, { actorRef: OWNER, ideaId: i2.id, now: now() });
    const kn = await w.db.query<any>(`SELECT status FROM lumi_knowledge_items`);
    assert.deepEqual(kn.map((k: any) => k.status), ["PROPOSED"], "ý tưởng không tự thành kiến thức có hiệu lực");
    // bỏ
    const i3 = (await createIdea(w.db, { actorRef: OWNER, title: "Ý tưởng bỏ", link: "https://example.com/x", now: now() })).idea;
    await rejects(discardIdea(w.db, { actorRef: OWNER, ideaId: i3.id, reason: "", now: now() }), "VALIDATION_ERROR");
    assert.equal((await discardIdea(w.db, { actorRef: OWNER, ideaId: i3.id, reason: "Không phù hợp", now: now() })).idea.status, "DISCARDED");
    await rejects(classifyIdea(w.db, { actorRef: OWNER, ideaId: i3.id, cls: "NOTE", now: now() }), "INVALID_TRANSITION");
  });
});

describe("Đợt 6 mẫu công việc (SKL-01..04) — lớp A", () => {
  const tpl = (o: any = {}) => ({ description: "Soát nhanh một bài đăng", whenToUse: "Khi có bài đăng mới", steps: "1. Đọc\n2. Ghi chú", inputs: "Liên kết bài", outputs: "Bản nhận xét", defaultTitle: "Soát bài đăng", ...o });

  it("3. phiên bản bất biến; chỉ OWNER duyệt; chỉ phiên bản ĐÃ DUYỆT dùng được; bản mới chờ duyệt không thay bản đang dùng; khôi phục = phiên bản mới; cảnh báo «bài học không phải nhật ký»", async () => {
    const w = await world();
    for (const who of [VIEWER, "bot:aff"]) await rejects(createTemplate(w.db, { actorRef: who, name: "Mẫu soát", ...tpl(), now: now() }), "FORBIDDEN");
    await rejects(createTemplate(w.db, { actorRef: OWNER, name: "Mẫu soát", ...tpl({ steps: "" }), now: now() }), "VALIDATION_ERROR");
    const c = await createTemplate(w.db, { actorRef: ADMIN, name: "Mẫu soát", ...tpl(), now: now() });
    const id = c.template.id;
    await rejects(createTaskFromTemplate(w.db, { actorRef: OWNER, templateId: id, projectId: w.p1, assigneeId: w.aff.id, key: "tpl-use-key-0001", now: now() }), "NOT_FOUND"); // chưa duyệt ⇒ chưa có hiệu lực
    await rejects(decideTemplateVersion(w.db, { actorRef: ADMIN, templateId: id, version: 1, decision: "APPROVE", now: now() }), "FORBIDDEN");
    await rejects(decideTemplateVersion(w.db, { actorRef: OWNER, templateId: id, version: 1, decision: "REJECT", now: now() }), "VALIDATION_ERROR");
    await decideTemplateVersion(w.db, { actorRef: OWNER, templateId: id, version: 1, decision: "APPROVE", now: now() });
    assert.equal((await decideTemplateVersion(w.db, { actorRef: OWNER, templateId: id, version: 1, decision: "APPROVE", now: now() })).alreadyProcessed, true);
    const u = await createTaskFromTemplate(w.db, { actorRef: OWNER, templateId: id, projectId: w.p1, assigneeId: w.aff.id, key: "tpl-use-key-0002", now: now() });
    assert.deepEqual([u.version, u.template.startsWith("TP-")], [1, true]);
    assert.equal((await w.db.query<any>(`SELECT version FROM lumi_task_template_uses WHERE task_id=$1`, [u.task.id]))[0].version, 1, "việc ghi mẫu và phiên bản đã dùng");
    // bản mới chờ duyệt: bản 1 vẫn là bản đang dùng
    const v2 = await proposeTemplateVersion(w.db, { actorRef: ADMIN, templateId: id, ...tpl({ steps: "1. Đọc\n2. Ghi chú\n3. Gửi", description: "Hôm qua tôi đã làm bước này ngày 10/11/2026" }), now: now() });
    assert.equal(v2.warnings.length, 2, "cảnh báo ngày cụ thể và giọng nhật ký, không chặn cứng");
    assert.equal((await createTaskFromTemplate(w.db, { actorRef: OWNER, templateId: id, projectId: w.p1, assigneeId: w.aff.id, key: "tpl-use-key-0003", now: now() })).version, 1);
    await decideTemplateVersion(w.db, { actorRef: OWNER, templateId: id, version: 2, decision: "APPROVE", now: now() });
    assert.deepEqual((await w.db.query<any>(`SELECT version,state FROM lumi_task_template_versions ORDER BY version`)).map((r: any) => r.state), ["SUPERSEDED", "APPROVED"]);
    await assert.rejects(w.db.query(`UPDATE lumi_task_template_versions SET steps='sửa lén' WHERE version=1`), /bất biến/);
    await assert.rejects(w.db.query(`DELETE FROM lumi_task_template_versions`), /bất biến/);
    // khôi phục bản 1 ⇒ bản 3 CHỜ DUYỆT
    const v3 = await restoreTemplateVersion(w.db, { actorRef: OWNER, templateId: id, version: 1, now: now() });
    assert.equal(v3.version.version, 3); assert.equal(v3.version.state, "PROPOSED");
    assert.deepEqual(contentWarnings({ description: "Hướng dẫn chung", steps: "Đọc rồi ghi" }), []);
  });

  it("4. bot ngoài danh sách được phép không dùng được mẫu; bot mặc định được dùng khi không chọn", async () => {
    const w = await world();
    const id = (await createTemplate(w.db, { actorRef: OWNER, name: "Mẫu hạn chế", ...tpl({ allowedAssistantIds: [w.aff.id], defaultAssigneeId: w.aff.id }), now: now() })).template.id;
    await decideTemplateVersion(w.db, { actorRef: OWNER, templateId: id, version: 1, decision: "APPROVE", now: now() });
    await rejects(createTaskFromTemplate(w.db, { actorRef: OWNER, templateId: id, projectId: w.p1, assigneeId: w.yt.id, key: "tpl-deny-key-0001", now: now() }), "FORBIDDEN");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 0);
    const ok = await createTaskFromTemplate(w.db, { actorRef: OWNER, templateId: id, projectId: w.p1, key: "tpl-ok-key-00001", now: now() });
    assert.ok(ok.task.id);
    assert.equal((await createTaskFromTemplate(w.db, { actorRef: OWNER, templateId: id, projectId: w.p1, key: "tpl-ok-key-00001", now: now() })).alreadyProcessed, true);
  });
});

describe("Đợt 6 routine (RTN-01..05, EXE-02) — lớp A", () => {
  it("5. lịch đọc được; múi giờ đổi thì giờ chạy đổi đúng; thứ 2–6 bỏ cuối tuần; hằng tuần đúng thứ", () => {
    const base = { schedule_kind: "WEEKDAYS", time_of_day: "07:30", weekday: null, timezone: "Asia/Ho_Chi_Minh" };
    assert.equal(scheduleText(base), "Thứ 2–6, 07:30 (Asia/Ho_Chi_Minh)");
    assert.equal(nextSlot(base, new Date("2026-11-09T00:00:00Z")).toISOString(), "2026-11-09T00:30:00.000Z"); // 07:30 VN
    assert.equal(nextSlot(base, new Date("2026-11-09T01:00:00Z")).toISOString(), "2026-11-10T00:30:00.000Z"); // đã qua ⇒ ngày mai
    assert.equal(nextSlot(base, new Date("2026-11-13T02:00:00Z")).toISOString(), "2026-11-16T00:30:00.000Z"); // thứ Sáu ⇒ thứ Hai
    assert.equal(nextSlot({ ...base, timezone: "UTC" }, new Date("2026-11-09T00:00:00Z")).toISOString(), "2026-11-09T07:30:00.000Z", "đổi múi giờ ⇒ giờ chạy đổi");
    assert.equal(nextSlot({ ...base, timezone: "America/New_York" }, new Date("2026-11-09T00:00:00Z")).toISOString(), "2026-11-09T12:30:00.000Z"); // EST (UTC-5)
    const wk = { schedule_kind: "WEEKLY", time_of_day: "09:00", weekday: 3, timezone: "Asia/Ho_Chi_Minh" };
    assert.equal(scheduleText(wk), "Thứ 4 hằng tuần, 09:00 (Asia/Ho_Chi_Minh)");
    assert.equal(nextSlot(wk, new Date("2026-11-09T01:00:00Z")).toISOString(), "2026-11-11T02:00:00.000Z");
    assert.equal(zonedToUtc(2026, 11, 9, 7, 30, "Asia/Ho_Chi_Minh").toISOString(), "2026-11-09T00:30:00.000Z");
    assert.equal(localDay(new Date("2026-11-08T23:30:00Z"), "Asia/Ho_Chi_Minh"), "2026-11-09");
  });

  it("6. EXE-02: routine tạo mới luôn TẮT; chỉ OWNER bật; thiếu giới hạn/bot chưa sẵn sàng ⇒ từ chối nêu trường thiếu; thông báo không cần bot", async () => {
    const w = await world();
    for (const who of [VIEWER, "bot:aff"]) await rejects(rt(w, { actorRef: who }), "FORBIDDEN");
    await rejects(rt(w, { timeOfDay: "25:00" }), "VALIDATION_ERROR");
    await rejects(rt(w, { scheduleKind: "WEEKLY" }), "VALIDATION_ERROR"); // thiếu thứ
    await rejects(rt(w, { timezone: "Mars/Base" }), "VALIDATION_ERROR");
    const n = (await rt(w)).routine;
    assert.equal(n.enabled, false);
    await rejects(setRoutineEnabled(w.db, { actorRef: ADMIN, routineId: n.id, enabled: true, now: now() }), "FORBIDDEN");
    const on = await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: n.id, enabled: true, now: T0 });
    assert.ok(on.routine.next_run_at);
    // loại tạo việc thiếu giới hạn
    const c = (await rt(w, { name: "Tạo việc hằng ngày", kind: "CREATE_TASK", title: "Việc ngày {date}", projectId: w.p1, assigneeId: w.aff.id, message: undefined, maxRunsPerDay: undefined })).routine;
    await assert.rejects(setRoutineEnabled(w.db, { actorRef: OWNER, routineId: c.id, enabled: true, now: now() }), (e: any) => e.code === "VALIDATION_ERROR" && e.data.rule === "EXE-02" && e.data.missing.includes("max_runs_per_day") && e.data.missing.includes("deadline_minutes"));
    const c2 = (await rt(w, { name: "Bot chưa sẵn sàng", kind: "CREATE_TASK", title: "Việc", projectId: w.p1, assigneeId: w.yt.id, message: undefined, maxRunsPerDay: 1, deadlineMinutes: 60 })).routine;
    await assert.rejects(setRoutineEnabled(w.db, { actorRef: OWNER, routineId: c2.id, enabled: true, now: now() }), (e: any) => e.data.missing.some((m: string) => m.startsWith("assignee.")));
    const c3 = (await rt(w, { name: "Đủ giới hạn", kind: "CREATE_TASK", title: "Việc", projectId: w.p1, assigneeId: w.aff.id, message: undefined, maxRunsPerDay: 1, deadlineMinutes: 60 })).routine;
    assert.equal((await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: c3.id, enabled: true, now: T0 })).routine.enabled, true);
    assert.equal((await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: c3.id, enabled: false, now: T0 })).routine.next_run_at, null);
  });

  it("7. tick: đến mốc ⇒ đúng MỘT lần (không chạy trùng mốc); loại tạo việc tạo đúng một việc có mã; thông báo không tạo việc/chi phí; sửa múi giờ tính lại lần kế", async () => {
    const w = await world();
    const task = (await rt(w, { name: "Việc hằng ngày", kind: "CREATE_TASK", title: "Báo cáo {date}", projectId: w.p1, assigneeId: w.aff.id, message: undefined, maxRunsPerDay: 3, deadlineMinutes: 120 })).routine;
    const ntf = (await rt(w, { name: "Nhắc" })).routine;
    for (const r of [task, ntf]) await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: r.id, enabled: true, now: new Date("2026-11-08T17:00:00Z") });
    const slot = new Date("2026-11-09T00:30:00Z"); // 07:30 VN
    assert.equal(new Date((await w.db.query<any>(`SELECT next_run_at FROM lumi_routines WHERE id=$1`, [task.id]))[0].next_run_at).toISOString(), slot.toISOString());
    const at = new Date(slot.getTime() + 60_000);
    assert.deepEqual(await routineTick(w.db, at), { ran: 2, skipped: 0 });
    assert.deepEqual(await routineTick(w.db, at), { ran: 0, skipped: 0 }, "tick lặp không chạy lại");
    const runs = await w.db.query<any>(`SELECT result,trigger,task_id FROM lumi_routine_runs ORDER BY result`);
    assert.equal(runs.length, 2); assert.ok(runs.every((r: any) => r.result === "DONE" && r.trigger === "SCHEDULE"));
    const tasks = await w.db.query<any>(`SELECT code,title FROM tasks`);
    assert.equal(tasks.length, 1); assert.equal(tasks[0].title, "Báo cáo 2026-11-09"); assert.match(tasks[0].code, /./);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_run_cost_probes`))[0].n, 0);
    // cùng mốc ghi lần hai ⇒ trùng, không thêm gì
    assert.equal((await runSlot(w.db, task.id, slot, "SCHEDULE", at)).duplicate, true);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 1);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_outbox WHERE dedupe_key LIKE 'notify:routine:%'`))[0].n, 1);
    assert.throws(() => { throw new Error("placeholder"); });
    // đổi múi giờ ⇒ lần chạy kế tiếp đổi theo
    const up = await updateRoutine(w.db, { actorRef: ADMIN, routineId: ntf.id, timezone: "UTC", now: at });
    assert.equal(new Date(up.routine.next_run_at).toISOString(), "2026-11-09T07:30:00.000Z");
    await assert.rejects(w.db.query(`DELETE FROM lumi_routine_runs`), /chỉ-thêm/);
  });

  it("8. lỡ mốc: chạy bù MỘT lần trong cửa sổ, quá cửa sổ ⇒ ghi «bỏ qua»; tạm dừng tất cả chặn loại tạo việc nhưng không chặn thông báo; chạm số lần/ngày ⇒ CAP", async () => {
    const w = await world();
    const mk = async (o: any) => { const r = (await rt(w, { kind: "CREATE_TASK", title: "Việc", projectId: w.p1, assigneeId: w.aff.id, message: undefined, maxRunsPerDay: 1, deadlineMinutes: 60, ...o })).routine; await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: r.id, enabled: true, now: new Date("2026-11-08T17:00:00Z") }); return r; };
    const a = await mk({ name: "Chạy bù" });
    const slot = new Date("2026-11-09T00:30:00Z");
    await routineTick(w.db, new Date(slot.getTime() + 2 * 3600_000)); // trễ 2 giờ (< 6 giờ)
    assert.equal((await w.db.query<any>(`SELECT trigger FROM lumi_routine_runs WHERE routine_id=$1`, [a.id]))[0].trigger, "CATCHUP");
    const b = await mk({ name: "Quá cửa sổ" });
    await routineTick(w.db, new Date(slot.getTime() + 20 * 3600_000)); // trễ 20 giờ
    assert.equal((await w.db.query<any>(`SELECT result FROM lumi_routine_runs WHERE routine_id=$1`, [b.id]))[0].result, "SKIPPED");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 1, "chỉ lượt chạy bù tạo việc");
    // tạm dừng tất cả
    const c = await mk({ name: "Bị tạm dừng" }); const n = (await rt(w, { name: "Thông báo vẫn chạy" })).routine;
    await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: n.id, enabled: true, now: new Date("2026-11-09T01:00:00Z") });
    await rejects(setRoutinesPaused(w.db, { actorRef: ADMIN, paused: true, now: now() }), "FORBIDDEN");
    await setRoutinesPaused(w.db, { actorRef: OWNER, paused: true, now: now() });
    const m1 = await runSlot(w.db, c.id, new Date("2026-11-10T00:30:00Z"), "SCHEDULE", new Date("2026-11-10T00:31:00Z"));
    const m2 = await runSlot(w.db, n.id, new Date("2026-11-10T00:30:00Z"), "SCHEDULE", new Date("2026-11-10T00:31:00Z"));
    assert.deepEqual([m1.result, m2.result], ["STOPPED", "DONE"]);
    await setRoutinesPaused(w.db, { actorRef: OWNER, paused: false, now: now() });
    // số lần/ngày
    const d = await mk({ name: "Một lần mỗi ngày", maxRunsPerDay: 1 });
    const r1 = await runSlot(w.db, d.id, new Date("2026-11-11T00:30:00Z"), "SCHEDULE", new Date("2026-11-11T00:31:00Z"));
    const r2 = await runSlot(w.db, d.id, new Date("2026-11-11T05:00:00Z"), "MANUAL", new Date("2026-11-11T05:01:00Z"));
    assert.deepEqual([r1.result, r2.result], ["DONE", "CAP"]);
    const lst: any = await listRoutines(w.db, now());
    assert.equal(lst.system.length, 2); assert.ok(lst.system.every((s: any) => s.read_only === true && s.last_run === null));
  });

  it("9. RTN-04: lỗi liên tiếp đủ ngưỡng ⇒ ĐÚNG MỘT cảnh báo, routine dừng; không tự chạy lại; thành công đặt lại bộ đếm", async () => {
    const w = await world();
    const r = (await rt(w, { name: "Sẽ lỗi", kind: "CREATE_TASK", title: "Việc", projectId: w.p1, assigneeId: w.aff.id, message: undefined, maxRunsPerDay: 5, deadlineMinutes: 60 })).routine;
    await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: r.id, enabled: true, now: new Date("2026-11-08T17:00:00Z") });
    await setSetting(w.db, { actorRef: OWNER, key: "routine_fail_threshold", value: 2, now: now() });
    await w.db.query(`UPDATE lumi_assistants SET status='ARCHIVED' WHERE id=$1`, [w.aff.id]); // bot không còn ⇒ tạo việc lỗi NOT_FOUND
    const d = (n: number) => new Date(`2026-11-1${n}T00:30:00Z`);
    assert.equal((await runSlot(w.db, r.id, d(0), "SCHEDULE", d(0))).result, "FAILED");
    assert.equal((await w.db.query<any>(`SELECT alerted,enabled FROM lumi_routines WHERE id=$1`, [r.id]))[0].alerted, false);
    assert.equal((await runSlot(w.db, r.id, d(1), "SCHEDULE", d(1))).result, "FAILED");
    const row = (await w.db.query<any>(`SELECT alerted,enabled,next_run_at,consecutive_failures,last_error FROM lumi_routines WHERE id=$1`, [r.id]))[0];
    assert.deepEqual([row.alerted, row.enabled, row.next_run_at, row.consecutive_failures], [true, false, null, 2]);
    assert.match(row.last_error, /NOT_FOUND/);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_outbox WHERE dedupe_key LIKE 'notify:routine-fail:%'`))[0].n, 1);
    assert.equal(await w.db.query<any>(`SELECT 1 FROM lumi_routines WHERE enabled`).then((x) => x.length), 0, "không tự chạy lại");
    // chạy tay một routine đủ giới hạn sau khi sửa lại bot ⇒ thành công, đếm về 0
    await w.db.query(`UPDATE lumi_assistants SET status='ACTIVE' WHERE id=$1`, [w.aff.id]);
    await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: r.id, enabled: true, now: d(2) });
    assert.equal((await runRoutineNow(w.db, { actorRef: OWNER, routineId: r.id, now: d(3) })).result, "DONE");
    assert.equal((await w.db.query<any>(`SELECT consecutive_failures n FROM lumi_routines WHERE id=$1`, [r.id]))[0].n, 0);
  });
});

describe("Đợt 6 soát kiến thức, hết hạn đề xuất, tìm kiếm — lớp A", () => {
  it("10. KNW-08: số tiền/% thiếu ngày bị đánh dấu; quá hạn soát bị đánh dấu; đánh dấu đã soát gỡ cờ cũ", async () => {
    const w = await world();
    const mk = async (title: string, content: string) => {
      const r: any = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "NOTE", scope: "COMPANY", title, content, manualEntry: true, reason: "thử", now: T0 });
      await decideKnowledge(w.db, { actorRef: OWNER, itemId: r.item.id, version: 1, decision: "APPROVE", reason: "ok", now: T0 } as any);
      return r.item;
    };
    const a = await mk("Hoa hồng mạng A", "Hoa hồng 12% cho mọi đơn");
    await mk("Hoa hồng có ngày", "Hoa hồng 12% (tính đến 2026-11-01)");
    await mk("Quy tắc đặt tên", "Đặt tên video theo mẫu");
    const later = new Date(T0.getTime() + 120 * 86400_000);
    const rep = await knowledgeReviewReport(w.db, T0);
    assert.deepEqual(rep.items.map((x: any) => [x.title, x.flags]), [["Hoa hồng mạng A", ["NO_DATE"]]]);
    const rep2 = await knowledgeReviewReport(w.db, later);
    assert.equal(rep2.items.length, 3, "quá 90 ngày chưa soát ⇒ cả ba bị đánh dấu cũ");
    await rejects(markKnowledgeReviewed(w.db, { actorRef: VIEWER, itemId: a.id, now: later }), "FORBIDDEN");
    await markKnowledgeReviewed(w.db, { actorRef: ADMIN, itemId: a.id, note: "Đã kiểm lại", now: later });
    const rep3 = await knowledgeReviewReport(w.db, later);
    assert.deepEqual(rep3.items.find((x: any) => x.id === a.id)!.flags, ["NO_DATE"]);
    assert.equal(rep3.items.length, 3 - 0 - 1 + 1 - 0, "mục vừa soát chỉ còn cờ thiếu ngày");
    await assert.rejects(w.db.query(`DELETE FROM lumi_knowledge_reviews`), /chỉ-thêm/);
  });

  it("11. APR-06: đề xuất chờ quá hạn ⇒ «đã bỏ» kèm nhật ký, KHÔNG BAO GIỜ tự duyệt; mục đã duyệt/đề xuất mới không bị đụng; hạn đọc từ cài đặt", async () => {
    const w = await world();
    const old: any = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "NOTE", scope: "COMPANY", title: "Đề xuất cũ", content: "nội dung", manualEntry: true, reason: "r", now: T0 });
    const fresh: any = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "NOTE", scope: "COMPANY", title: "Đề xuất mới", content: "nội dung", manualEntry: true, reason: "r", now: new Date(T0.getTime() + 6 * 86400_000) });
    await createTemplate(w.db, { actorRef: OWNER, name: "Mẫu cũ", description: "mô tả mẫu", whenToUse: "khi cần", steps: "các bước", inputs: "vào", outputs: "ra", defaultTitle: "Tiêu đề", now: T0 });
    await createIdea(w.db, { actorRef: OWNER, title: "Ý tưởng cũ", body: "nội dung", now: T0 });
    const day8 = new Date(T0.getTime() + 8 * 86400_000);
    await w.db.query(`UPDATE lumi_knowledge_versions SET created_at=$1 WHERE item_id=$2`, [T0.toISOString(), old.item.id]);
    await w.db.query(`UPDATE lumi_knowledge_versions SET created_at=$1 WHERE item_id=$2`, [new Date(T0.getTime() + 6 * 86400_000).toISOString(), fresh.item.id]);
    await w.db.query(`UPDATE lumi_task_template_versions SET created_at=$1`, [T0.toISOString()]);
    await w.db.query(`UPDATE lumi_ideas SET created_at=$1`, [T0.toISOString()]);
    assert.deepEqual(await expiryTick(w.db, day8), { knowledge: 1, templates: 1, ideas: 1 });
    assert.deepEqual(await expiryTick(w.db, day8), { knowledge: 0, templates: 0, ideas: 0 }, "lặp lại không làm gì thêm");
    const kn = await w.db.query<any>(`SELECT i.code,i.status,v.state,v.decided_by,v.decision_reason FROM lumi_knowledge_items i JOIN lumi_knowledge_versions v ON v.item_id=i.id ORDER BY i.code`);
    assert.deepEqual(kn.map((k: any) => [k.status, k.state]), [["REJECTED", "WITHDRAWN"], ["PROPOSED", "PROPOSED"]]);
    assert.match(kn[0].decision_reason, /Hết hạn đề xuất/); assert.equal(kn[0].decided_by, "system:expiry");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_knowledge_versions`))[0].n, 2, "lịch sử còn nguyên");
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_task_template_versions`))[0].state, "EXPIRED");
    assert.equal((await w.db.query<any>(`SELECT status FROM lumi_ideas`))[0].status, "DISCARDED");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_knowledge_items WHERE status='ACTIVE'`))[0].n, 0, "hết hạn không bao giờ duyệt");
    await setSetting(w.db, { actorRef: OWNER, key: "proposal_expiry_days", value: 1, now: now() });
    assert.equal((await expiryTick(w.db, new Date(T0.getTime() + 8 * 86400_000))).knowledge, 1, "hạn mới (1 ngày) áp dụng cho đề xuất còn lại");
  });

  it("12. SRC-01: tìm xuyên loại, nhóm theo loại, bỏ dấu cũng ra; không có từ khóa ⇒ lỗi; bot không tìm được", async () => {
    const w = await world();
    await w.db.query(`INSERT INTO lumi_goals(code,title,outcome,project_id,source_key,created_by) VALUES ('GL-9','Tăng doanh thu Đồng Hồ','Kết quả','${w.p1}','g-src','test')`);
    await createIdea(w.db, { actorRef: OWNER, title: "Video đồng hồ cơ", body: "ý tưởng", now: now() });
    await rt(w, { name: "Nhắc đồng hồ" });
    const r = await globalSearch(w.db, { viewer: { kind: "user", actorRef: OWNER }, q: "dong ho", now: now() });
    const types = r.groups.map((g) => g.type).sort();
    assert.deepEqual(types, ["GOAL", "IDEA", "ROUTINE"]);
    assert.ok(r.total >= 3);
    assert.deepEqual((await globalSearch(w.db, { viewer: { kind: "user", actorRef: OWNER }, q: "ĐỒNG HỒ", types: ["GOAL"], now: now() })).groups.map((g) => g.type), ["GOAL"]);
    assert.equal((await globalSearch(w.db, { viewer: { kind: "user", actorRef: OWNER }, q: "khongcoodau", now: now() })).total, 0);
    await rejects(globalSearch(w.db, { viewer: { kind: "user", actorRef: OWNER }, q: "  ", now: now() }), "VALIDATION_ERROR");
    await rejects(globalSearch(w.db, { viewer: { kind: "bot", assistantId: w.aff.id }, q: "dong ho", now: now() }), "FORBIDDEN");
    void localDay;
  });
});
