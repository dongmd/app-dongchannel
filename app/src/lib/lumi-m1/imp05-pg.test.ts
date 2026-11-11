/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-05 (Đợt 5) — evidence class B: a REAL PostgreSQL server, many real connections, real migrations 0000..0048.
 * HTTP contract by role for cost limits / money books / experiments, and concurrency: parallel limit changes, parallel money adjustments, parallel experiment locks.
 * No model is called; nothing outside the test database is touched.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { type Db } from "./core";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { createAssistant } from "./assistants";

let srv: PgServer; let db: Db;
let tick = 0;
const T0 = new Date();
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const BOT: Principal = { kind: "bot", slug: "x", actorRef: "bot:x" };
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });
const ctx = (): ApiCtx => ({ db, hermes: new SimulatedHermes(), now });
const call = (name: string, p: Principal | null, o: { params?: Record<string, string>; body?: any; key?: string } = {}) => handle(name, ctx(), { principal: p, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });
/** the HTTP layer returns failures as {status,data} (never throws) */
const rej = async (p: Promise<any>, status: number | null, code?: string) => { const r = await p; if (status !== null) assert.equal(r.status, status, JSON.stringify(r)); else assert.ok(r.status >= 400, JSON.stringify(r)); if (code) assert.equal(r.error?.code, code, JSON.stringify(r)); };
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

