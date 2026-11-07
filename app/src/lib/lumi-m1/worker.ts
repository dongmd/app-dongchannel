/**
 * Worker cycle (TDD 8.5): drain due outbox rows, then run the reaper (ack timeouts → DISPATCH_UNCERTAIN, run deadlines →
 * TIMED_OUT). Lease/epoch logic lives in core.ts (claimOutbox/finishOutbox/renewOutbox); this file only loops.
 * Recovery after a worker dies needs no special code: its lease expires and another worker claims the row with a higher epoch.
 */
import { processOutbox, reap, type Db, type HermesPort, type NotifyPort } from "./core";

export interface WorkerDeps { hermes: HermesPort; notify: NotifyPort; heartbeatMs?: number; clock?: () => Date }

export async function workerCycle(db: Db, deps: WorkerDeps, workerId: string, opts: { maxRows?: number; leaseSeconds?: number } = {}) {
  const clock = deps.clock ?? (() => new Date());
  const results: { kind: string; outcome: string }[] = [];
  for (let i = 0; i < (opts.maxRows ?? 50); i++) {
    const r = await processOutbox(db, { ...deps, clock }, workerId, clock(), opts.leaseSeconds ?? 60);
    if (!r) break;
    results.push(r);
  }
  const reaped = await reap(db, clock());
  return { results, reaped };
}
