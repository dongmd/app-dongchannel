/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 8 (nhóm 1–3) — evidence class B: a REAL PostgreSQL server, real migrations 0000..0055.
 * HTTP contract by role (capacity, funds, plan lead, campaigns, videos, strategy, turn meetings, articles, knowledge graph) and concurrency:
 * capacity never exceeded under parallel creation, one campaign start, one article approval/publication, parallel metric replays.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { type Db } from "./core";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { createAssistant } from "./assistants";
import { createTask } from "./core-web";

let srv: PgServer; let db: Db;
let tick = 0;
const T0 = new Date();
const now = () => new Date(T0.getTime() + 1000 * ++tick);
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const ADMIN2: Principal = { kind: "user", actorRef: "web:admin2@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const BOT: Principal = { kind: "bot", slug: "x", actorRef: "bot:x" };
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });
const ctx = (): ApiCtx => ({ db, hermes: new SimulatedHermes(), now });
const call = (name: string, p: Principal | null, o: { params?: Record<string, string>; body?: any; key?: string } = {}) => handle(name, ctx(), { principal: p, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });
const st = async (p: Promise<any>) => (await p).status as number;
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };
const BODY = "Đồng hồ cơ tự động dùng bộ máy lên dây bằng chuyển động cổ tay. ".repeat(6);

async function world() {
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${uniq()}`, `Dự án ${uniq()}`]);
  const mk = async (tag: string) => {
    const slug = `${tag}-${uniq()}`.slice(0, 20);
    const a = (await createAssistant(db, { actorRef: OWNER.actorRef, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=2 WHERE id=$1`, [a.id]);
    await db.query(`INSERT INTO lumi_project_members(project_id,assistant_id) VALUES ($1,$2)`, [proj.id, a.id]);
    return a;
  };
  return { proj: proj.id as string, a: await mk("a"), b: await mk("b") };
}

before(async () => {
  srv = await startPgServer(); db = postgresDb(srv.sql);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:admin2@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ref, role]);
});
after(async () => { await srv?.stop(); });

