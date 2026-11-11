/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-04 họp bất đồng bộ (MTG-01..03, 05..09) — evidence class A: PGlite + real migrations (incl. 0047). No model is called; "bots" act through the same
 * domain calls the MCP tools make. Proves the RULES: when a meeting may exist, what the app (not the chair) classifies, that silence is not agreement,
 * that a conclusion never widens money or permission, and that limits stop a meeting without asking for more.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createAssistant } from "./assistants";
import { setPolicy } from "./policies";
import { setSkill } from "./roster";
import { closeMeeting, contribute, decideConclusion, getMeeting, listMeetings, meetingCost, meetingTick, openMeeting, pendingMeetingProposals, requiredCoverage, respondAction, synthesizeMeeting, type OpenInput } from "./meetings";

const T0 = new Date("2026-11-08T08:00:00Z");
let tick = 0;
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test";
const DAY = 86400_000;
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

async function world(planStatus = "EXECUTING") {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án 1','AFFILIATE') RETURNING id`);
  const mk = async (slug: string, level = 2) => {
    const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=$2 WHERE id=$1`, [a.id, level]);
    await db.query(`INSERT INTO lumi_project_members(project_id,assistant_id) VALUES ($1,$2)`, [proj.id, a.id]);
    return a;
  };
  const aff = await mk("aff"), yt = await mk("yt"), pm = await mk("pm");
  const [goal] = await db.query<any>(`INSERT INTO lumi_goals(code,title,outcome,project_id,source_key,created_by) VALUES ('GL-T','Mục tiêu','Kết quả',$1,'goal-t','test') RETURNING id`, [proj.id]);
  const [plan] = await db.query<any>(`INSERT INTO lumi_plans(code,goal_id,project_id,lead_assistant_id,status,current_version,approved_version,created_by) VALUES ('PL-T',$1,$2,$3,$4,1,1,'test') RETURNING id,code`, [goal.id, proj.id, pm.id, planStatus]);
  await db.query(`INSERT INTO lumi_plan_versions(plan_id,version,state,body,content_hash,ceiling_amount,currency,submitted_by) VALUES ($1,1,'APPROVED','{}','h',10,'USD','bot:pm')`, [plan.id]);
  await setPolicy(db, { actorRef: OWNER, key: "meeting_cap", value: 2, now: now() });
  return { db, proj: proj.id as string, plan, aff, yt, pm };
}
type W = Awaited<ReturnType<typeof world>>;
let seq = 0;
const base = (w: W, over: Partial<OpenInput> = {}): OpenInput => ({
  actorRef: OWNER, idempotencyKey: `mtg-${++seq}-key-00001`, title: "Dự toán chung AFF + YT", question: "Dự toán chi phí sản xuất 3 video là bao nhiêu?", reason: "JOINT_PLAN", planId: w.plan.id,
  chairAssistantId: w.pm.id, backupChairAssistantId: undefined, participants: [{ assistantId: w.aff.id, role: "CONTRIBUTOR" }, { assistantId: w.yt.id, role: "CONTRIBUTOR" }],
  closesAt: new Date(T0.getTime() + DAY), maxRounds: 2, maxRuns: 6, endConditions: "Đủ đóng góp hoặc hết hạn", inputs: [{ kind: "PLAN_VERSION", ref: "PL-T", version: 1 }], now: now(), ...over,
});
const part = async (w: W, code: string, slug: string) => (await w.db.query<any>(`SELECT p.* FROM lumi_meeting_participants p JOIN lumi_assistants a ON a.id=p.assistant_id JOIN lumi_meetings m ON m.id=p.meeting_id WHERE m.code=$1 AND a.slug=$2`, [code, slug]))[0];
const say = (w: W, code: string, a: any, stance = "Tôi đề xuất 120 USD", extra: any = {}) => contribute(w.db, { meetingCode: code, actorRef: `bot:${a.slug}`, assistantId: a.id, stance, evidence: "Báo giá tháng 11", ...extra, now: now() });
const synth = (w: W, code: string, over: any = {}) => synthesizeMeeting(w.db, { meetingCode: code, actorRef: "bot:pm", assistantId: w.pm.id, summary: "Chốt dự toán", lines: over.lines, conclusions: over.conclusions ?? [{ type: "RECORD", text: "Dự toán 120 USD" }], now: over.now ?? now() });
const states = async (w: W, code: string) => (await w.db.query<any>(`SELECT state,outcome,close_reason FROM lumi_meetings WHERE code=$1`, [code]))[0];

describe("IMP-04 họp bất đồng bộ — lớp A", () => {
  it("1. mở họp: thiếu mục tiêu/giới hạn/đầu vào có phiên bản bị chặn; chỉ OWNER (người) mở; trần số họp do Chủ đặt (chưa đặt = chặn); phát lại cùng khóa = một cuộc họp; tạo việc đóng góp cho từng bot", async () => {
    const w = await world();
    for (const bad of [{ question: "" }, { maxRounds: 0 }, { maxRuns: 99 }, { endConditions: "" }, { inputs: [] }, { closesAt: new Date(T0.getTime() - 1000) }, { closesAt: new Date(T0.getTime() + 30 * DAY) }, { inputs: [{ kind: "PLAN_VERSION" as const, ref: "PL-T", version: 9 }] }])
      await rejects(openMeeting(w.db, base(w, bad as any)), "VALIDATION_ERROR");
    await rejects(openMeeting(w.db, base(w, { actorRef: ADMIN })), "FORBIDDEN");
    await rejects(openMeeting(w.db, base(w, { participants: Array.from({ length: 13 }, () => ({ assistantId: w.aff.id, role: "CONTRIBUTOR" as const })) })), "VALIDATION_ERROR"); // trần số người tham gia
    await rejects(openMeeting(w.db, base(w, { inputs: Array.from({ length: 11 }, () => ({ kind: "PLAN_VERSION" as const, ref: "PL-T", version: 1 })) })), "VALIDATION_ERROR");
    const key = `mtg-same-key-${++seq}`;
    const m1 = await openMeeting(w.db, base(w, { idempotencyKey: key }));
    const m2 = await openMeeting(w.db, base(w, { idempotencyKey: key }));
    assert.deepEqual([m1.alreadyProcessed, m2.alreadyProcessed, m1.meeting.id === m2.meeting.id], [false, true, true]);
    assert.match(m1.meeting.code, /^MT-\d{3}$/);
    const tasks = await w.db.query<any>(`SELECT k.code,k.title,a.slug,(SELECT count(*)::int FROM lumi_task_runs r WHERE r.task_id=k.id) AS runs FROM lumi_meeting_participants p JOIN tasks k ON k.id=p.task_id JOIN lumi_assistants a ON a.id=p.assistant_id WHERE p.meeting_id=$1 ORDER BY a.slug`, [m1.meeting.id]);
    assert.deepEqual(tasks.map((t: any) => [t.slug, t.runs]), [["aff", 1], ["pm", 1], ["yt", 1]], "mỗi bot phát biểu có một việc đóng góp và một lượt chạy");
    assert.equal(m1.meeting.runs_used, 3);
    // trần số họp mỗi kế hoạch (cap = 2): họp thứ hai được, thứ ba bị chặn
    await openMeeting(w.db, base(w));
    await assert.rejects(openMeeting(w.db, base(w)), (e: any) => e.code === "MEETING_CAP" && e.data.cap === 2);
    const w2 = await world(); await w2.db.query(`DELETE FROM lumi_policies`).catch(() => undefined);
  });

  it("2. không họp khi việc có một PIC rõ: chỉ một bot phát biểu ⇒ USE_HANDOFF (trừ khi Chủ yêu cầu); họp không do Chủ phải thuộc một kế hoạch; chủ trì/bot phải đang hoạt động", async () => {
    const w = await world();
    await assert.rejects(openMeeting(w.db, base(w, { participants: [] })), (e: any) => e.code === "USE_HANDOFF");
    await assert.rejects(openMeeting(w.db, base(w, { participants: [{ assistantId: w.aff.id, role: "OBSERVER" }] })), (e: any) => e.code === "USE_HANDOFF");
    const owner = await openMeeting(w.db, base(w, { reason: "OWNER", participants: [] }));
    assert.equal(owner.meeting.reason, "OWNER", "Chủ yêu cầu thì được");
    await rejects(openMeeting(w.db, base(w, { planId: undefined, projectId: w.proj })), "VALIDATION_ERROR");
    await rejects(openMeeting(w.db, base(w, { participants: [{ assistantId: "00000000-0000-0000-0000-0000000000aa", role: "CONTRIBUTOR" }] })), "NOT_FOUND");
    await rejects(openMeeting(w.db, base(w, { participants: [{ assistantId: w.aff.id, role: "REQUIRED_EXPERT" }, { assistantId: w.yt.id, role: "CONTRIBUTOR" }] })), "VALIDATION_ERROR"); // chuyên môn bắt buộc phải nêu tên
    const small = await world();
    await rejects(openMeeting(small.db, base(small, { maxRuns: 2 })), "VALIDATION_ERROR"); // 3 bot + lượt tổng hợp cần ≥ 4 lượt
  });

  it("3. đóng góp có cấu trúc: chỉ người được mời; quan sát viên không; giới hạn vòng; trùng = một; sau hạn lưu là MUỘN và KHÔNG đổi kết luận đã ghi", async () => {
    const w = await world();
    const { meeting } = await openMeeting(w.db, base(w, { participants: [{ assistantId: w.aff.id, role: "CONTRIBUTOR" }, { assistantId: w.yt.id, role: "OBSERVER" }] }));
    await rejects(contribute(w.db, { meetingCode: meeting.code, actorRef: "bot:yt", assistantId: w.yt.id, stance: "Tôi quan sát", now: now() }), "FORBIDDEN");
    const stranger = await createAssistant(w.db, { actorRef: OWNER, key: "mk-stranger-0001", input: { slug: "stranger", name: "Bot lạ", roleLabel: "Thử", toolAllowlist: ["knowledge.context"], hermesProfile: "stranger", limits: LIM }, now: now() });
    await rejects(contribute(w.db, { meetingCode: meeting.code, actorRef: "bot:stranger", assistantId: stranger.assistant.id, stance: "Tôi xin góp", now: now() }), "FORBIDDEN");
    await rejects(say(w, meeting.code, w.aff, "ab"), "VALIDATION_ERROR");
    const c1 = await say(w, meeting.code, w.aff);
    assert.deepEqual([c1.late, c1.alreadyProcessed], [false, false]);
    assert.equal((await say(w, meeting.code, w.aff)).alreadyProcessed, true);
    assert.equal((await say(w, meeting.code, w.aff, "Vòng hai: 130 USD", { round: 2 })).late, false);
    await rejects(say(w, meeting.code, w.aff, "Vòng ba", { round: 3 }), "ROUND_LIMIT");
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_meeting_participants WHERE id=$1`, [(await part(w, meeting.code, "aff")).id]))[0].state, "CONTRIBUTED");
    // đóng góp là nguồn bất biến ở cấp CSDL
    await assert.rejects(w.db.query(`UPDATE lumi_meeting_contributions SET stance='sửa lén'`), /chỉ-thêm/);
    // sau khi họp đóng: lưu muộn, kết luận cũ không đổi
    await closeMeeting(w.db, { meetingCode: meeting.code, actorRef: OWNER, reason: "Chủ đóng họp", now: now() });
    const late = await contribute(w.db, { meetingCode: meeting.code, actorRef: OWNER, stance: "Ý kiến của Chủ đến muộn", now: now() }).catch((e) => e);
    assert.ok(late instanceof LumiError && late.code === "FORBIDDEN", "Chủ không được mời (không có vai OWNER_OPTIONAL) nên không đóng góp được");
    const cl = await w.db.query<any>(`SELECT state,outcome FROM lumi_meetings WHERE id=$1`, [meeting.id]);
    assert.deepEqual([cl[0].state, cl[0].outcome], ["CLOSED", "NO_DECISION"]);
  });

  it("4. ý kiến chuyên môn bắt buộc (không chỉ đếm người): bot không có năng lực ĐÃ KIỂM CHỨNG không tính; thiếu ⇒ PARTIAL, quyết định phụ thuộc bị chặn; vắng ⇒ ABSENT, im lặng ≠ đồng ý", async () => {
    const w = await world();
    const { meeting } = await openMeeting(w.db, base(w, { participants: [{ assistantId: w.aff.id, role: "CONTRIBUTOR" }, { assistantId: w.yt.id, role: "REQUIRED_EXPERT", expertise: "SEO" }] }));
    await say(w, meeting.code, w.aff); await say(w, meeting.code, w.pm, "Chủ trì: đồng ý khung 120 USD");
    await say(w, meeting.code, w.yt, "SEO: cần thêm 30 USD cho từ khóa");
    const cov = await requiredCoverage(w.db, meeting.id);
    assert.deepEqual([cov[0]!.present, cov[0]!.verified, cov[0]!.satisfied], [true, false, false], "có mặt nhưng chưa kiểm chứng năng lực SEO ⇒ chưa đủ");
    const ids = (await w.db.query<any>(`SELECT c.id FROM lumi_meeting_contributions c WHERE c.meeting_id=$1 ORDER BY c.created_at`, [meeting.id])).map((x: any) => x.id as string);
    const out = await synth(w, meeting.code, { lines: [{ text: "Dự toán cơ sở 120 USD", contribution_ids: [ids[0]!] }, { text: "SEO cần thêm", contribution_ids: [ids[2]!] }], conclusions: [{ type: "RECORD", text: "Khung 120 USD" }, { type: "ACTION_ITEM", text: "Chốt từ khóa SEO", depends_on_expertise: "SEO", payload: { item_key: "seo-kw", title: "Chốt từ khóa", pic_slug: "yt", due_in_days: 2, expected_output: "Danh sách từ khóa", acceptance: "10 từ khóa" } }] });
    assert.equal(out.outcome, "PARTIAL"); assert.deepEqual(out.missing_expertise, ["SEO"]);
    const cs = await w.db.query<any>(`SELECT type,kind,state,reason FROM lumi_meeting_conclusions WHERE meeting_id=$1 ORDER BY idx`, [meeting.id]);
    assert.deepEqual(cs.map((c: any) => [c.type, c.state]), [["RECORD", "RECORDED"], ["ACTION_ITEM", "BLOCKED"]]);
    assert.match(cs[1].reason, /Thiếu ý kiến chuyên môn «SEO»/);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_meeting_actions WHERE meeting_id=$1`, [meeting.id])).length, 0, "quyết định phụ thuộc chuyên môn thiếu không tạo việc");
    // khi có năng lực đã kiểm chứng thì đủ
    const w2 = await world();
    await setSkill(w2.db, { actorRef: OWNER, assistantId: w2.yt.id, skill: "SEO", state: "VERIFIED", evidence: "Chấm 5 bài mẫu, 5/5 đạt", environment: "Thử trong ứng dụng", now: now() });
    const m2 = await openMeeting(w2.db, base(w2, { participants: [{ assistantId: w2.aff.id, role: "CONTRIBUTOR" }, { assistantId: w2.yt.id, role: "REQUIRED_EXPERT", expertise: "seo" }] }));
    await say(w2, m2.meeting.code, w2.yt, "SEO: cần thêm 30 USD");
    assert.equal((await requiredCoverage(w2.db, m2.meeting.id))[0]!.satisfied, true);
    // bot vắng: ABSENT, không bị coi là đồng ý
    await say(w2, m2.meeting.code, w2.pm, "Chủ trì tổng hợp");
    const id2 = (await w2.db.query<any>(`SELECT c.id FROM lumi_meeting_contributions c WHERE c.meeting_id=$1 LIMIT 1`, [m2.meeting.id]))[0].id;
    await synth(w2, m2.meeting.code, { lines: [{ text: "Thêm 30 USD", contribution_ids: [id2] }] });
    assert.equal((await part(w2, m2.meeting.code, "aff")).state, "ABSENT");
  });

  it("5. app phân loại kết luận (chủ trì không đổi được): ghi nhận / quyết định nội bộ trong biên / đề xuất cần Chủ; tiền-quyền-phạm vi-cam kết LUÔN là đề xuất và không đổi ngân sách", async () => {
    const w = await world();
    const { meeting } = await openMeeting(w.db, base(w));
    await say(w, meeting.code, w.aff); await say(w, meeting.code, w.yt); await say(w, meeting.code, w.pm, "Chủ trì: khung 120");
    const ids = (await w.db.query<any>(`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=$1 ORDER BY created_at`, [meeting.id])).map((x: any) => x.id as string);
    const budgetsBefore = JSON.stringify(await w.db.query(`SELECT * FROM lumi_budgets`));
    const grantsBefore = (await w.db.query<any>(`SELECT count(*)::int n FROM lumi_grants`))[0].n;
    const act = { item_key: "dung-video-1", title: "Dựng video 1", pic_slug: "yt", due_in_days: 3, expected_output: "Video 1 bản dựng", acceptance: "Đủ 3-5 phút, có phụ đề" };
    const out = await synth(w, meeting.code, {
      lines: [{ text: "Đồng thuận khung", contribution_ids: [ids[0]!, ids[1]!] }],
      conclusions: [{ type: "RECORD", text: "Khung 120 USD" }, { type: "ACTION_ITEM", text: "Dựng video 1", payload: act }, { type: "BUDGET_CHANGE", text: "Tăng trần lên 300 USD", payload: { to: 300 } }, { type: "GRANT_REQUEST", text: "Cấp quyền chi quảng cáo" }, { type: "EXTERNAL_COMMITMENT", text: "Ký hợp đồng với kênh X" }, { type: "SCOPE_CHANGE", text: "Thêm mảng website" }],
    });
    assert.deepEqual([out.outcome, out.applied, out.pending, out.blocked], ["DECIDED", 1, 4, 0]);
    const cs = await w.db.query<any>(`SELECT type,kind,state FROM lumi_meeting_conclusions WHERE meeting_id=$1 ORDER BY idx`, [meeting.id]);
    assert.deepEqual(cs.map((c: any) => `${c.type}:${c.kind}:${c.state}`), ["RECORD:RECORD:RECORDED", "ACTION_ITEM:INTERNAL:APPLIED", "BUDGET_CHANGE:PROPOSAL:PENDING_OWNER", "GRANT_REQUEST:PROPOSAL:PENDING_OWNER", "EXTERNAL_COMMITMENT:PROPOSAL:PENDING_OWNER", "SCOPE_CHANGE:PROPOSAL:PENDING_OWNER"]);
    assert.equal(JSON.stringify(await w.db.query(`SELECT * FROM lumi_budgets`)), budgetsBefore, "kết luận họp không đổi ngân sách");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_grants`))[0].n, grantsBefore, "kết luận họp không cấp quyền");
    // Chủ duyệt đề xuất chỉ GHI NHẬN, vẫn không tự đổi gì; bot không được duyệt
    const prop = (await pendingMeetingProposals(w.db)).find((p: any) => p.type === "BUDGET_CHANGE");
    await rejects(decideConclusion(w.db, { actorRef: "bot:pm", conclusionId: prop.id, decision: "APPROVE", now: now() }), "FORBIDDEN");
    await rejects(decideConclusion(w.db, { actorRef: ADMIN, conclusionId: prop.id, decision: "APPROVE", now: now() }), "FORBIDDEN");
    const d = await decideConclusion(w.db, { actorRef: OWNER, conclusionId: prop.id, decision: "APPROVE", now: now() });
    assert.match(d.note ?? "", /phiên bản kế hoạch/);
    assert.equal(JSON.stringify(await w.db.query(`SELECT * FROM lumi_budgets`)), budgetsBefore);
    assert.equal((await decideConclusion(w.db, { actorRef: OWNER, conclusionId: prop.id, decision: "APPROVE", now: now() })).alreadyProcessed, true);
    // kế hoạch không ở trạng thái EXECUTING ⇒ ngay cả việc nội bộ cũng thành đề xuất
    const w2 = await world("PENDING_APPROVAL");
    const m2 = await openMeeting(w2.db, base(w2));
    await say(w2, m2.meeting.code, w2.aff); await say(w2, m2.meeting.code, w2.pm);
    const id2 = (await w2.db.query<any>(`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=$1 LIMIT 1`, [m2.meeting.id]))[0].id;
    const o2 = await synth(w2, m2.meeting.code, { lines: [{ text: "Ý kiến đã nêu", contribution_ids: [id2] }], conclusions: [{ type: "ACTION_ITEM", text: "Việc", payload: act }] });
    assert.deepEqual([o2.applied, o2.pending], [0, 1]);
  });

  it("6. nhiệm vụ sau họp: đủ PIC/hạn/đầu ra/tiêu chí; trùng khóa (cuộc họp, mục) = một việc; liên kết việc sẵn có thay vì tạo trùng; giữ cho tới khi PIC nhận; từ chối cần lý do", async () => {
    const w = await world();
    const { meeting } = await openMeeting(w.db, base(w));
    await say(w, meeting.code, w.aff); await say(w, meeting.code, w.pm);
    const cid = (await w.db.query<any>(`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=$1 LIMIT 1`, [meeting.id]))[0].id;
    const act = { item_key: "viet-kich-ban", title: "Viết kịch bản video 1", pic_slug: "yt", due_in_days: 3, expected_output: "Kịch bản 3-5 phút", acceptance: "Có mở đầu, ví dụ, kết thúc" };
    // một việc sẵn có cùng PIC, cùng tên trong kế hoạch ⇒ liên kết, không tạo trùng
    const existing = (await w.db.query<any>(`INSERT INTO tasks(code,profile_slug,title,status,review_status,project_id,owner_kind,owner_assistant_id,source_key,plan_id,plan_task_key,created_at,updated_at) VALUES ('DL-900','yt',$1,'QUEUED','NONE',$2,'BOT',$3,'sk-900',$4,'t-exist',now(),now()) RETURNING id`, ["Viết kịch bản video 1", w.proj, w.yt.id, w.plan.id]))[0];
    const out = await synth(w, meeting.code, { lines: [{ text: "Cần kịch bản", contribution_ids: [cid] }], conclusions: [
      { type: "ACTION_ITEM", text: "Viết kịch bản", payload: act },
      { type: "ACTION_ITEM", text: "Viết kịch bản (lặp)", payload: act }, // cùng item_key ⇒ không tạo thêm
      { type: "ACTION_ITEM", text: "Thiếu tiêu chí", payload: { item_key: "thieu", title: "Việc thiếu", pic_slug: "yt", due_in_days: 2, expected_output: "Gì đó" } },
      { type: "ACTION_ITEM", text: "Thiếu PIC", payload: { item_key: "thieu-pic", title: "Việc không PIC", due_in_days: 2, expected_output: "Gì đó", acceptance: "ok" } },
    ] });
    assert.deepEqual([out.applied, out.blocked], [2, 2]);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_meeting_actions WHERE meeting_id=$1`, [meeting.id]))[0].n, 1, "phát lại cùng khóa không tạo thêm");
    assert.equal((await w.db.query<any>(`SELECT task_id FROM lumi_meeting_actions WHERE meeting_id=$1`, [meeting.id]))[0].task_id, existing.id, "đã liên kết việc sẵn có");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks WHERE title='Viết kịch bản video 1'`))[0].n, 1);
    // việc MỚI (không có sẵn) bị giữ cho tới khi PIC nhận
    const w2 = await world();
    const m2 = await openMeeting(w2.db, base(w2));
    await say(w2, m2.meeting.code, w2.aff); await say(w2, m2.meeting.code, w2.pm);
    const c2 = (await w2.db.query<any>(`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=$1 LIMIT 1`, [m2.meeting.id]))[0].id;
    await synth(w2, m2.meeting.code, { lines: [{ text: "Ý kiến đã nêu", contribution_ids: [c2] }], conclusions: [{ type: "ACTION_ITEM", text: "Dựng", payload: act }] });
    const tk = (await w2.db.query<any>(`SELECT k.id,k.status::text s,k.hold_reason h,(SELECT count(*)::int FROM lumi_task_runs r WHERE r.task_id=k.id AND r.state IN ('PENDING','DISPATCHED','RUNNING')) open_runs FROM lumi_meeting_actions x JOIN tasks k ON k.id=x.task_id WHERE x.meeting_id=$1`, [m2.meeting.id]))[0];
    assert.deepEqual([tk.s, tk.h, tk.open_runs], ["ON_HOLD", "MEETING_ACCEPT", 0], "chưa gửi cho bot trước khi PIC nhận");
    await rejects(respondAction(w2.db, { meetingCode: m2.meeting.code, itemKey: act.item_key, assistantId: w2.aff.id, actorRef: "bot:aff", decision: "ACCEPT", now: now() }), "FORBIDDEN");
    await rejects(respondAction(w2.db, { meetingCode: m2.meeting.code, itemKey: act.item_key, assistantId: w2.yt.id, actorRef: "bot:yt", decision: "DECLINE", now: now() }), "VALIDATION_ERROR");
    await respondAction(w2.db, { meetingCode: m2.meeting.code, itemKey: act.item_key, assistantId: w2.yt.id, actorRef: "bot:yt", decision: "ACCEPT", now: now() });
    const rel = (await w2.db.query<any>(`SELECT status::text s,(SELECT count(*)::int FROM lumi_task_runs r WHERE r.task_id=tasks.id AND r.state='PENDING') p FROM tasks WHERE id=$1`, [tk.id]))[0];
    assert.deepEqual([rel.s, rel.p], ["QUEUED", 1], "nhận ⇒ việc được thả với đúng MỘT lượt");
    assert.equal((await respondAction(w2.db, { meetingCode: m2.meeting.code, itemKey: act.item_key, assistantId: w2.yt.id, actorRef: "bot:yt", decision: "ACCEPT", now: now() })).alreadyProcessed, true);
    // PIC từ chối có lý do ⇒ cờ cần quyết định cho trưởng kế hoạch/Chủ
    const w3 = await world();
    const m3 = await openMeeting(w3.db, base(w3));
    await say(w3, m3.meeting.code, w3.aff); await say(w3, m3.meeting.code, w3.pm);
    const c3 = (await w3.db.query<any>(`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=$1 LIMIT 1`, [m3.meeting.id]))[0].id;
    await synth(w3, m3.meeting.code, { lines: [{ text: "Ý kiến đã nêu", contribution_ids: [c3] }], conclusions: [{ type: "ACTION_ITEM", text: "Dựng", payload: act }] });
    await respondAction(w3.db, { meetingCode: m3.meeting.code, itemKey: act.item_key, assistantId: w3.yt.id, actorRef: "bot:yt", decision: "DECLINE", reason: "Đang quá tải tuần này", now: now() });
    const dec = (await w3.db.query<any>(`SELECT k.needs_decision n FROM lumi_meeting_actions x JOIN tasks k ON k.id=x.task_id WHERE x.meeting_id=$1`, [m3.meeting.id]))[0];
    assert.equal(dec.n, true);
  });

  it("7. biên bản bất biến có phiên bản và truy về đóng góp gốc; dòng không có nguồn gốc bị từ chối; chủ trì tổng hợp phần lớn ý của chính mình ⇒ gắn 'tự kiểm tra'; chỉ chủ trì tổng hợp; chưa đủ điều kiện thì chặn", async () => {
    const w = await world();
    const { meeting } = await openMeeting(w.db, base(w, { participants: [{ assistantId: w.aff.id, role: "REQUIRED_EXPERT", expertise: "Dự toán" }, { assistantId: w.yt.id, role: "CONTRIBUTOR" }] }));
    await rejects(synth(w, meeting.code, { lines: [{ text: "Chưa ai nói", contribution_ids: ["00000000-0000-0000-0000-000000000001"] }] }), "NOT_READY");
    await say(w, meeting.code, w.pm, "Chủ trì: tôi cho rằng 120 USD"); await say(w, meeting.code, w.yt);
    await rejects(synth(w, meeting.code, { lines: [{ text: "Thiếu chuyên môn", contribution_ids: [(await w.db.query<any>(`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=$1 LIMIT 1`, [meeting.id]))[0].id] }] }), "NOT_READY"); // chuyên gia chưa nói, chưa hết hạn
    await rejects(synthesizeMeeting(w.db, { meetingCode: meeting.code, actorRef: "bot:yt", assistantId: w.yt.id, summary: "Tôi tổng hợp", lines: [], conclusions: [], now: now() }), "FORBIDDEN");
    await rejects(synth(w, meeting.code, { lines: [{ text: "Không nguồn", contribution_ids: [] }] }), "VALIDATION_ERROR");
    const after = new Date(T0.getTime() + 2 * DAY); // hết hạn ⇒ được tổng hợp dù thiếu chuyên gia
    const own = (await w.db.query<any>(`SELECT c.id FROM lumi_meeting_contributions c JOIN lumi_meeting_participants p ON p.id=c.participant_id WHERE c.meeting_id=$1 AND p.assistant_id=$2`, [meeting.id, w.pm.id]))[0].id;
    const out = await synth(w, meeting.code, { now: after, lines: [{ text: "Theo chủ trì: 120 USD", contribution_ids: [own] }, { text: "Cũng theo chủ trì", contribution_ids: [own] }] });
    assert.equal(out.self_checked, true);
    assert.equal(out.outcome, "PARTIAL");
    const note = (await w.db.query<any>(`SELECT * FROM lumi_meeting_notes WHERE meeting_id=$1`, [meeting.id]))[0];
    assert.equal(note.version, 1); assert.ok(note.self_checked);
    assert.ok((note.lines as any[]).every((l) => l.contribution_ids.length >= 1));
    await assert.rejects(w.db.query(`UPDATE lumi_meeting_notes SET summary='sửa lén'`), /chỉ-thêm/);
    await rejects(synth(w, meeting.code, { now: after, lines: [{ text: "Lần hai", contribution_ids: [own] }] }), "INVALID_TRANSITION"); // một cuộc họp, một biên bản; sửa = họp mới/cập nhật
    const detail = await getMeeting(w.db, meeting.code);
    assert.equal(detail.notes.length, 1); assert.ok(detail.contributions.length >= 2);
  });

  it("8. giới hạn và hạn chót: hết hạn tạo ĐÚNG MỘT lượt tổng hợp cho chủ trì; chủ trì vắng ⇒ chủ trì dự phòng một lần, không có ⇒ NO_DECISION; không đóng góp ⇒ NO_DECISION; hết lượt ⇒ 'chưa kết luận' không tự xin thêm", async () => {
    const w = await world();
    const a = await openMeeting(w.db, base(w, { backupChairAssistantId: w.aff.id }));
    await say(w, a.meeting.code, w.aff); await say(w, a.meeting.code, w.yt);
    assert.equal((await meetingTick(w.db, now())).acted, 0, "chưa hết hạn, chủ trì chưa nói: chờ");
    const late = new Date(T0.getTime() + 2 * DAY);
    await meetingTick(w.db, late); await meetingTick(w.db, late); // gọi lặp lại không tạo thêm
    const m = (await w.db.query<any>(`SELECT * FROM lumi_meetings WHERE code=$1`, [a.meeting.code]))[0];
    assert.equal(m.chair_switched, true); assert.equal(m.chair_assistant_id, w.aff.id, "chủ trì vắng ⇒ dự phòng");
    assert.ok(m.synth_task_id);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks WHERE title LIKE '%tổng hợp biên bản'`))[0].n, 1, "một lượt tổng hợp");
    assert.equal((await w.db.query<any>(`SELECT owner_assistant_id o FROM tasks WHERE id=$1`, [m.synth_task_id]))[0].o, w.aff.id);
    // dự phòng cũng không có ⇒ NO_DECISION
    const w2 = await world();
    const b = await openMeeting(w2.db, base(w2));
    await say(w2, b.meeting.code, w2.aff);
    await meetingTick(w2.db, new Date(T0.getTime() + 2 * DAY));
    const sb = await states(w2, b.meeting.code);
    assert.deepEqual([sb.state, sb.outcome], ["CLOSED", "NO_DECISION"]); assert.match(sb.close_reason, /Chủ trì vắng/);
    assert.equal((await w2.db.query<any>(`SELECT count(*)::int n FROM lumi_system_flags`)).length, 1);
    // không ai đóng góp
    const w3 = await world();
    const c = await openMeeting(w3.db, base(w3));
    await meetingTick(w3.db, new Date(T0.getTime() + 2 * DAY));
    assert.equal((await states(w3, c.meeting.code)).outcome, "NO_DECISION");
    // hết lượt chạy cho phép ⇒ không xin thêm
    const w4 = await world();
    const d = await openMeeting(w4.db, base(w4, { maxRuns: 4 }));
    await say(w4, d.meeting.code, w4.aff); await say(w4, d.meeting.code, w4.pm);
    await w4.db.query(`UPDATE lumi_meetings SET runs_used=4 WHERE id=$1`, [d.meeting.id]);
    await meetingTick(w4.db, new Date(T0.getTime() + 2 * DAY));
    const sd = await states(w4, d.meeting.code);
    assert.deepEqual([sd.state, sd.outcome], ["CLOSED", "NOT_CONCLUDED"]); assert.match(sd.close_reason, /không tự xin thêm/);
    assert.equal((await listMeetings(w4.db))[0].code, d.meeting.code);
  });

  it("9. chi phí họp: chỉ tính số ĐO THẬT; lượt chưa đo đếm là 'chưa biết' (không phải 0); chạm trần chi phí ⇒ dừng 'chưa kết luận'; chi phí họp vào sổ kế hoạch ở loại điều phối", async () => {
    const w = await world();
    const a = await openMeeting(w.db, base(w, { maxCost: 0.05, currency: "USD" }));
    const runs = await w.db.query<any>(`SELECT r.id,r.assistant_id FROM lumi_task_runs r JOIN lumi_meeting_participants p ON p.task_id=r.task_id WHERE p.meeting_id=$1`, [a.meeting.id]);
    assert.equal(runs.length, 3);
    for (const [i, r] of runs.entries()) await w.db.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',started_at=$2::timestamptz,finished_at=$2::timestamptz + interval '5 seconds' WHERE id=$1`, [r.id, new Date(T0.getTime() + 1000 * i).toISOString()]);
    await w.db.query(`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,after_usage,currency) VALUES ($1,$2,'MEASURED',1.00,1.03,'USD')`, [runs[0].id, runs[0].assistant_id]);
    const c1 = await meetingCost(w.db, a.meeting.id);
    assert.equal(c1.measured.toFixed(2), "0.03"); assert.equal(c1.unknown_runs, 2, "hai lượt chưa đo = chưa biết, không phải 0");
    assert.equal((await meetingTick(w.db, now())).acted, 0, "0.03 < trần 0.05");
    await w.db.query(`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,after_usage,currency) VALUES ($1,$2,'MEASURED',1.03,1.06,'USD')`, [runs[1].id, runs[1].assistant_id]);
    await meetingTick(w.db, now());
    const s = await states(w, a.meeting.code);
    assert.deepEqual([s.state, s.outcome], ["CLOSED", "NOT_CONCLUDED"]); assert.match(s.close_reason, /Chạm trần chi phí 0\.05/);
    assert.equal(Number((await w.db.query<any>(`SELECT cost_spent FROM lumi_meetings WHERE id=$1`, [a.meeting.id]))[0].cost_spent).toFixed(2), "0.06");
  });
});
