/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 8 nhóm 3 (MTG-04 họp theo lượt) — evidence class A: PGlite + real migrations (incl. 0054). Bots are simulated by calling the same domain function the MCP tool calls; no model is called.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createAssistant } from "./assistants";
import { closeTurnMeeting, listTurnMeetings, openTurnMeeting, submitTurn, turnMeetingCost, turnMeetingTick } from "./turn-meetings";
import { MCP_TOOLS } from "./mcp";

const T0 = new Date("2026-11-13T08:00:00Z");
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án AFF','AFFILIATE') RETURNING id`);
  const mk = async (slug: string, ready = true) => {
    const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    if (ready) await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=2 WHERE id=$1`, [a.id]);
    await db.query(`INSERT INTO lumi_project_members(project_id,assistant_id) VALUES ($1,$2)`, [p1.id, a.id]);
    return a;
  };
  return { db, p1: p1.id as string, aff: await mk("aff"), yt: await mk("yt"), pm: await mk("pm"), off: await mk("off", false) };
}
type W = Awaited<ReturnType<typeof world>>;
const open = (w: W, o: any = {}) => openTurnMeeting(w.db, { actorRef: OWNER, title: "Chọn ngân sách thử nghiệm", question: "Nên dành bao nhiêu cho thử nghiệm Q4?", projectId: w.p1, speakerIds: [w.aff.id, w.yt.id], maxTurns: 6, maxCost: 1, closesAt: new Date(T0.getTime() + 86400_000), now: T0, ...o });
const pending = async (w: W, code: string) => (await w.db.query<any>(`SELECT e.task_id,e.assistant_id,e.turn_no FROM lumi_turn_entries e JOIN lumi_turn_meetings m ON m.id=e.meeting_id WHERE m.code=$1 AND e.state='PENDING'`, [code]))[0];
const say = async (w: W, code: string, o: any = {}) => { const p = await pending(w, code); return submitTurn(w.db, { taskId: p.task_id, actorRef: "bot:x", assistantId: p.assistant_id, stance: "Đề xuất 200 USD cho thử nghiệm", newPosition: true, agrees: false, now: now(), ...o }); };
const meeting = async (w: W, code: string) => (await w.db.query<any>(`SELECT * FROM lumi_turn_meetings WHERE code=$1`, [code]))[0];

describe("Đợt 8 họp theo lượt (MTG-04) — lớp A", () => {
  it("1. mở: chỉ OWNER; 2–6 bot khác nhau đang hoạt động, đã kiểm kết nối, bật giao việc, thuộc dự án; trần chi phí và hạn giờ bắt buộc; lượt 1 là một việc có mã giao đúng bot đầu", async () => {
    const w = await world();
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(open(w, { actorRef: who }), "FORBIDDEN");
    await rejects(open(w, { speakerIds: [w.aff.id] }), "VALIDATION_ERROR");
    await rejects(open(w, { speakerIds: [w.aff.id, w.aff.id] }), "VALIDATION_ERROR");
    await rejects(open(w, { speakerIds: [w.aff.id, w.off.id] }), "VALIDATION_ERROR"); // bot chưa kết nối thật
    await rejects(open(w, { maxTurns: 1 }), "VALIDATION_ERROR");
    await rejects(open(w, { maxTurns: 31 }), "VALIDATION_ERROR");
    await rejects(open(w, { maxCost: undefined }), "VALIDATION_ERROR");
    await rejects(open(w, { closesAt: new Date(T0.getTime() - 1000) }), "VALIDATION_ERROR");
    await rejects(open(w, { closesAt: new Date(T0.getTime() + 30 * 86400_000) }), "VALIDATION_ERROR");
    const m = (await open(w)).meeting;
    assert.match(m.code, /^TM-\d+$/);
    const p = await pending(w, m.code);
    assert.deepEqual([p.turn_no, p.assistant_id], [1, w.aff.id]);
    assert.match((await w.db.query<any>(`SELECT description d FROM tasks WHERE id=$1`, [p.task_id]))[0].d, /người phát biểu đầu tiên/);
    assert.ok(MCP_TOOLS.some((t) => t.name === "meeting_turn_submit"));
  });

  it("2. luân phiên theo thứ tự; mỗi lượt thấy các lượt trước; một vòng đầy đủ đều đồng ý ⇒ CONCLUDED (chỉ là bản ghi, không tự có hiệu lực); gửi lại một lượt = một dòng", async () => {
    const w = await world(); const m = (await open(w)).meeting;
    const r1 = await say(w, m.code); assert.equal(r1.status, "NEXT_TURN");
    const p2 = await pending(w, m.code); assert.deepEqual([p2.turn_no, p2.assistant_id], [2, w.yt.id]);
    assert.match((await w.db.query<any>(`SELECT description d FROM tasks WHERE id=$1`, [p2.task_id]))[0].d, /Đề xuất 200 USD/);
    const again = await submitTurn(w.db, { taskId: p2.task_id, actorRef: "bot:yt", assistantId: w.yt.id, stance: "Đồng ý 200 USD", newPosition: false, agrees: true, now: now() });
    assert.equal(again.status, "NEXT_TURN");
    assert.equal((await submitTurn(w.db, { taskId: p2.task_id, actorRef: "bot:yt", assistantId: w.yt.id, stance: "Đồng ý 200 USD", newPosition: false, agrees: true, now: now() })).alreadyProcessed, true);
    await rejects(submitTurn(w.db, { taskId: (await pending(w, m.code)).task_id, actorRef: "bot:yt", assistantId: w.yt.id, stance: "sai người", newPosition: true, agrees: false, now: now() }), "NOT_FOUND");
    const r3 = await say(w, m.code, { agrees: true, newPosition: false }); // lượt 3 (aff) đồng ý: n lượt liên tiếp gần nhất (2,3) đều đồng ý
    assert.equal(r3.status, "AGREED");
    const row = await meeting(w, m.code);
    assert.deepEqual([row.state, row.outcome, row.stop_reason], ["CLOSED", "CONCLUDED", "AGREED"]);
    assert.match(row.summary, /Bot yt/);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_knowledge_items`))[0].n, 0, "kết luận không tự thành kiến thức/quyết định");
  });

  it("3. một vòng KHÔNG có lập trường mới ⇒ dừng «chưa kết luận» (hai bot không đẩy qua lại mãi); chạm số lượt tối đa ⇒ dừng; lượt tới muộn sau khi đóng bị ghi «muộn», không đổi kết quả", async () => {
    const w = await world(); const m = (await open(w, { maxTurns: 10 })).meeting;
    await say(w, m.code, { newPosition: true }); await say(w, m.code, { newPosition: true });      // vòng 1 có lập trường mới
    await say(w, m.code, { newPosition: false }); const r = await say(w, m.code, { newPosition: false }); // vòng (3,4) không có gì mới
    assert.equal(r.status, "NO_NEW_POSITION");
    const row = await meeting(w, m.code); assert.deepEqual([row.outcome, row.stop_reason], ["NOT_CONCLUDED", "NO_NEW_POSITION"]);
    const m2 = (await open(w, { maxTurns: 3 })).meeting;
    await say(w, m2.code); await say(w, m2.code); const r3 = await say(w, m2.code);
    assert.equal(r3.status, "MAX_TURNS");
    // lượt muộn: mở họp, đóng tay khi còn một lượt chờ, rồi bot nộp muộn
    const m3 = (await open(w)).meeting; const late = await pending(w, m3.code);
    await rejects(closeTurnMeeting(w.db, { actorRef: ADMIN, code: m3.code, reason: "dừng", now: now() }), "FORBIDDEN");
    await rejects(closeTurnMeeting(w.db, { actorRef: OWNER, code: m3.code, reason: "", now: now() }), "VALIDATION_ERROR");
    await closeTurnMeeting(w.db, { actorRef: OWNER, code: m3.code, reason: "Chủ dừng họp", now: now() });
    assert.equal((await closeTurnMeeting(w.db, { actorRef: OWNER, code: m3.code, reason: "lặp", now: now() })).alreadyProcessed, true);
    const l = await submitTurn(w.db, { taskId: late.task_id, actorRef: "bot:aff", assistantId: late.assistant_id, stance: "Nộp muộn", newPosition: true, agrees: true, now: now() });
    assert.equal((l as any).late, true);
    assert.deepEqual([(await meeting(w, m3.code)).outcome, (await meeting(w, m3.code)).stop_reason], ["NOT_CONCLUDED", "MANUAL"]);
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_turn_entries WHERE task_id=$1`, [late.task_id]))[0].state, "SKIPPED");
  });

  it("4. trần chi phí ĐO THẬT: chạm trần ⇒ dừng COST; lượt chưa đo đếm riêng (không phải 0); hạn giờ: tick đóng họp quá hạn và bỏ lượt chờ", async () => {
    const w = await world(); const m = (await open(w, { maxCost: 0.5 })).meeting;
    const p1 = await pending(w, m.code);
    const [run] = await w.db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [p1.task_id]);
    await w.db.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',started_at=$2,finished_at=$2 WHERE id=$1`, [run.id, T0.toISOString()]);
    await w.db.query(`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,after_usage,currency) VALUES ($1,$2,'MEASURED',1,1.6,'USD')`, [run.id, p1.assistant_id]);
    assert.equal(Math.round((await turnMeetingCost(w.db, m.id)).measured * 10) / 10, 0.6);
    const r = await submitTurn(w.db, { taskId: p1.task_id, actorRef: "bot:aff", assistantId: p1.assistant_id, stance: "Lượt đầu tốn kém", newPosition: true, agrees: false, now: now() });
    assert.equal(r.status, "COST");
    assert.equal((await meeting(w, m.code)).stop_reason, "COST");
    // hạn giờ
    const m2 = (await open(w, { closesAt: new Date(T0.getTime() + 3600_000) })).meeting;
    assert.equal(await turnMeetingTick(w.db, new Date(T0.getTime() + 1800_000)), 0, "chưa tới hạn");
    assert.equal(await turnMeetingTick(w.db, new Date(T0.getTime() + 7200_000)), 1);
    assert.equal(await turnMeetingTick(w.db, new Date(T0.getTime() + 7300_000)), 0, "đóng một lần");
    const row = await meeting(w, m2.code); assert.deepEqual([row.stop_reason, row.outcome], ["TIME", "NOT_CONCLUDED"]);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_turn_entries WHERE meeting_id=$1 AND state='PENDING'`, [m2.id]))[0].n, 0);
    const list: any[] = await listTurnMeetings(w.db);
    assert.ok(list.every((x) => x.state === "CLOSED" && x.stop_note));
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_outbox WHERE dedupe_key LIKE 'notify:turn-meeting:%'`))[0].n, 2);
  });
});
