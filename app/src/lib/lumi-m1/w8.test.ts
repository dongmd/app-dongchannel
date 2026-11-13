/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 8 nhóm 1 (ORG-06 công suất/chuyển giao, PLN-04 quỹ chuẩn bị, PLN-01 đổi trưởng kế hoạch, KNW-10 đồ thị, KNW-08 liên kết/mâu thuẫn) — evidence class A: PGlite + real migrations (incl. 0052).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createTask } from "./core-web";
import { createAssistant } from "./assistants";
import { changePlanLead, fundsOverview, leadHistory, listCapacity, setAssistantPaused, setCapacity, setPrepFund, transferWork } from "./capacity-funds";
import { checkKnowledgeLinks, checkUrl, isPrivateAddress, knowledgeConflicts, knowledgeGraph, lastLinkChecks } from "./kn-extras";
import { createSource, decideKnowledge, proposeKnowledge } from "./knowledge";
import { createRoutine, runSlot, setRoutineEnabled } from "./ops-routines";
import { getSettingNumber, globalSearch, setSetting } from "./ops-tools";

const T0 = new Date("2026-11-13T08:00:00Z");
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };
let seq = 0;

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án AFF','AFFILIATE') RETURNING id`);
  const mk = async (slug: string, member = true) => {
    const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=2 WHERE id=$1`, [a.id]);
    if (member) await db.query(`INSERT INTO lumi_project_members(project_id,assistant_id) VALUES ($1,$2)`, [p1.id, a.id]);
    return a;
  };
  return { db, p1: p1.id as string, aff: await mk("aff"), yt: await mk("yt"), out: await mk("out", false) };
}
type W = Awaited<ReturnType<typeof world>>;
const task = (w: W, a: any, title = `Việc ${++seq}`) => createTask(w.db, { actorRef: OWNER, clientRequestId: `w8-${++seq}-key-0001`, projectId: w.p1, assigneeId: a.id, title, now: T0 });

describe("Đợt 8 công suất, tạm dừng, chuyển giao (ORG-06) — lớp A", () => {
  it("1. chỉ OWNER đặt công suất; đủ công suất ⇒ việc mới bị từ chối CAPACITY_REACHED; nâng/bỏ công suất ⇒ nhận lại; tạm dừng đổi cờ và có nhật ký", async () => {
    const w = await world();
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(setCapacity(w.db, { actorRef: who, assistantId: w.aff.id, capacity: 2, now: now() }), "FORBIDDEN");
    await rejects(setCapacity(w.db, { actorRef: OWNER, assistantId: w.aff.id, capacity: 0, now: now() }), "VALIDATION_ERROR");
    await rejects(setCapacity(w.db, { actorRef: OWNER, assistantId: w.aff.id, capacity: 99, now: now() }), "VALIDATION_ERROR");
    await setCapacity(w.db, { actorRef: OWNER, assistantId: w.aff.id, capacity: 2, now: now() });
    await task(w, w.aff); await task(w, w.aff);
    await assert.rejects(task(w, w.aff), (e: any) => e instanceof LumiError && e.code === "CAPACITY_REACHED" && e.data.capacity === 2 && e.data.open === 2);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 2, "bị từ chối thì không tạo việc dở");
    await task(w, w.yt); // bot khác không bị ảnh hưởng
    await setCapacity(w.db, { actorRef: OWNER, assistantId: w.aff.id, capacity: null, now: now() });
    await task(w, w.aff);
    const p = await setAssistantPaused(w.db, { actorRef: OWNER, assistantId: w.aff.id, paused: true, now: now() });
    assert.equal(p.assistant.dispatch_paused, true);
    await rejects(setAssistantPaused(w.db, { actorRef: ADMIN, assistantId: w.aff.id, paused: false, now: now() }), "FORBIDDEN");
    const l: any = await listCapacity(w.db);
    assert.equal(l.assistants.find((x: any) => x.slug === "aff").open_tasks, 3);
  });

  it("2. chuyển giao: chỉ việc chưa chạy; bên nhận phải thuộc dự án và còn công suất; việc đang chạy không bị chuyển; mỗi lần chuyển có lịch sử bất biến", async () => {
    const w = await world();
    const a = (await task(w, w.aff)).task, b = (await task(w, w.aff)).task, c = (await task(w, w.aff)).task;
    const [run] = await w.db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [c.id]);
    await w.db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=now() WHERE id=$1`, [run.id]);
    for (const who of [ADMIN, VIEWER]) await rejects(transferWork(w.db, { actorRef: who, fromId: w.aff.id, toId: w.yt.id, reason: "cân tải", now: now() }), "FORBIDDEN");
    await rejects(transferWork(w.db, { actorRef: OWNER, fromId: w.aff.id, toId: w.yt.id, reason: "", now: now() }), "VALIDATION_ERROR");
    await rejects(transferWork(w.db, { actorRef: OWNER, fromId: w.aff.id, toId: w.aff.id, reason: "cân tải", now: now() }), "VALIDATION_ERROR");
    const r0 = await transferWork(w.db, { actorRef: OWNER, fromId: w.aff.id, toId: w.out.id, reason: "cân tải", now: now() });
    assert.equal(r0.moved.length, 0); assert.ok(r0.skipped.every((s: string) => /chưa thuộc dự án/.test(s)));
    await setCapacity(w.db, { actorRef: OWNER, assistantId: w.yt.id, capacity: 1, now: now() });
    const r1 = await transferWork(w.db, { actorRef: OWNER, fromId: w.aff.id, toId: w.yt.id, reason: "Cân tải giữa hai bot", now: now() });
    assert.equal(r1.moved.length, 1, "bên nhận chỉ còn chỗ cho 1 việc");
    assert.ok(r1.skipped.some((s: string) => /đủ công suất/.test(s)));
    await setCapacity(w.db, { actorRef: OWNER, assistantId: w.yt.id, capacity: null, now: now() });
    const r2 = await transferWork(w.db, { actorRef: OWNER, fromId: w.aff.id, toId: w.yt.id, taskIds: [a.id, b.id], reason: "Chuyển nốt", now: now() });
    assert.equal(r2.moved.length + r1.moved.length, 2);
    assert.equal((await w.db.query<any>(`SELECT owner_assistant_id o FROM tasks WHERE id=$1`, [c.id]))[0].o, w.aff.id, "việc đang chạy vẫn ở bot cũ");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_transfers`))[0].n, 2);
    await assert.rejects(w.db.query(`DELETE FROM lumi_transfers`), /chỉ-thêm/);
  });
});

describe("Đợt 8 quỹ chuẩn bị và bảng khả dụng (PLN-04) — lớp A", () => {
  it("3. chỉ OWNER đặt quỹ; một quỹ hiện hành mỗi phạm vi (đặt lại giữ bản cũ); khả dụng = quỹ − chi ĐO THẬT của lượt không thuộc kế hoạch đã duyệt; lượt chưa đo đếm riêng; lượt của việc thuộc kế hoạch không trừ quỹ chuẩn bị", async () => {
    const w = await world();
    const set = (o: any = {}) => setPrepFund(w.db, { actorRef: OWNER, scope: "COMPANY", amount: 5, periodStart: "2026-11-01", periodEnd: "2026-11-30", now: now(), ...o });
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(set({ actorRef: who }), "FORBIDDEN");
    await rejects(set({ amount: 0 }), "VALIDATION_ERROR");
    await rejects(set({ periodEnd: "2026-10-01" }), "VALIDATION_ERROR");
    await rejects(set({ scope: "ASSISTANT" }), "VALIDATION_ERROR");
    await rejects(set({ scope: "COMPANY", assistantId: w.aff.id }), "VALIDATION_ERROR");
    await set({ amount: 3 }); await set({ amount: 5 });
    assert.deepEqual((await w.db.query<any>(`SELECT active,amount::float a FROM lumi_prep_funds ORDER BY set_at`)).map((r: any) => [r.active, r.a]), [[false, 3], [true, 5]]);
    const spend = async (cost: number | null, plan = false) => {
      const t = (await task(w, w.aff)).task; const [r] = await w.db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [t.id]);
      if (plan) await w.db.query(`UPDATE tasks SET plan_task_key='k1' WHERE id=$1`, [t.id]);
      await w.db.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',started_at='2026-11-10T01:00:00Z',finished_at='2026-11-10T01:00:05Z' WHERE id=$1`, [r.id]);
      if (cost !== null) await w.db.query(`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,after_usage,currency) VALUES ($1,$2,'MEASURED',1,$3,'USD')`, [r.id, w.aff.id, 1 + cost]);
    };
    await spend(1.5); await spend(0.5); await spend(null); await spend(9, true);
    const f: any = await fundsOverview(w.db);
    const c = f.prep.find((x: any) => x.scope === "COMPANY");
    assert.deepEqual([c.amount, c.spent_measured, c.unknown_runs, c.available, c.over], [5, 2, 1, 3, false]);
    assert.match(f.note, /ĐO THẬT/);
    await set({ scope: "ASSISTANT", assistantId: w.aff.id, amount: 1 });
    const f2: any = await fundsOverview(w.db);
    const a = f2.prep.find((x: any) => x.scope === "ASSISTANT");
    assert.deepEqual([a.spent_measured, a.over, a.available], [2, true, 0], "vượt quỹ ⇒ đánh dấu, khả dụng không âm");
  });
});

