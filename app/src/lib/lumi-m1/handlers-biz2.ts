/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/** Đợt 8 (nhóm 2) HTTP handlers: campaigns + period metrics, video performance, YouTube strategy, offers/videos read models. User-only; roles enforced in the domain calls. */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { createCampaign, listCampaigns, listOffers, listVideos, listYtStrategy, recordCampaignMetric, recordVideoPerf, setCampaignCap, setYtStrategy, transitionCampaign } from "./biz2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };
const idem = (req: ApiReq) => { const k = req.headers.get("idempotency-key"); if (!k || k.length < 8 || k.length > 128) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] }); return k; };
const ok = (data: any, status = 200): ApiRes => ({ status, data });

export const HANDLERS_BIZ2: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  async listCampaigns(ctx, req) { user(req); return ok({ campaigns: await listCampaigns(ctx.db), note: "Số do người nhập kèm nguồn; không cộng khác tiền tệ; không có chỉ số lợi nhuận; chưa có dữ liệu thì ghi «chưa có»." }); },
  async createCampaign(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    return ok(await createCampaign(ctx.db, { actorRef: u.actorRef, projectId: uuid(b.project_id, "project_id"), name: String(b.name ?? ""), network: str(b.network), offerId: b.offer_id ? uuid(b.offer_id, "offer_id") : undefined, capAmount: num(b.cap_amount), currency: str(b.currency), now: ctx.now() }), 201);
  },
  async transitionCampaign(ctx, req) { const u = user(req); const b = req.body ?? {}; return ok(await transitionCampaign(ctx.db, { actorRef: u.actorRef, campaignId: uuid(req.params.id, "campaign_id"), to: String(b.to ?? ""), reason: str(b.reason), now: ctx.now() })); },
  async setCampaignCap(ctx, req) { const u = user(req); const b = req.body ?? {}; return ok(await setCampaignCap(ctx.db, { actorRef: u.actorRef, campaignId: uuid(req.params.id, "campaign_id"), capAmount: b.cap_amount === null || b.cap_amount === "" || b.cap_amount === undefined ? null : Number(b.cap_amount), reason: String(b.reason ?? ""), now: ctx.now() })); },
  async recordCampaignMetric(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    const r = await recordCampaignMetric(ctx.db, { actorRef: u.actorRef, campaignId: uuid(req.params.id, "campaign_id"), periodStart: String(b.period_start ?? ""), periodEnd: String(b.period_end ?? ""), spend: num(b.spend), clicks: num(b.clicks), conversions: num(b.conversions), revenue: num(b.revenue), currency: str(b.currency), source: String(b.source ?? ""), idempotencyKey: idem(req), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { already_processed: true } } : ok({ metric: r.metric, paused: r.paused }, 201);
  },
  async listVideos(ctx, req) { user(req); return ok(await listVideos(ctx.db)); },
  async recordVideoPerf(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    const r = await recordVideoPerf(ctx.db, { actorRef: u.actorRef, videoId: uuid(req.params.id, "video_id"), windowDays: Number(b.window_days), capturedAt: String(b.captured_at ?? ""), impressions: num(b.impressions), views: num(b.views), ctr: num(b.ctr), retention30s: num(b.retention_30s), avgPctViewed: num(b.avg_pct_viewed), subscribers: num(b.subscribers), affiliateClicks: num(b.affiliate_clicks), revenue: num(b.revenue), currency: str(b.currency), source: String(b.source ?? ""), idempotencyKey: idem(req), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { already_processed: true } } : ok({ perf: r.perf }, 201);
  },
  async listYtStrategy(ctx, req) { user(req); return ok({ strategies: await listYtStrategy(ctx.db) }); },
  async setYtStrategy(ctx, req) { const u = user(req); const b = req.body ?? {}; return ok(await setYtStrategy(ctx.db, { actorRef: u.actorRef, projectId: uuid(b.project_id, "project_id"), channelGoal: String(b.channel_goal ?? ""), uniquenessRules: String(b.uniqueness_rules ?? ""), patternBreaks: String(b.pattern_breaks ?? ""), now: ctx.now() }), 201); },
  async listOffers(ctx, req) { user(req); return ok({ offers: await listOffers(ctx.db) }); },
};
