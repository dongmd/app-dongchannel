/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/** IMP-05 HTTP handlers (cost limits, money books, experiments, dashboard blocks). User-only; roles are enforced in the domain calls. Merged into HANDLERS by handlers.ts. */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { listCostLimits, removeCostLimit, setCostLimit } from "./cost-limits";
import { buildCostSummary } from "./cost-summary";
import { adjustMoney, areaResults, economyReport, assistantHealth, createExperiment, decideExperiment, listExperiments, listMoney, lockExperiment, moneySummary, recordExperimentResult, recordMoney } from "./finance";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const need = (b: any, fields: string[]) => { const missing = fields.filter((f) => b?.[f] === undefined || b?.[f] === null || b?.[f] === ""); if (missing.length) throw new LumiError("VALIDATION_ERROR", 400, { missing }); };
const ok = (data: any, status = 200): ApiRes => ({ status, data });
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };
const idem = (req: ApiReq) => { const k = req.headers.get("idempotency-key"); if (!k || k.length < 8 || k.length > 128) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] }); return k; };

export const HANDLERS_IMP05: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  // ── cost limits (CST-01/02)
  async listCostLimits(ctx, req) { user(req); return ok({ limits: await listCostLimits(ctx.db, ctx.now()), summary: await buildCostSummary(ctx.db) }); },
  async setCostLimit(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["scope", "amount"]);
    return ok(await setCostLimit(ctx.db, { actorRef: u.actorRef, scope: b.scope, scopeRef: str(b.scope_ref), amount: Number(b.amount), currency: str(b.currency), warnRatio: num(b.warn_ratio), note: str(b.note), now: ctx.now() }), 201);
  },
  async removeCostLimit(ctx, req) { const u = user(req); return ok(await removeCostLimit(ctx.db, { actorRef: u.actorRef, limitId: uuid(req.params.id, "limit_id"), now: ctx.now() })); },
  // ── money books (ECO-02, MOS-03)
  async recordMoney(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["project_id", "ledger", "state", "amount", "currency", "source"]);
    const r = await recordMoney(ctx.db, { actorRef: u.actorRef, projectId: uuid(b.project_id, "project_id"), ledger: b.ledger, state: b.state, amount: Number(b.amount), currency: String(b.currency), periodStart: str(b.period_start), periodEnd: str(b.period_end), source: String(b.source), note: str(b.note), idempotencyKey: idem(req), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { entry: r.entry, already_processed: true } } : ok({ entry: r.entry }, 201);
  },
  async adjustMoney(ctx, req) {
    const u = user(req); need(req.body, ["to_state"]);
    const r = await adjustMoney(ctx.db, { actorRef: u.actorRef, entryId: uuid(req.params.id, "entry_id"), toState: req.body.to_state, amount: num(req.body.amount), note: str(req.body.note), idempotencyKey: idem(req), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { entry: r.entry, already_processed: true } } : ok({ entry: r.entry }, 201);
  },
  async moneyOverview(ctx, req) {
    user(req); const b = req.body ?? {}; const projectId = b.project_id ? uuid(b.project_id, "project_id") : undefined;
    return ok({ summary: await moneySummary(ctx.db, { projectId, from: str(b.from), to: str(b.to) }), entries: await listMoney(ctx.db, { projectId }) });
  },
  async economyReport(ctx, req) { user(req); const b = req.body ?? {}; return ok(await economyReport(ctx.db, { projectId: b.project_id ? uuid(b.project_id, "project_id") : undefined, from: str(b.from), to: str(b.to), now: ctx.now() })); },
  async dashboardFinance(ctx, req) { user(req); return ok({ areas: await areaResults(ctx.db), health: await assistantHealth(ctx.db, ctx.now()) }); },
  // ── experiments (ECO-04)
  async listExperiments(ctx, req) { user(req); return ok({ experiments: await listExperiments(ctx.db) }); },
  async createExperiment(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["project_id", "title", "hypothesis", "baseline", "metric_unit", "metric_source", "observation_days", "min_sample", "cap_amount", "max_loss", "currency", "stop_condition", "scale_condition", "evaluator"]);
    return ok(await createExperiment(ctx.db, { actorRef: u.actorRef, projectId: uuid(b.project_id, "project_id"), title: String(b.title), hypothesis: String(b.hypothesis), baseline: String(b.baseline), metricUnit: String(b.metric_unit), metricSource: String(b.metric_source), observationDays: Number(b.observation_days), minSample: Number(b.min_sample), capAmount: Number(b.cap_amount), maxLoss: Number(b.max_loss), currency: String(b.currency), stopCondition: String(b.stop_condition), scaleCondition: String(b.scale_condition), targetMetricMin: num(b.target_metric_min), stopSpendNoConversion: num(b.stop_spend_no_conversion), evaluator: String(b.evaluator), now: ctx.now() }), 201);
  },
  async lockExperiment(ctx, req) { const u = user(req); const r = await lockExperiment(ctx.db, { actorRef: u.actorRef, experimentId: uuid(req.params.id, "experiment_id"), now: ctx.now() }); return r.alreadyProcessed ? { status: 200, data: { already_processed: true } } : ok({ experiment: r.experiment }); },
  async recordExperimentResult(ctx, req) {
    const u = user(req); need(req.body, ["observed_on", "spend", "conversions"]);
    return ok(await recordExperimentResult(ctx.db, { actorRef: u.actorRef, experimentId: uuid(req.params.id, "experiment_id"), observedOn: String(req.body.observed_on), spend: Number(req.body.spend), conversions: Number(req.body.conversions), metricValue: num(req.body.metric_value), note: str(req.body.note), now: ctx.now() }), 201);
  },
  async decideExperiment(ctx, req) {
    const u = user(req); need(req.body, ["decision", "note"]);
    if (!["APPROVE_SCALE", "REJECT", "CLOSE"].includes(req.body.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    return ok(await decideExperiment(ctx.db, { actorRef: u.actorRef, experimentId: uuid(req.params.id, "experiment_id"), decision: req.body.decision, note: String(req.body.note), now: ctx.now() }));
  },
};
