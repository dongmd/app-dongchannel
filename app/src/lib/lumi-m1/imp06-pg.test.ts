/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đợt 6 — evidence class B: a REAL PostgreSQL server, many real connections, real migrations 0000..0049.
 * HTTP contract by role (routines, ideas, templates, settings, search) and concurrency: the same routine slot ticked by many workers, the same idea accepted twice, the same template version approved twice.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { type Db } from "./core";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { createAssistant } from "./assistants";
import { routineTick, runSlot } from "./ops-routines";

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
const st = async (p: Promise<any>) => (await p).status as number;
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

async function world() {
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${uniq()}`, `Dự án ${uniq()}`]);
  const slug = `a-${uniq()}`.slice(0, 20);
  const a = (await createAssistant(db, { actorRef: OWNER.actorRef, key: `mk-${slug}-0001`, input: { slug, name: `Bot ${slug}`, roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: slug, limits: LIM }, now: now() })).assistant;
  await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true,execution_level=2 WHERE id=$1`, [a.id]);
  return { proj: proj.id as string, a };
}
const tplBody = (o: any = {}) => ({ name: `Mẫu ${uniq()}`, description: "Soát nhanh bài đăng", when_to_use: "Khi có bài mới", steps: "1. Đọc 2. Ghi", inputs: "Liên kết", outputs: "Nhận xét", default_title: "Soát bài", ...o });

before(async () => {
  srv = await startPgServer(); db = postgresDb(srv.sql);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ref, role]);
});
after(async () => { await srv?.stop(); });

describe("Đợt 6 — hợp đồng HTTP theo vai trò (PostgreSQL thật)", () => {
  it("1. bot 403 và chưa đăng nhập 401 ở mọi route; VIEWER đọc được, không ghi được", async () => {
    const reads = ["listSettings", "listIdeas", "listTemplates", "listRoutines", "knowledgeReview"];
    for (const n of reads) {
      assert.equal(await st(call(n, BOT)), 403, `bot ${n}`); assert.equal(await st(call(n, null)), 401, `anon ${n}`);
      for (let i = 0; i < 3; i++) { const who: Principal = [OWNER, ADMIN, VIEWER][i]!; assert.equal(await st(call(n, who)), 200, `${n}`); }
    }
    const w = await world();
    const writes: [string, any, Record<string, string>?][] = [
      ["setSetting", { key: "proposal_expiry_days", value: 5 }], ["createIdea", { title: "Ý tưởng", body: "nội dung" }], ["createTemplate", tplBody()],
      ["createRoutine", { name: "Nhắc", kind: "NOTIFY", schedule_kind: "DAILY", time_of_day: "08:00", message: "xin chào", max_runs_per_day: 1 }], ["setRoutinesPaused", { paused: true }],
    ];
    for (const [n, body] of writes) { assert.equal(await st(call(n, VIEWER, { body })), 403, `viewer ${n}`); assert.equal(await st(call(n, BOT, { body })), 403, `bot ${n}`); }
    assert.equal(await st(call("setSetting", ADMIN, { body: { key: "proposal_expiry_days", value: 5 } })), 403, "admin không đổi cài đặt");
    assert.equal(await st(call("setRoutinesPaused", ADMIN, { body: { paused: true } })), 403);
    assert.equal(await st(call("setSetting", OWNER, { body: { key: "proposal_expiry_days", value: 5 } })), 200);
    assert.equal(await st(call("setSetting", OWNER, { body: { key: "proposal_expiry_days", value: 500 } })), 400);
    const c = await call("createRoutine", ADMIN, { body: writes[3]![1] });
    assert.equal(c.status, 201); assert.equal(c.data.routine.enabled, false);
    assert.equal(await st(call("setRoutineEnabled", ADMIN, { params: { id: c.data.routine.id }, body: { enabled: true } })), 403, "chỉ Chủ bật");
    assert.equal(await st(call("setRoutineEnabled", OWNER, { params: { id: c.data.routine.id }, body: { enabled: true } })), 200);
    // thiếu giới hạn ⇒ 400 nêu trường thiếu
    const t = await call("createRoutine", OWNER, { body: { name: "Tạo việc", kind: "CREATE_TASK", schedule_kind: "DAILY", time_of_day: "08:00", title: "Việc", project_id: w.proj, assignee_id: w.a.id } });
    const bad = await call("setRoutineEnabled", OWNER, { params: { id: t.data.routine.id }, body: { enabled: true } });
    assert.equal(bad.status, 400); assert.ok(JSON.stringify(bad.error).includes("max_runs_per_day"));
    // tìm kiếm
    assert.equal(await st(call("globalSearch", BOT, { body: { q: "x" } })), 403);
    assert.equal(await st(call("globalSearch", VIEWER, { body: { q: "Nhắc" } })), 200);
    assert.equal(await st(call("globalSearch", VIEWER, { body: {} })), 400);
  });

  it("2. mẫu → việc: thiếu khóa lặp 400; trùng khóa trả already_processed; chưa duyệt 404; bot ngoài danh sách 403", async () => {
    const w = await world();
    const c = await call("createTemplate", ADMIN, { body: tplBody({ allowed_assistant_ids: [w.a.id] }) });
    const id = c.data.template.id;
    assert.equal(await st(call("createTaskFromTemplate", OWNER, { params: { id }, body: { project_id: w.proj, assignee_id: w.a.id }, key: "tpl-http-key-0001" })), 404, "chưa duyệt");
    assert.equal(await st(call("decideTemplateVersion", ADMIN, { params: { id }, body: { version: 1, decision: "APPROVE" } })), 403);
    assert.equal(await st(call("decideTemplateVersion", OWNER, { params: { id }, body: { version: 1, decision: "APPROVE" } })), 200);
    assert.equal(await st(call("createTaskFromTemplate", OWNER, { params: { id }, body: { project_id: w.proj, assignee_id: w.a.id } })), 400);
    const a = await call("createTaskFromTemplate", OWNER, { params: { id }, body: { project_id: w.proj, assignee_id: w.a.id }, key: "tpl-http-key-0002" });
    const b = await call("createTaskFromTemplate", OWNER, { params: { id }, body: { project_id: w.proj, assignee_id: w.a.id }, key: "tpl-http-key-0002" });
    assert.deepEqual([a.status, b.status, b.data.already_processed], [201, 200, true]);
    const other = (await createAssistant(db, { actorRef: OWNER.actorRef, key: `mk-o-${uniq()}-1`, input: { slug: `o-${uniq()}`.slice(0, 20), name: "Bot khác", roleLabel: "Thử", toolAllowlist: ["outputs.submit"], hermesProfile: "o", limits: LIM }, now: now() })).assistant;
    assert.equal(await st(call("createTaskFromTemplate", OWNER, { params: { id }, body: { project_id: w.proj, assignee_id: other.id }, key: "tpl-http-key-0003" })), 403);
  });
});

