/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 8 nhóm 2 (AFF-02/03/05/06 chiến dịch + số liệu theo kỳ, YTB-02 hiệu suất video, YTB-04 chiến lược) — evidence class A: PGlite + real migrations (incl. 0053).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createCampaign, listCampaigns, listOffers, listVideos, listYtStrategy, recordCampaignMetric, recordVideoPerf, setCampaignCap, setYtStrategy, transitionCampaign } from "./biz2";

const T0 = new Date("2026-11-13T08:00:00Z");
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
let seq = 0; const key = () => `biz2-${++seq}-key-000001`;

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án AFF','AFFILIATE') RETURNING id`);
  const [offer] = await db.query<any>(`INSERT INTO offers(name,network) VALUES ('Offer đồng hồ','Impact') RETURNING id`);
  const [video] = await db.query<any>(`INSERT INTO videos(working_title) VALUES ('Review đồng hồ cơ') RETURNING id`);
  return { db, p1: p1.id as string, offer: offer.id as string, video: video.id as string };
}
type W = Awaited<ReturnType<typeof world>>;
const camp = (w: W, o: any = {}) => createCampaign(w.db, { actorRef: OWNER, projectId: w.p1, name: "Chiến dịch Google Search", network: "Impact", offerId: w.offer, capAmount: 50, now: now(), ...o });
const metric = (w: W, id: string, o: any = {}) => recordCampaignMetric(w.db, { actorRef: ADMIN, campaignId: id, periodStart: "2026-11-01", periodEnd: "2026-11-07", spend: 10, clicks: 100, conversions: 2, revenue: 30, source: "Bảng điều khiển Ads (thử)", idempotencyKey: key(), now: now(), ...o });

