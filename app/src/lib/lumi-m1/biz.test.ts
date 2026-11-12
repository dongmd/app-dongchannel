/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 7 (APR-07 ma trận tự chủ, ECO-05 báo cáo kinh tế, trạng thái tích hợp) — evidence class A: PGlite + real migrations (incl. 0050). No model, no outside account.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createAssistant } from "./assistants";
import { requestAction } from "./autonomy";
import { ACTION_TYPES, effectiveMode, listAutonomyMatrix, setAutonomyRule } from "./autonomy-matrix";
import { economyReport, recordMoney } from "./finance";
import { integrationsStatus } from "./integrations";
import { decideRoute, listSignals, proposeRoute, scoreSignal, submitSignal } from "./opportunities";

const T0 = new Date("2026-11-12T08:00:00Z");
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án AFF','AFFILIATE') RETURNING id`);
  const a = (await createAssistant(db, { actorRef: OWNER, key: "mk-aff-0001", input: { slug: "aff", name: "Bot aff", roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: "aff", limits: LIM }, now: now() })).assistant;
  return { db, p1: p1.id as string, a };
}
const act = (w: Awaited<ReturnType<typeof world>>, actionType: string, o: any = {}) => requestAction(w.db, { assistantId: w.a.id, projectId: w.p1, actionType, accountRef: "acct-1", summary: `Thử ${actionType}`, now: now(), ...o } as any);

describe("Đợt 7 ma trận tự chủ (APR-07) — lớp A", () => {
  it("1. mặc định theo PRD; chỉ OWNER đổi; loại chi tiền/xuất bản/phá hủy không bao giờ đặt được «tự động»; mỗi lần đổi giữ lịch sử", async () => {
    const w = await world();
    for (const t of ["research", "verify_evidence", "create_opportunity", "draft_content", "draft_ads"]) assert.equal((await effectiveMode(w.db, t)).mode, "AUTO", t);
    for (const t of ["start_paid_campaign", "raise_budget", "publish_wordpress", "post_youtube", "destructive_admin"]) assert.equal((await effectiveMode(w.db, t)).mode, "GRANT", t);
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(setAutonomyRule(w.db, { actorRef: who, actionType: "research", mode: "OFF", now: now() }), "FORBIDDEN");
    await rejects(setAutonomyRule(w.db, { actorRef: OWNER, actionType: "research", mode: "MAYBE", now: now() }), "VALIDATION_ERROR");
    await rejects(setAutonomyRule(w.db, { actorRef: OWNER, actionType: "khong_co", mode: "OFF", now: now() }), "VALIDATION_ERROR");
    for (const t of Object.keys(ACTION_TYPES).filter((k) => ACTION_TYPES[k]!.risky)) await rejects(setAutonomyRule(w.db, { actorRef: OWNER, actionType: t, mode: "AUTO", now: now() }), "VALIDATION_ERROR");
    await setAutonomyRule(w.db, { actorRef: OWNER, actionType: "research", mode: "GRANT", now: now() });
    await setAutonomyRule(w.db, { actorRef: OWNER, actionType: "research", mode: "OFF", note: "tạm dừng nghiên cứu", now: now() });
    const m: any = await listAutonomyMatrix(w.db);
    const r = m.matrix.find((x: any) => x.action_type === "research");
    assert.deepEqual([r.mode, r.is_default, r.history.length], ["OFF", false, 2]);
    await assert.rejects(w.db.query(`UPDATE lumi_autonomy_rules SET mode='AUTO'`), /chỉ-thêm/);
    await assert.rejects(w.db.query(`DELETE FROM lumi_autonomy_rules`), /chỉ-thêm/);
  });

  it("2. requestAction theo ma trận: AUTO đi qua không cần giấy nhưng được GHI; có số tiền thì không tự động; OFF bị từ chối; loại rủi ro vẫn phải xin; loại lạ vẫn phải xin", async () => {
    const w = await world();
    const a = await act(w, "research");
    assert.deepEqual([a.decision, a.reason], ["ALLOW", "AUTO_BY_POLICY"]);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_action_log WHERE outcome='ALLOW' AND reason='AUTO_BY_POLICY'`))[0].n, 1, "quyết định tự động vẫn vào nhật ký");
    assert.equal((await act(w, "research", { amount: 5, currency: "USD" })).decision, "ASK", "có chi tiền ⇒ không bao giờ tự động");
    assert.equal((await act(w, "publish_wordpress")).decision, "ASK", "xuất bản phải xin");
    assert.equal((await act(w, "loai.la.chua.khai.bao")).decision, "ASK", "loại lạ vẫn phải xin (như trước khi có ma trận)");
    await setAutonomyRule(w.db, { actorRef: OWNER, actionType: "research", mode: "OFF", now: now() });
    const off = await act(w, "research");
    assert.deepEqual([off.decision, off.reason], ["DENY", "ACTION_OFF_BY_POLICY"]);
    await setAutonomyRule(w.db, { actorRef: OWNER, actionType: "research", mode: "GRANT", now: now() });
    assert.equal((await act(w, "research")).decision, "ASK", "đổi sang cần giấy ⇒ phải xin");
    await w.db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('emergency_stop','true','test',now()) ON CONFLICT (key) DO UPDATE SET value='true'`);
    await setAutonomyRule(w.db, { actorRef: OWNER, actionType: "draft_content", mode: "AUTO", now: now() });
    assert.equal((await act(w, "draft_content")).reason, "EMERGENCY_STOP", "dừng khẩn cấp thắng ma trận");
  });
});

