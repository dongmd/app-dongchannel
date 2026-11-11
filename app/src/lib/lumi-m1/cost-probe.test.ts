/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL over a minimal Db interface */
/**
 * Đo chi phí AI thật theo lượt (ECO-03) — evidence class A: PGlite + real migrations. The provider is FAKED with a counter; no network and no model.
 * Proves WHEN the app may claim a measured number and that it refuses to in every other case (shared key, overlapping runs, unreadable, decreasing counter).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testdb";
import { createTask } from "./core-web";
import { createAssistant } from "./assistants";
import { captureBeforeUsage, costTick, GIVE_UP_MINUTES, SETTLE_SECONDS, type KeyUsage } from "./cost-probe";
import { SimulatedHermes } from "./hermes-port";

const T0 = new Date("2026-11-08T08:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const OWNER = "web:owner@test";
const LIM = { runDeadlineSeconds: 600, ackDeadlineSeconds: 60, maxRunFailures: 2, maxTransportAttempts: 2, maxRevisionRounds: 3, maxRunsPerDay: 500 };

/** a fake provider: cumulative usage per profile + whether the key is dedicated */
class FakeKeys {
  usage = new Map<string, number>(); dedicated = new Map<string, boolean>(); broken = new Set<string>();
  async readKeyUsage(profile: string): Promise<KeyUsage | null> {
    if (this.broken.has(profile)) return null;
    return { usage: this.usage.get(profile) ?? 0, limit: 2, remaining: 2 - (this.usage.get(profile) ?? 0), dedicated: this.dedicated.get(profile) ?? true };
  }
  async readProfileTools() { return []; }
  async dispatch() { return { kind: "accepted" as const }; }
}

