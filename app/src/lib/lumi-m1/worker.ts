/**
 * Worker cycle (TDD 8.5): drain due outbox rows, then run the reaper (ack timeouts → DISPATCH_UNCERTAIN, run deadlines →
 * TIMED_OUT). Lease/epoch logic lives in core.ts (claimOutbox/finishOutbox/renewOutbox); this file only loops.
 * Recovery after a worker dies needs no special code: its lease expires and another worker claims the row with a higher epoch.
 */
import { processOutbox, reap, type Db, type HermesPort, type NotifyPort } from "./core";
import { planTick } from "./plans";
import { costTick } from "./cost-probe";
import { costLimitTick } from "./cost-limits";
import { meetingTick } from "./meetings";

export interface WorkerDeps { hermes: HermesPort; notify: NotifyPort; heartbeatMs?: number; clock?: () => Date; hermesMode?: string; slugs?: string[] }

export async function workerCycle(db: Db, deps: WorkerDeps, workerId: string, opts: { maxRows?: number; leaseSeconds?: number } = {}) {
  const clock = deps.clock ?? (() => new Date());
  const results: { kind: string; outcome: string }[] = [];
  for (let i = 0; i < (opts.maxRows ?? 50); i++) {
    const r = await processOutbox(db, { ...deps, clock }, workerId, clock(), opts.leaseSeconds ?? 60);
    if (!r) break;
    results.push(r);
  }
  const reaped = await reap(db, clock());
  // IMP-04/05: take the 'after' key-usage readings (real AI cost per run) and advance meetings (deadlines, limits, synthesis run). Neither can block the loop.
  const costs = await costTick(db, deps.hermes, clock()).catch((e) => ({ error: String(e) }));
  const limits = await costLimitTick(db, clock()).catch((e) => ({ error: String(e) }));
  const meetings = await meetingTick(db, clock()).catch((e) => ({ error: String(e) }));
  // IMP-01: book run costs, release commitments, expire versions, write reports (no-op unless plans_enabled). Never blocks the loop.
  const plans = await planTick(db, clock(), { hermesMode: deps.hermesMode ?? "simulated" }).catch((e) => ({ error: String(e) }));
  return { results, reaped, plans, costs, limits, meetings };
}
