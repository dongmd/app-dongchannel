/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-04 kho kiến thức (KNW-01..07, 09, 11..14; CMP-01) — evidence class A: PGlite + real migrations (incl. 0047). No model is called.
 * Proves the rules THROUGH the app: who may propose/approve, what a bot may read, what is loaded into a run, versions and traceability.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createTask } from "./core-web";
import { createAssistant } from "./assistants";
import { requestAction } from "./autonomy";
import { archiveKnowledge, compareVersions, createSource, decideKnowledge, getKnowledge, knowledgeReads, lineDiff, proposeKnowledge, restoreKnowledgeVersion, reviseKnowledge, searchKnowledge, traceForItem, traceForTask } from "./knowledge";
import { loadKnowledgePackage, normalizeText } from "./knowledge-pack";

const T0 = new Date("2026-11-08T08:00:00Z");
let tick = 0;
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án 1','AFFILIATE') RETURNING id`);
  const [p2] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p2','Dự án 2','YOUTUBE') RETURNING id`);
  const mk = async (slug: string, projects: string[]) => {
    const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true WHERE id=$1`, [a.id]);
    for (const p of projects) await db.query(`INSERT INTO lumi_project_members(project_id,assistant_id) VALUES ($1,$2)`, [p, a.id]);
    return a;
  };
  return { db, p1: p1.id as string, p2: p2.id as string, aff: await mk("aff", [p1.id]), yt: await mk("yt", [p2.id]), loner: await mk("loner", []) };
}
type W = Awaited<ReturnType<typeof world>>;
let seq = 0;
const src = (w: W) => createSource(w.db, { actorRef: OWNER, title: `Nguồn ${++seq}`, kind: "DOCUMENT", ref: "https://example.test/doc", now: now() });
/** propose as owner and approve (a helper for "an active rule") */
async function activeRule(w: W, o: { scope?: any; scopeRef?: string; title?: string; content?: string; kind?: any } = {}) {
  const s = await src(w);
  const r = await proposeKnowledge(w.db, { actorRef: OWNER, kind: o.kind ?? "RULE", scope: o.scope ?? "COMPANY", scopeRef: o.scopeRef, title: o.title ?? `Quy tắc ${++seq}`, content: o.content ?? "Luôn ghi rõ nguồn và ngày.", reason: "Chủ đặt nguyên tắc vận hành", sources: [{ sourceId: s.id }], now: now() });
  await decideKnowledge(w.db, { actorRef: OWNER, itemId: r.item.id, version: 1, decision: "APPROVE", now: now() });
  return r.item;
}
const taskFor = async (w: W, assistant: any, project: string) => (await createTask(w.db, { actorRef: OWNER, clientRequestId: `kt-${++seq}-0000001`, projectId: project, assigneeId: assistant.id, title: `Việc ${seq}`, now: now() })).task;
const snapshot = async (w: W, taskId: string) => (await w.db.query<any>(`SELECT id,instruction_snapshot FROM lumi_task_runs WHERE task_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [taskId]))[0];

