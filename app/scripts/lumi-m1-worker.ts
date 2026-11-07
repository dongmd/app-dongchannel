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
import { SshHermes } from "../src/lib/lumi-m1/ssh-hermes";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const simulate = process.argv.includes("--simulate");
const once = process.argv.includes("--once");
const real = process.argv.includes("--hermes-ssh");
if (!simulate && !real) { console.error("Choose --simulate (fake boundary) or --hermes-ssh (REAL Hermes test profile over SSH; needs LUMI_HERMES_SSH_HOST) — see TDD 14.9."); process.exit(2); }

const sql = connectLumi(url, { max: 3 });
const db = postgresDb(sql);
const workerId = `worker:${process.pid}`;

class SimWithAssistant extends SimulatedHermes {
  override async dispatch(run: Parameters<HermesPort["dispatch"]>[0]) {
    const res = await super.dispatch(run);
    if (res.kind === "accepted") {
      setTimeout(async () => {
        try {
          const [r] = await db.query<{ slug: string; task_id: string; run_kind: string; revision_round: number; title: string }>(
            `SELECT a.slug,r.task_id,r.run_kind,t.revision_round,t.title FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id JOIN tasks t ON t.id=r.task_id WHERE r.id=$1`, [run.runId]);
          if (!r) return;
          await ackRun(db, r.slug, run.runId, new Date(), `sim-${run.runId.slice(0, 8)}`);
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
const notify: NotifyPort = { async send(payload) { console.log("[notify-stub] would send:", JSON.stringify(payload)); } };

async function tick() {
  const r = await workerCycle(db, { hermes, notify, heartbeatMs: 10_000 }, workerId);
  if (r.results.length || r.reaped.uncertain || r.reaped.timedOut) console.log(new Date().toISOString(), JSON.stringify(r));
}
(async () => {
  console.log(`[worker ${workerId}] mode=${real ? "REAL Hermes over SSH (test profile only)" : "SIMULATED (fake Hermes boundary)"}`);
  if (once) { await tick(); await sql.end(); return; }
  for (;;) { await tick().catch((e) => console.error("[worker]", String(e))); await new Promise((r) => setTimeout(r, 2000)); }
})();