describe("Đợt 6 — đồng thời (nhiều kết nối thật)", () => {
  it("3. 6 worker cùng tick một mốc ⇒ đúng MỘT lần chạy và MỘT việc; 6 lần chạy cùng một mốc trực tiếp ⇒ một bản ghi", async () => {
    const w = await world();
    const r = (await call("createRoutine", OWNER, { body: { name: "Đồng thời", kind: "CREATE_TASK", schedule_kind: "DAILY", time_of_day: "07:30", title: "Việc {date}", project_id: w.proj, assignee_id: w.a.id, max_runs_per_day: 5, deadline_minutes: 60 } })).data.routine;
    assert.equal(await st(call("setRoutineEnabled", OWNER, { params: { id: r.id }, body: { enabled: true } })), 200);
    const slot = new Date(Date.now() - 60_000);
    await db.query(`UPDATE lumi_routines SET next_run_at=$2 WHERE id=$1`, [r.id, slot.toISOString()]);
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => routineTick(db, new Date())));
    assert.ok(rs.every((x) => x.status === "fulfilled"), JSON.stringify(rs.filter((x) => x.status === "rejected")));
    const [runs] = await db.query<any>(`SELECT count(*)::int n FROM lumi_routine_runs WHERE routine_id=$1`, [r.id]);
    const [tasks] = await db.query<any>(`SELECT count(*)::int n FROM tasks WHERE source_key LIKE $1`, [`web:rtn-${r.id}-%`]);
    assert.deepEqual([runs.n, tasks.n], [1, 1]);
    const slot2 = new Date(Date.now() - 120_000);
    const outs = await Promise.all(Array.from({ length: 6 }, () => runSlot(db, r.id, slot2, "MANUAL", new Date())));
    assert.equal(outs.filter((o) => !o.duplicate).length, 1, "đúng một lần ghi nhận");
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_routine_runs WHERE routine_id=$1 AND scheduled_for=$2`, [r.id, slot2.toISOString()]))[0].n, 1);
  });

  it("4. nhận cùng một ý tưởng 6 lần song song ⇒ đúng một việc được tạo; duyệt cùng phiên bản mẫu 6 lần ⇒ một lần duyệt", async () => {
    const w = await world();
    const id = (await call("createIdea", OWNER, { body: { title: "Làm video mới", body: "nội dung" } })).data.idea.id;
    assert.equal(await st(call("classifyIdea", OWNER, { params: { id }, body: { class: "TASK", project_id: w.proj, assignee_id: w.a.id } })), 200);
    const rs = await Promise.all(Array.from({ length: 6 }, () => call("acceptIdea", OWNER, { params: { id } })));
    assert.equal(rs.filter((x) => x.status === 200).length, 1, JSON.stringify(rs.map((x) => x.status)));
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM tasks WHERE source_key=$1`, [`web:idea-${id}`]))[0].n, 1);
    const tid = (await call("createTemplate", OWNER, { body: tplBody() })).data.template.id;
    const ds = await Promise.all(Array.from({ length: 6 }, () => call("decideTemplateVersion", OWNER, { params: { id: tid }, body: { version: 1, decision: "APPROVE" } })));
    assert.ok(ds.every((x) => x.status === 200));
    assert.equal(ds.filter((x) => x.data.already_processed).length, 5);
    assert.equal((await db.query<any>(`SELECT count(*)::int n FROM lumi_task_template_versions WHERE template_id=$1 AND state='APPROVED'`, [tid]))[0].n, 1);
  });
});