describe("Đợt 8 đổi trưởng kế hoạch (PLN-01) — lớp A", () => {
  it("4. chỉ OWNER đổi; trưởng mới phải hoạt động, đã kiểm kết nối, thuộc dự án; không đổi khi chờ duyệt; có lịch sử và thông báo", async () => {
    const w = await world();
    const [goal] = await w.db.query<any>(`INSERT INTO lumi_goals(code,title,outcome,project_id,source_key,created_by) VALUES ('GL-W8','Mục tiêu','Kết quả',$1,'goal-w8','test') RETURNING id`, [w.p1]);
    const [plan] = await w.db.query<any>(`INSERT INTO lumi_plans(code,goal_id,project_id,lead_assistant_id,status,current_version,created_by) VALUES ('PL-W8',$1,$2,$3,'EXECUTING',1,'test') RETURNING id`, [goal.id, w.p1, w.aff.id]);
    const chg = (o: any = {}) => changePlanLead(w.db, { actorRef: OWNER, planId: plan.id, newLeadId: w.yt.id, reason: "YT chịu nội dung chính", now: now(), ...o });
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(chg({ actorRef: who }), "FORBIDDEN");
    await rejects(chg({ reason: "" }), "VALIDATION_ERROR");
    await rejects(chg({ newLeadId: w.aff.id }), "VALIDATION_ERROR");
    await rejects(chg({ newLeadId: w.out.id }), "VALIDATION_ERROR"); // chưa thuộc dự án
    await w.db.query(`UPDATE lumi_plans SET status='PENDING_APPROVAL' WHERE id=$1`, [plan.id]);
    await rejects(chg(), "INVALID_TRANSITION");
    await w.db.query(`UPDATE lumi_plans SET status='EXECUTING' WHERE id=$1`, [plan.id]);
    const r = await chg();
    assert.equal(r.plan.lead_assistant_id, w.yt.id);
    assert.equal((await w.db.query<any>(`SELECT lead_assistant_id l FROM lumi_plans WHERE id=$1`, [plan.id]))[0].l, w.yt.id);
    const h = await leadHistory(w.db, plan.id);
    assert.deepEqual([h.length, h[0].from_slug, h[0].to_slug], [1, "aff", "yt"]);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_outbox WHERE dedupe_key LIKE 'notify:lead:%'`))[0].n, 1);
    await assert.rejects(w.db.query(`UPDATE lumi_plan_lead_history SET reason='sửa lén'`), /chỉ-thêm/);
  });
});

describe("Đợt 8 đồ thị kiến thức, mâu thuẫn, kiểm liên kết (KNW-10, KNW-08) — lớp A", () => {
  it("5. đồ thị có nút mục + nguồn, cạnh trích dẫn/thay thế; mâu thuẫn = cùng loại và tiêu đề, khác nội dung, khác phạm vi", async () => {
    const w = await world();
    const mk = async (scope: string, ref: string | undefined, title: string, content: string, src?: any) => {
      const r: any = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "RULE", scope: scope as any, scopeRef: ref, title, content, reason: "thử", manualEntry: !src, sources: src ? [src] : undefined, now: T0 });
      await decideKnowledge(w.db, { actorRef: OWNER, itemId: r.item.id, version: 1, decision: "APPROVE", reason: "ok", now: T0 } as any);
      return r.item;
    };
    const a = await mk("COMPANY", undefined, "Độ dài mô tả", "Tối đa 100 từ", { kind: "URL", title: "Báo cáo tuần 45", ref: "https://example.com/bc" });
    await mk("PROJECT", w.p1, "Độ dài mô tả", "Tối đa 150 từ");
    await mk("PROJECT", w.p1, "Quy tắc đặt tên", "Đặt tên theo mẫu");
    const g: any = await knowledgeGraph(w.db);
    assert.equal(g.nodes.filter((n: any) => n.type === "ITEM").length, 3);
    assert.equal(g.nodes.filter((n: any) => n.type === "SOURCE").length, 1);
    assert.deepEqual(g.edges.map((e: any) => e.rel), ["CITES"]);
    const c: any = await knowledgeConflicts(w.db);
    assert.equal(c.conflicts.length, 1); assert.equal(c.conflicts[0].items.length, 2);
    void a; void createSource;
  });

  it("6. kiểm liên kết: chặn địa chỉ riêng/loopback/link-local, giao thức lạ, URL có tài khoản; không theo chuyển hướng; chỉ OWNER/ADMIN; kết quả lưu bất biến; liên kết gãy được đánh dấu", async () => {
    assert.ok(["10.0.0.5", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"].every(isPrivateAddress));
    assert.ok(!isPrivateAddress("93.184.216.34") && !isPrivateAddress("2606:2800:220:1::"));
    const pub = async () => ["93.184.216.34"];
    const fx = (st: number) => (async () => ({ status: st }) as Response) as unknown as typeof fetch;
    assert.equal((await checkUrl("ftp://x.example/a", { lookup: pub })).reason, "SCHEME_NOT_ALLOWED");
    assert.equal((await checkUrl("https://user:pw@x.example/a", { lookup: pub })).reason, "CREDENTIALS_IN_URL");
    assert.equal((await checkUrl("http://127.0.0.1:3010/api/health", { lookup: pub })).reason, "ADDRESS_NOT_PUBLIC");
    assert.equal((await checkUrl("http://metadata.internal/x", { lookup: async () => ["169.254.169.254"] })).reason, "ADDRESS_NOT_PUBLIC");
    assert.equal((await checkUrl("https://x.example/a", { lookup: async () => ["93.184.216.34", "10.0.0.1"] })).reason, "ADDRESS_NOT_PUBLIC", "một địa chỉ riêng là đủ để chặn");
    assert.deepEqual(await checkUrl("https://x.example/a", { lookup: pub, fetchFn: fx(200) }), { ok: true, status: 200, reason: "OK" });
    assert.equal((await checkUrl("https://x.example/a", { lookup: pub, fetchFn: fx(404) })).ok, false);
    assert.equal((await checkUrl("https://x.example/a", { lookup: pub, fetchFn: fx(302) })).reason, "REDIRECT");
    const w = await world();
    const r: any = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "NOTE", scope: "COMPANY", title: "Ghi chú có nguồn", content: "nội dung", reason: "thử", sources: [{ kind: "URL", title: "Nguồn A", ref: "https://x.example/a" }, { kind: "URL", title: "Nguồn B", ref: "https://y.example/b" }], now: T0 });
    await decideKnowledge(w.db, { actorRef: OWNER, itemId: r.item.id, version: 1, decision: "APPROVE", reason: "ok", now: T0 } as any);
    for (const who of [VIEWER, "bot:aff"]) await rejects(checkKnowledgeLinks(w.db, { actorRef: who, now: now() }), "FORBIDDEN");
    const out = await checkKnowledgeLinks(w.db, { actorRef: ADMIN, now: now() }, { lookup: pub, fetchFn: ((u: string) => Promise.resolve({ status: String(u).includes("y.example") ? 404 : 200 } as Response)) as unknown as typeof fetch });
    assert.equal(out.checked, 2);
    const last: any[] = await lastLinkChecks(w.db);
    assert.deepEqual(last.map((x) => x.ok).sort(), [false, true]);
    await assert.rejects(w.db.query(`DELETE FROM lumi_link_checks`), /chỉ-thêm/);
  });
});

describe("Đợt 8 lịch tự tìm cơ hội theo quỹ (PLN-12) và quét tìm kiếm cấu hình được (SRC-01/ADM-06) — lớp A", () => {
  it("7. routine «tìm cơ hội» tạo tắt; không có quỹ chuẩn bị ⇒ dừng ghi nhận; có quỹ ⇒ tạo đúng một việc; hết quỹ ⇒ dừng; không bao giờ tự mở ngân sách", async () => {
    const w = await world();
    const r = (await createRoutine(w.db, { actorRef: OWNER, name: "Tìm cơ hội hằng ngày", kind: "CREATE_TASK", scheduleKind: "DAILY", timeOfDay: "07:30", title: "Tìm cơ hội {date}", projectId: w.p1, assigneeId: w.aff.id, maxRunsPerDay: 3, deadlineMinutes: 60, purpose: "OPPORTUNITY_SCAN", now: now() })).routine;
    assert.deepEqual([r.enabled, r.purpose], [false, "OPPORTUNITY_SCAN"]);
    await rejects(createRoutine(w.db, { actorRef: OWNER, name: "Sai mục đích", kind: "NOTIFY", scheduleKind: "DAILY", timeOfDay: "07:30", message: "xin chào", maxRunsPerDay: 1, purpose: "KHAC", now: now() }), "VALIDATION_ERROR");
    await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: r.id, enabled: true, now: new Date("2026-11-12T17:00:00Z") });
    const slot = (h: number) => new Date(`2026-11-13T0${h}:30:00Z`);
    const a = await runSlot(w.db, r.id, slot(0), "SCHEDULE", slot(0));
    assert.equal(a.result, "CAP");
    assert.match((await w.db.query<any>(`SELECT error e FROM lumi_routine_runs WHERE scheduled_for=$1`, [slot(0).toISOString()]))[0].e, /Chưa có quỹ chuẩn bị/);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 0);
    await setPrepFund(w.db, { actorRef: OWNER, scope: "COMPANY", amount: 1, periodStart: "2026-11-01", periodEnd: "2026-11-30", now: now() });
    await setRoutineEnabled(w.db, { actorRef: OWNER, routineId: r.id, enabled: true, now: new Date("2026-11-12T17:00:00Z") }); // lỗi CAP không dừng routine (chỉ đếm)
    assert.equal((await runSlot(w.db, r.id, slot(1), "SCHEDULE", slot(1))).result, "DONE");
    // chi hết quỹ bằng một lượt đo thật 2 USD
    const [run] = await w.db.query<any>(`SELECT r.id FROM lumi_task_runs r JOIN tasks t ON t.id=r.task_id LIMIT 1`);
    await w.db.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',started_at='2026-11-13T01:00:00Z',finished_at='2026-11-13T01:00:05Z' WHERE id=$1`, [run.id]);
    await w.db.query(`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,after_usage,currency) VALUES ($1,$2,'MEASURED',1,3,'USD')`, [run.id, w.aff.id]);
    const b = await runSlot(w.db, r.id, slot(2), "SCHEDULE", slot(2));
    assert.equal(b.result, "CAP");
    assert.match((await w.db.query<any>(`SELECT error e FROM lumi_routine_runs WHERE scheduled_for=$1`, [slot(2).toISOString()]))[0].e, /Quỹ chuẩn bị đã hết/);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 1, "không tạo thêm việc khi hết quỹ");
  });

  it("8. số mục quét khi tìm kiếm đọc từ Cài đặt (có khoảng cho phép) và áp vào kết quả", async () => {
    const w = await world();
    for (let i = 0; i < 4; i++) await task(w, w.aff, `Báo cáo đối thủ ${i}`);
    assert.equal(await getSettingNumber(w.db, "search_scan_limit"), 1000);
    await rejects(setSetting(w.db, { actorRef: OWNER, key: "search_scan_limit", value: 50, now: now() }), "VALIDATION_ERROR");
    const all: any = await globalSearch(w.db, { viewer: { kind: "user", actorRef: OWNER }, q: "bao cao doi thu", types: ["TASK"], now: now() });
    assert.equal(all.groups[0].items.length, 4);
    await setSetting(w.db, { actorRef: OWNER, key: "search_scan_limit", value: 100, now: now() });
    assert.equal(await getSettingNumber(w.db, "search_scan_limit"), 100);
  });
});