async function world() {
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${uniq()}`, `Dự án ${uniq()}`]);
  const slug = `a-${uniq()}`.slice(0, 20);
  const a = (await createAssistant(db, { actorRef: OWNER.actorRef, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
  return { proj: proj.id as string, a };
}
const expBody = (proj: string, over: any = {}) => ({ project_id: proj, title: "Thử nghiệm PG", hypothesis: "Từ khóa thương hiệu tốt hơn", baseline: "0,8%", metric_unit: "USD/chuyển đổi", metric_source: "Bảng điều khiển quảng cáo", observation_days: 7, min_sample: 5, cap_amount: 50, max_loss: 30, currency: "USD", stop_condition: "Chi 30 USD mà không có chuyển đổi", scale_condition: "Từ 5 chuyển đổi, chi phí/chuyển đổi dưới mục tiêu", evaluator: "Chủ", ...over });

before(async () => {
  srv = await startPgServer(); db = postgresDb(srv.sql);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ref, role]);
});
after(async () => { await srv?.stop(); });

describe("IMP-05 — hợp đồng HTTP theo vai trò (PostgreSQL thật)", () => {
  it("1. giới hạn chi phí: chỉ OWNER đặt/gỡ; ai đăng nhập cũng xem; bot bị chặn", async () => {
    for (const p of [ADMIN, VIEWER, BOT]) await rej(call("setCostLimit", p, { body: { scope: "DAY_GLOBAL", amount: 1 } }), 403);
    await rej(call("setCostLimit", null, { body: { scope: "DAY_GLOBAL", amount: 1 } }), 401);
    const r = await call("setCostLimit", OWNER, { body: { scope: "DAY_GLOBAL", amount: 3 } });
    assert.equal(r.status, 201);
    for (const p of [OWNER, ADMIN, VIEWER]) { const l = await call("listCostLimits", p); assert.equal(l.status, 200); assert.ok(Array.isArray(l.data.limits)); }
    await rej(call("listCostLimits", BOT), 403);
    const id = r.data.limit.id;
    await rej(call("removeCostLimit", ADMIN, { params: { id } }), 403);
    assert.equal((await call("removeCostLimit", OWNER, { params: { id } })).status, 200);
  });

  it("2. sổ tiền: OWNER/ADMIN ghi; VIEWER/bot không; thiếu khóa lặp ⇒ 400; trùng khóa trả already_processed; tổng quan không có lợi nhuận", async () => {
    const w = await world();
    const body = { project_id: w.proj, ledger: "COMMISSION", state: "RECORDED", amount: 100, currency: "USD", source: "Sao kê tháng 10" };
    await rej(call("recordMoney", OWNER, { body }), 400);
    for (const p of [VIEWER, BOT]) await rej(call("recordMoney", p, { body, key: "money-forbidden-01" }), 403);
    const a = await call("recordMoney", ADMIN, { body, key: "money-same-key-0001" }); const b = await call("recordMoney", ADMIN, { body, key: "money-same-key-0001" });
    assert.deepEqual([a.status, b.status, b.data.already_processed], [201, 200, true]);
    const o = await call("moneyOverview", VIEWER, { body: { project_id: w.proj } });
    assert.equal(o.status, 200); assert.equal(o.data.entries.length, 1);
    assert.ok(!/profit|lợi nhuận ròng/i.test(Object.keys(o.data.summary).join(" ")));
    const d = await call("dashboardFinance", VIEWER);
    assert.equal(d.data.areas.length, 4); assert.ok(d.data.health.length >= 1);
  });

  it("3. thử nghiệm: tạo OWNER/ADMIN; chốt/quyết chỉ OWNER; nhập kết quả sau chốt; một chuyển đổi không đủ đề xuất mở rộng", async () => {
    const w = await world();
    await rej(call("createExperiment", VIEWER, { body: expBody(w.proj) }), 403);
    const c = await call("createExperiment", ADMIN, { body: expBody(w.proj) });
    assert.equal(c.status, 201); const id = c.data.experiment.id;
    await rej(call("recordExperimentResult", ADMIN, { params: { id }, body: { observed_on: "2026-11-08", spend: 5, conversions: 1 } }), null, "NOT_LOCKED");
    await rej(call("lockExperiment", ADMIN, { params: { id } }), 403);
    assert.equal((await call("lockExperiment", OWNER, { params: { id } })).status, 200);
    const r = await call("recordExperimentResult", ADMIN, { params: { id }, body: { observed_on: "2026-11-08", spend: 5, conversions: 1 } });
    assert.equal(r.status, 201);
    const list = await call("listExperiments", VIEWER);
    const ex = (list.data.experiments as any[]).find((x) => x.id === id);
    assert.notEqual(ex.verdict?.verdict, "SCALE_CANDIDATE", "một chuyển đổi không bao giờ đủ để đề xuất mở rộng");
    await rej(call("decideExperiment", ADMIN, { params: { id }, body: { decision: "CLOSE", note: "hết kỳ" } }), 403);
    await rej(call("decideExperiment", OWNER, { params: { id }, body: { decision: "XOA", note: "x" } }), 400);
    assert.equal((await call("decideExperiment", OWNER, { params: { id }, body: { decision: "CLOSE", note: "hết kỳ quan sát" } })).status, 200);
  });
});

describe("IMP-05 — đồng thời (nhiều kết nối thật)", () => {
  it("4. 8 yêu cầu đặt giới hạn cùng phạm vi song song ⇒ đúng MỘT giới hạn hiện hành, các bản cũ giữ lịch sử", async () => {
    const rs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => call("setCostLimit", OWNER, { body: { scope: "DAY_GLOBAL", amount: 1 + i } })));
    assert.ok(rs.every((r) => r.status === "fulfilled"), JSON.stringify(rs.filter((r) => r.status === "rejected")));
    const [n] = await db.query<any>(`SELECT count(*)::int n FROM lumi_cost_limits WHERE scope='DAY_GLOBAL' AND active`);
    assert.equal(n.n, 1);
  });

  it("5. 6 điều chỉnh «đã trả» song song cùng một khoản ⇒ đúng một dòng PAID, số tiền không bị cộng đôi", async () => {
    const w = await world();
    const e = (await call("recordMoney", OWNER, { body: { project_id: w.proj, ledger: "COMMISSION", state: "RECORDED", amount: 70, currency: "USD", source: "Sao kê" }, key: `race-${uniq()}-0001` })).data.entry;
    const rs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => call("adjustMoney", OWNER, { params: { id: e.id }, body: { to_state: "PAID" }, key: `race-adj-${uniq()}-${i}0001` })));
    const okN = rs.filter((r) => r.status === "fulfilled").length;
    assert.ok(okN >= 1);
    const [n] = await db.query<any>(`SELECT count(*)::int n FROM lumi_money_entries WHERE project_id=$1 AND state='PAID'`, [w.proj]);
    assert.equal(n.n, 1, "chỉ một dòng PAID");
    const o = await call("moneyOverview", OWNER, { body: { project_id: w.proj } });
    assert.equal(o.data.summary.ledgers.COMMISSION[0].PAID, 70);
  });

  it("6. 6 lần chốt tiêu chí song song ⇒ chốt đúng một lần, còn lại báo đã xử lý", async () => {
    const w = await world();
    const id = (await call("createExperiment", OWNER, { body: expBody(w.proj) })).data.experiment.id;
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => call("lockExperiment", OWNER, { params: { id } })));
    assert.ok(rs.every((r) => r.status === "fulfilled"));
    assert.equal(rs.filter((r) => r.status === "fulfilled" && (r.value as any).data.already_processed).length, 5);
    const [x] = await db.query<any>(`SELECT state FROM lumi_experiments WHERE id=$1`, [id]);
    assert.equal(x.state, "LOCKED");
  });
});
