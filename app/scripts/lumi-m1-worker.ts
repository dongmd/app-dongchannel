/**
 * M1 worker process (dev/test). Usage:
 *   DATABASE_URL=postgres://… pnpm tsx scripts/lumi-m1-worker.ts [--simulate] [--once]
 *
 * --simulate  uses SimulatedHermes and a fake assistant that acks and submits "[MÔ PHỎNG]" output after a short delay.
 *             This is a FAKE at the integration boundary; it proves app/worker/UI wiring, NOT Hermes/Telegram integration.
 * Without --simulate the process refuses to start: no real Hermes adapter exists until the integration spike (TDD 16 U1–U4, U16).
 * Telegram notifications are only logged (NotifyPort is a stub): there is no real Telegram send in this build.
 */
import { ackRun, submitOutput, type HermesPort, type NotifyPort } from "../src/lib/lumi-m1/core";
import { connectLumi, postgresDb } from "../src/lib/lumi-m1/pg-adapter";
import { SimulatedHermes } from "../src/lib/lumi-m1/hermes-port";
import { workerCycle } from "../src/lib/lumi-m1/worker";
import { planLimits, submitPlanVersion } from "../src/lib/lumi-m1/plans";
import { SshHermes } from "../src/lib/lumi-m1/ssh-hermes";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const simulate = process.argv.includes("--simulate");
const once = process.argv.includes("--once");
const real = process.argv.includes("--hermes-ssh");
if (!simulate && !real) { console.error("Choose --simulate (fake boundary) or --hermes-ssh (REAL Hermes test profile over SSH; needs LUMI_HERMES_SSH_HOST) — see TDD 14.9."); process.exit(2); }

