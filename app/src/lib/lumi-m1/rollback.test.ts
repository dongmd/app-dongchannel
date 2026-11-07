/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * EVIDENCE CLASS 2 (real PostgreSQL server): TDD 14.7 compatibility gate and drain/rollback rehearsal, on synthetic data.
 *
 *  1. Build a DB at the PREVIOUS release's schema (migrations 0000–0038) with legacy tasks.
 *  2. Run the previous release's OWN code (git worktree of the pre-M1 commit) against it → baseline smoke.
 *  3. Apply the M1 migrations 0039–0041 → run the previous release's smoke again on the migrated DB (gate step 3).
 *  4. Create M1 data incl. the new statuses (WAITING_ASSISTANT, ON_HOLD), then drain (flag off) and run the OLD release again
 *     (rehearsal, gate step 5): it must only meet statuses it knows, and legacy review/retry must not touch M1 tasks.
 * NOT covered (stated in TDD 14.9): a restore of a copy of REAL production data (gate step 1), the old release's HTTP routes
 * behind the old Next server, and a staging deploy. Set LUMI_REHEARSAL_FULL=1 to also run the old release's whole unit suite.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import { encode } from "next-auth/jwt";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replayMigrations, startPgServer, type PgServer } from "./pgserver";
import { postgresDb } from "./pg-adapter";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { drainM1 } from "./drain";
import { processOutbox } from "./core";
import { drainPlans, setPlansEnabled } from "./plans";
import { handleRpc } from "./mcp";

const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
let oldServer: ChildProcess | null = null;
const PREV_COMMIT = "2313f7c"; // last commit before any M1 code (docs only on top of the preview release)
const OLD_STATUSES = ["CAPTURED", "QUEUED", "RUNNING", "WAITING_REVIEW", "APPROVED", "REVISION_REQUESTED", "REJECTED", "COMPLETED", "FAILED", "CANCELLED", "SYNC_DELAYED", "IMPORTED"];
process.env.LUMI_PLAN_MAX_TASKS = "5";
const OWNER: Principal = { kind: "user", actorRef: "web:owner@test", role: "OWNER" };
const hdr = (k?: string) => ({ get: (n: string) => (n.toLowerCase() === "idempotency-key" ? k ?? null : null) });

let srv: PgServer;
let oldDir: string;
const clock = new Date();
const hermes = new SimulatedHermes();
const ctx = (): ApiCtx => ({ db: postgresDb(srv.sql), hermes, now: () => clock });
const call = (name: string, p: Principal | null, o: { params?: any; body?: any; key?: string } = {}) => handle(name, ctx(), { principal: p, params: o.params ?? {}, body: o.body ?? {}, headers: hdr(o.key) });

const SMOKE = `
import { listTasks } from "@/lib/tasks/list";
import { computeDashboardSummary } from "@/lib/dashboard/summary";
import { reviewTask } from "@/lib/tasks/review";
(async () => {
  const l = await listTasks({ profile: "all", limit: 100 });
  const d = await computeDashboardSummary("all");
  const imported = l.items.find((i: any) => i.status === "IMPORTED");
  const rev: any = imported ? await reviewTask({ taskId: imported.id, action: "approve", actorId: "owner@test", requestId: "smoke" }) : null;
  console.log("SMOKE " + JSON.stringify({ count: l.items.length, statuses: l.items.map((i: any) => i.status), kpiOk: !!d, reviewOk: rev ? rev.ok : null, reviewDetail: rev && !rev.ok ? rev : null }));
  process.exit(0);
})().catch((e) => { console.error("SMOKE_FAIL", String(e)); process.exit(1); });
`;