describe("Đợt 7 báo cáo kinh tế (ECO-05) — lớp A", () => {
  it("3. báo cáo nêu công thức, kỳ, nguồn từng dòng; lọc theo kỳ và dự án; không có trường lợi nhuận; dòng tạm tính đếm riêng", async () => {
    const w = await world();
    const rec = (o: any) => recordMoney(w.db, { actorRef: OWNER, projectId: w.p1, ledger: "COMMISSION", state: "RECORDED", amount: 100, currency: "USD", source: "Sao kê (thử)", idempotencyKey: `eco-${++tick}-key-0001`, now: now(), ...o });
    await rec({ state: "PAID", amount: 120, periodStart: "2026-10-01", periodEnd: "2026-10-31" });
    await rec({ amount: 30, periodStart: "2026-11-01", periodEnd: "2026-11-30", source: "Mạng báo, chờ xác nhận" });
    await rec({ ledger: "ADS_COST", amount: 40, periodStart: "2026-10-01", periodEnd: "2026-10-31" });
    await rec({ ledger: "SPONSOR", state: "PIPELINE", amount: 2000, source: "Hợp đồng đã ký" });
    const all: any = await economyReport(w.db, { now: now() });
    assert.equal(all.rows.length, 4); assert.equal(all.formulas.length, 6);
    assert.deepEqual([all.reconciliation.provisional_rows, all.reconciliation.settled_rows], [3, 1]);
    assert.ok(all.rows.every((r: any) => r.source && r.recorded_by && r.recorded_at), "mỗi dòng có nguồn, người nhập, thời điểm");
    for (const k of [...Object.keys(all), ...Object.keys(all.summary)]) assert.ok(!/profit|loi_nhuan|margin|net_/i.test(k), `không có trường lợi nhuận: ${k}`);
    assert.equal(all.summary.ledgers.COMMISSION[0].PAID, 120);
    const oct: any = await economyReport(w.db, { from: "2026-10-01", to: "2026-10-31", now: now() });
    assert.equal(oct.rows.filter((r: any) => r.ledger === "COMMISSION").length, 1, "kỳ tháng 10 không lẫn khoản tháng 11");
    const other: any = await economyReport(w.db, { projectId: "00000000-0000-4000-8000-000000000099", now: now() });
    assert.equal(other.rows.length, 0);
  });
});