// Safety: a simulated worker must never fabricate results for a REAL assistant. Against any non-local database it refuses to start unless
// LUMI_SIM_SLUGS lists the (clearly labelled) simulated assistants it may serve; it then rejects every other assistant's runs.
const simSlugs = new Set((process.env.LUMI_SIM_SLUGS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
if (simulate && simSlugs.size === 0 && !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) { console.error("Refusing --simulate on a non-local database without LUMI_SIM_SLUGS (the simulated assistants this worker may serve)."); process.exit(2); }

// Real mode serves ONLY the assistants listed in LUMI_REAL_SLUGS (claim-time filter: the other lane's runs are never claimed, failed or resent).
const realSlugs = (process.env.LUMI_REAL_SLUGS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
if (real && realSlugs.length === 0) { console.error("Refusing --hermes-ssh without LUMI_REAL_SLUGS (the assistants this REAL worker may serve)."); process.exit(2); }
const laneSlugs = real ? realSlugs : [...simSlugs];
const hermesMode = real ? "ssh (Hermes thật qua SSH)" : "simulated (ADAPTER GIẢ)";

const sql = connectLumi(url, { max: 3 });
const db = postgresDb(sql);
const workerId = `worker:${process.pid}`;

class SimWithAssistant extends SimulatedHermes {
  override async dispatch(run: Parameters<HermesPort["dispatch"]>[0]) {
    if (simSlugs.size) {
      const [who] = await db.query<{ slug: string }>(`SELECT a.slug FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE r.id=$1`, [run.runId]);
      if (!who || !simSlugs.has(who.slug)) return { kind: "rejected" as const, transient: true, message: "Worker giả không xử lý trợ lý này (chỉ LUMI_SIM_SLUGS)" };
    }
    const res = await super.dispatch(run);
    if (res.kind === "accepted") {
      setTimeout(async () => {
        try {
          const [r] = await db.query<{ slug: string; task_id: string; run_kind: string; revision_round: number; title: string; plan_id: string | null; plan_task_key: string | null }>(
            `SELECT a.slug,r.task_id,r.run_kind,t.revision_round,t.title,t.plan_id,t.plan_task_key FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id JOIN tasks t ON t.id=r.task_id WHERE r.id=$1`, [run.runId]);
          if (!r) return;
          await ackRun(db, r.slug, run.runId, new Date(), `sim-${run.runId.slice(0, 8)}`);
          if (r.plan_id && !r.plan_task_key) {
            // PLANNING run: the fake assistant authors a canned, clearly labelled Plan & Cost (IMP-01). It proves wiring only.
            setTimeout(async () => {
              try {
                const slug = r.slug;
                const body = {
                  schema: 1, summary: `[MÔ PHỎNG] Kế hoạch mẫu do adapter giả tạo cho «${r.title}». Nội dung không có giá trị kinh doanh.`,
                  opportunity: { evidence: [{ claim: "[MÔ PHỎNG] bằng chứng giả", ref: "mô phỏng", as_of: new Date().toISOString().slice(0, 10) }], confidence: "LOW" },
                  scope: { in: ["[MÔ PHỎNG] nghiên cứu"], out: ["chạy quảng cáo"] },
                  deliverables: [{ key: "dossier", title: "Hồ sơ mô phỏng", acceptance: "Có đầu ra mô phỏng" }],
                  tasks: [
                    { key: "t1", title: "[MÔ PHỎNG] Việc 1", description: "Việc giả", deliverable_key: "dossier", assignee_slug: slug, expected_output: "Đầu ra giả", acceptance: "Có đầu ra", due_in_days: 3, budget_alloc: { amount: 30, currency: "USD" }, depends_on: [] },
                    { key: "t2", title: "[MÔ PHỎNG] Việc 2", description: "Việc giả", deliverable_key: "dossier", assignee_slug: slug, expected_output: "Đầu ra giả", acceptance: "Có đầu ra", due_in_days: 5, budget_alloc: { amount: 20, currency: "USD" }, depends_on: [] },
                  ],
                  milestones: [{ key: "m1", after_task_key: "t1", label: "Xong việc 1" }],
                  cost: { currency: "USD", ceiling_requested: 100, lines: [{ category: "TOOL", low: 5, base: 10, high: 20, source: "ESTIMATED", as_of: new Date().toISOString().slice(0, 10), confidence: "LOW" }], unknown_note: "Chi phí AI chưa đo" },
                  prepare_spent: { amount: null, note: "chưa đo" }, grants_requested: [], stop_conditions: ["Dừng nếu không có đầu ra"], risks: ["Dữ liệu giả"], alternatives: ["Không làm"],
                };
                await submitPlanVersion(db, { runId: run.runId, botSlug: slug, body, now: new Date(), limits: planLimits() });
              } catch (e) { console.error("[sim-assistant] plan", String(e)); }
            }, 2000);
            return;
          }
          setTimeout(async () => {
            await submitOutput(db, { taskId: r.task_id, runId: run.runId, actorRef: `bot:${r.slug}`, content: `[MÔ PHỎNG] Bản trả lời cho «${r.title}» (lần chạy ${r.run_kind}, vòng sửa ${r.revision_round}). Nội dung giả do adapter mô phỏng tạo ra.`, idempotencyKey: `sim:${run.runId}`, now: new Date() });
          }, 3000);
        } catch (e) { console.error("[sim-assistant]", String(e)); }
      }, 1500);
    }
    return res;
  }
}
const hermes = real
  ? new SshHermes({ host: process.env.LUMI_HERMES_SSH_HOST ?? "dlnew", profile: process.env.LUMI_HERMES_PROFILE ?? "lumitest", maxTurns: Number(process.env.LUMI_HERMES_MAX_TURNS ?? 8), runDeadlineSeconds: Number(process.env.LUMI_RUN_DEADLINE_SECONDS ?? 600) })
  : new SimWithAssistant();
const notify: NotifyPort = { async send(payload) { console.log("[notify-stub] NOT sent (Telegram chưa nối):", JSON.stringify(payload)); return { delivered: false, reason: "stub: Telegram chưa nối, không gửi gì" }; } };

let lastBeat = 0; let lastSnap = 0; let lastError: string | null = null;
const lane = real ? "real" : "sim";
const putFlag = (key: string, value: unknown) =>
  db.query(`INSERT INTO lumi_system_flags(key,value,set_by,set_at) VALUES ($1,$2::jsonb,$3,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,set_by=EXCLUDED.set_by,set_at=EXCLUDED.set_at`, [key, JSON.stringify(value), `worker:${lane}`]);
/** ADM-07: a heartbeat (every ~30 s) and, for the real lane, a read-only snapshot of every Hermes profile (every ~60 s). The Admin screen shows "mất tín hiệu" when they stop. */
async function beat() {
  const now = Date.now();
  if (now - lastBeat >= 30_000) { lastBeat = now; await putFlag(`worker_status:${lane}`, { at: new Date().toISOString(), mode: hermesMode, serves: laneSlugs, pid: process.pid, lastError }); }
  if (hermes instanceof SshHermes && now - lastSnap >= 60_000) {
    lastSnap = now;
    const profiles = await (hermes as SshHermes).readProfileStatus();
    if (profiles) await putFlag("hermes_status", { at: new Date().toISOString(), profiles });
  }
}

async function tick() {
  const r = await workerCycle(db, { hermes, notify, heartbeatMs: 10_000, hermesMode, slugs: laneSlugs.length ? laneSlugs : undefined }, workerId);
  lastError = null;
  if (r.results.length || r.reaped.uncertain || r.reaped.timedOut) console.log(new Date().toISOString(), JSON.stringify(r));
}
(async () => {
  console.log(`[worker ${workerId}] mode=${real ? "REAL Hermes (test profile only)" : "SIMULATED (fake Hermes boundary)"} serves=${laneSlugs.length ? laneSlugs.join(",") : "(all, local db)"}`);
  if (once) { await tick(); await sql.end(); return; }
  for (;;) { await tick().catch((e) => { lastError = String(e).slice(0, 200); console.error("[worker]", String(e)); }); await beat().catch((e) => console.error("[worker] heartbeat", String(e))); await new Promise((r) => setTimeout(r, 2000)); }
})();
