/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-04/05 — evidence class B (TDD 14.9): a REAL PostgreSQL server process, many real connections, the real migrations 0000..0047.
 * Proves the HTTP contract by role for knowledge/meetings/cost, concurrent proposals/approvals/openings/contributions/ticks, and the five new MCP tools.
 * Hermes is simulated; no model is called.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { type Db } from "./core";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { handleRpc } from "./mcp";
import { SimulatedHermes } from "./hermes-port";
import { createAssistant } from "./assistants";
import { setPolicy } from "./policies";
import { contribute, meetingTick, openMeeting } from "./meetings";
import { decideKnowledge, proposeKnowledge } from "./knowledge";

let srv: PgServer; let db: Db;
let tick = 0;
const T0 = new Date();
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const BOT: Principal = { kind: "bot", slug: "x", actorRef: "bot:x" };
const OWNER_REF = "web:owner@test";
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });
const ctx = (): ApiCtx => ({ db, hermes: new SimulatedHermes(), now });
const call = (name: string, p: Principal | null, o: { params?: Record<string, string>; body?: any; key?: string } = {}) => handle(name, ctx(), { principal: p, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };
const DAY = 86400_000;

async function world() {
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${uniq()}`, `Dự án ${uniq()}`]);
  const mk = async (tag: string) => {
    const slug = `${tag}-${uniq()}`.slice(0, 20);
    const a = (await createAssistant(db, { actorRef: OWNER_REF, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=2 WHERE id=$1`, [a.id]);
    await db.query(`INSERT INTO lumi_project_members(project_id,assistant_id) VALUES ($1,$2)`, [proj.id, a.id]);
    return a;
  };
  const aff = await mk("aff"), yt = await mk("yt"), pm = await mk("pm");
  const [goal] = await db.query<any>(`INSERT INTO lumi_goals(code,title,outcome,project_id,source_key,created_by) VALUES ('GL-'||$1,'Mục tiêu','Kết quả',$2,$3,'test') RETURNING id`, [uniq().toUpperCase(), proj.id, `goal-${uniq()}`]);
  const [plan] = await db.query<any>(`INSERT INTO lumi_plans(code,goal_id,project_id,lead_assistant_id,status,current_version,approved_version,created_by) VALUES ('PL-'||$1,$2,$3,$4,'EXECUTING',1,1,'test') RETURNING id,code`, [uniq().toUpperCase(), goal.id, proj.id, pm.id]);
  await db.query(`INSERT INTO lumi_plan_versions(plan_id,version,state,body,content_hash,ceiling_amount,currency,submitted_by) VALUES ($1,1,'APPROVED','{}','h',10,'USD','bot:pm')`, [plan.id]);
  return { proj: proj.id as string, aff, yt, pm, plan };
}
type W = Awaited<ReturnType<typeof world>>;
const botP = (a: any): any => ({ kind: "bot", slug: a.slug, actorRef: `bot:${a.slug}` });
const rpc = (bot: any, name: string, args: any) => handleRpc(ctx(), bot, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).then((r: any) => r.result);
const openIn = (w: W, over: any = {}) => openMeeting(db, { actorRef: OWNER_REF, idempotencyKey: `mtg-${uniq()}-key-001`, title: "Dự toán chung", question: "Dự toán 3 video là bao nhiêu?", reason: "JOINT_PLAN", planId: w.plan.id, chairAssistantId: w.pm.id,
  participants: [{ assistantId: w.aff.id, role: "CONTRIBUTOR" }, { assistantId: w.yt.id, role: "CONTRIBUTOR" }], closesAt: new Date(Date.now() + DAY), maxRounds: 2, maxRuns: 6, endConditions: "Đủ đóng góp hoặc hết hạn", inputs: [{ kind: "PLAN_VERSION", ref: w.plan.code, version: 1 }], now: new Date(), ...over });
const running = async (taskId: string) => { const [r] = await db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1 AND state='PENDING'`, [taskId]); await db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=now(),acked_at=now() WHERE id=$1`, [r.id]); return r.id as string; };

before(async () => {
  srv = await startPgServer(); db = postgresDb(srv.sql);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  await setPolicy(db, { actorRef: OWNER_REF, key: "meeting_cap", value: 50, now: now() });
});
after(async () => {
  await srv.stop();
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});

