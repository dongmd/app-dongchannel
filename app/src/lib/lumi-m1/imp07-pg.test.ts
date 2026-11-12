/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 7 — evidence class B: a REAL PostgreSQL server, real migrations 0000..0051.
 * HTTP contract by role (autonomy matrix, integrations, economy report, opportunities) and concurrency: the same signal submitted by many connections, the same route decided many times.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { type Db } from "./core";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";

let srv: PgServer; let db: Db;
let tick = 0;
const T0 = new Date();
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const BOT: Principal = { kind: "bot", slug: "x", actorRef: "bot:x" };
const hdr = () => ({ get: () => null });
const ctx = (): ApiCtx => ({ db, hermes: new SimulatedHermes(), now });
const call = (name: string, p: Principal | null, o: { params?: Record<string, string>; body?: any } = {}) => handle(name, ctx(), { principal: p, params: o.params ?? {}, body: o.body ?? {}, headers: hdr() });
const st = async (p: Promise<any>) => (await p).status as number;
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

before(async () => {
  srv = await startPgServer(); db = postgresDb(srv.sql);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ref, role]);
});
after(async () => { await srv?.stop(); });

describe("Đợt 7 — hợp đồng HTTP theo vai trò (PostgreSQL thật)", () => {
  it("1. đọc: bot 403, chưa đăng nhập 401, mọi vai trò đăng nhập 200; ghi: chỉ vai trò đúng", async () => {
    for (const n of ["listAutonomyMatrix", "integrationsStatus", "listSignals"]) {
      assert.equal(await st(call(n, BOT)), 403, `bot ${n}`); assert.equal(await st(call(n, null)), 401, `anon ${n}`);
      for (let i = 0; i < 3; i++) { const who: Principal = [OWNER, ADMIN, VIEWER][i]!; assert.equal(await st(call(n, who)), 200, `${n}`); }
    }
    assert.equal(await st(call("economyReport", VIEWER, { body: {} })), 200);
    assert.equal(await st(call("economyReport", BOT, { body: {} })), 403);
    for (const who of [ADMIN, VIEWER, BOT]) assert.equal(await st(call("setAutonomyRule", who, { body: { action_type: "research", mode: "OFF" } })), 403);
    assert.equal(await st(call("setAutonomyRule", OWNER, { body: { action_type: "publish_wordpress", mode: "AUTO" } })), 400, "loại xuất bản không thể là tự động");
    assert.equal(await st(call("setAutonomyRule", OWNER, { body: { action_type: "research", mode: "GRANT" } })), 200);
    assert.equal(await st(call("setAutonomyRule", OWNER, { body: {} })), 400);
    for (const who of [VIEWER, BOT]) assert.equal(await st(call("submitSignal", who, { body: { kind: "KEYWORD", title: "đồng hồ" } })), 403);
    assert.equal(await st(call("submitSignal", ADMIN, { body: { kind: "KEYWORD", title: "đồng hồ cơ " + uniq() } })), 201);
    assert.equal(await st(call("submitSignal", OWNER, { body: { kind: "KEYWORD" } })), 400);
    const r = await call("integrationsStatus", OWNER);
    assert.ok(!JSON.stringify(r.data).includes(process.env.DATABASE_URL ?? "__none__"), "không lộ biến môi trường");
  });

  it("2. tín hiệu → chấm → tuyến: chỉ OWNER quyết tuyến; tuyến chấp nhận không tạo khoản chi", async () => {
    const t = `Từ khóa ${uniq()}`;
    const s = (await call("submitSignal", OWNER, { body: { kind: "TREND", title: t } })).data.signal;
    const sc = await call("scoreSignal", ADMIN, { params: { id: s.id }, body: { values: { audience_usefulness: 0.8, search_opportunity: 0.4 } } });
    assert.equal(sc.status, 200); assert.equal(sc.data.breakdown.reconciles, true);
    assert.equal(await st(call("scoreSignal", VIEWER, { params: { id: s.id }, body: { values: {} } })), 403);
    assert.equal(await st(call("scoreSignal", OWNER, { params: { id: s.id }, body: { values: { audience_usefulness: 2 } } })), 400);
    const r = (await call("proposeRoute", ADMIN, { params: { id: s.id }, body: { route_type: "WATCHLIST", reason: "Theo dõi thêm" } })).data.route;
    assert.equal(await st(call("decideRoute", ADMIN, { params: { id: r.id }, body: { decision: "ACCEPT" } })), 403);
    assert.equal(await st(call("decideRoute", OWNER, { params: { id: r.id }, body: { decision: "ACCEPT" } })), 200);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_money_entries`))[0].n, 0);
    const list = await call("listSignals", VIEWER);
    const row = (list.data.signals as any[]).find((x) => x.title === t);
    assert.equal(row.status, "ROUTED"); assert.ok(row.overall_score > 0); assert.equal(row.routes.length, 1);
  });
});

describe("Đợt 7 — đồng thời (nhiều kết nối thật)", () => {
  it("3. 8 kết nối cùng ghi một tín hiệu ⇒ đúng MỘT dòng, 7 lần báo trùng", async () => {
    const title = `Tín hiệu song song ${uniq()}`;
    const rs = await Promise.all(Array.from({ length: 8 }, () => call("submitSignal", OWNER, { body: { kind: "KEYWORD", title } })));
    assert.ok(rs.every((x) => x.status === 201), JSON.stringify(rs.map((x) => x.status)));
    assert.equal(rs.filter((x) => x.data.duplicate).length, 7);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM opportunity_signals WHERE title=$1`, [title]))[0].n, 1);
  });

  it("4. 6 lần quyết cùng một tuyến song song ⇒ đúng một lần thành công; 6 lần đổi quy tắc tự chủ song song ⇒ lịch sử đủ 6 dòng, hiện hành hợp lệ", async () => {
    const s = (await call("submitSignal", OWNER, { body: { kind: "OWNER_IDEA", title: `Ý tưởng ${uniq()}` } })).data.signal;
    const r = (await call("proposeRoute", OWNER, { params: { id: s.id }, body: { route_type: "CONTENT_OPPORTUNITY", reason: "Bài tổng hợp" } })).data.route;
    const ds = await Promise.all(Array.from({ length: 6 }, () => call("decideRoute", OWNER, { params: { id: r.id }, body: { decision: "ACCEPT" } })));
    assert.equal(ds.filter((x) => x.status === 200).length, 1, JSON.stringify(ds.map((x) => x.status)));
    const modes = ["GRANT", "OFF", "GRANT", "OFF", "GRANT", "OFF"];
    const ms = await Promise.all(modes.map((mode) => call("setAutonomyRule", OWNER, { body: { action_type: "draft_ads", mode } })));
    assert.ok(ms.every((x) => x.status === 200));
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_autonomy_rules WHERE action_type='draft_ads'`))[0].n, 6);
    const cur = (await call("listAutonomyMatrix", OWNER)).data.matrix.find((m: any) => m.action_type === "draft_ads");
    assert.ok(["GRANT", "OFF"].includes(cur.mode));
  });
});