async function world() {
  const { db } = await freshDb();
  await db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ('m1_enabled','true','test',now())`);
  await db.query(`INSERT INTO lumi_actors(actor_ref,role) VALUES ($1,'OWNER')`, [OWNER]);
  const [proj] = await db.query<any>(`INSERT INTO lumi_projects(slug,name,area) VALUES ('p1','Dự án 1','AFFILIATE') RETURNING id`);
  const a = (await createAssistant(db, { actorRef: OWNER, key: "mk-cost-0000001", input: { slug: "aff-trial", name: "AFF thử", roleLabel: "Thử", toolAllowlist: ["knowledge.context", "outputs.submit"], hermesProfile: "aff-trial", limits: LIM }, now: at(0) })).assistant;
  await db.query(`UPDATE lumi_assistants SET connection_state='VERIFIED',dispatch_enabled=true WHERE id=$1`, [a.id]);
  const keys = new FakeKeys();
  let n = 0;
  const run = async () => {
    const t = (await createTask(db, { actorRef: OWNER, clientRequestId: `cost-${++n}-0000001`, projectId: proj.id, assigneeId: a.id, title: `Việc ${n}`, now: at(0) })).task;
    return (await db.query<any>(`SELECT id FROM lumi_task_runs WHERE task_id=$1`, [t.id]))[0].id as string;
  };
  const finish = (id: string, startSec: number, endSec: number, state = "SUCCEEDED") => db.query(`UPDATE lumi_task_runs SET state=$4,started_at=$2::timestamptz,acked_at=$2::timestamptz,finished_at=$3::timestamptz,error_code=CASE WHEN $4 IN ('FAILED','TIMED_OUT') THEN 'X' END WHERE id=$1`, [id, at(startSec).toISOString(), at(endSec).toISOString(), state]);
  const probe = async (id: string) => (await db.query<any>(`SELECT * FROM lumi_run_cost_probes WHERE run_id=$1`, [id]))[0];
  return { db, a, keys, run, finish, probe };
}

describe("đo chi phí AI theo lượt — lớp A", () => {
  it("1. khóa riêng: đọc TRƯỚC khi gửi, đọc SAU khi xong và chờ ổn định; chênh lệch = chi phí lượt; số đo ghi đúng", async () => {
    const w = await world();
    const r = await w.run();
    w.keys.usage.set("aff-trial", 0.1);
    await captureBeforeUsage(w.db, w.keys as any, w.a, r, at(10));
    assert.deepEqual([(await w.probe(r)).state, Number((await w.probe(r)).before_usage)], ["PENDING", 0.1]);
    await w.finish(r, 11, 100);
    w.keys.usage.set("aff-trial", 0.1342);
    assert.deepEqual(await costTick(w.db, w.keys as any, at(100 + SETTLE_SECONDS - 5)), { measured: 0, overlap: 0, unavailable: 0, waiting: 0 }, "chưa đủ thời gian ổn định ⇒ chưa đọc");
    assert.equal((await costTick(w.db, w.keys as any, at(100 + SETTLE_SECONDS + 1))).measured, 1);
    const p = await w.probe(r);
    assert.deepEqual([p.state, (Number(p.after_usage) - Number(p.before_usage)).toFixed(4)], ["MEASURED", "0.0342"]);
    assert.equal((await costTick(w.db, w.keys as any, at(1000))).measured, 0, "đã đo thì không đo lại");
  });

  it("2. không khẳng định số đo khi: khóa dùng chung; không đọc được; adapter giả (không có đầu đọc) — luôn kèm lý do, không bao giờ là 0", async () => {
    const w = await world();
    const shared = await w.run(); w.keys.dedicated.set("aff-trial", false);
    await captureBeforeUsage(w.db, w.keys as any, w.a, shared, at(10));
    assert.deepEqual([(await w.probe(shared)).state, (await w.probe(shared)).reason, (await w.probe(shared)).before_usage], ["UNAVAILABLE", "SHARED_KEY", null]);
    w.keys.dedicated.set("aff-trial", true); w.keys.broken.add("aff-trial");
    const broken = await w.run();
    await captureBeforeUsage(w.db, w.keys as any, w.a, broken, at(20));
    assert.deepEqual([(await w.probe(broken)).state, (await w.probe(broken)).reason], ["UNAVAILABLE", "KEY_UNREADABLE"]);
    const sim = await w.run();
    await captureBeforeUsage(w.db, new SimulatedHermes(), w.a, sim, at(30));
    assert.equal(await w.probe(sim), undefined, "adapter giả không có đầu đọc: không ghi gì, không khẳng định gì");
    // đọc lần trước được nhưng sau khi khóa bị đổi sang khóa chung ⇒ không tin
    w.keys.broken.delete("aff-trial");
    const swapped = await w.run();
    await captureBeforeUsage(w.db, w.keys as any, w.a, swapped, at(40));
    await w.finish(swapped, 41, 100); w.keys.dedicated.set("aff-trial", false);
    await costTick(w.db, w.keys as any, at(200));
    assert.equal((await w.probe(swapped)).reason, "SHARED_KEY");
  });

  it("3. hai lượt chồng nhau trên cùng một khóa ⇒ OVERLAP (không chia đôi theo đoán); bộ đếm giảm bất thường ⇒ không tin; quá thời gian chờ mà không đọc được ⇒ bỏ cuộc có lý do", async () => {
    const w = await world();
    const a = await w.run(), b = await w.run();
    w.keys.usage.set("aff-trial", 1);
    await captureBeforeUsage(w.db, w.keys as any, w.a, a, at(10));
    await captureBeforeUsage(w.db, w.keys as any, w.a, b, at(20));
    await w.finish(a, 11, 100); await w.finish(b, 21, 150);
    w.keys.usage.set("aff-trial", 1.5);
    await costTick(w.db, w.keys as any, at(200));
    assert.deepEqual([(await w.probe(a)).state, (await w.probe(b)).state], ["OVERLAP", "OVERLAP"]);
    assert.equal((await w.probe(a)).reason, "RUNS_OVERLAPPED");
    // bộ đếm giảm
    const c = await w.run(); w.keys.usage.set("aff-trial", 5);
    await captureBeforeUsage(w.db, w.keys as any, w.a, c, at(300)); await w.finish(c, 301, 320);
    w.keys.usage.set("aff-trial", 4);
    await costTick(w.db, w.keys as any, at(400));
    assert.deepEqual([(await w.probe(c)).state, (await w.probe(c)).reason], ["UNAVAILABLE", "USAGE_DECREASED"]);
    // không đọc được lần sau: chờ, rồi bỏ cuộc sau khoảng cho phép
    const d = await w.run(); w.keys.usage.set("aff-trial", 6);
    await captureBeforeUsage(w.db, w.keys as any, w.a, d, at(500)); await w.finish(d, 501, 520, "FAILED");
    w.keys.broken.add("aff-trial");
    assert.equal((await costTick(w.db, w.keys as any, at(700))).waiting, 1);
    assert.equal((await w.probe(d)).state, "PENDING");
    assert.equal((await costTick(w.db, w.keys as any, at(520 + GIVE_UP_MINUTES * 60 + 5))).unavailable, 1);
    assert.equal((await w.probe(d)).reason, "AFTER_MISSED");
  });

  it("4. lượt LỖI vẫn có số đo (chi phí thật của lượt hỏng); lượt xếp hàng chưa chạy không làm lượt đang chạy bị coi là chồng", async () => {
    const w = await world();
    const failed = await w.run(); const queued = await w.run(); // `queued` vẫn PENDING, chưa bắt đầu
    w.keys.usage.set("aff-trial", 2);
    await captureBeforeUsage(w.db, w.keys as any, w.a, failed, at(10)); await w.finish(failed, 11, 80, "TIMED_OUT");
    w.keys.usage.set("aff-trial", 2.25);
    await costTick(w.db, w.keys as any, at(200));
    const p = await w.probe(failed);
    assert.deepEqual([p.state, (Number(p.after_usage) - Number(p.before_usage)).toFixed(2)], ["MEASURED", "0.25"]);
    assert.equal(await w.probe(queued), undefined);
  });
});