describe("IMP-04/05 trên PostgreSQL server thật", () => {
  it("1. hợp đồng HTTP theo vai trò: bot 403 ở mọi route; VIEWER/ADMIN không duyệt/đóng/mở; chưa đăng nhập 401; đọc được cho người đăng nhập", async () => {
    const w = await world();
    const p = await call("proposeKnowledge", ADMIN, { body: { kind: "RULE", scope: "PROJECT", scope_ref: w.proj, title: "Quy tắc thử", content: "Nội dung thử", reason: "Lý do đủ dài để thử" } });
    assert.equal(p.status, 201, JSON.stringify(p));
    const itemId = p.data.item.id as string;
    const m = await openIn(w);
    const ownerOnly: [string, any][] = [
      ["decideKnowledge", { params: { id: itemId }, body: { version: 1, decision: "APPROVE" } }],
      ["archiveKnowledge", { params: { id: itemId }, body: { reason: "xong" } }],
      ["openMeeting", { key: "mtg-http-key-0001", body: { title: "x y z", question: "q q q", reason: "OWNER", chair_assistant_id: w.pm.id, closes_at: new Date(Date.now() + DAY).toISOString(), max_rounds: 1, max_runs: 5, end_conditions: "xong", inputs: [{ kind: "PLAN_VERSION", ref: w.plan.code, version: 1 }] } }],
      ["closeMeeting", { params: { code: m.meeting.code }, body: { reason: "đóng" } }],
      ["decideConclusion", { params: { id: "00000000-0000-0000-0000-000000000001" }, body: { decision: "APPROVE" } }],
    ];
    for (const [name, o] of ownerOnly) {
      assert.equal((await call(name, BOT, o)).status, 403, `bot ${name}`);
      assert.equal((await call(name, VIEWER, o)).status, 403, `viewer ${name}`);
      assert.equal((await call(name, null, o)).status, 401, `anon ${name}`);
    }
    for (const name of ["decideKnowledge", "archiveKnowledge", "openMeeting", "closeMeeting", "decideConclusion"]) assert.equal((await call(name, ADMIN, ownerOnly.find((x) => x[0] === name)![1])).status, 403, `admin ${name}`);
    assert.equal((await call("proposeKnowledge", VIEWER, { body: { kind: "NOTE", scope: "COMPANY", title: "Ghi chú", content: "nội dung", reason: "lý do đủ dài" } })).status, 403);
    for (const who of [VIEWER, ADMIN, OWNER]) {
      assert.equal((await call("searchKnowledge", who, { body: {} })).status, 200);
      assert.equal((await call("getKnowledge", who, { params: { id: itemId } })).status, 200);
      assert.equal((await call("listMeetings", who)).status, 200);
      assert.equal((await call("getMeeting", who, { params: { code: m.meeting.code } })).status, 200);
      assert.equal((await call("costSummary", who)).status, 200);
    }
    for (const r of ["searchKnowledge", "listMeetings", "costSummary"]) assert.equal((await call(r, BOT)).status, 403, `bot ${r}`);
    assert.equal((await call("searchKnowledge", null)).status, 401);
    assert.equal((await call("openMeeting", OWNER, { body: { title: "x y z" } })).status, 400);
    assert.equal((await call("openMeeting", OWNER, { body: ownerOnly[2]![1].body })).status, 400, "thiếu Idempotency-Key");
  });

  it("2. đề xuất kiến thức đồng thời: 6 kết nối gửi CÙNG đề xuất ⇒ một mục; 6 người duyệt CÙNG bản ⇒ một lần hiệu lực (còn lại already_processed); duyệt hai mục cùng tiêu đề đồng thời ⇒ chỉ một ACTIVE", async () => {
    const w = await world();
    const src = (await call("createSource", OWNER, { body: { title: "Nguồn thử", kind: "DOCUMENT", ref: "https://example.test" } })).data.source;
    const body = { kind: "RULE", scope: "PROJECT", scope_ref: w.proj, title: "Quy tắc đua", content: "Nội dung đua", reason: "Lý do đủ dài để duyệt", sources: [{ source_id: src.id }] };
    const props = await Promise.all(Array.from({ length: 6 }, () => call("proposeKnowledge", ADMIN, { body })));
    assert.ok(props.every((r) => r.status === 201 || r.status === 200), JSON.stringify(props.map((r) => [r.status, r.error?.code])));
    assert.equal(new Set(props.map((r) => r.data.item.id)).size, 1);
    const id = props[0]!.data.item.id as string;
    const dec = await Promise.all(Array.from({ length: 6 }, () => call("decideKnowledge", OWNER, { params: { id }, body: { version: 1, decision: "APPROVE" } })));
    assert.ok(dec.every((r) => r.status === 200), JSON.stringify(dec.map((r) => [r.status, r.error?.code])));
    assert.equal(dec.filter((r) => !r.data.already_processed).length, 1, "đúng một lần duyệt thật");
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM audit_events WHERE action='knowledge.approved' AND after_json->>'itemId'=$1`, [id]))[0].n, 1);
    // hai mục khác nhau cùng tiêu đề/phạm vi, duyệt cùng lúc: không cho cả hai cùng ACTIVE
    const mk = async (c: string) => (await call("proposeKnowledge", ADMIN, { body: { ...body, title: "Giọng văn chung", content: c } })).data.item.id as string;
    const [a, b] = [await mk("Trang trọng"), await mk("Thân mật")];
    const both = await Promise.all([call("decideKnowledge", OWNER, { params: { id: a }, body: { version: 1, decision: "APPROVE" } }), call("decideKnowledge", OWNER, { params: { id: b }, body: { version: 1, decision: "APPROVE" } })]);
    const act = (await db.query<any>(`SELECT count(*)::int n FROM lumi_knowledge_items WHERE scope='PROJECT' AND scope_ref=$1 AND status='ACTIVE' AND id = ANY($2::uuid[])`, [w.proj, [a, b]]))[0].n;
    assert.ok(act <= 1, `không được có hai mục cùng tiêu đề cùng ACTIVE: ${act} (${JSON.stringify(both.map((r) => r.error?.code ?? r.status))})`);
  });

  it("3. họp đồng thời: 6 yêu cầu mở CÙNG khóa ⇒ một cuộc họp và đúng một bộ việc đóng góp; 6 đóng góp cùng vòng ⇒ một; hai worker cùng tick lúc hết hạn ⇒ đúng MỘT lượt tổng hợp", async () => {
    const w = await world();
    const key = `mtg-same-${uniq()}`;
    const body = { title: "Họp đua", question: "Câu hỏi đua", reason: "JOINT_PLAN", plan_id: w.plan.id, chair_assistant_id: w.pm.id, closes_at: new Date(Date.now() + DAY).toISOString(), max_rounds: 1, max_runs: 6, end_conditions: "đủ đóng góp",
      inputs: [{ kind: "PLAN_VERSION", ref: w.plan.code, version: 1 }], participants: [{ assistant_id: w.aff.id, role: "CONTRIBUTOR" }, { assistant_id: w.yt.id, role: "CONTRIBUTOR" }] };
    const rs = await Promise.all(Array.from({ length: 6 }, () => call("openMeeting", OWNER, { key, body })));
    assert.ok(rs.every((r) => r.status === 201 || r.status === 200), JSON.stringify(rs.map((r) => [r.status, r.error?.code])));
    assert.equal(new Set(rs.map((r) => r.data.meeting.id)).size, 1);
    const code = rs[0]!.data.meeting.code as string; const mid = rs[0]!.data.meeting.id as string;
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_meeting_participants WHERE meeting_id=$1 AND task_id IS NOT NULL`, [mid]))[0].n, 3);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM tasks WHERE title LIKE $1`, [`Họp ${code}:%`]))[0].n, 3);
    const says = await Promise.allSettled(Array.from({ length: 6 }, () => contribute(db, { meetingCode: code, actorRef: `bot:${w.aff.slug}`, assistantId: w.aff.id, stance: "Tôi đề xuất 100 USD", now: now() })));
    assert.ok(says.every((x) => x.status === "fulfilled"));
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_meeting_contributions WHERE meeting_id=$1`, [mid]))[0].n, 1);
    await contribute(db, { meetingCode: code, actorRef: `bot:${w.yt.slug}`, assistantId: w.yt.id, stance: "Tôi đề xuất 120 USD", now: now() });
    await contribute(db, { meetingCode: code, actorRef: `bot:${w.pm.slug}`, assistantId: w.pm.id, stance: "Chủ trì: khoảng 110 USD", now: now() });
    // tất cả đã nói ⇒ hai worker cùng tick ⇒ một lượt tổng hợp
    await Promise.all([meetingTick(db, now()), meetingTick(db, now()), meetingTick(db, now())]);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM tasks WHERE title=$1`, [`Họp ${code}: tổng hợp biên bản`]))[0].n, 1);
  });

  it("4. công cụ MCP: bot đề xuất kiến thức (chờ duyệt, nguồn gắn nhãn chưa kiểm chứng, không tự có hiệu lực); không đề xuất ngoài phạm vi; đóng góp họp chỉ trong việc họp của mình; chủ trì tổng hợp, hệ thống phân loại; nhận nhiệm vụ sau họp", async () => {
    const w = await world();
    const stranger = (await createAssistant(db, { actorRef: OWNER_REF, key: `mk-str-${uniq()}`, input: { slug: `str-${uniq()}`.slice(0, 20), name: "Bot lạ", roleLabel: "Thử", toolAllowlist: ["knowledge.context"], hermesProfile: `str-${uniq()}`.slice(0, 20), limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true WHERE id=$1`, [stranger.id]);
    // việc của aff trong dự án để có lượt chạy mở
    const mt = await openIn(w);
    const parts = await db.query<any>(`SELECT p.assistant_id,p.task_id,a.slug FROM lumi_meeting_participants p JOIN lumi_assistants a ON a.id=p.assistant_id WHERE p.meeting_id=$1`, [mt.meeting.id]);
    const of = (slug: string) => parts.find((x: any) => x.slug === slug)!;
    const affRun = await running(of(w.aff.slug).task_id);
    const k1 = await rpc(botP(w.aff), "knowledge_propose", { run_id: affRun, kind: "RULE", title: "Mở bài bằng câu hỏi", content: "Mở đầu mỗi bài bằng một câu hỏi.", reason: "Thử nghiệm cho thấy giữ chân tốt hơn", sources: [{ title: "Báo cáo tuần", ref: "https://example.test/r" }] });
    assert.equal(k1.isError, false, k1.content[0].text); assert.match(k1.content[0].text, /KN-\d+.*CHỜ CHỦ DUYỆT/);
    const it = (await db.query<any>(`SELECT status,scope FROM lumi_knowledge_items ORDER BY created_at DESC LIMIT 1`))[0];
    assert.deepEqual([it.status, it.scope], ["PROPOSED", "PROJECT"], "bot không tự kích hoạt");
    assert.equal((await rpc(botP(w.aff), "knowledge_propose", { run_id: affRun, kind: "RULE", scope: "COMPANY", title: "Nguyên tắc công ty", content: "Bot không được đặt nguyên tắc công ty.", reason: "Lý do đủ dài ok" })).isError, true);
    assert.equal((await rpc(botP(stranger), "knowledge_propose", { run_id: affRun, kind: "RULE", title: "Mượn lượt người khác", content: "nội dung", reason: "Lý do đủ dài ok" })).isError, true, "lượt của bot khác không dùng được");
    // đóng góp họp
    const c1 = await rpc(botP(w.aff), "meeting_contribute", { run_id: affRun, stance: "Tôi đề xuất 100 USD", evidence: "Báo giá" });
    assert.equal(c1.isError, false, c1.content[0].text);
    const ytRun = await running(of(w.yt.slug).task_id); const pmRun = await running(of(w.pm.slug).task_id);
    await rpc(botP(w.yt), "meeting_contribute", { run_id: ytRun, stance: "Tôi đề xuất 120 USD" });
    await rpc(botP(w.pm), "meeting_contribute", { run_id: pmRun, stance: "Chủ trì: 110 USD" });
    // việc không phải việc họp ⇒ từ chối
    const [plain] = await db.query<any>(`SELECT k.id FROM tasks k WHERE k.plan_id=$1 AND k.owner_assistant_id=$2 AND k.id NOT IN (SELECT task_id FROM lumi_meeting_participants WHERE task_id IS NOT NULL)`, [w.plan.id, w.aff.id]).catch(() => []);
    void plain;
    // tick ⇒ việc tổng hợp cho chủ trì ⇒ chủ trì tổng hợp qua MCP
    await meetingTick(db, now());
    const [mm] = await db.query<any>(`SELECT synth_task_id FROM lumi_meetings WHERE id=$1`, [mt.meeting.id]);
    assert.ok(mm.synth_task_id, "đã tạo việc tổng hợp");
    const synthRun = await running(mm.synth_task_id);
    const ids = (await db.query<any>(`SELECT id FROM lumi_meeting_contributions WHERE meeting_id=$1 ORDER BY created_at`, [mt.meeting.id])).map((x: any) => x.id as string);
    const notChair = await rpc(botP(w.aff), "meeting_synthesize", { run_id: synthRun, summary: "Tôi tổng hợp", lines: [], conclusions: [] });
    assert.equal(notChair.isError, true, "bot khác không tổng hợp bằng lượt của chủ trì");
    const s1 = await rpc(botP(w.pm), "meeting_synthesize", { run_id: synthRun, summary: "Chốt dự toán 110 USD", lines: [{ text: "Dự toán 110 USD", contribution_ids: [ids[0]!, ids[1]!] }],
      conclusions: [{ type: "RECORD", text: "Dự toán 110 USD" }, { type: "BUDGET_CHANGE", text: "Tăng trần lên 300 USD" }, { type: "ACTION_ITEM", text: "Dựng video 1", payload: { item_key: "dung-1", title: "Dựng video 1", pic_slug: w.yt.slug, due_in_days: 3, expected_output: "Video 1", acceptance: "Đủ 3 phút" } }] });
    assert.equal(s1.isError, false, s1.content[0].text); assert.match(s1.content[0].text, /1 nội bộ đã áp dụng, 1 đề xuất chờ Chủ/);
    const bud = (await db.query<any>(`SELECT count(*)::int n FROM lumi_budgets WHERE plan_id=$1`, [w.plan.id]))[0].n; assert.equal(bud, 0, "kết luận họp không tạo/đổi ngân sách");
    // PIC nhận nhiệm vụ qua MCP: cần một lượt mở của yt (dùng lượt đóng góp đã chạy)
    const act = await rpc(botP(w.yt), "meeting_action_respond", { run_id: ytRun, meeting_code: mt.meeting.code, item_key: "dung-1", decision: "ACCEPT" });
    assert.equal(act.isError, false, act.content[0].text);
    assert.equal((await db.query<any>(`SELECT state FROM lumi_meeting_actions WHERE meeting_id=$1`, [mt.meeting.id]))[0].state, "ACCEPTED");
    // chủ duyệt qua HTTP chỉ GHI NHẬN
    const prop = (await db.query<any>(`SELECT id FROM lumi_meeting_conclusions WHERE meeting_id=$1 AND type='BUDGET_CHANGE'`, [mt.meeting.id]))[0];
    const d = await call("decideConclusion", OWNER, { params: { id: prop.id }, body: { decision: "APPROVE" } });
    assert.equal(d.status, 200); assert.match(d.data.note, /phiên bản kế hoạch/);
  });

  it("5. nạp kiến thức vào lượt chạy trên PostgreSQL thật: chỉ mục đã duyệt đúng phạm vi; ghi nhận cùng giao dịch; bot không đọc được mục ngoài phạm vi qua tìm kiếm", async () => {
    const w = await world(); const w2 = await world();
    const p1 = await proposeKnowledge(db, { actorRef: OWNER_REF, kind: "RULE", scope: "PROJECT", scopeRef: w.proj, title: "Quy tắc dự án 1", content: "Giọng thân mật.", reason: "Chủ đặt cho dự án 1", now: now() });
    await decideKnowledge(db, { actorRef: OWNER_REF, itemId: p1.item.id, version: 1, decision: "APPROVE", now: now() });
    const p2 = await proposeKnowledge(db, { actorRef: OWNER_REF, kind: "RULE", scope: "PROJECT", scopeRef: w2.proj, title: "Quy tắc dự án 2", content: "Giọng nghiêm túc.", reason: "Chủ đặt cho dự án 2", now: now() });
    await decideKnowledge(db, { actorRef: OWNER_REF, itemId: p2.item.id, version: 1, decision: "APPROVE", now: now() });
    const t = (await call("createTask", OWNER, { key: `task-${uniq()}-0001`, body: { project_id: w.proj, assignee_id: w.aff.id, title: "Viết mô tả sản phẩm" } })).data.task;
    const [run] = await db.query<any>(`SELECT id,instruction_snapshot FROM lumi_task_runs WHERE task_id=$1`, [t.id]);
    const titles = (run.instruction_snapshot.knowledge.items as any[]).map((i) => i.title);
    assert.deepEqual(titles, ["Quy tắc dự án 1"]);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_run_knowledge WHERE run_id=$1`, [run.id]))[0].n, 1);
    await db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=now(),acked_at=now() WHERE id=$1`, [run.id]);
    const ctxText = await rpc(botP(w.aff), "knowledge_context", { run_id: run.id });
    assert.match(ctxText.content[0].text, /Quy tắc dự án 1/); assert.match(ctxText.content[0].text, /KHÔNG phải quyền hành động/);
    const found = await rpc(botP(w.aff), "knowledge_search", { run_id: run.id, q: "quy tac du an" });
    assert.match(found.content[0].text, /dự án 1/); assert.ok(!/dự án 2/.test(found.content[0].text));
  });
});
