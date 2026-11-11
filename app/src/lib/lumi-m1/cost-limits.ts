/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-05 (CST-01, CST-02): limits on AI cost the OWNER sets per day (all bots / one bot), per project (total) and per run, with a warning threshold.
 * HONEST SCOPE: a limit is enforced only against MEASURED cost (cost-probe.ts). Runs whose cost is unknown cannot be counted against a cap, so the per-bot
 * run caps (max runs per day, total runs) stay the hard brake for those; the measured cost lags a run by about a minute. At a cap NEW runs are refused
 * (`COST_CAP`); running ones are never killed by a limit (the existing emergency stop does that). A limit never asks for more budget.
 * `enforceCostLimits` is READ-ONLY (it is called inside the transaction that creates a run; a refusal there rolls everything back), alerts are written by the worker tick.
 */
import { audit, enqueueNotify, LumiError, requireRole, type Db } from "./core";

const iso = (d: Date) => d.toISOString();
export const VN_OFFSET_MS = 7 * 3600_000; // Asia/Ho_Chi_Minh has no daylight saving; the day boundary of every "per day" limit
export const dayKey = (now: Date) => new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
export const dayStart = (now: Date) => new Date(Date.parse(`${dayKey(now)}T00:00:00Z`) - VN_OFFSET_MS);
export const SCOPES = ["DAY_GLOBAL", "DAY_ASSISTANT", "PROJECT_TOTAL", "RUN"] as const;
export type LimitScope = (typeof SCOPES)[number];

const SPENT_SQL = `COALESCE(SUM(pr.after_usage - pr.before_usage),0)::float`;
export async function measuredSpend(t: Db, o: { since?: Date; assistantId?: string; projectId?: string }): Promise<number> {
  const p: any[] = []; const w: string[] = [`pr.state='MEASURED'`];
  if (o.since) { p.push(iso(o.since)); w.push(`pr.after_at >= $${p.length}::timestamptz`); }
  if (o.assistantId) { p.push(o.assistantId); w.push(`pr.assistant_id = $${p.length}::uuid`); }
  if (o.projectId) { p.push(o.projectId); w.push(`k.project_id = $${p.length}::uuid`); }
  const [r] = await t.query<any>(`SELECT ${SPENT_SQL} AS s FROM lumi_run_cost_probes pr JOIN lumi_task_runs r ON r.id=pr.run_id JOIN tasks k ON k.id=r.task_id WHERE ${w.join(" AND ")}`, p);
  return Number(r?.s ?? 0);
}