describe("Đợt 7 trạng thái tích hợp — lớp A", () => {
  it("4. chỉ kiểm biến có mặt (không bao giờ hiện giá trị); thiếu một phần/chưa cấu hình/chưa có mã được phân biệt; bằng chứng lấy từ CSDL", async () => {
    const w = await world();
    const SECRET = "super-secret-value-should-never-appear";
    const r: any = await integrationsStatus(w.db, { WORDPRESS_BASE_URL: "https://x.example", WORDPRESS_INTEGRATION_USER: SECRET, TELEGRAM_WEBHOOK_SECRET: SECRET, GOOGLE_CLIENT_ID: SECRET });
    const by = (k: string) => r.items.find((i: any) => i.key === k);
    assert.equal(by("wordpress").status, "PARTIAL"); assert.deepEqual(by("wordpress").missing, ["WORDPRESS_APPLICATION_PASSWORD"]);
    assert.equal(by("telegram").status, "PARTIAL");
    assert.equal(by("google").status, "PARTIAL");
    for (const k of ["affiliate_net", "youtube_api", "ga4_gsc"]) assert.equal(by(k).status, "NOT_BUILT");
    assert.equal(by("openrouter").status, "PARTIAL", "chưa có lượt đo thật ⇒ chưa sẵn sàng");
    assert.ok(!JSON.stringify(r).includes(SECRET), "không lộ giá trị biến");
    const none: any = await integrationsStatus(w.db, {});
    assert.equal(none.items.find((i: any) => i.key === "wordpress").status, "MISSING");
    assert.ok(none.ready < none.total);
  });
});

