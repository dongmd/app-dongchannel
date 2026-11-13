/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/** Đợt 8 (nhóm 3) HTTP handlers: content pipeline with three gates (AGT-06/08/10/11). User-only; roles enforced in the domain calls. */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { approveArticle, createArticle, listArticles, publishArticle, qaReview, rejectArticle, reviseArticle, setClaims, submitForQa, LEVEL_TEXT, MIN_FACT_LEVEL } from "./content-pipeline";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };
const ok = (data: any, status = 200): ApiRes => ({ status, data });

export const HANDLERS_CONTENT: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  async listArticles(ctx, req) { user(req); return ok({ articles: await listArticles(ctx.db), levels: LEVEL_TEXT, min_fact_level: MIN_FACT_LEVEL, label: "Đích xuất bản duy nhất hiện có là ADAPTER GIẢ có nhãn; WordPress thật chưa nối." }); },
  async createArticle(ctx, req) { const u = user(req); const b = req.body ?? {}; return ok(await createArticle(ctx.db, { actorRef: u.actorRef, projectId: uuid(b.project_id, "project_id"), title: String(b.title ?? ""), body: String(b.body ?? ""), aiAssisted: typeof b.ai_assisted === "boolean" ? b.ai_assisted : undefined, hasAffiliateLinks: typeof b.has_affiliate_links === "boolean" ? b.has_affiliate_links : undefined, aiDisclosure: str(b.ai_disclosure), affiliateDisclosure: str(b.affiliate_disclosure), now: ctx.now() }), 201); },
  async reviseArticle(ctx, req) { const u = user(req); const b = req.body ?? {}; return ok(await reviseArticle(ctx.db, { actorRef: u.actorRef, articleId: uuid(req.params.id, "article_id"), title: String(b.title ?? ""), body: String(b.body ?? ""), aiDisclosure: str(b.ai_disclosure), affiliateDisclosure: str(b.affiliate_disclosure), hasAffiliateLinks: typeof b.has_affiliate_links === "boolean" ? b.has_affiliate_links : undefined, aiAssisted: typeof b.ai_assisted === "boolean" ? b.ai_assisted : undefined, now: ctx.now() })); },
  async setArticleClaims(ctx, req) { const u = user(req); const b = req.body ?? {}; return ok(await setClaims(ctx.db, { actorRef: u.actorRef, articleId: uuid(req.params.id, "article_id"), claims: Array.isArray(b.claims) ? b.claims.map((c: any) => ({ text: String(c.text ?? ""), evidenceLevel: String(c.evidence_level ?? ""), sourceRef: str(c.source_ref), isOpinion: c.is_opinion === true })) : [], now: ctx.now() })); },
  async submitArticleForQa(ctx, req) { const u = user(req); return ok(await submitForQa(ctx.db, { actorRef: u.actorRef, articleId: uuid(req.params.id, "article_id"), now: ctx.now() })); },
  async qaArticle(ctx, req) { const u = user(req); const b = req.body ?? {}; if (!["PASS", "FAIL"].includes(b.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision(PASS|FAIL)"] }); return ok(await qaReview(ctx.db, { actorRef: u.actorRef, articleId: uuid(req.params.id, "article_id"), decision: b.decision, notes: str(b.notes), now: ctx.now() })); },
  async approveArticle(ctx, req) { const u = user(req); const r = await approveArticle(ctx.db, { actorRef: u.actorRef, articleId: uuid(req.params.id, "article_id"), version: Number(req.body?.version), now: ctx.now() }); return ok(r.alreadyProcessed ? { article: r.article, already_processed: true } : { article: r.article }); },
  async rejectArticle(ctx, req) { const u = user(req); return ok(await rejectArticle(ctx.db, { actorRef: u.actorRef, articleId: uuid(req.params.id, "article_id"), reason: String(req.body?.reason ?? ""), now: ctx.now() })); },
  async publishArticle(ctx, req) { const u = user(req); const r = await publishArticle(ctx.db, { actorRef: u.actorRef, articleId: uuid(req.params.id, "article_id"), target: str(req.body?.target), now: ctx.now() }); return ok(r.alreadyProcessed ? { article: r.article, already_processed: true } : { article: r.article }); },
};
