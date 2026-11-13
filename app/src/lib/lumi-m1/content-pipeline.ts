/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 8 (nhóm 3) — content pipeline with three gates (AGT-06 independent QA, AGT-08 three-gate publisher, AGT-10 AI/affiliate disclosure, AGT-11 evidence levels E0–E4).
 *   Gate 1  QA by someone OTHER than the author (the writer never passes their own piece), against a deterministic checklist.
 *   Gate 2  The owner approves a SPECIFIC VERSION; any edit afterwards voids QA and approval.
 *   Gate 3  Publishing needs that approved, QA-passed, current version; idempotent per version; the owner presses it.
 * The only publish target that exists is the LABELLED FAKE (`lumi_fake_wp`). A real WordPress target is refused until it is configured and verified — the app never pretends.
 * Evidence: a claim stated as fact needs ≥ E2 AND a source; E0/E1 claims must be marked as opinion or removed. Disclosures are mandatory when AI-assisted / affiliate links present.
 */
import { createHash } from "node:crypto";
import { LumiError, audit, requireRole, type Db } from "./core";

const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LEVELS = ["E0", "E1", "E2", "E3", "E4"] as const;
export const LEVEL_TEXT: Record<string, string> = { E0: "Không có bằng chứng", E1: "Một nguồn yếu / lời đồn", E2: "Một nguồn đáng tin", E3: "Nhiều nguồn độc lập", E4: "Đã tự kiểm chứng trực tiếp" };
export const MIN_FACT_LEVEL = "E2";
const hash = (title: string, body: string) => createHash("sha256").update(JSON.stringify([title.trim(), body.trim()])).digest("hex");

export interface Problem { code: string; text: string }
/** deterministic checklist used by QA and re-checked at publish time */
export function checklist(a: { has_affiliate_links: boolean; ai_assisted: boolean; ai_disclosure: string | null; affiliate_disclosure: string | null; title: string; body: string }, claims: { text: string; evidence_level: string; source_ref: string | null; is_opinion: boolean }[]): Problem[] {
  const out: Problem[] = [];
  if (a.ai_assisted && (a.ai_disclosure ?? "").trim().length < 10) out.push({ code: "AI_DISCLOSURE_MISSING", text: "Bài có AI hỗ trợ nhưng chưa có câu khai báo (≥ 10 ký tự)" });
  if (a.has_affiliate_links && (a.affiliate_disclosure ?? "").trim().length < 10) out.push({ code: "AFFILIATE_DISCLOSURE_MISSING", text: "Bài có liên kết affiliate nhưng chưa có câu công khai (≥ 10 ký tự)" });
  if (a.body.trim().length < 200) out.push({ code: "BODY_TOO_SHORT", text: "Nội dung dưới 200 ký tự" });
  if (claims.length === 0) out.push({ code: "NO_CLAIMS_LISTED", text: "Chưa liệt kê mệnh đề nào kèm mức bằng chứng" });
  for (const c of claims) {
    if (!c.is_opinion && LEVELS.indexOf(c.evidence_level as any) < LEVELS.indexOf(MIN_FACT_LEVEL)) out.push({ code: "CLAIM_TOO_WEAK", text: `«${c.text.slice(0, 80)}» chỉ ở mức ${c.evidence_level}: phải đánh dấu là ý kiến hoặc bỏ` });
    if (!c.is_opinion && LEVELS.indexOf(c.evidence_level as any) >= 2 && (c.source_ref ?? "").trim().length < 3) out.push({ code: "CLAIM_NO_SOURCE", text: `«${c.text.slice(0, 80)}» mức ${c.evidence_level} nhưng thiếu nguồn` });
  }
  return out;
}