describe("Đợt 8 — hợp đồng HTTP theo vai trò (PostgreSQL thật)", () => {
  it("1. đọc: bot 403, chưa đăng nhập 401, mọi vai trò đăng nhập 200", async () => {
    for (const n of ["listCapacity", "listFunds", "knowledgeGraph", "knowledgeConflicts", "lastLinkChecks", "listCampaigns", "listVideos", "listYtStrategy", "listOffers", "listTurnMeetings", "listArticles"]) {
      assert.equal(await st(call(n, BOT)), 403, `bot ${n}`); assert.equal(await st(call(n, null)), 401, `anon ${n}`);
      for (let i = 0; i < 3; i++) { const who: Principal = [OWNER, ADMIN, VIEWER][i]!; assert.equal(await st(call(n, who)), 200, `${n}`); }
    }
  });

  it("2. ghi: chỉ vai trò đúng (công suất/tạm dừng/chuyển giao/quỹ/trưởng KH/chiến lược/họp lượt = OWNER; chiến dịch/số liệu/bài = OWNER+ADMIN; VIEWER và bot 403)", async () => {
    const w = await world();
    const task = (await createTask(db, { actorRef: OWNER.actorRef, clientRequestId: `h-${uniq()}-key-0001`, projectId: w.proj, assigneeId: w.a.id, title: "Việc chuyển giao", now: now() })).task;
    const owner: [string, any, Record<string, string>?][] = [
      ["setCapacity", { capacity: 3 }, { id: w.a.id }], ["setAssistantPaused", { paused: false }, { id: w.a.id }],
      ["transferWork", { from_id: w.a.id, to_id: w.b.id, task_ids: [task.id], reason: "Cân tải" }], ["setPrepFund", { scope: "COMPANY", amount: 5, period_start: "2026-11-01", period_end: "2026-11-30" }],
      ["setYtStrategy", { project_id: w.proj, channel_goal: "Review trung thực", uniqueness_rules: "Đo thực tế", pattern_breaks: "Không top 10" }],
    ];
    for (const [n, body, params] of owner) {
      for (let i = 0; i < 3; i++) { const who: Principal = [ADMIN, VIEWER, BOT][i]!; assert.equal(await st(call(n, who, { body, params })), 403, `${i} ${n}`); }
      assert.ok([200, 201].includes(await st(call(n, OWNER, { body, params }))), `owner ${n}`);
    }
    const c = (await call("createCampaign", ADMIN, { body: { project_id: w.proj, name: "Chiến dịch HTTP", cap_amount: 100 } }));
    assert.equal(c.status, 201); const cid = c.data.campaign.id;
    for (const who of [VIEWER, BOT]) assert.equal(await st(call("createCampaign", who, { body: { project_id: w.proj, name: "Chiến dịch HTTP 2" } })), 403);
    assert.equal(await st(call("transitionCampaign", ADMIN, { params: { id: cid }, body: { to: "ACTIVE" } })), 403, "chạy chiến dịch chỉ Chủ");
    assert.equal(await st(call("transitionCampaign", OWNER, { params: { id: cid }, body: { to: "ACTIVE" } })), 200);
    const body = { period_start: "2026-11-01", period_end: "2026-11-07", spend: 10, clicks: 100, source: "Bảng Ads (thử)" };
    assert.equal(await st(call("recordCampaignMetric", ADMIN, { params: { id: cid }, body })), 400, "thiếu khóa lặp");
    assert.equal(await st(call("recordCampaignMetric", VIEWER, { params: { id: cid }, body, key: "http-metric-0001" })), 403);
    const m1 = await call("recordCampaignMetric", ADMIN, { params: { id: cid }, body, key: "http-metric-0002" }); const m2 = await call("recordCampaignMetric", ADMIN, { params: { id: cid }, body, key: "http-metric-0002" });
    assert.deepEqual([m1.status, m2.status, m2.data.already_processed], [201, 200, true]);
    assert.equal(await st(call("checkKnowledgeLinks", VIEWER, { body: {} })), 403);
    assert.equal(await st(call("openTurnMeeting", ADMIN, { body: { project_id: w.proj, title: "Họp thử", question: "Câu hỏi?", speaker_ids: [w.a.id, w.b.id], max_turns: 4, max_cost: 1, closes_at: new Date(Date.now() + 3600_000).toISOString() } })), 403);
    assert.equal(await st(call("openTurnMeeting", OWNER, { body: { project_id: w.proj, title: "x" } })), 400);
  });

  it("3. bài viết ba cổng qua HTTP: tác giả không tự QA; chỉ OWNER duyệt/đăng; đích thật bị từ chối; đăng lại không đổi; lỗi danh sách kiểm nêu chi tiết", async () => {
    const w = await world();
    const a = (await call("createArticle", ADMIN, { body: { project_id: w.proj, title: "Review đồng hồ cơ", body: BODY, ai_disclosure: "Bài có sự hỗ trợ của AI và đã được người kiểm tra." } }));
    assert.equal(a.status, 201); const id = a.data.article.id;
    assert.equal(await st(call("createArticle", VIEWER, { body: { project_id: w.proj, title: "Bài", body: BODY } })), 403);
    assert.equal(await st(call("setArticleClaims", ADMIN, { params: { id }, body: { claims: [{ text: "Bộ máy tự động lên dây", evidence_level: "E3", source_ref: "https://example.com/a" }] } })), 200);
    assert.equal(await st(call("submitArticleForQa", ADMIN, { params: { id } })), 200);
    const self = await call("qaArticle", ADMIN, { params: { id }, body: { decision: "PASS" } });
    assert.deepEqual([self.status, self.error?.code], [403, "SELF_REVIEW"]);
    assert.equal(await st(call("qaArticle", ADMIN2, { params: { id }, body: { decision: "PASS" } })), 200);
    assert.equal(await st(call("approveArticle", ADMIN, { params: { id }, body: { version: 1 } })), 403);
    assert.equal(await st(call("publishArticle", OWNER, { params: { id }, body: {} })), 409, "chưa duyệt");
    assert.equal(await st(call("approveArticle", OWNER, { params: { id }, body: { version: 1 } })), 200);
    const real = await call("publishArticle", OWNER, { params: { id }, body: { target: "WORDPRESS" } });
    assert.deepEqual([real.status, real.error?.code], [422, "NOT_CONFIGURED"]);
    assert.equal(await st(call("publishArticle", OWNER, { params: { id }, body: {} })), 200);
    const again = await call("publishArticle", OWNER, { params: { id }, body: {} });
    assert.deepEqual([again.status, again.data.already_processed], [200, true]);
    const weak = (await call("createArticle", ADMIN, { body: { project_id: w.proj, title: "Bài yếu", body: BODY, has_affiliate_links: true } })).data.article.id;
    await call("setArticleClaims", ADMIN, { params: { id: weak }, body: { claims: [{ text: "Tin đồn không nguồn", evidence_level: "E1" }] } });
    await call("submitArticleForQa", ADMIN, { params: { id: weak } });
    const bad = await call("qaArticle", ADMIN2, { params: { id: weak }, body: { decision: "PASS" } });
    assert.equal(bad.status, 422); assert.ok((bad.error?.details as any).problems.length >= 2);
  });
});