// ───────────────────────── owner configuration
export async function setCostLimit(db: Db, a: { actorRef: string; scope: LimitScope; scopeRef?: string; amount: number; currency?: string; warnRatio?: number; note?: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  const bad: string[] = [];
  if (!SCOPES.includes(a.scope)) bad.push("scope");
  if (!(typeof a.amount === "number" && Number.isFinite(a.amount) && a.amount > 0)) bad.push("amount(>0)");
  if ((a.currency ?? "USD") !== "USD") bad.push("currency(chỉ USD: chi phí AI đo được theo USD)");
  const w = a.warnRatio ?? 0.8;
  if (!(w > 0 && w <= 1)) bad.push("warn_ratio(0..1)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    let ref: string | null = null;
    if (a.scope === "DAY_ASSISTANT") { const [x] = await t.query<any>(`SELECT slug FROM lumi_assistants WHERE slug=$1`, [a.scopeRef ?? ""]); if (!x) throw new LumiError("NOT_FOUND", 404, { what: "assistant" }); ref = x.slug; }
    else if (a.scope === "PROJECT_TOTAL") { const [x] = await t.query<any>(`SELECT id FROM lumi_projects WHERE id::text=$1`, [a.scopeRef ?? ""]); if (!x) throw new LumiError("NOT_FOUND", 404, { what: "project" }); ref = x.id; }
    else if (a.scopeRef) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["scope_ref(không dùng với phạm vi này)"] });
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cost-limit:${a.scope}:${ref ?? ""}`]);
    const prior = (await t.query<any>(`SELECT id FROM lumi_cost_limits WHERE active AND scope=$1 AND coalesce(scope_ref,'')=$2`, [a.scope, ref ?? ""]))[0];
    if (prior) await t.query(`UPDATE lumi_cost_limits SET active=false,ended_by=$2,ended_at=$3 WHERE id=$1`, [prior.id, a.actorRef, iso(a.now)]); // history is kept: a change is a new row
    const [row] = await t.query<any>(`INSERT INTO lumi_cost_limits(scope,scope_ref,amount,currency,warn_ratio,note,set_by,set_at) VALUES ($1,$2,$3,'USD',$4,$5,$6,$7) RETURNING *`, [a.scope, ref, a.amount, w, a.note ?? null, a.actorRef, iso(a.now)]);
    await audit(t, "cost.limit_set", a.actorRef, { limitId: row.id, scope: a.scope, scopeRef: ref, amount: a.amount }, a.now);
    return { limit: row };
  });
}
export async function removeCostLimit(db: Db, a: { actorRef: string; limitId: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const r = await t.query<any>(`UPDATE lumi_cost_limits SET active=false,ended_by=$2,ended_at=$3 WHERE id=$1 AND active RETURNING id`, [a.limitId, a.actorRef, iso(a.now)]);
    if (!r.length) throw new LumiError("NOT_FOUND", 404);
    await audit(t, "cost.limit_removed", a.actorRef, { limitId: a.limitId }, a.now);
    return { removed: true as const };
  });
}

/** Limits with how much of each is used right now (measured only). */
export async function listCostLimits(db: Db, now: Date) {
  const limits = await db.query<any>(`SELECT l.*, a.name AS assistant_name, p.name AS project_name FROM lumi_cost_limits l LEFT JOIN lumi_assistants a ON l.scope='DAY_ASSISTANT' AND a.slug=l.scope_ref LEFT JOIN lumi_projects p ON l.scope='PROJECT_TOTAL' AND p.id::text=l.scope_ref WHERE l.active ORDER BY l.scope,l.set_at`);
  const out: any[] = [];
  for (const l of limits) {
    let spent: number | null = null;
    if (l.scope === "DAY_GLOBAL") spent = await measuredSpend(db, { since: dayStart(now) });
    else if (l.scope === "DAY_ASSISTANT") { const [a] = await db.query<any>(`SELECT id FROM lumi_assistants WHERE slug=$1`, [l.scope_ref]); spent = a ? await measuredSpend(db, { since: dayStart(now), assistantId: a.id }) : 0; }
    else if (l.scope === "PROJECT_TOTAL") spent = await measuredSpend(db, { projectId: l.scope_ref });
    out.push({ ...l, amount: Number(l.amount), warn_ratio: Number(l.warn_ratio), spent_measured: spent, ratio: spent === null ? null : spent / Number(l.amount) });
  }
  return out;
}

// ───────────────────────── enforcement (read-only; called from createRun)
export async function enforceCostLimits(t: Db, asst: { id: string; slug: string }, projectId: string | null, now: Date): Promise<void> {
  const limits = await t.query<any>(`SELECT * FROM lumi_cost_limits WHERE active AND scope IN ('DAY_GLOBAL','DAY_ASSISTANT','PROJECT_TOTAL') AND (scope='DAY_GLOBAL' OR (scope='DAY_ASSISTANT' AND scope_ref=$1) OR (scope='PROJECT_TOTAL' AND scope_ref=$2))`, [asst.slug, projectId ?? ""]);
  for (const l of limits) {
    const spent = l.scope === "DAY_GLOBAL" ? await measuredSpend(t, { since: dayStart(now) }) : l.scope === "DAY_ASSISTANT" ? await measuredSpend(t, { since: dayStart(now), assistantId: asst.id }) : await measuredSpend(t, { projectId: l.scope_ref });
    if (spent >= Number(l.amount)) throw new LumiError("COST_CAP", 409, { scope: l.scope, scope_ref: l.scope_ref, limit: Number(l.amount), spent_measured: spent, currency: "USD" });
  }
}

// ───────────────────────── worker tick: warnings, stop notices, per-run overruns (each once)
export async function costLimitTick(db: Db, now: Date): Promise<{ warned: number; stopped: number; runsFlagged: number }> {
  const out = { warned: 0, stopped: 0, runsFlagged: 0 };
  const day = dayKey(now);
  for (const l of await listCostLimits(db, now)) {
    if (l.scope === "RUN" || l.spent_measured === null) continue;
    const kind = l.spent_measured >= l.amount ? "STOP" : l.spent_measured >= l.amount * l.warn_ratio ? "WARN" : null;
    if (!kind) continue;
    await db.tx(async (t) => {
      const ins = await t.query<any>(`INSERT INTO lumi_cost_alerts(limit_id,day,kind,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING limit_id`, [l.id, l.scope === "PROJECT_TOTAL" ? "total" : day, kind, iso(now)]);
      if (!ins[0]) return;
      await enqueueNotify(t, `notify:cost:${l.id}:${kind}:${l.scope === "PROJECT_TOTAL" ? "total" : day}`, { type: kind === "STOP" ? "COST_CAP_REACHED" : "COST_WARNING", scope: l.scope, ref: l.scope_ref, spent: l.spent_measured, limit: l.amount }, now);
      await audit(t, kind === "STOP" ? "cost.cap_reached" : "cost.warning", "system:cost", { limitId: l.id, scope: l.scope, spent: l.spent_measured }, now);
      if (kind === "STOP") out.stopped += 1; else out.warned += 1;
    });
  }
  // a single run that cost more than the per-run limit: flagged for the owner after the fact (a run cannot be priced before it ends)
  const [run] = await db.query<any>(`SELECT amount FROM lumi_cost_limits WHERE active AND scope='RUN'`);
  if (run) {
    const over = await db.query<any>(
      `SELECT pr.run_id, r.task_id, (pr.after_usage-pr.before_usage)::float AS cost FROM lumi_run_cost_probes pr JOIN lumi_task_runs r ON r.id=pr.run_id
        WHERE pr.state='MEASURED' AND pr.after_at >= $2::timestamptz AND (pr.after_usage-pr.before_usage) > $1
          AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.action='cost.run_over' AND e.entity_id=r.task_id::text AND e.after_json->>'runId'=pr.run_id::text)`, [Number(run.amount), iso(new Date(now.getTime() - 2 * 86400_000))]);
    for (const o of over) {
      await db.tx(async (t) => {
        await t.query(`UPDATE tasks SET needs_decision=true,updated_at=$2 WHERE id=$1`, [o.task_id, iso(now)]);
        await enqueueNotify(t, `notify:cost-run:${o.run_id}`, { type: "RUN_OVER_LIMIT", runId: o.run_id, cost: o.cost, limit: Number(run.amount) }, now);
        await audit(t, "cost.run_over", "system:cost", { taskId: o.task_id, runId: o.run_id, cost: o.cost, limit: Number(run.amount) }, now);
      });
      out.runsFlagged += 1;
    }
  }
  return out;
}