export async function createArticle(db: Db, a: { actorRef: string; projectId: string; title: string; body: string; aiAssisted?: boolean; hasAffiliateLinks?: boolean; aiDisclosure?: string; affiliateDisclosure?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  if (!UUID.test(a.projectId ?? "")) bad.push("project_id(uuid)");
  if (typeof a.title !== "string" || a.title.trim().length < 3 || a.title.length > 200) bad.push("title(3..200)");
  if (typeof a.body !== "string" || a.body.trim().length < 3 || a.body.length > 60000) bad.push("body(3..60000)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    const [p] = await t.query<any>(`SELECT id FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [a.projectId]);
    if (!p) throw new LumiError("NOT_FOUND", 404, { what: "project" });
    const [r] = await t.query<any>(`INSERT INTO lumi_articles(project_id,ai_assisted,has_affiliate_links,ai_disclosure,affiliate_disclosure,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [a.projectId, a.aiAssisted ?? true, a.hasAffiliateLinks ?? false, a.aiDisclosure ?? null, a.affiliateDisclosure ?? null, a.actorRef, iso(a.now)]);
    await t.query(`INSERT INTO lumi_article_versions(article_id,version,title,body,content_hash,created_by,created_at) VALUES ($1,1,$2,$3,$4,$5,$6)`, [r.id, a.title.trim(), a.body.trim(), hash(a.title, a.body), a.actorRef, iso(a.now)]);
    return { article: r };
  });
}
/** editing creates a NEW version and voids QA/approval (they were for the old text) */
export async function reviseArticle(db: Db, a: { actorRef: string; articleId: string; title: string; body: string; aiDisclosure?: string; affiliateDisclosure?: string; hasAffiliateLinks?: boolean; aiAssisted?: boolean; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (typeof a.title !== "string" || a.title.trim().length < 3 || typeof a.body !== "string" || a.body.trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["title/body"] });
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT * FROM lumi_articles WHERE id=$1 FOR UPDATE`, [a.articleId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    if (r.state === "PUBLISHED") throw new LumiError("INVALID_TRANSITION", 409, { from: "PUBLISHED", note: "Bài đã đăng: tạo bài mới hoặc bản sửa sau khi gỡ" });
    const v = r.current_version + 1;
    await t.query(`INSERT INTO lumi_article_versions(article_id,version,title,body,content_hash,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [r.id, v, a.title.trim(), a.body.trim(), hash(a.title, a.body), a.actorRef, iso(a.now)]);
    const [u] = await t.query<any>(`UPDATE lumi_articles SET state='DRAFT',current_version=$2,ai_disclosure=coalesce($3,ai_disclosure),affiliate_disclosure=coalesce($4,affiliate_disclosure),has_affiliate_links=coalesce($5,has_affiliate_links),ai_assisted=coalesce($6,ai_assisted),qa_version=NULL,qa_by=NULL,qa_at=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,updated_at=$7 WHERE id=$1 RETURNING *`, [r.id, v, a.aiDisclosure ?? null, a.affiliateDisclosure ?? null, a.hasAffiliateLinks ?? null, a.aiAssisted ?? null, iso(a.now)]);
    return { article: u };
  });
}
export async function setClaims(db: Db, a: { actorRef: string; articleId: string; claims: { text: string; evidenceLevel: string; sourceRef?: string; isOpinion?: boolean }[]; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (!Array.isArray(a.claims) || a.claims.length > 100) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["claims(<=100)"] });
  for (const c of a.claims) if (typeof c.text !== "string" || c.text.trim().length < 3 || c.text.length > 1000 || !(LEVELS as readonly string[]).includes(c.evidenceLevel)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["claim(text 3..1000, evidence_level E0..E4)"] });
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT * FROM lumi_articles WHERE id=$1 FOR UPDATE`, [a.articleId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    if (["QA_PASSED", "OWNER_APPROVED", "PUBLISHED"].includes(r.state)) throw new LumiError("INVALID_TRANSITION", 409, { from: r.state, note: "Đã qua QA/duyệt: sửa bài (phiên bản mới) rồi mới đổi mệnh đề" });
    await t.query(`DELETE FROM lumi_article_claims WHERE article_id=$1 AND version=$2`, [r.id, r.current_version]);
    for (const c of a.claims) await t.query(`INSERT INTO lumi_article_claims(article_id,version,text,evidence_level,source_ref,is_opinion,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [r.id, r.current_version, c.text.trim(), c.evidenceLevel, c.sourceRef?.trim() || null, c.isOpinion === true, a.actorRef, iso(a.now)]);
    return { count: a.claims.length };
  });
}
async function load(t: Db, id: string) {
  const [r] = await t.query<any>(`SELECT * FROM lumi_articles WHERE id=$1 FOR UPDATE`, [id]);
  if (!r) throw new LumiError("NOT_FOUND", 404);
  const [v] = await t.query<any>(`SELECT * FROM lumi_article_versions WHERE article_id=$1 AND version=$2`, [id, r.current_version]);
  const claims = await t.query<any>(`SELECT text,evidence_level,source_ref,is_opinion FROM lumi_article_claims WHERE article_id=$1 AND version=$2 ORDER BY created_at`, [id, r.current_version]);
  return { r, v, claims };
}
/** Gate 1: QA by someone other than the author, against the checklist */
export async function submitForQa(db: Db, a: { actorRef: string; articleId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  return db.tx(async (t) => {
    const { r } = await load(t, a.articleId);
    if (!["DRAFT", "QA_FAILED"].includes(r.state)) throw new LumiError("INVALID_TRANSITION", 409, { from: r.state });
    const [u] = await t.query<any>(`UPDATE lumi_articles SET state='QA_PENDING',updated_at=$2 WHERE id=$1 RETURNING *`, [r.id, iso(a.now)]);
    return { article: u };
  });
}
export async function qaReview(db: Db, a: { actorRef: string; articleId: string; decision: "PASS" | "FAIL"; notes?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  return db.tx(async (t) => {
    const { r, v, claims } = await load(t, a.articleId);
    if (r.state !== "QA_PENDING") throw new LumiError("INVALID_TRANSITION", 409, { from: r.state });
    const authors = await t.query<any>(`SELECT DISTINCT created_by FROM lumi_article_versions WHERE article_id=$1 AND version=$2`, [r.id, r.current_version]);
    if (authors.some((x: any) => x.created_by === a.actorRef)) throw new LumiError("SELF_REVIEW", 403, { note: "QA phải do người khác tác giả bản này thực hiện" });
    const problems = checklist({ ...r, title: v.title, body: v.body }, claims);
    if (a.decision === "PASS" && problems.length > 0) throw new LumiError("QA_CHECKLIST_FAILED", 422, { problems });
    if (a.decision === "FAIL" && (a.notes ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["notes(>=3)"] });
    const [u] = await t.query<any>(`UPDATE lumi_articles SET state=$2,qa_version=$3,qa_by=$4,qa_at=$5,qa_notes=$6,updated_at=$5 WHERE id=$1 RETURNING *`, [r.id, a.decision === "PASS" ? "QA_PASSED" : "QA_FAILED", r.current_version, a.actorRef, iso(a.now), a.notes ?? null]);
    await audit(t, "article.qa", a.actorRef, { code: r.code, decision: a.decision, version: r.current_version }, a.now);
    return { article: u };
  });
}
/** Gate 2: the owner approves THIS version */
export async function approveArticle(db: Db, a: { actorRef: string; articleId: string; version: number; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const { r } = await load(t, a.articleId);
    if (r.state === "OWNER_APPROVED" && r.approved_version === a.version) return { article: r, alreadyProcessed: true as const };
    if (r.state !== "QA_PASSED") throw new LumiError("INVALID_TRANSITION", 409, { from: r.state, note: "Chỉ duyệt bài đã qua QA" });
    if (a.version !== r.current_version || r.qa_version !== r.current_version) throw new LumiError("STALE_VERSION", 409, { current: r.current_version });
    const [u] = await t.query<any>(`UPDATE lumi_articles SET state='OWNER_APPROVED',approved_version=$2,approved_by=$3,approved_at=$4,updated_at=$4 WHERE id=$1 RETURNING *`, [r.id, a.version, a.actorRef, iso(a.now)]);
    await audit(t, "article.approved", a.actorRef, { code: r.code, version: a.version }, a.now);
    return { article: u, alreadyProcessed: false as const };
  });
}
export async function rejectArticle(db: Db, a: { actorRef: string; articleId: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  const up = await db.query<any>(`UPDATE lumi_articles SET state='REJECTED',qa_notes=$2,updated_at=$3 WHERE id=$1 AND state IN ('DRAFT','QA_PENDING','QA_FAILED','QA_PASSED','OWNER_APPROVED') RETURNING *`, [a.articleId, a.reason.trim(), iso(a.now)]);
  if (!up.length) throw new LumiError("INVALID_TRANSITION", 409);
  return { article: up[0] };
}
/** Gate 3: publish the approved, QA-passed, current version; the checklist runs AGAIN; idempotent per version; only the labelled FAKE target exists */
export async function publishArticle(db: Db, a: { actorRef: string; articleId: string; target?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const target = a.target ?? "FAKE";
  if (target !== "FAKE") throw new LumiError("NOT_CONFIGURED", 422, { target, note: "WordPress thật chưa được cấu hình và kiểm tra: ứng dụng không đăng giả vờ. Chỉ có đích «FAKE» (có nhãn)." });
  return db.tx(async (t) => {
    const { r, v, claims } = await load(t, a.articleId);
    if (r.state === "PUBLISHED" && r.published_version === r.current_version) return { article: r, alreadyProcessed: true as const };
    if (r.state !== "OWNER_APPROVED" || r.approved_version !== r.current_version || r.qa_version !== r.current_version) throw new LumiError("INVALID_TRANSITION", 409, { from: r.state, note: "Cần: QA đạt + Chủ duyệt đúng phiên bản hiện hành" });
    const problems = checklist({ ...r, title: v.title, body: v.body }, claims);
    if (problems.length) throw new LumiError("QA_CHECKLIST_FAILED", 422, { problems });
    const ref = `fake-${r.code}-v${r.current_version}`;
    await t.query(`INSERT INTO lumi_fake_wp(post_ref,article_id,version,title,body,published_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [ref, r.id, r.current_version, v.title, v.body, iso(a.now)]);
    const [u] = await t.query<any>(`UPDATE lumi_articles SET state='PUBLISHED',published_version=$2,published_at=$3,publish_target='FAKE',publish_ref=$4,updated_at=$3 WHERE id=$1 RETURNING *`, [r.id, r.current_version, iso(a.now), ref]);
    await audit(t, "article.published", a.actorRef, { code: r.code, version: r.current_version, target: "FAKE" }, a.now);
    return { article: u, alreadyProcessed: false as const };
  });
}
export async function listArticles(db: Db) {
  const rs = await db.query<any>(`SELECT a.*, p.name AS project_name, v.title, v.body FROM lumi_articles a JOIN lumi_projects p ON p.id=a.project_id JOIN lumi_article_versions v ON v.article_id=a.id AND v.version=a.current_version ORDER BY a.created_at DESC LIMIT 100`);
  const cs = await db.query<any>(`SELECT c.article_id,c.version,c.text,c.evidence_level,c.source_ref,c.is_opinion FROM lumi_article_claims c JOIN lumi_articles a ON a.id=c.article_id AND a.current_version=c.version ORDER BY c.created_at`);
  return rs.map((r: any) => { const claims = cs.filter((c: any) => c.article_id === r.id); return { ...r, claims, problems: checklist(r, claims) }; });
}