describe("Đợt 8 — đồng thời (nhiều kết nối thật)", () => {
  it("4. công suất 2, 8 việc tạo song song ⇒ đúng 2 việc được tạo, 6 bị CAPACITY_REACHED (không bao giờ vượt)", async () => {
    const w = await world();
    await db.query(`UPDATE lumi_assistants SET capacity=2 WHERE id=$1`, [w.a.id]);
    const rs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createTask(db, { actorRef: OWNER.actorRef, clientRequestId: `cap-${uniq()}-${i}-0001`, projectId: w.proj, assigneeId: w.a.id, title: `Việc song song ${i}`, now: now() })));
    assert.equal(rs.filter((r) => r.status === "fulfilled").length, 2, JSON.stringify(rs.map((r) => r.status === "rejected" ? (r.reason as any).code : "ok")));
    assert.ok(rs.filter((r) => r.status === "rejected").every((r) => (r as any).reason.code === "CAPACITY_REACHED"));
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM tasks WHERE owner_assistant_id=$1`, [w.a.id]))[0].n, 2);
  });

  it("5. 6 lần bật cùng một chiến dịch song song ⇒ một lần chuyển, các lần còn lại báo sai bước; 8 lần ghi cùng khóa số liệu ⇒ một dòng; chạm trần đúng một thông báo", async () => {
    const w = await world();
    const cid = (await call("createCampaign", OWNER, { body: { project_id: w.proj, name: `Đồng thời ${uniq()}`, cap_amount: 15 } })).data.campaign.id;
    const ts = await Promise.all(Array.from({ length: 6 }, () => call("transitionCampaign", OWNER, { params: { id: cid }, body: { to: "ACTIVE" } })));
    assert.equal(ts.filter((x) => x.status === 200).length, 1, JSON.stringify(ts.map((x) => x.status)));
    const body = { period_start: "2026-11-01", period_end: "2026-11-07", spend: 10, source: "Bảng Ads (thử)" };
    const ms = await Promise.all(Array.from({ length: 8 }, () => call("recordCampaignMetric", ADMIN, { params: { id: cid }, body, key: "race-metric-same-key" })));
    assert.ok(ms.every((x) => x.status === 200 || x.status === 201));
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_campaign_metrics WHERE campaign_id=$1`, [cid]))[0].n, 1);
    const more = await Promise.all(Array.from({ length: 4 }, (_, i) => call("recordCampaignMetric", ADMIN, { params: { id: cid }, body: { ...body, spend: 4 }, key: `race-metric-${uniq()}-${i}` })));
    assert.ok(more.every((x) => x.status === 201));
    assert.equal((await db.query<any>(`SELECT state FROM lumi_campaigns WHERE id=$1`, [cid]))[0].state, "PAUSED");
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_outbox WHERE dedupe_key=$1`, [`notify:campaign-cap:${cid}`]))[0].n, 1);
  });

  it("6. 6 lần duyệt và 6 lần đăng cùng một bài song song ⇒ một lần duyệt, một bài đăng giả (không bản trùng)", async () => {
    const w = await world();
    const id = (await call("createArticle", ADMIN, { body: { project_id: w.proj, title: "Bài song song", body: BODY, ai_disclosure: "Bài có sự hỗ trợ của AI và đã được người kiểm tra." } })).data.article.id;
    await call("setArticleClaims", ADMIN, { params: { id }, body: { claims: [{ text: "Bộ máy tự động lên dây", evidence_level: "E3", source_ref: "https://example.com/a" }] } });
    await call("submitArticleForQa", ADMIN, { params: { id } }); await call("qaArticle", ADMIN2, { params: { id }, body: { decision: "PASS" } });
    const ap = await Promise.all(Array.from({ length: 6 }, () => call("approveArticle", OWNER, { params: { id }, body: { version: 1 } })));
    assert.ok(ap.every((x) => x.status === 200));
    assert.equal(ap.filter((x) => x.data.already_processed).length, 5);
    const pb = await Promise.all(Array.from({ length: 6 }, () => call("publishArticle", OWNER, { params: { id }, body: {} })));
    assert.ok(pb.every((x) => x.status === 200), JSON.stringify(pb.map((x) => x.status)));
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_fake_wp WHERE article_id=$1`, [id]))[0].n, 1);
  });
});