/** The previous release lives in a cached git worktree with its OWN installed dependencies (a junction to the real node_modules breaks Next's resolver). */
function prepareOldRelease(): string {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const dir = path.join(os.tmpdir(), `lumi-prev-release-${PREV_COMMIT}`);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["-C", root, "worktree", "prune"], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync("git", ["-C", root, "worktree", "add", "--detach", dir, PREV_COMMIT], { stdio: "ignore" });
  }
  const web = path.join(dir, "apps", "web");
  if (!fs.existsSync(path.join(web, "node_modules", "next"))) {
    // The old release's own lockfile (no new dependencies). First run downloads ~400 packages (~1 min); later runs reuse it.
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: web, stdio: "ignore", shell: true, timeout: 600_000 });
  }
  fs.writeFileSync(path.join(web, "scripts", "prev-smoke.ts"), SMOKE);
  return dir;
}
function oldSmoke(): { count: number; statuses: string[]; kpiOk: boolean; reviewOk: boolean | null; reviewDetail?: unknown } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "scripts/prev-smoke.ts"], {
    cwd: path.join(oldDir, "apps", "web"), env: { ...process.env, DATABASE_URL: srv.url, NODE_ENV: "test" }, encoding: "utf8", timeout: 120_000,
  });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("SMOKE "));
  assert.ok(line, `old release smoke failed: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(line!.slice(6));
}
const q = async (text: string, p: unknown[] = []) => (await srv.sql.unsafe(text, p as any[])) as any[];

before(async () => {
  oldDir = prepareOldRelease();
  srv = await startPgServer({ migrate: false });
  await replayMigrations(srv.sql, "0038");
  await q(`INSERT INTO profiles(slug,name,type,status) VALUES ('aff','AFF','bot','active') ON CONFLICT DO NOTHING`);
  for (let i = 1; i <= 4; i++) await q(`INSERT INTO tasks(code,profile_slug,title,status,created_at,updated_at) VALUES ($1,'aff',$2,$3::task_status,date_trunc('milliseconds',now()),date_trunc('milliseconds',now()))`, [`AFF-000${i}`, `Việc cũ ${i}`, i === 1 ? "IMPORTED" : i === 2 ? "FAILED" : i === 3 ? "WAITING_REVIEW" : "COMPLETED"]);
});
after(async () => {
  oldServer?.kill();
  await srv.stop();
  // The cached worktree is kept on purpose (dependencies installed once); remove with `git worktree remove --force <tmp>/lumi-prev-release-2313f7c`.
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});

describe("rollback rehearsal (PostgreSQL server, previous release code, synthetic data)", () => {
  it("1. baseline: bản trước M1 chạy được trên schema cũ (0000–0038)", () => {
    const s = oldSmoke();
    assert.equal(s.count, 4);
    assert.equal(s.reviewOk, true, JSON.stringify(s.reviewDetail));
    assert.ok(s.kpiOk);
  });

  it("2. sau khi áp 0039–0044, bản cũ vẫn chạy trên CSDL đã migrate với dữ liệu cũ (cổng bước 3)", async () => {
    await replayMigrations(srv.sql, "0044", "0039"); // all of this release's migrations: the old code must still run on the fully migrated schema
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name IN ('project_id','owner_kind','description')`);
    assert.equal(cols.length, 3);
    const s = oldSmoke();
    assert.equal(s.count, 4);
    assert.ok(s.statuses.every((x) => OLD_STATUSES.includes(x)));
    // the old release's INSERT (legacy columns only) still works against the new schema: new columns are nullable/defaulted
    await q(`INSERT INTO tasks(code,profile_slug,title,status,created_at,updated_at) VALUES ('AFF-0099','aff','ghi bằng mã cũ','IMPORTED'::task_status,date_trunc('milliseconds',now()),date_trunc('milliseconds',now()))`);
    assert.equal(oldSmoke().count, 5);
  });

  it("3. diễn tập: bật cờ → dữ liệu M1 gồm trạng thái mới → tắt cờ + drain → bản cũ chỉ gặp trạng thái nó biết", async () => {
    await q(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now()) ON CONFLICT (key) DO UPDATE SET value='true'`);
    await q(`INSERT INTO profiles(slug,name,type,status) VALUES ('rb1','Rehearsal bot','bot','active') ON CONFLICT DO NOTHING`);
    for (const [ref, role] of [["web:owner@test", "OWNER"]]) await q(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ref, role]);
    const [proj] = await q(`INSERT INTO lumi_projects(slug,name,area) VALUES ('rb','Dự án diễn tập','AFFILIATE') RETURNING id`);
    // Assistant 1: verified but dispatch NOT enabled → tasks wait (WAITING_ASSISTANT)
    const [wait] = await q(`INSERT INTO lumi_assistants(slug,name,hermes_profile,connection_state,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,execution_level) VALUES ('rb1','Bot rb1','rb1','VERIFIED','["outputs.submit"]',600,30,2,3,2,50,0) RETURNING id`);
    const t1 = await call("createTask", OWNER, { key: "rehearsal-wait-0001", body: { project_id: proj.id, assignee_id: wait.id, title: "Việc chờ trợ lý" } });
    assert.equal(t1.data.task.status, "WAITING_ASSISTANT");
    // Assistant 2: enabled → QUEUED/RUNNING/WAITING_REVIEW paths
    await q(`INSERT INTO profiles(slug,name,type,status) VALUES ('rb2','Rehearsal bot 2','bot','active') ON CONFLICT DO NOTHING`);
    const [on] = await q(`INSERT INTO lumi_assistants(slug,name,hermes_profile,connection_state,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,execution_level) VALUES ('rb2','Bot rb2','rb2','VERIFIED','["tasks.intake","outputs.submit","knowledge.context"]',600,30,2,3,2,50,0) RETURNING id`);
    assert.equal((await call("setDispatch", OWNER, { params: { id: on.id }, body: { enabled: true } })).status, 200);
    const t2 = await call("createTask", OWNER, { key: "rehearsal-run-00002", body: { project_id: proj.id, assignee_id: on.id, title: "Việc đang chạy" } });
    const t3 = await call("createTask", OWNER, { key: "rehearsal-rev-00003", body: { project_id: proj.id, assignee_id: on.id, title: "Việc chờ duyệt" } });
    const db = postgresDb(srv.sql);
    while (await processOutbox(db, { hermes, notify: { send: async () => {} } }, "rb-w", clock)) { /* dispatch both */ }
    const bot3: Principal = { kind: "bot", slug: "rb2", actorRef: "bot:rb2" };
    const run3 = (await q(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [t3.data.task.id]))[0];
    await call("ack", bot3, { params: { runId: run3.id } });
    const s3 = await call("submitOutput", bot3, { params: { id: t3.data.task.id }, body: { run_id: run3.id, content: "Bản 1", idempotency_key: "rehearsal-out-1" } });
    assert.equal(s3.status, 201);
    const run2 = (await q(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [t2.data.task.id]))[0];
    await call("ack", bot3, { params: { runId: run2.id } }); // t2 stays RUNNING (in flight)
    // a task ON_HOLD (cost cap path sets this; here set through the same column the app uses)
    const t4 = await call("createTask", OWNER, { key: "rehearsal-hold-0004", body: { project_id: proj.id, assignee_id: on.id, title: "Việc tạm giữ" } });
    await q(`UPDATE lumi_task_runs SET state='STOPPED_CAP',finished_at=now(),error_code='COST_CAP' WHERE task_id=$1`, [t4.data.task.id]);
    await q(`UPDATE tasks SET status='ON_HOLD',hold_reason='COST_CAP' WHERE id=$1`, [t4.data.task.id]);

    const before = await q(`SELECT status,count(*)::int n FROM tasks GROUP BY status ORDER BY status`);
    assert.ok(before.some((r) => r.status === "WAITING_ASSISTANT") && before.some((r) => r.status === "ON_HOLD"));

    // New code must keep legacy review/retry away from M1 tasks (they have their own approval/run model).
    process.env.DATABASE_URL = srv.url;
    const { reviewTask } = await import("@/lib/tasks/review");
    const legacy = await reviewTask({ taskId: t3.data.task.id, action: "approve", actorId: "owner@test", requestId: "x" });
    assert.deepEqual([legacy.ok, (legacy as any).code], [false, "INVALID_TRANSITION"]);
    assert.equal((await q(`SELECT status FROM tasks WHERE id=$1`, [t3.data.task.id]))[0].status, "WAITING_REVIEW");

    // L0 + drain
    const rep = await drainM1(db, "web:owner@test", clock);
    assert.deepEqual(rep.rewritten, { onHold: 1, waitingAssistant: 1 });
    assert.ok(rep.inFlightRuns >= 1, "chạy dở được BÁO CÁO, không bị đụng");
    const after = await q(`SELECT DISTINCT status::text AS status FROM tasks`);
    assert.ok(after.every((r) => OLD_STATUSES.includes(r.status)), JSON.stringify(after));
    // flag off: no new work, and the worker will not dispatch
    assert.equal((await call("createTask", OWNER, { key: "rehearsal-off-00005", body: { project_id: proj.id, assignee_id: on.id, title: "Không được tạo" } })).error?.code, "M1_DISABLED");
    assert.equal((await call("intake", { kind: "bot", slug: "rb2", actorRef: "bot:rb2" }, { body: { source_key: "x", actor_ref: "x", text: "Giao việc: a" } })).error?.code, "M1_DISABLED");

    // The previous release now runs on the drained DB (rehearsal step 5, data side)
    const s = oldSmoke();
    assert.ok(s.statuses.every((x) => OLD_STATUSES.includes(x)));
    assert.ok(s.kpiOk);
    // drain is idempotent
    const again = await drainM1(db, "web:owner@test", clock);
    assert.deepEqual(again.rewritten, { onHold: 0, waitingAssistant: 0 });
  });

  it("3b. IMP-01: tạo mục tiêu→kế hoạch→duyệt→việc→sổ, drain kế hoạch+M1 ⇒ không xóa dữ liệu, bản cũ vẫn chạy, drain lặp được", async () => {
    const db = postgresDb(srv.sql);
    const before0 = (await q(`SELECT count(*)::int n FROM tasks`))[0].n;
    await q(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now()) ON CONFLICT (key) DO UPDATE SET value='true'`);
    await setPlansEnabled(db, "web:owner@test", true, clock, { maxTasks: 5, versionTtlHours: null });
    await q(`INSERT INTO profiles(slug,name,type,status) VALUES ('rb3','Rehearsal bot 3','bot','active') ON CONFLICT DO NOTHING`);
    const [a] = await q(`INSERT INTO lumi_assistants(slug,name,hermes_profile,connection_state,tool_allowlist,run_deadline_seconds,ack_deadline_seconds,max_run_failures,max_transport_attempts,max_revision_rounds,max_runs_per_day,execution_level) VALUES ('rb3','Bot rb3','rb3','VERIFIED','["tasks.intake","outputs.submit","knowledge.context"]',600,30,2,3,2,50,0) RETURNING id`);
    assert.equal((await call("setDispatch", OWNER, { params: { id: a.id }, body: { enabled: true } })).status, 200);
    const [proj] = await q(`SELECT id FROM lumi_projects WHERE slug='rb'`);
    const g = await call("createGoal", OWNER, { key: "rb-goal-000000001", body: { title: "Mục tiêu diễn tập", outcome: "Kế hoạch diễn tập", project_id: proj.id } });
    assert.equal(g.status, 201, JSON.stringify(g));
    const p = await call("createPlan", OWNER, { key: "rb-plan-000000001", body: { goal_id: g.data.goal.id, lead_assistant_id: a.id } });
    assert.equal(p.status, 201, JSON.stringify(p));
    const planId = p.data.plan.id as string;
    const [pl] = await q(`SELECT planning_task_id FROM lumi_plans WHERE id=$1`, [planId]);
    const [run] = await q(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$2,acked_at=$2 WHERE task_id=$1 AND state='PENDING' RETURNING id`, [pl.planning_task_id, clock.toISOString()]);
    const body = {
      schema: 1, summary: "[DIỄN TẬP] Kế hoạch tổng hợp cho bài diễn tập rollback, không có giá trị kinh doanh.",
      opportunity: { evidence: [{ claim: "dữ liệu giả", ref: "diễn tập", as_of: "2026-11-01" }], confidence: "LOW" },
      scope: { in: ["a"], out: ["b"] }, deliverables: [{ key: "d", title: "Đầu ra", acceptance: "Có" }],
      tasks: [{ key: "t1", title: "Việc diễn tập", description: "x", deliverable_key: "d", assignee_slug: "rb3", expected_output: "Đầu ra", acceptance: "Có đầu ra", due_in_days: 3, budget_alloc: { amount: 30, currency: "USD" }, depends_on: [] }],
      milestones: [], cost: { currency: "USD", ceiling_requested: 100, lines: [{ category: "TOOL", low: 5, base: 10, high: 20, source: "ESTIMATED", as_of: "2026-11-07", confidence: "LOW" }], unknown_note: "Chi phí AI chưa đo" },
      prepare_spent: { amount: null, note: "chưa đo" }, grants_requested: [], stop_conditions: ["Dừng nếu không có đầu ra"], risks: [], alternatives: [],
    };
    const rpc = await handleRpc(ctx(), { kind: "bot", slug: "rb3", actorRef: "bot:rb3" } as any, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plan_submit_version", arguments: { run_id: run.id, body } } });
    assert.ok(!(rpc as any).result.isError, JSON.stringify(rpc));
    const [v] = await q(`SELECT content_hash FROM lumi_plan_versions WHERE plan_id=$1 AND version=1`, [planId]);
    assert.equal((await call("decidePlan", OWNER, { params: { id: planId }, body: { version: 1, content_hash: v.content_hash, decision: "APPROVE" } })).status, 200);
    assert.equal((await call("recordLedger", OWNER, { params: { id: planId }, key: "rb-ledger-00000001", body: { category: "TOOL", amount: 7, currency: "USD", source: "MANUAL" } })).status, 201);
    const counts = async () => (await q(`SELECT (SELECT count(*)::int FROM lumi_goals) g,(SELECT count(*)::int FROM lumi_plans) p,(SELECT count(*)::int FROM lumi_plan_versions) v,(SELECT count(*)::int FROM lumi_ledger_entries) l,(SELECT count(*)::int FROM lumi_budgets) b`))[0];
    const c0 = await counts();
    const d = await drainPlans(db, "web:owner@test", clock);
    assert.equal(d.plansPaused, 1);
    await drainM1(db, "web:owner@test", clock);
    assert.deepEqual(await counts(), c0, "drain không xóa dữ liệu kế hoạch/sổ");
    assert.equal((await q(`SELECT status FROM lumi_plans WHERE id=$1`, [planId]))[0].status, "PAUSED_ADJUSTMENT");
    assert.ok((await q(`SELECT count(*)::int n FROM tasks`))[0].n > before0, "việc của kế hoạch vẫn còn");
    assert.equal((await call("createGoal", OWNER, { key: "rb-goal-000000002", body: { title: "Không được tạo", outcome: "x", project_id: proj.id } })).status >= 400, true);
    const s = oldSmoke();
    assert.ok(s.statuses.every((x) => OLD_STATUSES.includes(x)), JSON.stringify(s.statuses));
    assert.ok(s.kpiOk);
    const again = await drainPlans(db, "web:owner@test", clock);
    assert.equal(again.plansPaused, 0);
    assert.deepEqual(await counts(), c0);
  });

  it("5. bản cũ khởi động như một máy chủ Next THẬT trên CSDL đã drain và phục vụ qua HTTP (khác với kiểm thử trên bản sao dữ liệu production — chưa làm)", async () => {
    const port: number = await new Promise((res) => { const sv = net.createServer(); sv.listen(0, "127.0.0.1", () => { const x = (sv.address() as net.AddressInfo).port; sv.close(() => res(x)); }); });
    const secret = "rollback-http-test-secret-0123456789abcdef";
    const svc = "rollback-svc-token-test-only";
    const nextBin = path.join(path.dirname(nodeRequire.resolve(path.join(oldDir, "apps", "web", "node_modules", "next", "package.json"))), "dist", "bin", "next");
    oldServer = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
      cwd: path.join(oldDir, "apps", "web"), stdio: "ignore",
      env: { ...process.env, DATABASE_URL: srv.url, NEXTAUTH_URL: `http://localhost:${port}`, NEXTAUTH_SECRET: secret, OPS_HUB_SERVICE_TOKEN: svc, NODE_ENV: "development" },
    });
    const base = `http://localhost:${port}`;
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(`${base}/api/health`)).status < 500) break; } catch { /* starting */ } if (Date.now() - t0 > 150_000) throw new Error("old release did not start"); await new Promise((r) => setTimeout(r, 500)); }
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const jwt = await encode({ secret, token: { email: "owner@dev.local", role: "OWNER", userId: "00000000-0000-4000-8000-000000000001" } });
    const cookie = { cookie: `next-auth.session-token=${jwt}` };
    const anon = await fetch(`${base}/tasks`, { redirect: "manual" });
    assert.ok([302, 307, 308].includes(anon.status), "bản cũ vẫn chặn người chưa đăng nhập");
    for (const route of ["/", "/tasks", "/memory"]) {
      const r = await fetch(`${base}${route}`, { headers: cookie, redirect: "manual" });
      assert.equal(r.status, 200, `${route} -> ${r.status}`);
    }
    const tasksHtml = await (await fetch(`${base}/tasks`, { headers: cookie })).text();
    assert.ok(tasksHtml.includes("Việc cũ 2") || tasksHtml.includes("AFF-0002"), "danh sách việc cũ hiển thị trên CSDL đã drain");
    // M1 tasks belong to profiles outside the old aff/yt filter, so the list need not show them; opening one directly must not crash the old release.
    const m1 = await q(`SELECT id, status::text AS status FROM tasks WHERE project_id IS NOT NULL ORDER BY code`);
    assert.ok(m1.length >= 4);
    for (const row of m1) {
      const r = await fetch(`${base}/tasks/${row.id}`, { headers: cookie, redirect: "manual" });
      assert.ok(r.status < 500, `bản cũ mở việc M1 (${row.status}) -> ${r.status}`);
    }
    const sum = await fetch(`${base}/api/v1/dashboard/summary`, { headers: cookie });
    assert.equal(sum.status, 200);
    const alerts = await fetch(`${base}/api/v1/outbound/alerts?profile=aff`, { headers: { "x-dc-service-token": svc } });
    assert.equal(alerts.status, 200);
    assert.equal((await fetch(`${base}/api/v1/outbound/alerts?profile=aff`, { headers: { "x-dc-service-token": "wrong" } })).status === 200, false);
    oldServer.kill(); oldServer = null;
  });

  it("4. (tuỳ chọn LUMI_REHEARSAL_FULL=1) toàn bộ bộ test đơn vị của bản cũ chạy trên CSDL đã migrate", { skip: process.env.LUMI_REHEARSAL_FULL !== "1" }, () => {
    const r = spawnSync("pnpm", ["test"], { cwd: path.join(oldDir, "apps", "web"), env: { ...process.env, DATABASE_URL: srv.url, NODE_ENV: "test" }, encoding: "utf8", timeout: 600_000, shell: true });
    const tail = (r.stdout ?? "").split("\n").filter((l) => /^# (tests|pass|fail)/.test(l)).join(" | ");
    console.log("OLD_SUITE", tail);
    assert.equal(r.status, 0, tail + (r.stderr ?? "").slice(-500));
  });
});
