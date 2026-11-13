/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 8 nhóm 3 (AGT-06 QA độc lập, AGT-08 xuất bản ba cổng, AGT-10 khai báo AI/affiliate, AGT-11 mức bằng chứng E0–E4) — evidence class A: PGlite + real migrations (incl. 0055).
 * Đích xuất bản duy nhất là bản GIẢ có nhãn; nothing here touches a real website.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { approveArticle, checklist, createArticle, listArticles, publishArticle, qaReview, rejectArticle, reviseArticle, setClaims, submitForQa } from "./content-pipeline";

const T0 = new Date("2026-11-13T08:00:00Z");
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", ADMIN2 = "web:admin2@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const BODY = "Đồng hồ cơ tự động dùng bộ máy lên dây bằng chuyển động cổ tay. ".repeat(6);

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [ADMIN2, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Website đồng hồ','WEBSITE') RETURNING id`);
  return { db, p1: p1.id as string };
}
type W = Awaited<ReturnType<typeof world>>;
const GOOD_CLAIMS = [{ text: "Bộ máy tự động lên dây bằng chuyển động cổ tay", evidenceLevel: "E3", sourceRef: "https://example.com/a" }, { text: "Mẫu này đẹp nhất tầm giá", evidenceLevel: "E0", isOpinion: true }];
const mk = async (w: W, o: any = {}) => (await createArticle(w.db, { actorRef: ADMIN, projectId: w.p1, title: "Review đồng hồ cơ", body: BODY, aiDisclosure: "Bài có sự hỗ trợ của AI và đã được người kiểm tra.", now: now(), ...o })).article;
const ready = async (w: W, a: any) => { await setClaims(w.db, { actorRef: ADMIN, articleId: a.id, claims: GOOD_CLAIMS, now: now() }); await submitForQa(w.db, { actorRef: ADMIN, articleId: a.id, now: now() }); };

