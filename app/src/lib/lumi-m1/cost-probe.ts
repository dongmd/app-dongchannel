/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Real AI cost per run (ECO-03; TDD U22). The provider reports cumulative usage of an API key. If a profile has its OWN key, the usage read BEFORE a run is sent
 * and AFTER it ends differs by exactly what that run cost, provided nothing else used the key in between. The app therefore only claims a measured cost when:
 *   - the key is dedicated (not the key other profiles share),
 *   - no other run of the same assistant overlapped the window,
 *   - both readings succeeded and usage did not go down.
 * In every other case the cost stays UNKNOWN with the reason; it is never filled with 0 and never estimated. The key itself never leaves the Hermes container:
 * only the three numbers (usage, limit, remaining) and a "dedicated" yes/no are read.
 */
import type { Db, HermesPort } from "./core";

const iso = (d: Date) => d.toISOString();
export interface KeyUsage { usage: number; limit: number | null; remaining: number | null; dedicated: boolean }
export const SETTLE_SECONDS = 45;          // the provider's counter lags a little behind the last token
export const GIVE_UP_MINUTES = 30;         // an "after" reading that cannot be taken in this time is recorded as missed
const READER_TIMEOUT_MS = 25_000;

type Reader = (profile: string) => Promise<KeyUsage | null>;
const readerOf = (h: HermesPort): Reader | null => (typeof (h as any).readKeyUsage === "function" ? ((p: string) => (h as any).readKeyUsage(p)) : null);
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

/** Called right before a run is sent. Best-effort: a failure here records "unavailable", never blocks or fails the dispatch. */
export async function captureBeforeUsage(db: Db, hermes: HermesPort, asst: { id: string; hermes_profile: string | null }, runId: string, now: Date): Promise<void> {
  const read = readerOf(hermes);
  if (!read || !asst.hermes_profile) return; // simulated adapter: nothing to measure, and nothing is claimed
  let state = "PENDING"; let reason: string | null = null; let u: KeyUsage | null = null;
  try {
    u = await withTimeout(read(asst.hermes_profile), READER_TIMEOUT_MS);
    if (!u) { state = "UNAVAILABLE"; reason = "KEY_UNREADABLE"; }
    else if (!u.dedicated) { state = "UNAVAILABLE"; reason = "SHARED_KEY"; }
  } catch { state = "UNAVAILABLE"; reason = "PROBE_ERROR"; }
  await db.query(
    `INSERT INTO lumi_run_cost_probes(run_id,assistant_id,state,before_usage,before_at,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$5) ON CONFLICT (run_id) DO NOTHING`,
    [runId, asst.id, state, state === "PENDING" ? u!.usage : null, iso(now), reason]);
}

/** Worker tick: take the "after" reading for runs that ended long enough ago, decide MEASURED / OVERLAP / UNAVAILABLE. */
export async function costTick(db: Db, hermes: HermesPort, now: Date): Promise<{ measured: number; overlap: number; unavailable: number; waiting: number }> {
  const read = readerOf(hermes);
  const out = { measured: 0, overlap: 0, unavailable: 0, waiting: 0 };
  if (!read) return out;
  const due = await db.query<any>(
    `SELECT pr.run_id, pr.assistant_id, pr.before_usage, pr.before_at, r.finished_at, a.hermes_profile
       FROM lumi_run_cost_probes pr JOIN lumi_task_runs r ON r.id=pr.run_id JOIN lumi_assistants a ON a.id=pr.assistant_id
      WHERE pr.state='PENDING' AND r.state IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','ABANDONED','STOPPED_CAP') AND r.finished_at IS NOT NULL
        AND r.finished_at <= $1::timestamptz - make_interval(secs => $2) ORDER BY r.finished_at LIMIT 10`, [iso(now), SETTLE_SECONDS]);
  for (const p of due) {
    const giveUp = now.getTime() - new Date(p.finished_at).getTime() > GIVE_UP_MINUTES * 60_000;
    let u: KeyUsage | null = null;
    try { u = await withTimeout(read(p.hermes_profile), READER_TIMEOUT_MS); } catch { u = null; }
    if (!u) {
      if (giveUp) { await db.query(`UPDATE lumi_run_cost_probes SET state='UNAVAILABLE',reason='AFTER_MISSED' WHERE run_id=$1 AND state='PENDING'`, [p.run_id]); out.unavailable += 1; } else out.waiting += 1;
      continue;
    }
    if (!u.dedicated) { await db.query(`UPDATE lumi_run_cost_probes SET state='UNAVAILABLE',reason='SHARED_KEY' WHERE run_id=$1 AND state='PENDING'`, [p.run_id]); out.unavailable += 1; continue; }
    // another run of the same assistant (same key) was active inside the window ⇒ the difference cannot be split between them
    const [ov] = await db.query<any>(
      `SELECT 1 AS x FROM lumi_task_runs r2 WHERE r2.assistant_id=$1 AND r2.id<>$2
          AND (r2.state IN ('DISPATCHED','DISPATCH_UNCERTAIN','RUNNING') OR (r2.started_at IS NOT NULL AND r2.finished_at IS NOT NULL AND r2.finished_at > $3::timestamptz AND r2.started_at < $4::timestamptz)) LIMIT 1`,
      [p.assistant_id, p.run_id, iso(new Date(p.before_at)), iso(now)]);
    if (ov) { await db.query(`UPDATE lumi_run_cost_probes SET state='OVERLAP',after_usage=$2,after_at=$3,reason='RUNS_OVERLAPPED' WHERE run_id=$1 AND state='PENDING'`, [p.run_id, u.usage, iso(now)]); out.overlap += 1; continue; }
    if (u.usage + 1e-9 < Number(p.before_usage)) { await db.query(`UPDATE lumi_run_cost_probes SET state='UNAVAILABLE',after_usage=$2,after_at=$3,reason='USAGE_DECREASED' WHERE run_id=$1 AND state='PENDING'`, [p.run_id, u.usage, iso(now)]); out.unavailable += 1; continue; }
    await db.query(`UPDATE lumi_run_cost_probes SET state='MEASURED',after_usage=$2,after_at=$3 WHERE run_id=$1 AND state='PENDING'`, [p.run_id, u.usage, iso(now)]);
    out.measured += 1;
  }
  return out;
}

export const PROBE_REASON_TEXT: Record<string, string> = {
  SHARED_KEY: "Khóa dùng chung với bot khác nên không quy được chi phí cho lượt này",
  RUNS_OVERLAPPED: "Các lượt chạy chồng nhau trên cùng một khóa nên không tách được chi phí từng lượt",
  KEY_UNREADABLE: "Không đọc được mức sử dụng của khóa nhà cung cấp",
  PROBE_ERROR: "Lỗi khi đọc mức sử dụng của khóa nhà cung cấp",
  AFTER_MISSED: "Không đọc được mức sử dụng sau lượt chạy trong thời gian cho phép",
  USAGE_DECREASED: "Mức sử dụng của khóa giảm bất thường nên không tin được số đo",
};