describe("Đợt 8 chiến dịch affiliate và số liệu theo kỳ (AFF-02/03/05/06) — lớp A", () => {
  it("1. tạo: OWNER/ADMIN; thiếu/ sai trường bị chặn; vòng đời PLANNED→ACTIVE⇄PAUSED→ENDED; chạy (ACTIVE) chỉ OWNER; dừng/kết thúc cần lý do; ENDED là cuối", async () => {
    const w = await world();
    for (const who of [VIEWER, "bot:aff"]) await rejects(camp(w, { actorRef: who }), "FORBIDDEN");
    await rejects(camp(w, { name: "ab" }), "VALIDATION_ERROR");
    await rejects(camp(w, { capAmount: -1 }), "VALIDATION_ERROR");
    await rejects(camp(w, { offerId: "00000000-0000-4000-8000-000000000099" }), "NOT_FOUND");
    const c = (await camp(w, { actorRef: ADMIN })).campaign;
    assert.deepEqual([c.state, c.code.startsWith("CP-")], ["PLANNED", true]);
    await rejects(transitionCampaign(w.db, { actorRef: ADMIN, campaignId: c.id, to: "ACTIVE", now: now() }), "FORBIDDEN");
    await rejects(transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "PAUSED", reason: "tạm dừng thử", now: now() }), "INVALID_TRANSITION");
    await transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "ACTIVE", now: now() });
    await rejects(transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "PAUSED", now: now() }), "VALIDATION_ERROR");
    await transitionCampaign(w.db, { actorRef: ADMIN, campaignId: c.id, to: "PAUSED", reason: "Kiểm tra lại từ khóa", now: now() });
    await transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "ACTIVE", now: now() });
    await transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "ENDED", reason: "Hết ngân sách quý", now: now() });
    await rejects(transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "ACTIVE", now: now() }), "INVALID_TRANSITION");
    const ev = await w.db.query<any>(`SELECT event FROM lumi_campaign_events ORDER BY at`);
    assert.deepEqual(ev.map((e: any) => e.event), ["CREATED", "STATE_ACTIVE", "STATE_PAUSED", "STATE_ACTIVE", "STATE_ENDED"]);
    await assert.rejects(w.db.query(`DELETE FROM lumi_campaign_events`), /chỉ-thêm/);
  });

  it("2. số liệu theo kỳ: nguồn bắt buộc, ≥1 chỉ số, kỳ hợp lệ, trùng khóa = một dòng; bản ghi chỉ-thêm; tổng theo tiền tệ KHÔNG cộng khác tiền; thiếu chỉ số = «chưa có» (không phải 0); không có trường lợi nhuận", async () => {
    const w = await world();
    const c = (await camp(w, { capAmount: undefined })).campaign;
    for (const who of [VIEWER, "bot:aff"]) await rejects(metric(w, c.id, { actorRef: who }), "FORBIDDEN");
    await rejects(metric(w, c.id, { source: "" }), "VALIDATION_ERROR");
    await rejects(metric(w, c.id, { spend: undefined, clicks: undefined, conversions: undefined, revenue: undefined }), "VALIDATION_ERROR");
    await rejects(metric(w, c.id, { periodEnd: "2026-10-01" }), "VALIDATION_ERROR");
    await rejects(metric(w, c.id, { spend: -5 }), "VALIDATION_ERROR");
    const k = key(); const a = await metric(w, c.id, { idempotencyKey: k }); const b = await metric(w, c.id, { idempotencyKey: k });
    assert.deepEqual([a.alreadyProcessed, b.alreadyProcessed], [false, true]);
    await metric(w, c.id, { periodStart: "2026-11-08", periodEnd: "2026-11-14", spend: 5, clicks: 50, conversions: undefined, revenue: undefined });
    await metric(w, c.id, { currency: "VND", spend: 200000, clicks: 10, conversions: 1, revenue: 500000 });
    const l: any[] = await listCampaigns(w.db);
    const x = l.find((r) => r.id === c.id);
    const usd = x.totals.find((t: any) => t.currency === "USD"), vnd = x.totals.find((t: any) => t.currency === "VND");
    assert.deepEqual([usd.spend, usd.clicks, usd.conversions, usd.revenue], [15, 150, 2, 30], "chỉ số thiếu của dòng thứ hai không bị tính 0");
    assert.equal(usd.cpc, 0.1); assert.equal(vnd.spend, 200000);
    for (const k2 of [...Object.keys(x), ...Object.keys(usd)]) assert.ok(!/profit|loi_nhuan|margin/i.test(k2));
    const only = (await listCampaigns(w.db, { from: "2026-11-08", to: "2026-11-30" })).find((r: any) => r.id === c.id);
    assert.equal(only.totals.find((t: any) => t.currency === "USD").spend, 5, "lọc theo kỳ");
    assert.equal((await camp(w, { name: "Chiến dịch trống" }).then((r) => listCampaigns(w.db).then((q: any[]) => q.find((z) => z.id === r.campaign.id)))).has_data, false);
    await assert.rejects(w.db.query(`UPDATE lumi_campaign_metrics SET spend=1`), /chỉ-thêm/);
  });

  it("3. trần chi (AFF-03): chi lũy kế chạm trần ⇒ chiến dịch TỰ DỪNG + thông báo một lần; chạy lại bị chặn tới khi Chủ nâng trần (quyết định mới, có lịch sử)", async () => {
    const w = await world();
    const c = (await camp(w, { capAmount: 20 })).campaign;
    await transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "ACTIVE", now: now() });
    const r1 = await metric(w, c.id, { spend: 12 }); assert.equal(r1.paused, false);
    const r2 = await metric(w, c.id, { spend: 9 }); assert.equal(r2.paused, true);
    let row = (await w.db.query<any>(`SELECT state,pause_reason FROM lumi_campaigns WHERE id=$1`, [c.id]))[0];
    assert.deepEqual([row.state, /trần/.test(row.pause_reason)], ["PAUSED", true]);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_outbox WHERE dedupe_key LIKE 'notify:campaign-cap:%'`))[0].n, 1);
    await assert.rejects(transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "ACTIVE", now: now() }), (e: any) => e.code === "CAP_REACHED" && e.data.spent === 21);
    await rejects(setCampaignCap(w.db, { actorRef: ADMIN, campaignId: c.id, capAmount: 100, reason: "thêm ngân sách", now: now() }), "FORBIDDEN");
    await rejects(setCampaignCap(w.db, { actorRef: OWNER, campaignId: c.id, capAmount: 100, reason: "", now: now() }), "VALIDATION_ERROR");
    await setCampaignCap(w.db, { actorRef: OWNER, campaignId: c.id, capAmount: 100, reason: "Chủ duyệt thêm ngân sách quý", now: now() });
    await transitionCampaign(w.db, { actorRef: OWNER, campaignId: c.id, to: "ACTIVE", now: now() });
    row = (await w.db.query<any>(`SELECT state FROM lumi_campaigns WHERE id=$1`, [c.id]))[0]; assert.equal(row.state, "ACTIVE");
    assert.ok((await w.db.query<any>(`SELECT detail FROM lumi_campaign_events WHERE event='CAP_CHANGED'`))[0].detail.includes("20 → 100"));
    // không có trần mặc định: chiến dịch không đặt trần không tự dừng
    const free = (await camp(w, { name: "Không đặt trần", capAmount: undefined })).campaign;
    await transitionCampaign(w.db, { actorRef: OWNER, campaignId: free.id, to: "ACTIVE", now: now() });
    assert.equal((await metric(w, free.id, { spend: 99999 })).paused, false);
  });
});

describe("Đợt 8 hiệu suất video, chiến lược YouTube, đọc offer/video cũ (YTB-02/04, AFF-01) — lớp A", () => {
  it("4. hiệu suất: cửa sổ 1/7/28/90, tỷ lệ 0–1, nguồn bắt buộc, trùng khóa = một dòng, mỗi video chỉ một dòng trong danh sách dù nhiều lần chụp; hiện bản chụp mới nhất theo từng cửa sổ", async () => {
    const w = await world();
    const rec = (o: any = {}) => recordVideoPerf(w.db, { actorRef: ADMIN, videoId: w.video, windowDays: 7, capturedAt: "2026-11-10T00:00:00Z", views: 1000, ctr: 0.05, source: "YouTube Studio (thử)", idempotencyKey: key(), now: now(), ...o });
    for (const who of [VIEWER, "bot:aff"]) await rejects(rec({ actorRef: who }), "FORBIDDEN");
    await rejects(rec({ windowDays: 5 }), "VALIDATION_ERROR");
    await rejects(rec({ ctr: 1.5 }), "VALIDATION_ERROR");
    await rejects(rec({ source: "" }), "VALIDATION_ERROR");
    await rejects(rec({ views: undefined, ctr: undefined }), "VALIDATION_ERROR");
    await rejects(rec({ videoId: "00000000-0000-4000-8000-000000000099" }), "NOT_FOUND");
    const k = key(); await rec({ idempotencyKey: k }); assert.equal((await rec({ idempotencyKey: k })).alreadyProcessed, true);
    await rec({ capturedAt: "2026-11-12T00:00:00Z", views: 1500 });
    await rec({ windowDays: 28, views: 4000 });
    const v: any = await listVideos(w.db);
    assert.equal(v.videos.length, 1);
    const p7 = v.videos[0].perf.find((p: any) => p.window_days === 7);
    assert.deepEqual([p7.views, v.videos[0].perf.length], [1500, 2], "bản chụp mới nhất theo cửa sổ");
    assert.match(v.note, /không phải 0/);
    await assert.rejects(w.db.query(`DELETE FROM lumi_video_perf`), /chỉ-thêm/);
  });

  it("5. chiến lược YouTube: chỉ OWNER; đủ ba trường; mỗi lần đổi là phiên bản mới, bản hiện hành là mới nhất; lịch sử bất biến", async () => {
    const w = await world();
    const st = (o: any = {}) => setYtStrategy(w.db, { actorRef: OWNER, projectId: w.p1, channelGoal: "Review trung thực đồng hồ cơ", uniquenessRules: "Luôn đo thực tế độ lệch giờ", patternBreaks: "Không làm video top 10 chung chung", now: now(), ...o });
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(st({ actorRef: who }), "FORBIDDEN");
    await rejects(st({ channelGoal: "" }), "VALIDATION_ERROR");
    await rejects(st({ projectId: "00000000-0000-4000-8000-000000000099" }), "NOT_FOUND");
    await st(); await st({ channelGoal: "Review đồng hồ cơ và quartz" });
    const l: any[] = await listYtStrategy(w.db);
    assert.deepEqual(l.map((x) => [x.version, x.current]), [[2, true], [1, false]]);
    await assert.rejects(w.db.query(`UPDATE lumi_yt_strategy SET channel_goal='sửa lén'`), /chỉ-thêm/);
  });

  it("6. đọc offer của hệ cũ (chỉ đọc)", async () => {
    const w = await world();
    const o: any[] = await listOffers(w.db);
    assert.deepEqual([o.length, o[0].status, o[0].confidence], [1, "NEW", "UNVERIFIED"]);
  });
});