describe("Đợt 8 pipeline nội dung ba cổng (AGT-06/08/10/11) — lớp A", () => {
  it("1. danh sách kiểm xác định: mệnh đề thật cần ≥ E2 và có nguồn; E0/E1 phải là ý kiến; thiếu khai báo AI/affiliate; thiếu mệnh đề/nội dung quá ngắn", () => {
    const base = { has_affiliate_links: false, ai_assisted: true, ai_disclosure: "Bài có AI hỗ trợ", affiliate_disclosure: null, title: "T", body: BODY };
    assert.deepEqual(checklist(base, [{ text: "Mệnh đề tốt", evidence_level: "E2", source_ref: "nguồn A", is_opinion: false }]), []);
    const codes = (x: any[]) => x.map((p) => p.code).sort();
    assert.deepEqual(codes(checklist(base, [])), ["NO_CLAIMS_LISTED"]);
    assert.deepEqual(codes(checklist({ ...base, ai_disclosure: "" }, [{ text: "ok ok", evidence_level: "E3", source_ref: "nguồn A", is_opinion: false }])), ["AI_DISCLOSURE_MISSING"]);
    assert.deepEqual(codes(checklist({ ...base, has_affiliate_links: true }, [{ text: "ok ok", evidence_level: "E3", source_ref: "nguồn A", is_opinion: false }])), ["AFFILIATE_DISCLOSURE_MISSING"]);
    assert.deepEqual(codes(checklist({ ...base, ai_assisted: false, ai_disclosure: null }, [{ text: "Tin đồn", evidence_level: "E1", source_ref: null, is_opinion: false }])), ["CLAIM_TOO_WEAK"]);
    assert.deepEqual(codes(checklist(base, [{ text: "Tin đồn", evidence_level: "E1", source_ref: null, is_opinion: true }])), []);
    assert.deepEqual(codes(checklist(base, [{ text: "Thiếu nguồn", evidence_level: "E3", source_ref: "", is_opinion: false }])), ["CLAIM_NO_SOURCE"]);
    assert.deepEqual(codes(checklist({ ...base, body: "ngắn" }, [{ text: "ok ok", evidence_level: "E2", source_ref: "nguồn A", is_opinion: false }])), ["BODY_TOO_SHORT"]);
  });

  it("2. cổng QA: tác giả KHÔNG tự qua QA; người khác qua được khi đạt danh sách kiểm; không đạt ⇒ lỗi nêu từng vấn đề; FAIL cần ghi chú; viewer/bot không được", async () => {
    const w = await world(); const a = await mk(w);
    for (const who of [VIEWER, "bot:aff"]) await rejects(createArticle(w.db, { actorRef: who, projectId: w.p1, title: "Bài", body: BODY, now: now() }), "FORBIDDEN");
    await rejects(submitForQa(w.db, { actorRef: ADMIN, articleId: a.id, now: now() }).then(() => qaReview(w.db, { actorRef: ADMIN, articleId: a.id, decision: "PASS", now: now() })), "SELF_REVIEW");
    await assert.rejects(qaReview(w.db, { actorRef: ADMIN2, articleId: a.id, decision: "PASS", now: now() }), (e: any) => e.code === "QA_CHECKLIST_FAILED" && e.data.problems.some((p: any) => p.code === "NO_CLAIMS_LISTED"));
    await rejects(qaReview(w.db, { actorRef: ADMIN2, articleId: a.id, decision: "FAIL", now: now() }), "VALIDATION_ERROR");
    assert.equal((await qaReview(w.db, { actorRef: ADMIN2, articleId: a.id, decision: "FAIL", notes: "Thiếu mệnh đề kèm bằng chứng", now: now() })).article.state, "QA_FAILED");
    await setClaims(w.db, { actorRef: ADMIN, articleId: a.id, claims: GOOD_CLAIMS, now: now() });
    await submitForQa(w.db, { actorRef: ADMIN, articleId: a.id, now: now() });
    const ok = (await qaReview(w.db, { actorRef: OWNER, articleId: a.id, decision: "PASS", now: now() })).article;
    assert.deepEqual([ok.state, ok.qa_by, ok.qa_version], ["QA_PASSED", OWNER, 1]);
    await rejects(setClaims(w.db, { actorRef: ADMIN, articleId: a.id, claims: GOOD_CLAIMS, now: now() }), "INVALID_TRANSITION");
  });

  it("3. cổng duyệt: chỉ OWNER; đúng phiên bản; sửa bài sau QA/duyệt ⇒ phiên bản mới, MỌI chữ ký cũ bị vô hiệu; lịch sử phiên bản bất biến", async () => {
    const w = await world(); const a = await mk(w); await ready(w, a);
    await rejects(approveArticle(w.db, { actorRef: OWNER, articleId: a.id, version: 1, now: now() }), "INVALID_TRANSITION"); // chưa qua QA
    await qaReview(w.db, { actorRef: ADMIN2, articleId: a.id, decision: "PASS", now: now() });
    for (const who of [ADMIN, ADMIN2, VIEWER]) await rejects(approveArticle(w.db, { actorRef: who, articleId: a.id, version: 1, now: now() }), "FORBIDDEN");
    await rejects(approveArticle(w.db, { actorRef: OWNER, articleId: a.id, version: 2, now: now() }), "STALE_VERSION");
    const ap = await approveArticle(w.db, { actorRef: OWNER, articleId: a.id, version: 1, now: now() });
    assert.equal(ap.article.state, "OWNER_APPROVED");
    assert.equal((await approveArticle(w.db, { actorRef: OWNER, articleId: a.id, version: 1, now: now() })).alreadyProcessed, true);
    const rv = (await reviseArticle(w.db, { actorRef: ADMIN, articleId: a.id, title: "Review đồng hồ cơ (sửa)", body: BODY + " Thêm một đoạn.", now: now() })).article;
    assert.deepEqual([rv.state, rv.current_version, rv.qa_version, rv.approved_version], ["DRAFT", 2, null, null], "QA và duyệt cũ bị vô hiệu");
    await rejects(publishArticle(w.db, { actorRef: OWNER, articleId: a.id, now: now() }), "INVALID_TRANSITION");
    await assert.rejects(w.db.query(`UPDATE lumi_article_versions SET body='sửa lén'`), /chỉ-thêm/);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_article_versions`))[0].n, 2);
  });

  it("4. cổng xuất bản: chỉ OWNER; cần QA đạt + duyệt đúng phiên bản hiện hành; kiểm lại danh sách kiểm lúc đăng; đích thật chưa cấu hình bị từ chối; đăng lại = một bản; đích FAKE có nhãn", async () => {
    const w = await world(); const a = await mk(w); await ready(w, a);
    await qaReview(w.db, { actorRef: ADMIN2, articleId: a.id, decision: "PASS", now: now() });
    await rejects(publishArticle(w.db, { actorRef: OWNER, articleId: a.id, now: now() }), "INVALID_TRANSITION"); // chưa duyệt
    await approveArticle(w.db, { actorRef: OWNER, articleId: a.id, version: 1, now: now() });
    for (const who of [ADMIN, VIEWER]) await rejects(publishArticle(w.db, { actorRef: who, articleId: a.id, now: now() }), "FORBIDDEN");
    await assert.rejects(publishArticle(w.db, { actorRef: OWNER, articleId: a.id, target: "WORDPRESS", now: now() }), (e: any) => e.code === "NOT_CONFIGURED" && /không đăng giả vờ/.test(e.data.note));
    // kiểm lại lúc đăng: một mệnh đề bị hạ mức sau duyệt (sửa SQL trực tiếp) ⇒ đăng bị chặn
    await w.db.query(`UPDATE lumi_article_claims SET evidence_level='E0', is_opinion=false WHERE article_id=$1`, [a.id]);
    await assert.rejects(publishArticle(w.db, { actorRef: OWNER, articleId: a.id, now: now() }), (e: any) => e.code === "QA_CHECKLIST_FAILED");
    await w.db.query(`UPDATE lumi_article_claims SET evidence_level='E3' WHERE article_id=$1 AND text LIKE 'Bộ máy%'`, [a.id]);
    await w.db.query(`UPDATE lumi_article_claims SET is_opinion=true WHERE article_id=$1 AND text LIKE 'Mẫu này%'`, [a.id]);
    const p = await publishArticle(w.db, { actorRef: OWNER, articleId: a.id, now: now() });
    assert.deepEqual([p.article.state, p.article.publish_target, p.alreadyProcessed], ["PUBLISHED", "FAKE", false]);
    assert.equal((await publishArticle(w.db, { actorRef: OWNER, articleId: a.id, now: now() })).alreadyProcessed, true);
    const wp = await w.db.query<any>(`SELECT label FROM lumi_fake_wp`);
    assert.equal(wp.length, 1); assert.match(wp[0].label, /ADAPTER GIẢ/);
    await rejects(reviseArticle(w.db, { actorRef: ADMIN, articleId: a.id, title: "Sửa sau khi đăng", body: BODY, now: now() }), "INVALID_TRANSITION");
  });

  it("5. Chủ bác bài ở mọi bước trước khi đăng (cần lý do); danh sách trả kèm các lỗi còn tồn tại; bài thiếu khai báo affiliate không qua QA", async () => {
    const w = await world();
    const a = await mk(w, { hasAffiliateLinks: true });
    await setClaims(w.db, { actorRef: ADMIN, articleId: a.id, claims: GOOD_CLAIMS, now: now() });
    await submitForQa(w.db, { actorRef: ADMIN, articleId: a.id, now: now() });
    await assert.rejects(qaReview(w.db, { actorRef: ADMIN2, articleId: a.id, decision: "PASS", now: now() }), (e: any) => e.data.problems.some((p: any) => p.code === "AFFILIATE_DISCLOSURE_MISSING"));
    const l: any[] = await listArticles(w.db);
    assert.ok(l[0].problems.some((p: any) => p.code === "AFFILIATE_DISCLOSURE_MISSING"));
    await rejects(rejectArticle(w.db, { actorRef: ADMIN, articleId: a.id, reason: "không phù hợp", now: now() }), "FORBIDDEN");
    await rejects(rejectArticle(w.db, { actorRef: OWNER, articleId: a.id, reason: "", now: now() }), "VALIDATION_ERROR");
    assert.equal((await rejectArticle(w.db, { actorRef: OWNER, articleId: a.id, reason: "Nội dung không phù hợp định hướng", now: now() })).article.state, "REJECTED");
    await rejects(rejectArticle(w.db, { actorRef: OWNER, articleId: a.id, reason: "lặp lại", now: now() }), "INVALID_TRANSITION");
  });
});
