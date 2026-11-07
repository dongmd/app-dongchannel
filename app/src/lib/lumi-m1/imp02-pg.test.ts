/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * IMP-02 — evidence class B (TDD 14.9): a REAL PostgreSQL server process, many real connections, the real migrations 0000..0045.
 * Proves the HTTP contract by role (handle()), concurrent creates/archives/policy writes and lane-scoped claiming across genuinely separate
 * sessions. Hermes is simulated; no model is called.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { claimOutbox, setDispatchEnabled, type Db } from "./core";
import { createTask } from "./core-web";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { createAssistant } from "./assistants";

let srv: PgServer; let db: Db;
const T0 = new Date("2026-11-07T08:00:00Z");
const clock = T0;
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const ADMIN: Principal = { kind: "user", actorRef: "web:admin@test", role: "ADMIN" };
const VIEWER: Principal = { kind: "user", actorRef: "web:viewer@test", role: "VIEWER" };
const BOT: Principal = { kind: "bot", slug: "x", actorRef: "bot:x" };
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });
const ctx = (): ApiCtx => ({ db, hermes: new SimulatedHermes(), now: () => clock });
const call = (name: string, p: Principal | null, o: { params?: Record<string, string>; body?: any; key?: string } = {}) => handle(name, ctx(), { principal: p, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const LIMITS = { run_deadline_seconds: 600, ack_deadline_seconds: 60, max_run_failures: 2, max_transport_attempts: 2, max_revision_rounds: 2, max_runs_per_day: 20 };
const asstBody = (slug: string, over: any = {}) => ({ slug, name: `Trợ lý ${slug}`, role_label: "Nghiên cứu", hermes_profile: slug, tool_allowlist: ["knowledge.context", "outputs.submit"], limits: LIMITS, ...over });

before(async () => {
  srv = await startPgServer(); db = postgresDb(srv.sql);
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  for (const [ref, role] of [["web:owner@test", "OWNER"], ["web:admin@test", "ADMIN"], ["web:viewer@test", "VIEWER"]]) await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2)`, [ref, role]);
});
after(async () => {
  await srv.stop();
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref(); // same convention as the other PG test files
});

describe("IMP-02 trên PostgreSQL server thật", () => {
  it("1. hợp đồng HTTP theo vai trò: bot 403 ở mọi route mới; VIEWER/ADMIN không ghi; chưa đăng nhập 401; đọc được cho người đăng nhập; thiếu Idempotency-Key 400", async () => {
    const a = await call("createAssistant", OWNER, { key: `a-${uniq()}-xxxx`, body: asstBody("hd-" + uniq().slice(0, 6)) });
    assert.equal(a.status, 201, JSON.stringify(a));
    const id = a.data.assistant.id as string;
    const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`p-${uniq()}`, `Dự án ${uniq()}`]);
    const writes: [string, any][] = [
      ["createAssistant", { body: asstBody("zz-" + uniq().slice(0, 5)), key: "k-aaaaaaaa" }],
      ["updateAssistant", { params: { id }, body: { name: "Tên mới hợp lệ" } }],
      ["archiveAssistant", { params: { id }, body: {} }],
      ["verifyAssistant", { params: { id }, body: {} }],
      ["createProject", { body: { name: "Dự án mới ABC", area: "OTHER" }, key: "k-bbbbbbbb" }],
      ["updateProject", { params: { id: proj.id }, body: { goal: "x" } }],
      ["archiveProject", { params: { id: proj.id }, body: {} }],
      ["setPolicy", { body: { key: "currency", value: "USD" } }],
    ];
    for (const [name, o] of writes) {
      assert.equal((await call(name, BOT, o)).status, 403, `bot ${name}`);
      assert.equal((await call(name, VIEWER, o)).status, 403, `viewer ${name}`);
      assert.equal((await call(name, ADMIN, o)).status, 403, `admin ${name}`);
      assert.equal((await call(name, null, o)).status, 401, `anon ${name}`);
    }
    for (const who of [VIEWER, ADMIN, OWNER]) for (const r of ["listAssistants", "listPolicies", "adminStatus"]) assert.equal((await call(r, who)).status, 200, `${who.actorRef} ${r}`);
    assert.equal((await call("listGrants", VIEWER, { params: { id } })).status, 200);
    for (const r of ["listAssistants", "listPolicies", "adminStatus", "notificationsSeen"]) assert.equal((await call(r, BOT)).status, 403, `bot ${r}`);
    assert.equal((await call("createAssistant", OWNER, { body: asstBody("kk-" + uniq().slice(0, 5)) })).status, 400); // no Idempotency-Key
    assert.equal((await call("createProject", OWNER, { body: { name: "Thiếu khóa", area: "OTHER" } })).status, 400);
    const bad = await call("createAssistant", OWNER, { key: `b-${uniq()}-xxxx`, body: asstBody("BAD SLUG", { limits: { ...LIMITS, max_runs_per_day: 0 } }) });
    assert.equal(bad.status, 400); assert.ok(bad.error!.details.errors.some((e: string) => e.startsWith("slug")) && bad.error!.details.errors.some((e: string) => e.startsWith("limits.maxRunsPerDay")));
    // nothing secret in what the screen reads
    const list = await call("listAssistants", OWNER);
    assert.ok(!/token|secret|password|api_key/i.test(Object.keys(list.data.assistants[0]).join(",")));
  });

  it("2. tạo đồng thời: 6 yêu cầu CÙNG khóa ⇒ một trợ lý; 6 yêu cầu khác khóa CÙNG mã ⇒ đúng một thắng, còn lại SLUG_TAKEN", async () => {
    const slugA = "cc-" + uniq().slice(0, 6);
    const key = `same-${uniq()}-key`;
    const same = await Promise.all(Array.from({ length: 6 }, () => call("createAssistant", OWNER, { key, body: asstBody(slugA) })));
    assert.ok(same.every((r) => r.status === 201 || r.status === 200), JSON.stringify(same.map((r) => [r.status, r.error?.code])));
    assert.equal(new Set(same.map((r) => r.data.assistant.id)).size, 1);
    assert.equal((await db.query(`SELECT 1 FROM lumi_assistants WHERE slug=$1`, [slugA])).length, 1);
    const slugB = "dd-" + uniq().slice(0, 6);
    const diff = await Promise.all(Array.from({ length: 6 }, (_, i) => call("createAssistant", OWNER, { key: `diff-${uniq()}-${i}`, body: asstBody(slugB, { name: `Tên ${slugB} ${i}`, hermes_profile: `${slugB}-${i}` }) })));
    const wins = diff.filter((r) => r.status === 201);
    assert.equal(wins.length, 1, JSON.stringify(diff.map((r) => [r.status, r.error?.code])));
    assert.deepEqual([...new Set(diff.filter((r) => r.status !== 201).map((r) => r.error?.code))], ["SLUG_TAKEN"], "kẻ thua phải nhận 409 SLUG_TAKEN, không phải 500");
    assert.ok(diff.filter((r) => r.status !== 201).every((r) => r.status === 409));
    // tên dự án: 6 yêu cầu khác khóa CÙNG tên ⇒ một dự án, còn lại 409 NAME_TAKEN
    const pname = `Dự án đua ${uniq()}`;
    const pr = await Promise.all(Array.from({ length: 6 }, (_, i) => call("createProject", OWNER, { key: `pr-${uniq()}-${i}`, body: { name: pname, area: "OTHER" } })));
    assert.equal(pr.filter((r) => r.status === 201).length, 1, JSON.stringify(pr.map((r) => [r.status, r.error?.code])));
    assert.deepEqual([...new Set(pr.filter((r) => r.status !== 201).map((r) => r.error?.code))], ["NAME_TAKEN"]);
    assert.equal((await db.query(`SELECT 1 FROM lumi_projects WHERE lower(name)=lower($1)`, [pname])).length, 1);
    assert.equal((await db.query(`SELECT 1 FROM lumi_assistants WHERE slug=$1`, [slugB])).length, 1);
  });

  it("3. đặt chính sách đồng thời ×8 giá trị khác nhau ⇒ phiên bản liên tục 1..n, không trùng, không mất; lịch sử bất biến", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call("setPolicy", OWNER, { body: { key: "report_cadence_days", value: i + 1 } })));
    assert.ok(rs.every((r) => r.status === 201 || r.status === 200), JSON.stringify(rs.map((r) => [r.status, r.error?.code])));
    const vs = (await db.query<any>(`SELECT version FROM lumi_policies WHERE key='report_cadence_days' AND scope='COMPANY' ORDER BY version`)).map((r: any) => r.version);
    assert.deepEqual(vs, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(rs.map((r) => r.data.version)).size, 8, "mỗi lần ghi nhận một phiên bản riêng");
    // same value from a concurrent burst makes no new version
    const cur = (await db.query<any>(`SELECT value FROM lumi_policies WHERE key='report_cadence_days' ORDER BY version DESC LIMIT 1`))[0].value;
    const dup = await Promise.all(Array.from({ length: 5 }, () => call("setPolicy", OWNER, { body: { key: "report_cadence_days", value: cur } })));
    assert.ok(dup.every((r) => r.status === 200 && r.data.already_processed));
    assert.equal((await db.query(`SELECT 1 FROM lumi_policies WHERE key='report_cadence_days'`)).length, 8);
    await assert.rejects(() => db.query(`DELETE FROM lumi_policies`), /chỉ-thêm/);
  });

  it("4. lưu trữ đồng thời ×4: việc mở chuyển về Chủ đúng MỘT lần, các lượt còn lại alreadyProcessed; lịch sử giữ nguyên", async () => {
    const slug = "ar-" + uniq().slice(0, 6);
    const a = (await createAssistant(db, { actorRef: OWNER.actorRef, key: `ar-${uniq()}-key`, input: { slug, name: `Lưu trữ ${slug}`, roleLabel: "Thử", toolAllowlist: ["outputs.submit"], hermesProfile: slug, limits: { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 2, maxRunsPerDay: 50 } }, now: clock })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED' WHERE id=$1`, [a.id]);
    await setDispatchEnabled(db, new SimulatedHermes({ tools: ["outputs.submit"] }), OWNER.actorRef, a.id, true, clock);
    const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`pa-${uniq()}`, `Dự án ${uniq()}`]);
    for (let i = 0; i < 3; i++) await createTask(db, { actorRef: OWNER.actorRef, clientRequestId: `ar-task-${uniq()}-${i}`, projectId: proj.id, assigneeId: a.id, title: `Việc ${i}`, now: clock });
    await db.query(`UPDATE lumi_outbox SET state='DONE' WHERE state IN ('PENDING','LEASED')`);
    const rs = await Promise.all(Array.from({ length: 4 }, () => call("archiveAssistant", OWNER, { params: { id: a.id } })));
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => [r.status, r.error?.code])));
    assert.equal(rs.filter((r) => !r.data.already_processed).length, 1, "đúng một lần lưu trữ thực sự");
    assert.equal(rs.find((r) => !r.data.already_processed)!.data.transferred, 3);
    const tasks = await db.query<any>(`SELECT owner_kind,owner_actor_ref FROM tasks WHERE project_id=$1`, [proj.id]);
    assert.ok(tasks.every((t: any) => t.owner_kind === "HUMAN" && t.owner_actor_ref === OWNER.actorRef));
    assert.equal((await db.query(`SELECT 1 FROM task_activities WHERE event_type='task.owner_changed_on_archive'`)).length >= 3, true);
    assert.equal((await db.query(`SELECT 1 FROM audit_events WHERE action='assistant.archived'`)).length >= 1, true);
  });

  it("5. worker theo lane: hai worker thật sự khác nhau nhận hàng đợi đồng thời — mỗi bên chỉ nhận lượt của trợ lý mình; không bên nào nhận lượt của bên kia; không lượt nào bị nhận hai lần", async () => {
    const mk = async (slug: string) => {
      const a = (await createAssistant(db, { actorRef: OWNER.actorRef, key: `ln-${uniq()}-${slug}`, input: { slug, name: `Lane ${slug}`, roleLabel: "Thử", toolAllowlist: ["outputs.submit"], hermesProfile: slug, limits: { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 2, maxRunsPerDay: 50 } }, now: clock })).assistant;
      await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED' WHERE id=$1`, [a.id]);
      await setDispatchEnabled(db, new SimulatedHermes({ tools: ["outputs.submit"] }), OWNER.actorRef, a.id, true, clock);
      return a;
    };
    const s1 = "l1-" + uniq().slice(0, 5); const s2 = "l2-" + uniq().slice(0, 5);
    const a1 = await mk(s1); const a2 = await mk(s2);
    const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ($1,$2,'AFFILIATE') RETURNING id`, [`pl-${uniq()}`, `Dự án ${uniq()}`]);
    await db.query(`UPDATE lumi_outbox SET state='DONE' WHERE state IN ('PENDING','LEASED')`);
    for (let i = 0; i < 6; i++) await createTask(db, { actorRef: OWNER.actorRef, clientRequestId: `ln-t1-${uniq()}-${i}`, projectId: proj.id, assigneeId: a1.id, title: `L1 ${i}`, now: clock });
    for (let i = 0; i < 6; i++) await createTask(db, { actorRef: OWNER.actorRef, clientRequestId: `ln-t2-${uniq()}-${i}`, projectId: proj.id, assigneeId: a2.id, title: `L2 ${i}`, now: clock });
    const grab = async (worker: string, slugs: string[]) => { const got: any[] = []; for (let i = 0; i < 20; i++) { const r = await claimOutbox(db, worker, 60, clock, slugs); if (!r) break; got.push(r); } return got; };
    const [g1, g2] = await Promise.all([grab("w-lane-1", [s1]), grab("w-lane-2", [s2])]);
    const owner = async (rows: any[]) => (await db.query<any>(`SELECT DISTINCT a.slug FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE r.id::text = ANY($1::text[])`, [rows.filter((r) => r.kind === "DISPATCH_RUN").map((r) => r.aggregate_id)])).map((x: any) => x.slug);
    assert.equal(g1.filter((r) => r.kind === "DISPATCH_RUN").length, 6); assert.equal(g2.filter((r) => r.kind === "DISPATCH_RUN").length, 6);
    assert.deepEqual(await owner(g1), [s1]); assert.deepEqual(await owner(g2), [s2]);
    assert.equal(new Set([...g1, ...g2].map((r) => r.id)).size, g1.length + g2.length, "không lượt nào bị nhận hai lần");
  });
});
