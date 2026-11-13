/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 8 (nhóm 2) — Affiliate campaigns + period results (AFF-02/03/05/06), video performance by window (YTB-02), YouTube strategy with versions (YTB-04), and read models over the legacy offers/videos.
 * Numbers are typed by a person with a stated source (append-only, correction = new row); nothing is netted into a profit; a missing figure is «chưa có», never 0.
 * Campaign lifecycle: PLANNED → ACTIVE ⇄ PAUSED → ENDED (final). Going ACTIVE (it can spend money) is the owner's decision; passing the spend cap pauses the campaign and needs a NEW owner decision.
 */
import { LumiError, audit, enqueueNotify, requireRole, type Db } from "./core";

const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUR = /^[A-Z]{3,5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NEXT: Record<string, string[]> = { PLANNED: ["ACTIVE", "ENDED"], ACTIVE: ["PAUSED", "ENDED"], PAUSED: ["ACTIVE", "ENDED"], ENDED: [] };
const ev = (t: Db, id: string, event: string, detail: string | null, by: string, now: Date) => t.query(`INSERT INTO lumi_campaign_events(campaign_id,event,detail,by,at) VALUES ($1,$2,$3,$4,$5)`, [id, event, detail, by, iso(now)]);

export async function createCampaign(db: Db, a: { actorRef: string; projectId: string; name: string; network?: string; offerId?: string; capAmount?: number; currency?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  if (!UUID.test(a.projectId ?? "")) bad.push("project_id(uuid)");
  if (typeof a.name !== "string" || a.name.trim().length < 3 || a.name.length > 160) bad.push("name(3..160)");
  if (a.offerId !== undefined && !UUID.test(a.offerId)) bad.push("offer_id(uuid)");
  if (a.capAmount !== undefined && !(a.capAmount > 0)) bad.push("cap_amount(>0)");
  if (a.currency !== undefined && !CUR.test(a.currency)) bad.push("currency");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    const [p] = await t.query<any>(`SELECT id FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [a.projectId]);
    if (!p) throw new LumiError("NOT_FOUND", 404, { what: "project" });
    if (a.offerId) { const [o] = await t.query<any>(`SELECT id FROM offers WHERE id=$1`, [a.offerId]); if (!o) throw new LumiError("NOT_FOUND", 404, { what: "offer" }); }
    const [c] = await t.query<any>(`INSERT INTO lumi_campaigns(project_id,name,network,offer_id,cap_amount,currency,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [a.projectId, a.name.trim(), a.network ?? null, a.offerId ?? null, a.capAmount ?? null, a.currency ?? "USD", a.actorRef, iso(a.now)]);
    await ev(t, c.id, "CREATED", null, a.actorRef, a.now);
    return { campaign: c };
  });
}
export async function transitionCampaign(db: Db, a: { actorRef: string; campaignId: string; to: string; reason?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (a.to === "ACTIVE") await requireRole(db, a.actorRef, ["OWNER"]); // a running campaign can spend money
  if (["PAUSED", "ENDED"].includes(a.to) && (a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  return db.tx(async (t) => {
    const [c] = await t.query<any>(`SELECT * FROM lumi_campaigns WHERE id=$1 FOR UPDATE`, [a.campaignId]);
    if (!c) throw new LumiError("NOT_FOUND", 404);
    if (!(NEXT[c.state] ?? []).includes(a.to)) throw new LumiError("INVALID_TRANSITION", 409, { from: c.state, to: a.to, allowed: NEXT[c.state] });
    if (a.to === "ACTIVE" && c.cap_amount) {
      const spent = await spentOf(t, c.id);
      if (spent >= Number(c.cap_amount)) throw new LumiError("CAP_REACHED", 409, { cap: Number(c.cap_amount), spent, note: "Đã chạm trần chi: nâng trần (quyết định mới của Chủ) rồi mới chạy lại" });
    }
    const [u] = await t.query<any>(`UPDATE lumi_campaigns SET state=$2,pause_reason=$3,updated_at=$4 WHERE id=$1 RETURNING *`, [c.id, a.to, a.to === "ACTIVE" ? null : a.reason?.trim() ?? null, iso(a.now)]);
    await ev(t, c.id, `STATE_${a.to}`, a.reason ?? null, a.actorRef, a.now);
    await audit(t, "campaign.transition", a.actorRef, { code: c.code, from: c.state, to: a.to }, a.now);
    return { campaign: u };
  });
}
export async function setCampaignCap(db: Db, a: { actorRef: string; campaignId: string; capAmount: number | null; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (a.capAmount !== null && !(a.capAmount > 0)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["cap_amount(>0 hoặc bỏ trần)"] });
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  return db.tx(async (t) => {
    const [c] = await t.query<any>(`SELECT * FROM lumi_campaigns WHERE id=$1 FOR UPDATE`, [a.campaignId]);
    if (!c) throw new LumiError("NOT_FOUND", 404);
    if (c.state === "ENDED") throw new LumiError("INVALID_TRANSITION", 409, { from: "ENDED" });
    const [u] = await t.query<any>(`UPDATE lumi_campaigns SET cap_amount=$2,updated_at=$3 WHERE id=$1 RETURNING *`, [c.id, a.capAmount, iso(a.now)]);
    await ev(t, c.id, "CAP_CHANGED", `${c.cap_amount ?? "không trần"} → ${a.capAmount ?? "không trần"}: ${a.reason.trim()}`, a.actorRef, a.now);
    return { campaign: u };
  });
}
async function spentOf(t: Db, id: string): Promise<number> {
  const [r] = await t.query<any>(`SELECT coalesce(sum(spend),0)::float s FROM lumi_campaign_metrics WHERE campaign_id=$1`, [id]);
  return Number(r?.s ?? 0);
}
export async function recordCampaignMetric(db: Db, a: { actorRef: string; campaignId: string; periodStart: string; periodEnd: string; spend?: number; clicks?: number; conversions?: number; revenue?: number; currency?: string; source: string; idempotencyKey: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  if (!DATE.test(a.periodStart ?? "") || !DATE.test(a.periodEnd ?? "") || a.periodEnd < a.periodStart) bad.push("period(YYYY-MM-DD, đến ≥ từ)");
  if (typeof a.source !== "string" || a.source.trim().length < 2) bad.push("source(bắt buộc: số liệu lấy từ đâu)");
  if (typeof a.idempotencyKey !== "string" || a.idempotencyKey.length < 8) bad.push("Idempotency-Key");
  for (const [k, v] of [["spend", a.spend], ["clicks", a.clicks], ["conversions", a.conversions], ["revenue", a.revenue]] as const) if (v !== undefined && !(Number.isFinite(v) && v >= 0)) bad.push(`${k}(>=0)`);
  if (a.spend === undefined && a.clicks === undefined && a.conversions === undefined && a.revenue === undefined) bad.push("ít nhất một chỉ số");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cmp:${a.campaignId}`]);
    const [prior] = await t.query<any>(`SELECT id FROM lumi_campaign_metrics WHERE idempotency_key=$1`, [a.idempotencyKey]);
    if (prior) return { metric: prior, alreadyProcessed: true as const, paused: false };
    const [c] = await t.query<any>(`SELECT * FROM lumi_campaigns WHERE id=$1 FOR UPDATE`, [a.campaignId]);
    if (!c) throw new LumiError("NOT_FOUND", 404);
    const cur = a.currency ?? c.currency;
    if (!CUR.test(cur)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["currency"] });
    const [m] = await t.query<any>(`INSERT INTO lumi_campaign_metrics(campaign_id,period_start,period_end,spend,clicks,conversions,revenue,currency,source,idempotency_key,recorded_by,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [c.id, a.periodStart, a.periodEnd, a.spend ?? null, a.clicks ?? null, a.conversions ?? null, a.revenue ?? null, cur, a.source.trim(), a.idempotencyKey, a.actorRef, iso(a.now)]);
    let paused = false;
    if (c.cap_amount && c.state === "ACTIVE" && cur === c.currency && (await spentOf(t, c.id)) >= Number(c.cap_amount)) {
      await t.query(`UPDATE lumi_campaigns SET state='PAUSED',pause_reason=$2,updated_at=$3 WHERE id=$1`, [c.id, "Chạm trần chi — cần quyết định mới của Chủ", iso(a.now)]);
      await ev(t, c.id, "CAP_REACHED", `Chi lũy kế ≥ trần ${c.cap_amount} ${c.currency}`, "system:cap", a.now);
      await enqueueNotify(t, `notify:campaign-cap:${c.id}`, { type: "CAMPAIGN_CAP_REACHED", campaign: c.code }, a.now);
      paused = true;
    }
    return { metric: m, alreadyProcessed: false as const, paused };
  });
}
export async function listCampaigns(db: Db, o: { from?: string; to?: string } = {}) {
  const cs = await db.query<any>(`SELECT c.*, p.name AS project_name, ofr.name AS offer_name FROM lumi_campaigns c JOIN lumi_projects p ON p.id=c.project_id LEFT JOIN offers ofr ON ofr.id=c.offer_id ORDER BY c.created_at DESC LIMIT 200`);
  const ms = await db.query<any>(`SELECT campaign_id,period_start::text ps,period_end::text pe,spend::float,clicks,conversions,revenue::float,currency,source,recorded_by,recorded_at FROM lumi_campaign_metrics ORDER BY period_start DESC, recorded_at DESC`);
  const evs = await db.query<any>(`SELECT campaign_id,event,detail,by,at FROM lumi_campaign_events ORDER BY at DESC`);
  return cs.map((c: any) => {
    const rows = ms.filter((m: any) => m.campaign_id === c.id && (!o.from || m.pe >= o.from) && (!o.to || m.ps <= o.to));
    const by: Record<string, any> = {};
    for (const r of rows) {
      const t = (by[r.currency] ??= { currency: r.currency, spend: null as number | null, clicks: null as number | null, conversions: null as number | null, revenue: null as number | null });
      for (const k of ["spend", "clicks", "conversions", "revenue"] as const) if (r[k] !== null && r[k] !== undefined) t[k] = (t[k] ?? 0) + Number(r[k]);
    }
    const totals = Object.values(by).map((t: any) => ({ ...t, cpc: t.clicks && t.spend !== null ? t.spend / t.clicks : null, cost_per_conversion: t.conversions && t.spend !== null ? t.spend / t.conversions : null }));
    const spent = rows.filter((r: any) => r.currency === c.currency).reduce((s: number, r: any) => s + (r.spend ?? 0), 0);
    return { ...c, cap_amount: c.cap_amount === null ? null : Number(c.cap_amount), totals, rows: rows.slice(0, 20), has_data: rows.length > 0, spent_in_currency: spent, events: evs.filter((e: any) => e.campaign_id === c.id).slice(0, 8) };
  });
}

// ───────────────────────── YTB-02 / YTB-04
export async function recordVideoPerf(db: Db, a: { actorRef: string; videoId: string; windowDays: number; capturedAt: string; impressions?: number; views?: number; ctr?: number; retention30s?: number; avgPctViewed?: number; subscribers?: number; affiliateClicks?: number; revenue?: number; currency?: string; source: string; idempotencyKey: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  if (![1, 7, 28, 90].includes(a.windowDays)) bad.push("window_days(1|7|28|90)");
  if (Number.isNaN(Date.parse(a.capturedAt))) bad.push("captured_at");
  if (typeof a.source !== "string" || a.source.trim().length < 2) bad.push("source(bắt buộc)");
  if (typeof a.idempotencyKey !== "string" || a.idempotencyKey.length < 8) bad.push("Idempotency-Key");
  for (const [k, v] of [["ctr", a.ctr], ["retention_30s", a.retention30s], ["avg_pct_viewed", a.avgPctViewed]] as const) if (v !== undefined && !(v >= 0 && v <= 1)) bad.push(`${k}(0..1)`);
  if ([a.impressions, a.views, a.subscribers, a.affiliateClicks, a.revenue].some((v) => v !== undefined && !(v >= 0)) ) bad.push("số đo(>=0)");
  if ([a.impressions, a.views, a.ctr, a.retention30s, a.avgPctViewed, a.subscribers, a.affiliateClicks, a.revenue].every((v) => v === undefined)) bad.push("ít nhất một chỉ số");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    const [prior] = await t.query<any>(`SELECT id FROM lumi_video_perf WHERE idempotency_key=$1`, [a.idempotencyKey]);
    if (prior) return { perf: prior, alreadyProcessed: true as const };
    const [v] = await t.query<any>(`SELECT id FROM videos WHERE id=$1`, [a.videoId]);
    if (!v) throw new LumiError("NOT_FOUND", 404, { what: "video" });
    const [p] = await t.query<any>(`INSERT INTO lumi_video_perf(video_id,window_days,captured_at,impressions,views,ctr,retention_30s,avg_pct_viewed,subscribers,affiliate_clicks,revenue,currency,source,idempotency_key,recorded_by,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [v.id, a.windowDays, a.capturedAt, a.impressions ?? null, a.views ?? null, a.ctr ?? null, a.retention30s ?? null, a.avgPctViewed ?? null, a.subscribers ?? null, a.affiliateClicks ?? null, a.revenue ?? null, a.currency ?? "USD", a.source.trim(), a.idempotencyKey, a.actorRef, iso(a.now)]);
    return { perf: p, alreadyProcessed: false as const };
  });
}
export async function listVideos(db: Db) {
  const vs = await db.query<any>(`SELECT v.id,v.working_title,v.title,v.status::text AS status,v.publish_url,v.published_at,o.name AS offer_name FROM videos v LEFT JOIN offers o ON o.id=v.offer_id ORDER BY v.updated_at DESC LIMIT 200`);
  const perf = await db.query<any>(`SELECT DISTINCT ON (video_id, window_days) video_id,window_days,captured_at,impressions::float,views::float,ctr::float,retention_30s::float,avg_pct_viewed::float,subscribers,affiliate_clicks,revenue::float,currency,source FROM lumi_video_perf ORDER BY video_id, window_days, captured_at DESC`);
  return { videos: vs.map((v: any) => ({ ...v, perf: perf.filter((p: any) => p.video_id === v.id) })), note: "Mỗi số có cửa sổ (1/7/28/90 ngày), thời điểm chụp và nguồn do người nhập; chưa có dữ liệu thì để trống, không phải 0. Mỗi video chỉ đếm một lần dù có nhiều việc sản xuất." };
}
export async function setYtStrategy(db: Db, a: { actorRef: string; projectId: string; channelGoal: string; uniquenessRules: string; patternBreaks: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const len = (v: unknown, lo: number, hi: number) => typeof v === "string" && v.trim().length >= lo && v.length <= hi;
  const bad: string[] = [];
  if (!UUID.test(a.projectId ?? "")) bad.push("project_id(uuid)");
  if (!len(a.channelGoal, 3, 1000)) bad.push("channel_goal(3..1000)");
  if (!len(a.uniquenessRules, 3, 2000)) bad.push("uniqueness_rules(3..2000)");
  if (!len(a.patternBreaks, 3, 2000)) bad.push("pattern_breaks(3..2000)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`yt-strategy:${a.projectId}`]);
    const [p] = await t.query<any>(`SELECT id FROM lumi_projects WHERE id=$1`, [a.projectId]);
    if (!p) throw new LumiError("NOT_FOUND", 404);
    const [m] = await t.query<any>(`SELECT coalesce(max(version),0)::int v FROM lumi_yt_strategy WHERE project_id=$1`, [a.projectId]);
    const [s] = await t.query<any>(`INSERT INTO lumi_yt_strategy(project_id,version,channel_goal,uniqueness_rules,pattern_breaks,set_by,set_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [a.projectId, m.v + 1, a.channelGoal.trim(), a.uniquenessRules.trim(), a.patternBreaks.trim(), a.actorRef, iso(a.now)]);
    return { strategy: s };
  });
}
export async function listYtStrategy(db: Db) {
  return db.query<any>(`SELECT s.*, p.name AS project_name, (s.version = (SELECT max(version) FROM lumi_yt_strategy x WHERE x.project_id=s.project_id)) AS current FROM lumi_yt_strategy s JOIN lumi_projects p ON p.id=s.project_id ORDER BY p.name, s.version DESC`);
}
export async function listOffers(db: Db) {
  return db.query<any>(`SELECT id,name,network,status::text AS status,confidence::text AS confidence,last_verified_at FROM offers ORDER BY updated_at DESC LIMIT 200`);
}