describe("Đợt 7 cơ hội (MOS-04 dán trong app, MOS-05 chấm điểm, MOS-02 tuyến) — lớp A", () => {
  it("5. tín hiệu: chỉ OWNER/ADMIN; trùng khóa (không phân biệt hoa/thường) ⇒ gộp vào bản gốc, không lưu hai lần; độ tin cậy luôn «chưa rõ»", async () => {
    const w = await world();
    for (const who of [VIEWER, "bot:aff"]) await rejects(submitSignal(w.db, { actorRef: who, kind: "KEYWORD", title: "đồng hồ cơ", now: now() }), "FORBIDDEN");
    await rejects(submitSignal(w.db, { actorRef: OWNER, kind: "SAI", title: "đồng hồ cơ", now: now() }), "VALIDATION_ERROR");
    await rejects(submitSignal(w.db, { actorRef: OWNER, kind: "KEYWORD", title: "ab", now: now() }), "VALIDATION_ERROR");
    await rejects(submitSignal(w.db, { actorRef: OWNER, kind: "KEYWORD", title: "đồng hồ cơ", url: "ftp://x", now: now() }), "VALIDATION_ERROR");
    const a = await submitSignal(w.db, { actorRef: ADMIN, kind: "KEYWORD", title: "Đồng hồ cơ  giá rẻ", now: now() });
    assert.deepEqual([a.duplicate, a.signal.status], [false, "NEW"]);
    const b = await submitSignal(w.db, { actorRef: OWNER, kind: "KEYWORD", title: "đồng hồ cơ giá rẻ", now: now() });
    assert.deepEqual([b.duplicate, b.signal, b.original.id === a.signal!.id], [true, null, true]);
    const list: any = await listSignals(w.db);
    assert.equal(list.signals.length, 1, "cùng một quan sát chỉ lưu một lần"); assert.ok(list.signals.every((x: any) => x.confidence === "UNKNOWN"));
    assert.match(list.note, /chưa xác minh/);
  });

  it("6. chấm điểm: từng thành phần + phiên bản, tổng khớp; tiêu chí chưa biết đóng góp 0; trừ điểm cần lý do; ngoài khoảng 0–1 bị chặn; lần chấm lại giữ lịch sử", async () => {
    const w = await world();
    const sig = (await submitSignal(w.db, { actorRef: OWNER, kind: "TREND", title: "Xu hướng đồng hồ", now: now() })).signal;
    const r1 = await scoreSignal(w.db, { actorRef: OWNER, signalId: sig.id, values: { audience_usefulness: 1, search_opportunity: 0.5 }, now: now() });
    assert.equal(r1.breakdown.reconciles, true);
    assert.equal(r1.breakdown.normalisedScore > 0, true);
    assert.equal(r1.breakdown.knownDimensions, 2);
    assert.equal(r1.breakdown.contributions.find((c: any) => c.dimension === "uniqueness")!.known, false);
    assert.equal(r1.breakdown.contributions.find((c: any) => c.dimension === "uniqueness")!.contribution, 0, "chưa biết ⇒ không cộng điểm");
    await rejects(scoreSignal(w.db, { actorRef: OWNER, signalId: sig.id, values: { audience_usefulness: 1.5 }, now: now() }), "VALIDATION_ERROR");
    await rejects(scoreSignal(w.db, { actorRef: OWNER, signalId: sig.id, values: { khong_co: 1 }, now: now() }), "VALIDATION_ERROR");
    await rejects(scoreSignal(w.db, { actorRef: OWNER, signalId: sig.id, values: { risk: 1 }, now: now() }), "VALIDATION_ERROR"); // trừ điểm không kèm lý do
    const r2 = await scoreSignal(w.db, { actorRef: OWNER, signalId: sig.id, values: { audience_usefulness: 1, risk: 0.5 }, penaltyReasons: { risk: "Có thể vi phạm chính sách quảng cáo" }, now: now() });
    assert.equal(r2.history.length, 2, "lần chấm trước vẫn còn trong lịch sử");
    assert.equal(r2.breakdown.contributions.find((c: any) => c.dimension === "risk")!.reason, "Có thể vi phạm chính sách quảng cáo");
    const [row] = await w.db.query<any>(`SELECT count(*)::int n, max(config_version) v FROM lumi_signal_scores WHERE signal_id=$1`, [sig.id]);
    assert.deepEqual([row.n, row.v], [2, r2.breakdown.configVersion]);
    await assert.rejects(w.db.query(`UPDATE lumi_signal_scores SET score=1`), /chỉ-thêm/);
    await rejects(scoreSignal(w.db, { actorRef: VIEWER, signalId: sig.id, values: {}, now: now() }), "FORBIDDEN");
  });

  it("7. tuyến: đề xuất (OWNER/ADMIN), chỉ OWNER quyết; từ chối cần lý do; chấp nhận ⇒ tín hiệu «đã có tuyến» nhưng KHÔNG phải duyệt chi tiền; một tín hiệu nhiều tuyến; trùng loại tuyến bị chặn", async () => {
    const w = await world();
    const sig = (await submitSignal(w.db, { actorRef: OWNER, kind: "OWNER_IDEA", title: "Kênh review đồng hồ", now: now() })).signal;
    await rejects(proposeRoute(w.db, { actorRef: VIEWER, signalId: sig.id, routeType: "WATCHLIST", reason: "theo dõi", now: now() }), "FORBIDDEN");
    await rejects(proposeRoute(w.db, { actorRef: OWNER, signalId: sig.id, routeType: "PPC", reason: "theo dõi", now: now() }), "VALIDATION_ERROR");
    await rejects(proposeRoute(w.db, { actorRef: OWNER, signalId: sig.id, routeType: "WATCHLIST", reason: "", now: now() }), "VALIDATION_ERROR");
    const r1 = (await proposeRoute(w.db, { actorRef: ADMIN, signalId: sig.id, routeType: "YOUTUBE_NICHE", reason: "Hợp kênh", fitScore: 70, now: now() })).route;
    const r2 = (await proposeRoute(w.db, { actorRef: ADMIN, signalId: sig.id, routeType: "CONTENT_OPPORTUNITY", reason: "Bài tổng hợp", now: now() })).route;
    await rejects(decideRoute(w.db, { actorRef: ADMIN, routeId: r1.id, decision: "ACCEPT", now: now() }), "FORBIDDEN");
    await rejects(decideRoute(w.db, { actorRef: OWNER, routeId: r2.id, decision: "REJECT", now: now() }), "VALIDATION_ERROR");
    const d1 = await decideRoute(w.db, { actorRef: OWNER, routeId: r1.id, decision: "ACCEPT", now: now() });
    assert.match(d1.note, /KHÔNG phải phê duyệt chi tiền/);
    await rejects(decideRoute(w.db, { actorRef: OWNER, routeId: r1.id, decision: "ACCEPT", now: now() }), "INVALID_TRANSITION");
    await decideRoute(w.db, { actorRef: OWNER, routeId: r2.id, decision: "REJECT", notes: "Chưa cần", now: now() });
    assert.equal((await w.db.query<any>(`SELECT status FROM opportunity_signals WHERE id=$1`, [sig.id]))[0].status, "ROUTED");
    await rejects(proposeRoute(w.db, { actorRef: OWNER, signalId: sig.id, routeType: "YOUTUBE_NICHE", reason: "lại", now: now() }), "INVALID_TRANSITION"); // trùng loại tuyến
    assert.equal((await submitSignal(w.db, { actorRef: OWNER, kind: "OWNER_IDEA", title: "kênh review đồng hồ", now: now() })).duplicate, true);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_money_entries`))[0].n, 0, "chọn tuyến không tạo khoản chi nào");
  });
});
