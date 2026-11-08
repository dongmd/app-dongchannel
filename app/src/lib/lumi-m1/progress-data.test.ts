/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/** Tiến trình: the read model over REAL tables (PGlite + real migrations). No model is called. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { createAssistant } from "./assistants";
import { createGoal, createPlan, setPlansEnabled } from "./plans";
import { buildProgress } from "./progress-data";

const OWNER = "web:owner@test";
const T0 = new Date("2026-11-08T08:00:00Z");
let tick = 0; const now = () => new Date(T0.getTime() + 1000 * ++tick);

describe("Tiến trình — dữ liệu thật (lớp A)", () => {
  it("đi qua các giai đoạn: chưa có kế hoạch → chờ lượt/đang chạy → chờ duyệt; lọc theo mục tiêu đang theo đuổi", async () => {
    const { db } = await freshDb();
    await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
    await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,'OWNER')`, [OWNER]);
    const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án 1','AFFILIATE') RETURNING id`);
    const a = (await createAssistant(db, { actorRef: OWNER, key: "mk-prog-000001", input: { slug: "aff", name: "AFF", roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit", "plan.submit.version"], hermesProfile: "aff", limits: { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 50 } }, now: now() })).assistant;
    await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true WHERE id=$1`, [a.id]);
    await setPlansEnabled(db, OWNER, true, now(), { maxTasks: 5, versionTtlHours: null });
    const g = (await createGoal(db, { actorRef: OWNER, key: "goal-prog-00001", title: "Mục tiêu thử", outcome: "Kết quả thử", projectId: proj.id, now: now() })).goal;
    let r = await buildProgress(db, now());
    assert.deepEqual(r.items.map((x) => [x.goal_code, x.stage, x.who]), [[g.code, "NO_PLAN", "OWNER"]]);
    await createPlan(db, { actorRef: OWNER, key: "plan-prog-00001", goalId: g.id, leadAssistantId: a.id, now: now() });
    r = await buildProgress(db, now());
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.stage, "RUN_QUEUED"); assert.equal(r.items[0]!.who, "BOT"); assert.equal(r.items[0]!.runs?.used, 1);
    await db.query(`UPDATE lumi_task_runs SET state='RUNNING',started_at=$1,acked_at=$1,deadline_at=$1::timestamptz + interval '600 seconds' WHERE state='PENDING'`, [now().toISOString()]);
    r = await buildProgress(db, new Date(now().getTime()));
    assert.equal(r.items[0]!.stage, "RUN_ACTIVE"); assert.equal(r.items[0]!.run?.limit_seconds, 600);
    assert.equal((await buildProgress(db, now(), { planId: "00000000-0000-0000-0000-000000000000" })).items.length, 0);
  });
});
