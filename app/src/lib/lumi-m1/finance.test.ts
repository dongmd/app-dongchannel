/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-05 (CST-01/02, ECO-02/04, MOS-03, DSH-05/07) — evidence class A: PGlite + real migrations (incl. 0048). No model, no outside account.
 * Proves: limits are enforced ONLY on measured cost and say so; the three ledgers never merge into a profit and PIPELINE is never cash; adjustments never rewrite a number;
 * experiment criteria are fixed before data and one conversion never recommends scaling.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { LumiError } from "./core";
import { createTask } from "./core-web";
import { createAssistant } from "./assistants";
import { costLimitTick, dayKey, dayStart, listCostLimits, removeCostLimit, setCostLimit } from "./cost-limits";
import { adjustMoney, areaResults, assistantHealth, createExperiment, decideExperiment, evaluateExperiment, listExperiments, listMoney, lockExperiment, moneySummary, recordExperimentResult, recordMoney } from "./finance";

const T0 = new Date("2026-11-08T08:00:00Z");
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER = "web:owner@test", ADMIN = "web:admin@test", VIEWER = "web:viewer@test";
const rejects = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: any) => e instanceof LumiError && e.code === code, `expected ${code}`); };
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [[OWNER, "OWNER"], [ADMIN, "ADMIN"], [VIEWER, "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
  const [p1] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án AFF','AFFILIATE') RETURNING id`);
  const [p2] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p2','Dự án YT','YOUTUBE') RETURNING id`);
  const mk = async (slug: string) => { const a = (await createAssistant(db, { actorRef: OWNER, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant; await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true WHERE id=$1`, [a.id]); return a; };
  return { db, p1: p1.id as string, p2: p2.id as string, aff: await mk("aff"), yt: await mk("yt") };
}
type W = Awaited<ReturnType<typeof world>>;
let seq = 0;
const task = (w: W, a: any, project: string) => createTask(w.db, { actorRef: OWNER, clientRequestId: `fin-${++seq}-0000001`, projectId: project, assigneeId: a.id, title: `Việc ${seq}`, now: T0 });
/** a finished run with a measured cost today (the same row the worker's probe writes) */
async function measured(w: W, a: any, project: string, cost: number) {
  const t = (await task(w, a, project)).task;
  const run = (await w.db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [t.id]))[0];
  await w.db.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',started_at=$2::timestamptz,finished_at=$2::timestamptz + interval '5 seconds' WHERE id=$1`, [run.id, T0.toISOString()]);
  await w.db.query(`INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,after_usage,before_at,after_at,currency) VALUES ($1,$2,'MEASURED',1,$3,$4,$4,'USD')`, [run.id, a.id, 1 + cost, T0.toISOString()]);
  return { run: run.id as string, task: t };
}

describe("IMP-05 giới hạn chi phí AI — lớp A", () => {
  it("1. chỉ OWNER đặt; chỉ USD; thay giới hạn giữ lịch sử; ngày tính theo giờ Việt Nam", async () => {
    const w = await world();
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(setCostLimit(w.db, { actorRef: who, scope: "DAY_GLOBAL", amount: 1, now: now() }), "FORBIDDEN");
    await rejects(setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_GLOBAL", amount: 0, now: now() }), "VALIDATION_ERROR");
    await rejects(setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_GLOBAL", amount: 5, currency: "VND", now: now() }), "VALIDATION_ERROR");
    await rejects(setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_ASSISTANT", scopeRef: "khong-co", amount: 1, now: now() }), "NOT_FOUND");
    await rejects(setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_GLOBAL", scopeRef: "x", amount: 1, now: now() }), "VALIDATION_ERROR");
    await setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_GLOBAL", amount: 1, now: now() });
    await setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_GLOBAL", amount: 2, now: now() }); // thay ⇒ bản cũ vẫn còn trong lịch sử
    assert.deepEqual((await w.db.query<any>(`SELECT active,amount::float a FROM lumi_cost_limits ORDER BY set_at`)).map((r: any) => [r.active, r.a]), [[false, 1], [true, 2]]);
    assert.equal((await listCostLimits(w.db, now())).length, 1);
    // 23:30 UTC ngày 8 = 06:30 ngày 9 giờ Việt Nam
    assert.equal(dayKey(new Date("2026-11-08T23:30:00Z")), "2026-11-09");
    assert.equal(dayStart(new Date("2026-11-08T23:30:00Z")).toISOString(), "2026-11-08T17:00:00.000Z");
  });

  it("2. chạm trần theo ngày (cả công ty / từng bot) và theo dự án ⇒ lượt MỚI bị từ chối COST_CAP; lượt chưa đo chi phí không bị tính (nói rõ); dưới trần vẫn chạy", async () => {
    const w = await world();
    await setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_GLOBAL", amount: 0.5, now: now() });
    await task(w, w.aff, w.p1); // chưa có số đo nào ⇒ chưa chạm
    await measured(w, w.aff, w.p1, 0.2);
    await task(w, w.yt, w.p2); // 0.2 < 0.5
    await measured(w, w.yt, w.p2, 0.35); // tổng 0.55 ≥ 0.5
    await assert.rejects(task(w, w.aff, w.p1), (e: any) => e instanceof LumiError && e.code === "COST_CAP" && e.data.scope === "DAY_GLOBAL" && (e.data as any).spent_measured >= 0.5);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM tasks`))[0].n, 4, "bị từ chối thì không tạo việc/lượt dở");
    // giới hạn riêng từng bot: yt chạm, aff không
    const w2 = await world();
    await setCostLimit(w2.db, { actorRef: OWNER, scope: "DAY_ASSISTANT", scopeRef: "yt", amount: 0.3, now: now() });
    await measured(w2, w2.yt, w2.p2, 0.31); await measured(w2, w2.aff, w2.p1, 0.31);
    await rejects(task(w2, w2.yt, w2.p2), "COST_CAP");
    await task(w2, w2.aff, w2.p1);
    // theo dự án (tổng cộng dồn, không reset theo ngày)
    const w3 = await world();
    await setCostLimit(w3.db, { actorRef: OWNER, scope: "PROJECT_TOTAL", scopeRef: w3.p1, amount: 0.4, now: now() });
    await measured(w3, w3.aff, w3.p1, 0.41);
    await rejects(task(w3, w3.aff, w3.p1), "COST_CAP");
    await task(w3, w3.aff, w3.p2); // dự án khác không bị
    // gỡ giới hạn ⇒ chạy lại được
    const lim = (await listCostLimits(w3.db, now()))[0];
    await removeCostLimit(w3.db, { actorRef: OWNER, limitId: lim.id, now: now() });
    await task(w3, w3.aff, w3.p1);
    await rejects(removeCostLimit(w3.db, { actorRef: OWNER, limitId: lim.id, now: now() }), "NOT_FOUND");
  });

  it("3. cảnh báo ở ngưỡng và thông báo chạm trần: mỗi mức MỘT lần mỗi ngày; chi phí một lượt vượt trần lượt ⇒ gắn cờ cần quyết định đúng một lần", async () => {
    const w = await world();
    const lim = (await setCostLimit(w.db, { actorRef: OWNER, scope: "DAY_GLOBAL", amount: 1, warnRatio: 0.5, now: now() })).limit;
    await setCostLimit(w.db, { actorRef: OWNER, scope: "RUN", amount: 0.3, now: now() });
    const r = await measured(w, w.aff, w.p1, 0.6);
    const t1 = await costLimitTick(w.db, T0);
    assert.deepEqual([t1.warned, t1.stopped, t1.runsFlagged], [1, 0, 1]);
    assert.deepEqual(await costLimitTick(w.db, T0), { warned: 0, stopped: 0, runsFlagged: 0 }, "lặp lại không báo thêm");
    assert.equal((await w.db.query<any>(`SELECT needs_decision n FROM tasks WHERE id=$1`, [r.task.id]))[0].n, true);
    await measured(w, w.aff, w.p1, 0.5); // tổng 1.1 ≥ 1 ⇒ báo chạm trần
    const t2 = await costLimitTick(w.db, T0);
    assert.equal(t2.stopped, 1);
    assert.equal((await costLimitTick(w.db, T0)).stopped, 0);
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_cost_alerts WHERE limit_id=$1`, [lim.id]))[0].n, 2);
    // sang ngày mới: ngưỡng đếm lại từ 0 ⇒ không báo
    assert.deepEqual(await costLimitTick(w.db, new Date(T0.getTime() + 2 * 86400_000)), { warned: 0, stopped: 0, runsFlagged: 0 });
  });
});

describe("IMP-05 sổ tiền tách riêng (ECO-02, MOS-03, DSH-05) — lớp A", () => {
  const rec = (w: W, o: any = {}) => recordMoney(w.db, { actorRef: OWNER, projectId: w.p1, ledger: "COMMISSION", state: "RECORDED", amount: 100, currency: "USD", source: "Sao kê mạng lưới tháng 10", idempotencyKey: `mny-${++seq}-key-00001`, now: now(), ...o });

  it("4. chỉ OWNER/ADMIN ghi; bot/VIEWER không; nguồn bắt buộc; trạng thái bắt đầu theo sổ; trùng khóa = một dòng", async () => {
    const w = await world();
    for (const who of [VIEWER, "bot:aff"]) await rejects(rec(w, { actorRef: who }), "FORBIDDEN");
    await rejects(rec(w, { source: "" }), "VALIDATION_ERROR");
    await rejects(rec(w, { amount: -1 }), "VALIDATION_ERROR");
    await rejects(rec(w, { currency: "usd" }), "VALIDATION_ERROR");
    await rejects(rec(w, { ledger: "ADS_COST", state: "PAID" }), "VALIDATION_ERROR"); // chi phí quảng cáo chỉ «đã ghi»
    await rejects(rec(w, { ledger: "COMMISSION", state: "PIPELINE" }), "VALIDATION_ERROR"); // pipeline chỉ cho tài trợ
    await rejects(rec(w, { periodStart: "2026-11-10", periodEnd: "2026-11-01" }), "VALIDATION_ERROR");
    const a = await rec(w, { idempotencyKey: "mny-same-key-0001" }); const b = await rec(w, { idempotencyKey: "mny-same-key-0001" });
    assert.deepEqual([a.alreadyProcessed, b.alreadyProcessed, a.entry.id === b.entry.id], [false, true, true]);
    assert.equal((await rec(w, { actorRef: ADMIN })).alreadyProcessed, false);
  });

  it("5. vòng đời và điều chỉnh: ghi nhận → xác nhận → đã trả → đảo; số cũ KHÔNG bị sửa/xóa; đảo là trạng thái cuối; chi phí QC chỉ đảo; sai bước bị chặn", async () => {
    const w = await world();
    const e = (await rec(w)).entry;
    const adj = (to: any, extra: any = {}) => adjustMoney(w.db, { actorRef: OWNER, entryId: e.id, toState: to, idempotencyKey: `adj-${++seq}-key-00001`, now: now(), ...extra });
    await rejects(adjustMoney(w.db, { actorRef: VIEWER, entryId: e.id, toState: "CONFIRMED", idempotencyKey: "adj-viewer-00001", now: now() }), "FORBIDDEN");
    await rejects(adj("RECORDED"), "INVALID_TRANSITION"); // không lùi
    await adj("CONFIRMED"); await adj("PAID");
    await rejects(adj("CONFIRMED"), "INVALID_TRANSITION");
    assert.equal((await moneySummary(w.db)).ledgers.COMMISSION[0]!.PAID, 100);
    await adj("REVERSED", { amount: 100, note: "Mạng lưới đảo hoa hồng (chargeback)" });
    await rejects(adj("PAID"), "INVALID_TRANSITION");
    const sm = await moneySummary(w.db);
    assert.deepEqual([sm.ledgers.COMMISSION[0]!.PAID, sm.ledgers.COMMISSION[0]!.REVERSED], [0, 100], "báo cáo hiện trạng thái hiện hành, không cộng dồn");
    const rows = await w.db.query<any>(`SELECT state FROM lumi_money_entries ORDER BY created_at`);
    assert.deepEqual(rows.map((r: any) => r.state), ["RECORDED", "CONFIRMED", "PAID", "REVERSED"], "bốn dòng được giữ nguyên làm lịch sử");
    await assert.rejects(w.db.query(`UPDATE lumi_money_entries SET amount=999`), /chỉ-thêm/);
    await assert.rejects(w.db.query(`DELETE FROM lumi_money_entries`), /chỉ-thêm/);
    // đảo vượt số gốc bị chặn
    const e2 = (await rec(w, { amount: 50 })).entry;
    await rejects(adjustMoney(w.db, { actorRef: OWNER, entryId: e2.id, toState: "REVERSED", amount: 60, idempotencyKey: "adj-over-key-0001", now: now() }), "VALIDATION_ERROR");
    // chi phí quảng cáo chỉ có thể đảo
    const ad = (await rec(w, { ledger: "ADS_COST", amount: 30 })).entry;
    await rejects(adjustMoney(w.db, { actorRef: OWNER, entryId: ad.id, toState: "CONFIRMED", idempotencyKey: "adj-ads-key-00001", now: now() }), "INVALID_TRANSITION");
    // phát lại điều chỉnh cùng khóa ⇒ không thêm dòng
    const k = "adj-replay-key-001";
    await adjustMoney(w.db, { actorRef: OWNER, entryId: e2.id, toState: "CONFIRMED", idempotencyKey: k, now: now() });
    assert.equal((await adjustMoney(w.db, { actorRef: OWNER, entryId: e2.id, toState: "CONFIRMED", idempotencyKey: k, now: now() })).alreadyProcessed, true);
    assert.equal((await listMoney(w.db)).find((x: any) => x.root_id === e2.id)!.history.length, 1);
  });

  it("6. ba sổ KHÔNG cộng thành lợi nhuận; pipeline (hợp đồng đã ký) không phải tiền thu; tiền tệ khác nhau tách riêng; chi phí AI là sổ thứ tư chỉ tính số đo", async () => {
    const w = await world();
    await rec(w, { ledger: "ADS_COST", amount: 40 });
    await rec(w, { ledger: "COMMISSION", state: "PAID", amount: 100 });
    await rec(w, { ledger: "COMMISSION", state: "CONFIRMED", amount: 30 });
    await rec(w, { ledger: "COMMISSION", state: "PAID", amount: 500000, currency: "VND" });
    await rec(w, { ledger: "SPONSOR", state: "PIPELINE", amount: 2000, source: "Hợp đồng tài trợ đã ký (chưa nhận tiền)" });
    await measured(w, w.aff, w.p1, 0.25);
    const sm: any = await moneySummary(w.db);
    assert.equal(sm.ledgers.ADS_COST[0].RECORDED, 40);
    assert.deepEqual(sm.ledgers.COMMISSION.map((c: any) => [c.currency, c.PAID, c.CONFIRMED]).sort(), [["USD", 100, 30], ["VND", 500000, 0]]);
    assert.deepEqual([sm.ledgers.SPONSOR[0].PIPELINE, sm.ledgers.SPONSOR[0].PAID], [2000, 0], "pipeline không cộng vào tiền đã thu");
    assert.equal(sm.ai_cost.measured.toFixed(2), "0.25");
    for (const k of Object.keys(sm)) assert.ok(!/profit|loi_nhuan|net|margin/i.test(k), `không có trường lợi nhuận: ${k}`);
    assert.match(sm.note, /KHÔNG cộng thành lợi nhuận/);
    const areas: any[] = await areaResults(w.db);
    const aff = areas.find((a) => a.area === "AFFILIATE");
    assert.deepEqual([aff.has_data, aff.commission_paid.USD, aff.ads_cost.USD, aff.pipeline.USD], [true, 100, 40, 2000]);
    assert.deepEqual(aff.sources.length > 0, true);
    for (const empty of ["YOUTUBE", "WEBSITE", "OTHER"]) assert.equal(areas.find((a) => a.area === empty).has_data, false, `${empty}: chưa có dữ liệu, không tự điền`);
    assert.equal((await moneySummary(w.db, { projectId: w.p2 })).entries, 0);
  });

  it("7. tình trạng trợ lý: số lượt đang chạy, việc chờ kết nối, chi phí hôm nay chỉ tính số đo và đếm riêng lượt chưa biết", async () => {
    const w = await world();
    await measured(w, w.aff, w.p1, 0.12);
    const t = (await task(w, w.aff, w.p1)).task; const run = (await w.db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [t.id]))[0];
    await w.db.query(`UPDATE lumi_task_runs SET state='SUCCEEDED',started_at=$2::timestamptz,finished_at=$2::timestamptz + interval '3 seconds' WHERE id=$1`, [run.id, T0.toISOString()]); // không có thăm dò ⇒ chưa biết
    const h = await assistantHealth(w.db, T0);
    const aff: any = h.find((x: any) => x.slug === "aff");
    assert.equal(aff.cost_today_measured.toFixed(2), "0.12"); assert.equal(aff.runs_unknown_today, 1);
    assert.equal(h.find((x: any) => x.slug === "yt")!.cost_today_measured, 0);
  });
});

describe("IMP-05 thử nghiệm có tiêu chí chốt trước (ECO-04, AFF-04) — lớp A", () => {
  const base = (w: W, o: any = {}) => ({ actorRef: OWNER, projectId: w.p1, title: "Thử Google Search", hypothesis: "Từ khóa thương hiệu chuyển đổi tốt hơn", baseline: "0,8% chuyển đổi", metricUnit: "USD/chuyển đổi", metricSource: "Báo cáo Google Ads", observationDays: 14, minSample: 5, capAmount: 100, maxLoss: 60, currency: "USD", stopCondition: "Chi 40 USD mà không có chuyển đổi", scaleCondition: "≥ 5 chuyển đổi và CPA ≤ 12 USD", targetMetricMin: 8, stopSpendNoConversion: 40, evaluator: "Chủ", now: now(), ...o });

  it("8. thiếu giả thuyết/baseline/nguồn/trần/điều kiện dừng-scale/người đánh giá thì không tạo; chốt chỉ OWNER; sau chốt tiêu chí KHÔNG sửa được (kể cả bằng SQL); chưa chốt không nhận kết quả", async () => {
    const w = await world();
    for (const bad of [{ hypothesis: "" }, { baseline: "" }, { metricSource: "" }, { stopCondition: "" }, { scaleCondition: "" }, { evaluator: "" }, { capAmount: -1 }, { minSample: 0 }, { observationDays: 0 }, { currency: "us" }]) await rejects(createExperiment(w.db, base(w, bad) as any), "VALIDATION_ERROR");
    const e = (await createExperiment(w.db, base(w) as any)).experiment;
    assert.equal(e.state, "DRAFT");
    await rejects(recordExperimentResult(w.db, { actorRef: OWNER, experimentId: e.id, observedOn: "2026-11-08", spend: 5, conversions: 0, now: now() }), "NOT_LOCKED");
    for (const who of [ADMIN, VIEWER, "bot:aff"]) await rejects(lockExperiment(w.db, { actorRef: who, experimentId: e.id, now: now() }), "FORBIDDEN");
    await lockExperiment(w.db, { actorRef: OWNER, experimentId: e.id, now: now() });
    assert.equal((await lockExperiment(w.db, { actorRef: OWNER, experimentId: e.id, now: now() })).alreadyProcessed, true);
    await assert.rejects(w.db.query(`UPDATE lumi_experiments SET cap_amount=1000 WHERE id=$1`, [e.id]), /đã chốt trước khi chạy/);
    await assert.rejects(w.db.query(`UPDATE lumi_experiments SET stop_condition='đổi luật giữa chừng' WHERE id=$1`, [e.id]), /đã chốt/);
  });

  it("9. hàm đánh giá: một chuyển đổi KHÔNG bao giờ khuyến nghị scale; chạm trần/ngưỡng chi không chuyển đổi ⇒ STOP; đủ mẫu + đạt mục tiêu ⇒ chỉ là ứng viên; thiếu dữ liệu ⇒ «chưa đủ bằng chứng»", () => {
    const c = { cap_amount: 100, max_loss: 60, min_sample: 5, observation_days: 14, target_metric_min: 8, stop_spend_no_conversion: 40 };
    const r = (spend: number, conv: number, metric: number | null, day = "2026-11-08") => ({ observed_on: day, spend, conversions: conv, metric_value: metric });
    assert.equal(evaluateExperiment(c, []).verdict, "RUNNING");
    const lucky = evaluateExperiment(c, [r(10, 1, 50)]);
    assert.equal(lucky.verdict, "INSUFFICIENT_EVIDENCE"); assert.match(lucky.reasons.join(" "), /một chuyển đổi/);
    assert.equal(evaluateExperiment(c, [r(45, 0, null)]).verdict, "STOP");
    assert.equal(evaluateExperiment(c, [r(100, 9, 20)]).verdict, "STOP", "chạm trần ưu tiên hơn kết quả tốt");
    assert.equal(evaluateExperiment(c, [r(30, 6, 9, "2026-11-08"), r(20, 2, 9, "2026-11-09")]).verdict, "SCALE_CANDIDATE");
    assert.equal(evaluateExperiment(c, [r(30, 6, 5)]).verdict, "INSUFFICIENT_EVIDENCE", "đủ mẫu nhưng chưa đạt mục tiêu");
    assert.equal(evaluateExperiment({ ...c, min_sample: 1 }, [r(10, 2, 50)]).verdict, "INSUFFICIENT_EVIDENCE", "ngay cả min_sample = 1, sàn là 3 chuyển đổi");
    assert.equal(evaluateExperiment({ ...c, target_metric_min: null }, [r(30, 9, 50)]).verdict, "INSUFFICIENT_EVIDENCE");
  });

  it("10. vòng đời: kết quả tốt ⇒ SCALE_PROPOSED nhưng KHÔNG đổi ngân sách/quyền; Chủ đồng ý chỉ ghi nhận hướng; chạm trần ⇒ STOPPED và nhánh dừng không nhận thêm dữ liệu; đóng khi thiếu mẫu ⇒ INSUFFICIENT", async () => {
    const w = await world();
    const make = async (o: any = {}) => { const e = (await createExperiment(w.db, base(w, o) as any)).experiment; await lockExperiment(w.db, { actorRef: OWNER, experimentId: e.id, now: now() }); return e; };
    const res = (id: string, spend: number, conv: number, metric?: number, day = "2026-11-08") => recordExperimentResult(w.db, { actorRef: ADMIN, experimentId: id, observedOn: day, spend, conversions: conv, metricValue: metric, now: now() });
    const budgets = JSON.stringify(await w.db.query(`SELECT * FROM lumi_budgets`)); const grants = (await w.db.query<any>(`SELECT count(*)::int n FROM lumi_grants`))[0].n;
    // 1) scale được đề xuất
    const a = await make();
    assert.equal((await res(a.id, 10, 1, 50)).verdict.verdict, "INSUFFICIENT_EVIDENCE");
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_experiments WHERE id=$1`, [a.id]))[0].state, "LOCKED");
    assert.equal((await res(a.id, 30, 6, 9, "2026-11-09")).verdict.verdict, "SCALE_CANDIDATE");
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_experiments WHERE id=$1`, [a.id]))[0].state, "SCALE_PROPOSED");
    await rejects(decideExperiment(w.db, { actorRef: ADMIN, experimentId: a.id, decision: "APPROVE_SCALE", note: "ok", now: now() }), "FORBIDDEN");
    await rejects(decideExperiment(w.db, { actorRef: OWNER, experimentId: a.id, decision: "APPROVE_SCALE", note: "", now: now() }), "VALIDATION_ERROR");
    await decideExperiment(w.db, { actorRef: OWNER, experimentId: a.id, decision: "APPROVE_SCALE", note: "Đồng ý thử mở rộng nhẹ", now: now() });
    assert.match((await w.db.query<any>(`SELECT decision_note n FROM lumi_experiments WHERE id=$1`, [a.id]))[0].n, /ngân sách\/giấy ủy quyền phải cấp RIÊNG/);
    assert.equal(JSON.stringify(await w.db.query(`SELECT * FROM lumi_budgets`)), budgets, "kết quả tốt không tự cấp thêm ngân sách");
    assert.equal((await w.db.query<any>(`SELECT count(*)::int n FROM lumi_grants`))[0].n, grants);
    // 2) chạm ngưỡng ⇒ dừng nhánh
    const b = await make({ title: "Thử khác" });
    assert.equal((await res(b.id, 45, 0)).verdict.verdict, "STOP");
    assert.equal((await w.db.query<any>(`SELECT state FROM lumi_experiments WHERE id=$1`, [b.id]))[0].state, "STOPPED");
    await rejects(res(b.id, 1, 1, 1), "EXPERIMENT_CLOSED");
    // 3) hết kỳ mà thiếu mẫu ⇒ «chưa đủ bằng chứng»
    const c = await make({ title: "Thử thứ ba" });
    await res(c.id, 10, 1, 4);
    assert.equal((await decideExperiment(w.db, { actorRef: OWNER, experimentId: c.id, decision: "CLOSE", note: "Hết kỳ quan sát", now: now() })).state, "INSUFFICIENT");
    const list: any[] = await listExperiments(w.db);
    assert.deepEqual(list.map((e) => e.state).sort(), ["COMPLETED", "INSUFFICIENT", "STOPPED"]);
  });
});