describe("IMP-04 kho kiến thức — lớp A", () => {
  it("1. chỉ OWNER duyệt; bot và VIEWER không; bot chỉ đề xuất trong phạm vi mình đọc được; đề xuất chưa duyệt không bao giờ vào gói nạp", async () => {
    const w = await world();
    const sp = await proposeKnowledge(w.db, { actorRef: ADMIN, kind: "RULE", scope: "PROJECT", scopeRef: w.p1, title: "Mở bài bằng câu hỏi", content: "Mở đầu mỗi bài bằng một câu hỏi.", reason: "Thử nghiệm cho thấy giữ chân tốt hơn", now: now() });
    for (const who of ["bot:aff", VIEWER, ADMIN]) await rejects(decideKnowledge(w.db, { actorRef: who, itemId: sp.item.id, version: 1, decision: "APPROVE", now: now() }), "FORBIDDEN");
    await rejects(proposeKnowledge(w.db, { actorRef: VIEWER, kind: "NOTE", scope: "COMPANY", title: "Ghi chú", content: "nội dung", reason: "lý do đủ dài", now: now() }), "FORBIDDEN");
    // bot: chỉ dự án mình tham gia; không công ty/cá nhân; cần nguồn hoặc lý do
    const bot = { actorRef: "bot:aff", assistantId: w.aff.id } as const;
    await rejects(proposeKnowledge(w.db, { ...bot, kind: "RULE", scope: "COMPANY", title: "Thử công ty", content: "nội dung", reason: "lý do đủ dài ok", now: now() }), "FORBIDDEN");
    await rejects(proposeKnowledge(w.db, { ...bot, kind: "RULE", scope: "PROJECT", scopeRef: w.p2, title: "Dự án khác", content: "nội dung", reason: "lý do đủ dài ok", now: now() }), "FORBIDDEN");
    await assert.rejects(proposeKnowledge(w.db, { ...bot, kind: "RULE", scope: "PROJECT", scopeRef: w.p1, title: "Không nguồn", content: "nội dung", now: now() }), (e: any) => e.code === "VALIDATION_ERROR");
    const bp = await proposeKnowledge(w.db, { ...bot, kind: "RULE", scope: "PROJECT", scopeRef: w.p1, title: "Bot đề xuất", content: "Dùng ví dụ thật.", sources: [{ title: "Video mẫu", ref: "https://example.test/v" }], now: now() });
    assert.equal((await w.db.query<any>(`SELECT s.kind FROM lumi_knowledge_links l JOIN lumi_knowledge_sources s ON s.id=l.source_id WHERE l.item_id=$1`, [bp.item.id]))[0].kind, "BOT_CITED", "nguồn do bot nêu được gắn nhãn chưa kiểm chứng");
    assert.equal(bp.item.status, "PROPOSED");
    const pack = await loadKnowledgePackage(w.db, w.aff.id, null, now());
    assert.equal(pack.items.length, 0, "đề xuất chưa duyệt không bao giờ được nạp như quy tắc");
  });

  it("2. phạm vi: quy tắc dự án A không xuất hiện ở dự án B; mảng theo dự án của bot; công ty ai cũng đọc; cá nhân chỉ khi Chủ chia sẻ rõ", async () => {
    const w = await world();
    await activeRule(w, { scope: "COMPANY", title: "Nguyên tắc công ty", content: "Không bịa số liệu." });
    await activeRule(w, { scope: "PROJECT", scopeRef: w.p1, title: "Riêng dự án 1", content: "Giọng văn thân mật." });
    await activeRule(w, { scope: "PROJECT", scopeRef: w.p2, title: "Riêng dự án 2", content: "Tiêu đề dưới 60 ký tự." });
    await activeRule(w, { scope: "AREA", scopeRef: "AFFILIATE", title: "Mảng affiliate", content: "Ghi rõ có hoa hồng." });
    const personal = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "NOTE", scope: "PERSONAL", title: "Sở thích Chủ", content: "Thích bản ngắn.", reason: "Ghi chú cá nhân", sharedWith: [w.aff.id], now: now() });
    await decideKnowledge(w.db, { actorRef: OWNER, itemId: personal.item.id, version: 1, decision: "APPROVE", now: now() });
    const titles = async (a: any, project: string | null) => (await loadKnowledgePackage(w.db, a.id, project ? (await taskFor(w, a, project)).id : null, now())).items.map((i) => i.title).sort();
    assert.deepEqual(await titles(w.aff, w.p1), ["Mảng affiliate", "Nguyên tắc công ty", "Riêng dự án 1"]);
    assert.deepEqual(await titles(w.yt, w.p2), ["Nguyên tắc công ty", "Riêng dự án 2"]);
    assert.deepEqual(await titles(w.loner, null), ["Nguyên tắc công ty"], "bot không thuộc dự án nào chỉ đọc kiến thức công ty");
    // NOTE (ghi chú) không được nạp như chỉ dẫn; chỉ RULE/DECISION
    assert.ok(!(await titles(w.aff, null)).includes("Sở thích Chủ"));
    const visible = async (a: any) => (await searchKnowledge(w.db, { viewer: { kind: "bot", assistantId: a.id }, now: now() })).map((r: any) => r.title).sort();
    assert.ok((await visible(w.aff)).includes("Sở thích Chủ") && !(await visible(w.yt)).includes("Sở thích Chủ") && !(await visible(w.aff)).includes("Riêng dự án 2"));
    const p2item = (await w.db.query<any>(`SELECT id FROM lumi_knowledge_items WHERE scope='PROJECT' AND scope_ref=$1`, [w.p2]))[0].id;
    await rejects(getKnowledge(w.db, { viewer: { kind: "bot", assistantId: w.aff.id }, itemId: p2item, now: now() }), "NOT_FOUND");
  });

  it("3. không duyệt được khi thiếu nguồn/lý do (trừ nhập tay); quyết định cần lý do VÀ nguồn; từ chối cần lý do; đề xuất trùng nội dung đã bị từ chối có cảnh báo", async () => {
    const w = await world();
    const bare = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "RULE", scope: "COMPANY", title: "Quy tắc trơn", content: "Không có căn cứ.", now: now() });
    assert.ok(bare.warnings.some((x) => /Chưa có nguồn/.test(x)));
    await rejects(decideKnowledge(w.db, { actorRef: OWNER, itemId: bare.item.id, version: 1, decision: "APPROVE", now: now() }), "NEEDS_SUPPORT");
    const manual = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "RULE", scope: "COMPANY", title: "Nhập tay", content: "Chủ tự ghi.", manualEntry: true, now: now() });
    assert.equal((await decideKnowledge(w.db, { actorRef: OWNER, itemId: manual.item.id, version: 1, decision: "APPROVE", now: now() })).item.status, "ACTIVE");
    const dec = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "DECISION", scope: "COMPANY", title: "Chọn nền tảng", content: "Chọn YouTube trước.", reason: "Có sẵn kênh và khán giả", now: now() });
    await rejects(decideKnowledge(w.db, { actorRef: OWNER, itemId: dec.item.id, version: 1, decision: "APPROVE", now: now() }), "NEEDS_SUPPORT"); // lý do có, nguồn chưa
    await rejects(decideKnowledge(w.db, { actorRef: OWNER, itemId: bare.item.id, version: 1, decision: "REJECT", now: now() }), "VALIDATION_ERROR");
    await rejects(decideKnowledge(w.db, { actorRef: OWNER, itemId: bare.item.id, version: 1, decision: "REJECT", reason: "ab", now: now() }), "VALIDATION_ERROR");
    await decideKnowledge(w.db, { actorRef: OWNER, itemId: bare.item.id, version: 1, decision: "REJECT", reason: "Không có căn cứ", now: now() });
    assert.equal((await w.db.query<any>(`SELECT status FROM lumi_knowledge_items WHERE id=$1`, [bare.item.id]))[0].status, "REJECTED");
    const again = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "RULE", scope: "COMPANY", title: "Quy tắc trơn", content: "Không có căn cứ.", now: now() });
    assert.ok(again.warnings.some((x) => /đã bị từ chối ngày 2026-11-08: Không có căn cứ/.test(x)), again.warnings.join("|"));
    // gửi lại y hệt khi còn đang chờ ⇒ một đề xuất
    const a1 = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "NOTE", scope: "COMPANY", title: "Trùng lặp", content: "nội dung", reason: "lý do đủ dài", now: now() });
    const a2 = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "NOTE", scope: "COMPANY", title: "Trùng lặp", content: "nội dung", reason: "lý do đủ dài", now: now() });
    assert.deepEqual([a1.alreadyProcessed, a2.alreadyProcessed, a1.item.id === a2.item.id], [false, true, true]);
  });

  it("4. phiên bản: sửa quy tắc đang hiệu lực tạo bản mới CHỜ DUYỆT (bản cũ vẫn là bản áp dụng); việc cũ vẫn hiện v1, việc mới hiện v2; truy hai chiều; cảnh báo 'đã đổi sau khi chạy'", async () => {
    const w = await world();
    const item = await activeRule(w, { scope: "PROJECT", scopeRef: w.p1, title: "Độ dài", content: "Tối đa 100 từ." });
    const t1 = await taskFor(w, w.aff, w.p1); // chạy với v1
    const rv = await reviseKnowledge(w.db, { actorRef: ADMIN, itemId: item.id, content: "Tối đa 150 từ.", reason: "Thử nghiệm dài hơn", now: now() });
    assert.equal(rv.version, 2);
    assert.deepEqual(Object.values((await w.db.query<any>(`SELECT status,current_version,approved_version FROM lumi_knowledge_items WHERE id=$1`, [item.id]))[0]), ["ACTIVE", 2, 1], "v2 chưa duyệt: vẫn áp dụng v1");
    const t2 = await taskFor(w, w.aff, w.p1);
    assert.match(JSON.stringify((await snapshot(w, t2.id)).instruction_snapshot.knowledge.items), /100 từ/, "việc chạy khi v2 chưa duyệt vẫn nhận v1");
    await decideKnowledge(w.db, { actorRef: OWNER, itemId: item.id, version: 2, decision: "APPROVE", now: now() });
    const t3 = await taskFor(w, w.aff, w.p1);
    assert.match(JSON.stringify((await snapshot(w, t3.id)).instruction_snapshot.knowledge.items), /150 từ/);
    const tr1 = await traceForTask(w.db, t1.id);
    assert.deepEqual([tr1[0].code, tr1[0].used_version, tr1[0].current_version, tr1[0].changed_since], [item.code, 1, 2, true], "việc cũ hiện v1 và cảnh báo quy tắc đã đổi");
    assert.deepEqual((await traceForTask(w.db, t3.id)).map((x: any) => [x.used_version, x.changed_since]), [[2, false]]);
    const back = await traceForItem(w.db, item.id);
    assert.deepEqual(back.map((x: any) => [x.version, x.task_code]).sort(), [[1, t1.code], [1, t2.code], [2, t3.code]].sort());
    const cmp = await compareVersions(w.db, item.id, 1, 2);
    assert.ok(cmp.diff.some((d) => d.type === "del" && /100/.test(d.text)) && cmp.diff.some((d) => d.type === "add" && /150/.test(d.text)));
    // khôi phục bản cũ ⇒ bản MỚI (v3), vẫn cần duyệt
    assert.equal((await restoreKnowledgeVersion(w.db, { actorRef: OWNER, itemId: item.id, version: 1, now: now() })).version, 3);
    assert.equal((await w.db.query<any>(`SELECT content FROM lumi_knowledge_versions WHERE item_id=$1 AND version=3`, [item.id]))[0].content, "Tối đa 100 từ.");
    assert.equal((await w.db.query<any>(`SELECT approved_version FROM lumi_knowledge_items WHERE id=$1`, [item.id]))[0].approved_version, 2);
    // nội dung một phiên bản bất biến ở cấp CSDL
    await assert.rejects(w.db.query(`UPDATE lumi_knowledge_versions SET content='sửa lén' WHERE item_id=$1 AND version=1`, [item.id]), /bất biến/);
    await assert.rejects(w.db.query(`UPDATE lumi_knowledge_sources SET title='sửa lén'`), /bất biến/);
  });

  it("5. thay thế: quy tắc mới cùng tiêu đề/phạm vi buộc thay thế rõ; sau khi thay chỉ một bản hiệu lực; bản cũ 'Đã thay thế' nhưng còn xem được; chuỗi thay thế", async () => {
    const w = await world();
    const old = await activeRule(w, { scope: "COMPANY", title: "Giọng văn", content: "Trang trọng." });
    const s = await src(w);
    const fresh = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "RULE", scope: "COMPANY", title: "Giọng văn", content: "Thân mật.", reason: "Khán giả trẻ hơn", sources: [{ sourceId: s.id }], now: now() });
    await assert.rejects(decideKnowledge(w.db, { actorRef: OWNER, itemId: fresh.item.id, version: 1, decision: "APPROVE", now: now() }), (e: any) => e.code === "CONFLICT_ACTIVE" && e.data.items.includes(old.code));
    await decideKnowledge(w.db, { actorRef: OWNER, itemId: fresh.item.id, version: 1, decision: "APPROVE", supersedeItemId: old.id, now: now() });
    const act = await w.db.query<any>(`SELECT code,status FROM lumi_knowledge_items WHERE scope='COMPANY' ORDER BY code`);
    assert.deepEqual(act.map((x: any) => x.status), ["SUPERSEDED", "ACTIVE"]);
    assert.equal((await loadKnowledgePackage(w.db, w.aff.id, null, now())).items.length, 1);
    const g = await getKnowledge(w.db, { viewer: { kind: "user", role: "VIEWER" }, itemId: fresh.item.id, now: now() });
    assert.deepEqual(g.supersedes_chain.map((c: any) => c.status), ["ACTIVE", "SUPERSEDED"]);
    assert.equal((await getKnowledge(w.db, { viewer: { kind: "user", role: "VIEWER" }, itemId: old.id, now: now() })).versions.length, 1, "bản cũ vẫn xem được");
    // thay thế sai phạm vi bị chặn
    const proj = await activeRule(w, { scope: "PROJECT", scopeRef: w.p1, title: "Khác phạm vi" });
    const bad = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "RULE", scope: "COMPANY", title: "Khác", content: "nội dung", manualEntry: true, now: now() });
    await rejects(decideKnowledge(w.db, { actorRef: OWNER, itemId: bad.item.id, version: 1, decision: "APPROVE", supersedeItemId: proj.id, now: now() }), "SUPERSEDE_INVALID");
  });

  it("6. lưu trữ thay vì xóa: không còn được nạp, vẫn mở được và liên kết cũ còn; sửa khi duyệt giữ cả bản đề xuất lẫn bản đã sửa", async () => {
    const w = await world();
    const item = await activeRule(w, { scope: "COMPANY", title: "Sẽ lưu trữ", content: "Nội dung." });
    assert.equal((await loadKnowledgePackage(w.db, w.aff.id, null, now())).items.length, 1);
    await rejects(archiveKnowledge(w.db, { actorRef: "bot:aff", itemId: item.id, reason: "xong", now: now() }), "FORBIDDEN");
    await rejects(archiveKnowledge(w.db, { actorRef: OWNER, itemId: item.id, reason: "", now: now() }), "VALIDATION_ERROR");
    await archiveKnowledge(w.db, { actorRef: OWNER, itemId: item.id, reason: "Hết hiệu lực", now: now() });
    assert.equal((await archiveKnowledge(w.db, { actorRef: OWNER, itemId: item.id, reason: "Hết hiệu lực", now: now() })).alreadyProcessed, true);
    assert.equal((await loadKnowledgePackage(w.db, w.aff.id, null, now())).items.length, 0);
    assert.equal((await getKnowledge(w.db, { viewer: { kind: "user", role: "OWNER" }, itemId: item.id, now: now() })).item.status, "ARCHIVED");
    await rejects(reviseKnowledge(w.db, { actorRef: OWNER, itemId: item.id, content: "sửa", now: now() }), "INVALID_TRANSITION");
    const s = await src(w);
    const p = await proposeKnowledge(w.db, { actorRef: "bot:aff", assistantId: w.aff.id, kind: "RULE", scope: "PROJECT", scopeRef: w.p1, title: "Bot đề xuất dài", content: "Câu một. Câu hai thừa.", reason: "Bot thấy hiệu quả hơn", sources: [{ sourceId: s.id }], now: now() });
    await decideKnowledge(w.db, { actorRef: OWNER, itemId: p.item.id, version: 1, decision: "APPROVE", edit: { content: "Câu một." }, unsupported: ["Câu hai"], now: now() });
    const vs = await w.db.query<any>(`SELECT version,state,content FROM lumi_knowledge_versions WHERE item_id=$1 ORDER BY version`, [p.item.id]);
    assert.deepEqual(vs.map((v: any) => [v.version, v.state, v.content]), [[1, "SUPERSEDED", "Câu một. Câu hai thừa."], [2, "APPROVED", "Câu một."]]);
  });

  it("7. tìm kiếm bỏ dấu và lọc; bot chỉ thấy phần được đọc và mỗi lần đọc được ghi nhật ký (bot, mục, phiên bản, thời điểm)", async () => {
    const w = await world();
    const it = await activeRule(w, { scope: "PROJECT", scopeRef: w.p1, title: "Quy tắc đặt tiêu đề", content: "Tiêu đề ngắn gọn, có số liệu." });
    await activeRule(w, { scope: "PROJECT", scopeRef: w.p2, title: "Quy tắc khác", content: "Nội dung khác hẳn." });
    assert.equal(normalizeText("Đặt Tiêu Đề"), "dat tieu de");
    const owner = (q: string, extra: any = {}) => searchKnowledge(w.db, { viewer: { kind: "user", role: "OWNER" }, q, now: now(), ...extra });
    assert.deepEqual((await owner("tieu de ngan gon")).map((r: any) => r.code), [it.code], "không dấu vẫn tìm được, nhiều từ là AND");
    assert.equal((await owner("", { scope: "PROJECT", projectId: w.p2 })).length, 1);
    const r = (await owner("quy tac dat"))[0];
    assert.ok(r.title && r.content && r.sources.length === 1 && r.updated_at, "kết quả mở được nội dung, nguồn, thời điểm");
    const botHits = await searchKnowledge(w.db, { viewer: { kind: "bot", assistantId: w.aff.id }, q: "quy tac", now: now() });
    assert.deepEqual(botHits.map((x: any) => x.code), [it.code], "bot aff không thấy quy tắc của dự án 2");
    const logs = await knowledgeReads(w.db, it.id);
    assert.deepEqual(logs.map((l: any) => [l.slug, l.version, l.via]), [["aff", 1, "SEARCH"]]);
  });

  it("8. nguyên tắc/quy tắc chỉ là chỉ dẫn: duyệt hay sửa không đổi quyền hành động, ngân sách hay hồ sơ bot", async () => {
    const w = await world();
    const ask = () => requestAction(w.db, { assistantId: w.aff.id, projectId: w.p1, accountRef: "ads:123", actionType: "ads.spend", amount: 5, currency: "USD", summary: "Chi thử 5 USD", now: now() });
    const before = await ask();
    const snap = async () => JSON.stringify([(await w.db.query<any>(`SELECT tool_allowlist,capability_mode,execution_level,dispatch_enabled,max_runs_per_day FROM lumi_assistants WHERE id=$1`, [w.aff.id]))[0], (await w.db.query<any>(`SELECT count(*)::int g FROM lumi_grants`))[0], (await w.db.query<any>(`SELECT count(*)::int b FROM lumi_budgets`))[0]]);
    const a0 = await snap();
    await activeRule(w, { scope: "COMPANY", title: "Được phép chi tiền", content: "Bot được phép chi tùy ý không cần hỏi." }); // nội dung cố tình trái quy tắc quyền
    const after = await ask();
    assert.deepEqual([after.decision, (after as any).reason ?? null], [before.decision, (before as any).reason ?? null], "kết quả requestAction không đổi");
    assert.equal(await snap(), a0);
    assert.match(JSON.stringify((await snapshot(w, (await taskFor(w, w.aff, w.p1)).id)).instruction_snapshot.knowledge.items), /Được phép chi tiền/, "vẫn được nạp, nhưng chỉ như chỉ dẫn");
  });

  it("9. nạp kiến thức ghi cùng giao dịch với lượt chạy (danh sách mục + phiên bản có TRƯỚC khi gửi); lượt không có kiến thức phù hợp không ghi gì", async () => {
    const w = await world();
    const none = await taskFor(w, w.aff, w.p1);
    assert.equal((await w.db.query(`SELECT 1 FROM lumi_run_knowledge rk JOIN lumi_task_runs r ON r.id=rk.run_id WHERE r.task_id=$1`, [none.id])).length, 0);
    assert.equal((await snapshot(w, none.id)).instruction_snapshot.knowledge, undefined);
    const item = await activeRule(w, { scope: "COMPANY", title: "Nguyên tắc", content: "Ghi nguồn." });
    const t = await taskFor(w, w.aff, w.p1);
    const run = await snapshot(w, t.id);
    const rk = await w.db.query<any>(`SELECT item_id,version FROM lumi_run_knowledge WHERE run_id=$1`, [run.id]);
    assert.deepEqual(rk.map((x: any) => [x.item_id, x.version]), [[item.id, 1]]);
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_task_runs WHERE id=$1`, [run.id]))[0].state, "PENDING", "ghi nhận có trước khi lượt chạy được gửi");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_knowledge_reads WHERE run_id=$1 AND via='DISPATCH'`, [run.id]))[0].n, 1);
  });

  it("10. so sánh dòng (diff) đúng; hết hiệu lực không còn được nạp", async () => {
    assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc").map((d) => `${d.type}:${d.text}`), ["same:a", "del:b", "add:x", "same:c"]);
    const w = await world();
    const s = await src(w);
    const r = await proposeKnowledge(w.db, { actorRef: OWNER, kind: "RULE", scope: "COMPANY", title: "Có hạn", content: "Áp dụng đến hết tuần.", reason: "Chiến dịch ngắn hạn", sources: [{ sourceId: s.id }], effectiveUntil: new Date(T0.getTime() + 3600_000), now: now() });
    await decideKnowledge(w.db, { actorRef: OWNER, itemId: r.item.id, version: 1, decision: "APPROVE", now: now() });
    assert.equal((await loadKnowledgePackage(w.db, w.aff.id, null, T0)).items.length, 1);
    assert.equal((await loadKnowledgePackage(w.db, w.aff.id, null, new Date(T0.getTime() + 7200_000))).items.length, 0);
  });
});
