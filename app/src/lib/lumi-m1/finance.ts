/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-05 finance that needs NO outside account (ECO-02, ECO-04, MOS-03, DSH-05/07): the three ledgers are kept APART and never summed into a "profit":
 *   ADS_COST (what was spent on ads), COMMISSION (affiliate commission by state), SPONSOR (contracts and sponsor income) — and AI cost (measured, cost-probe.ts).
 * Every number is typed by the person (source stated); nothing is auto-filled; a missing source shows "chưa có dữ liệu". An adjustment is a NEW row pointing at the
 * entry it adjusts (the old number is never changed); a signed sponsor contract or an expected payment is PIPELINE and is never added to money received.
 * Experiments carry their stop/scale criteria fixed BEFORE they run; a good number never grants budget and one conversion never recommends scaling.
 */
import { audit, enqueueNotify, LumiError, requireRole, type Db } from "./core";
import { uniqueViolation } from "./assistants";

const iso = (d: Date) => d.toISOString();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LEDGERS = ["ADS_COST", "COMMISSION", "SPONSOR"] as const;
export type Ledger = (typeof LEDGERS)[number];
export type MoneyState = "RECORDED" | "CONFIRMED" | "PAID" | "REVERSED" | "PIPELINE";
const START_STATES: Record<Ledger, MoneyState[]> = { ADS_COST: ["RECORDED"], COMMISSION: ["RECORDED", "CONFIRMED", "PAID"], SPONSOR: ["PIPELINE", "RECORDED", "CONFIRMED", "PAID"] };
const NEXT: Record<MoneyState, MoneyState[]> = { PIPELINE: ["RECORDED", "CONFIRMED", "PAID", "REVERSED"], RECORDED: ["CONFIRMED", "PAID", "REVERSED"], CONFIRMED: ["PAID", "REVERSED"], PAID: ["REVERSED"], REVERSED: [] };
const NEXT_ADS: MoneyState[] = ["REVERSED"];

// ───────────────────────── money entries (ECO-02, MOS-03)
export interface MoneyInput { actorRef: string; projectId: string; ledger: Ledger; state: MoneyState; amount: number; currency: string; periodStart?: string; periodEnd?: string; source: string; note?: string; idempotencyKey: string; now: Date }
export async function recordMoney(db: Db, i: MoneyInput) {
  if (i.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403); // a bot never writes the money books
  await requireRole(db, i.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  if (!LEDGERS.includes(i.ledger)) bad.push("ledger");
  else if (!START_STATES[i.ledger].includes(i.state)) bad.push(`state(sổ ${i.ledger} bắt đầu ở: ${START_STATES[i.ledger].join("/")})`);
  if (!(typeof i.amount === "number" && Number.isFinite(i.amount) && i.amount >= 0)) bad.push("amount(>=0)");
  if (!/^[A-Z]{3,5}$/.test(i.currency ?? "")) bad.push("currency(ví dụ USD, VND)");
  if (typeof i.source !== "string" || i.source.trim().length < 2) bad.push("source(nguồn số liệu, bắt buộc)");
  for (const [k, v] of [["period_start", i.periodStart], ["period_end", i.periodEnd]] as const) if (v !== undefined && !DATE_RE.test(v)) bad.push(`${k}(YYYY-MM-DD)`);
  if (i.periodStart && i.periodEnd && i.periodEnd < i.periodStart) bad.push("period_end(không trước period_start)");
  if (typeof i.idempotencyKey !== "string" || i.idempotencyKey.length < 8) bad.push("idempotency_key");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  try {
    return await db.tx(async (t) => {
      const [prior] = await t.query<any>(`SELECT * FROM lumi_money_entries WHERE idempotency_key=$1`, [i.idempotencyKey]);
      if (prior) return { entry: prior, alreadyProcessed: true as const };
      if (!(await t.query(`SELECT 1 FROM lumi_projects WHERE id=$1`, [i.projectId])).length) throw new LumiError("NOT_FOUND", 404, { what: "project" });
      const [e] = await t.query<any>(
        `INSERT INTO lumi_money_entries(project_id,ledger,state,amount,currency,period_start,period_end,source,note,idempotency_key,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [i.projectId, i.ledger, i.state, i.amount, i.currency, i.periodStart ?? null, i.periodEnd ?? null, i.source.trim(), i.note ?? null, i.idempotencyKey, i.actorRef, iso(i.now)]);
      await audit(t, "money.recorded", i.actorRef, { entryId: e.id, ledger: i.ledger, state: i.state, amount: i.amount, currency: i.currency }, i.now);
      return { entry: e, alreadyProcessed: false as const };
    });
  } catch (e) { throw uniqueViolation(e, []) ?? e; }
}

/** The CURRENT state of a chain: the newest row that descends from the root. */
const EFFECTIVE_SQL = `
  WITH RECURSIVE chain AS (
    SELECT r.id AS root_id, r.id, r.created_at, 0 AS d FROM lumi_money_entries r WHERE r.parent_id IS NULL
    UNION ALL SELECT c.root_id, e.id, e.created_at, c.d+1 FROM lumi_money_entries e JOIN chain c ON e.parent_id=c.id WHERE c.d < 20
  ), latest AS (SELECT DISTINCT ON (root_id) root_id, id FROM chain ORDER BY root_id, d DESC, created_at DESC)
  SELECT m.*, l.root_id, p.name AS project_name, p.area FROM latest l JOIN lumi_money_entries m ON m.id=l.id JOIN lumi_projects p ON p.id=m.project_id`;

export async function adjustMoney(db: Db, a: { actorRef: string; entryId: string; toState: MoneyState; amount?: number; note?: string; idempotencyKey: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (typeof a.idempotencyKey !== "string" || a.idempotencyKey.length < 8) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["idempotency_key"] });
  return db.tx(async (t) => {
    const [prior] = await t.query<any>(`SELECT * FROM lumi_money_entries WHERE idempotency_key=$1`, [a.idempotencyKey]);
    if (prior) return { entry: prior, alreadyProcessed: true as const };
    const [root] = await t.query<any>(`SELECT * FROM lumi_money_entries WHERE id=$1`, [a.entryId]);
    if (!root) throw new LumiError("NOT_FOUND", 404);
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`money-chain:${root.parent_id ?? root.id}`]);
    const rootId = root.parent_id ?? root.id;
    const [cur] = (await t.query<any>(`${EFFECTIVE_SQL}`)).filter((x: any) => x.root_id === rootId);
    if (!cur) throw new LumiError("NOT_FOUND", 404);
    const allowed = cur.ledger === "ADS_COST" ? NEXT_ADS : NEXT[cur.state as MoneyState];
    if (!allowed.includes(a.toState)) throw new LumiError("INVALID_TRANSITION", 409, { from: cur.state, to: a.toState, allowed });
    const amount = a.amount ?? Number(cur.amount);
    if (!(amount >= 0) || (a.toState === "REVERSED" && amount > Number(cur.amount))) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["amount(không vượt số đang đảo/hoàn)"] });
    if ((a.note ?? "").length > 1000) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["note(<=1000)"] });
    const [e] = await t.query<any>(
      `INSERT INTO lumi_money_entries(project_id,ledger,state,amount,currency,period_start,period_end,source,note,parent_id,idempotency_key,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [cur.project_id, cur.ledger, a.toState, amount, cur.currency, cur.period_start, cur.period_end, cur.source, a.note ?? null, cur.id, a.idempotencyKey, a.actorRef, iso(a.now)]);
    await audit(t, "money.adjusted", a.actorRef, { entryId: e.id, parentId: cur.id, from: cur.state, to: a.toState, amount }, a.now);
    return { entry: e, alreadyProcessed: false as const };
  });
}

/** Per ledger and currency; states are never merged; no profit is computed. Mixed currencies stay separate. */
export async function moneySummary(db: Db, o: { projectId?: string; from?: string; to?: string } = {}) {
  const rows = (await db.query<any>(EFFECTIVE_SQL)).filter((r: any) =>
    (!o.projectId || r.project_id === o.projectId) && (!o.from || !r.period_end || r.period_end >= o.from) && (!o.to || !r.period_start || r.period_start <= o.to));
  const sum = (ledger: Ledger) => {
    const by: Record<string, Record<string, number>> = {};
    for (const r of rows.filter((x: any) => x.ledger === ledger)) { const c = (by[r.currency] ??= { RECORDED: 0, CONFIRMED: 0, PAID: 0, PIPELINE: 0, REVERSED: 0 }); c[r.state] = (c[r.state] ?? 0) + Number(r.amount); }
    return Object.entries(by).map(([currency, s]) => ({ currency, ...s }) as { currency: string } & Record<MoneyState, number>);
  };
  const [ai] = await db.query<any>(`SELECT coalesce(sum(CASE WHEN pr.state='MEASURED' THEN pr.after_usage-pr.before_usage END),0)::float AS measured, count(r.id) FILTER (WHERE r.state IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','ABANDONED','STOPPED_CAP') AND coalesce(pr.state,'NONE')<>'MEASURED')::int AS unknown_runs FROM lumi_task_runs r LEFT JOIN lumi_run_cost_probes pr ON pr.run_id=r.id`);
  const latest = rows.reduce((m: string | null, r: any) => (!m || r.created_at > m ? r.created_at : m), null);
  return {
    ledgers: { ADS_COST: sum("ADS_COST"), COMMISSION: sum("COMMISSION"), SPONSOR: sum("SPONSOR") },
    ai_cost: { currency: "USD", measured: Number(ai?.measured ?? 0), unknown_runs: Number(ai?.unknown_runs ?? 0) },
    entries: rows.length, updated_at: latest ? new Date(latest).toISOString() : null,
    note: "Bốn sổ tách riêng, KHÔNG cộng thành lợi nhuận. «Đã trả» mới là tiền đã nhận; «pipeline» (hợp đồng đã ký, doanh thu dự kiến) không cộng vào tiền thu. Số liệu do người nhập kèm nguồn; chưa có nguồn thì «chưa có dữ liệu».",
  };
}

export async function listMoney(db: Db, o: { projectId?: string; limit?: number } = {}) {
  const rows = (await db.query<any>(EFFECTIVE_SQL)).filter((r: any) => !o.projectId || r.project_id === o.projectId).sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1)).slice(0, o.limit ?? 100);
  const hist = await db.query<any>(`SELECT id,parent_id,state,amount,note,created_by,created_at FROM lumi_money_entries WHERE parent_id IS NOT NULL ORDER BY created_at`);
  return rows.map((r: any) => ({ ...r, amount: Number(r.amount), history: hist.filter((h: any) => h.parent_id === r.root_id || (h.parent_id && h.parent_id === r.id)).map((h: any) => ({ state: h.state, amount: Number(h.amount), note: h.note, by: h.created_by, at: h.created_at })) }));
}

/** DSH-05: result per area; each number carries its period/source/updated time and «chưa có dữ liệu» when nothing was entered. */
export async function areaResults(db: Db) {
  const rows = await db.query<any>(EFFECTIVE_SQL);
  const AREAS = ["AFFILIATE", "YOUTUBE", "WEBSITE", "OTHER"];
  return AREAS.map((area) => {
    const rs = rows.filter((r: any) => r.area === area);
    const tot = (ledger: Ledger, states: MoneyState[]) => { const by: Record<string, number> = {}; for (const r of rs.filter((x: any) => x.ledger === ledger && states.includes(x.state))) by[r.currency] = (by[r.currency] ?? 0) + Number(r.amount); return by; };
    return { area, has_data: rs.length > 0, ads_cost: tot("ADS_COST", ["RECORDED"]), commission_paid: tot("COMMISSION", ["PAID"]), commission_confirmed: tot("COMMISSION", ["CONFIRMED"]), sponsor_paid: tot("SPONSOR", ["PAID"]), pipeline: tot("SPONSOR", ["PIPELINE"]), sources: [...new Set(rs.map((r: any) => r.source))], updated_at: rs.length ? new Date(rs.reduce((m: string, r: any) => (r.created_at > m ? r.created_at : m), rs[0].created_at)).toISOString() : null };
  });
}

/** DSH-07: assistant health with today's measured AI cost (unknown runs are counted, not priced at 0). */
export async function assistantHealth(db: Db, now: Date) {
  const day = new Date(Date.parse(`${new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10)}T00:00:00Z`) - 7 * 3600_000);
  return db.query<any>(
    `SELECT a.slug,a.name,a.connection_state,a.dispatch_enabled,a.dispatch_paused,a.connection_checked_at,
            (SELECT count(*)::int FROM lumi_task_runs r WHERE r.assistant_id=a.id AND r.state IN ('DISPATCHED','DISPATCH_UNCERTAIN','RUNNING')) AS running,
            (SELECT count(*)::int FROM tasks k WHERE k.owner_assistant_id=a.id AND k.status::text='WAITING_ASSISTANT') AS waiting_connection,
            (SELECT count(*)::int FROM lumi_task_runs r WHERE r.assistant_id=a.id AND r.created_at >= $1::timestamptz) AS runs_today,
            (SELECT coalesce(sum(pr.after_usage-pr.before_usage),0)::float FROM lumi_run_cost_probes pr WHERE pr.assistant_id=a.id AND pr.state='MEASURED' AND pr.after_at >= $1::timestamptz) AS cost_today_measured,
            (SELECT count(*)::int FROM lumi_task_runs r LEFT JOIN lumi_run_cost_probes pr ON pr.run_id=r.id WHERE r.assistant_id=a.id AND r.finished_at >= $1::timestamptz AND coalesce(pr.state,'NONE')<>'MEASURED') AS runs_unknown_today
       FROM lumi_assistants a WHERE a.status='ACTIVE' ORDER BY a.name`, [iso(day)]);
}

// ───────────────────────── experiments (ECO-04, AFF-04)
export interface ExpCriteria { cap_amount: number; max_loss: number; min_sample: number; observation_days: number; target_metric_min: number | null; stop_spend_no_conversion: number | null }
export interface ExpResult { observed_on: string; spend: number; conversions: number; metric_value: number | null }
export interface Verdict { verdict: "RUNNING" | "STOP" | "SCALE_CANDIDATE" | "INSUFFICIENT_EVIDENCE"; reasons: string[]; spend: number; conversions: number; days_observed: number }

/** Pure. STOP wins; SCALE needs the target AND enough conversions (never from one lucky conversion); otherwise "chưa đủ bằng chứng". */
export function evaluateExperiment(c: ExpCriteria, results: ExpResult[]): Verdict {
  const spend = results.reduce((s, r) => s + r.spend, 0); const conv = results.reduce((s, r) => s + r.conversions, 0);
  const days = new Set(results.map((r) => r.observed_on)).size;
  const base = { spend, conversions: conv, days_observed: days };
  const why: string[] = [];
  if (spend >= c.cap_amount) why.push(`Chi ${spend} đã chạm trần ${c.cap_amount}.`);
  if (spend >= c.max_loss && conv === 0) why.push(`Chi ${spend} ≥ mức lỗ tối đa ${c.max_loss} mà chưa có chuyển đổi.`);
  if (c.stop_spend_no_conversion !== null && conv === 0 && spend >= c.stop_spend_no_conversion) why.push(`Chi ${spend} ≥ ngưỡng ${c.stop_spend_no_conversion} mà chưa có chuyển đổi.`);
  if (why.length) return { verdict: "STOP", reasons: why, ...base };
  const need = Math.max(c.min_sample, 3);
  const latest = [...results].filter((r) => r.metric_value !== null).sort((a, b) => (a.observed_on < b.observed_on ? 1 : -1))[0];
  if (conv >= need && days >= Math.min(c.observation_days, 1) && c.target_metric_min !== null && latest && Number(latest.metric_value) >= c.target_metric_min) return { verdict: "SCALE_CANDIDATE", reasons: [`Đủ ${conv} chuyển đổi (≥ ${need}) và chỉ số ${latest.metric_value} ≥ mục tiêu ${c.target_metric_min}. Chỉ là đề xuất: không tự cấp thêm ngân sách.`], ...base };
  if (conv < need) why.push(`Mới ${conv} chuyển đổi, cần ít nhất ${need} (không khuyến nghị mở rộng chỉ dựa vào ${conv === 1 ? "một chuyển đổi" : "vài chuyển đổi"}).`);
  if (c.target_metric_min === null) why.push("Chưa đặt chỉ số mục tiêu để so.");
  else if (!latest) why.push("Chưa có số đo chỉ số.");
  else if (Number(latest.metric_value) < c.target_metric_min) why.push(`Chỉ số ${latest.metric_value} chưa đạt mục tiêu ${c.target_metric_min}.`);
  return { verdict: results.length ? "INSUFFICIENT_EVIDENCE" : "RUNNING", reasons: results.length ? why : ["Chưa có kết quả nào."], ...base };
}

export interface ExpInput { actorRef: string; projectId: string; title: string; hypothesis: string; baseline: string; metricUnit: string; metricSource: string; observationDays: number; minSample: number; capAmount: number; maxLoss: number; currency: string; stopCondition: string; scaleCondition: string; targetMetricMin?: number; stopSpendNoConversion?: number; evaluator: string; now: Date }
export async function createExperiment(db: Db, i: ExpInput) {
  if (i.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, i.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  const s = (v: unknown, n: string, min = 2) => { if (typeof v !== "string" || v.trim().length < min) bad.push(n); };
  s(i.title, "title", 3); s(i.hypothesis, "hypothesis(giả thuyết)", 3); s(i.baseline, "baseline", 1); s(i.metricUnit, "metric_unit(đơn vị đo)", 1); s(i.metricSource, "metric_source(nguồn)", 2); s(i.stopCondition, "stop_condition", 3); s(i.scaleCondition, "scale_condition", 3); s(i.evaluator, "evaluator(người đánh giá)", 2);
  if (!Number.isInteger(i.observationDays) || i.observationDays < 1 || i.observationDays > 365) bad.push("observation_days(1..365)");
  if (!Number.isInteger(i.minSample) || i.minSample < 1) bad.push("min_sample(>=1)");
  if (!(i.capAmount >= 0)) bad.push("cap_amount(>=0)"); if (!(i.maxLoss >= 0)) bad.push("max_loss(>=0)");
  if (!/^[A-Z]{3,5}$/.test(i.currency ?? "")) bad.push("currency");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    if (!(await t.query(`SELECT 1 FROM lumi_projects WHERE id=$1`, [i.projectId])).length) throw new LumiError("NOT_FOUND", 404, { what: "project" });
    const [e] = await t.query<any>(
      `INSERT INTO lumi_experiments(code,project_id,title,hypothesis,baseline,metric_unit,metric_source,observation_days,min_sample,cap_amount,max_loss,currency,stop_condition,scale_condition,target_metric_min,stop_spend_no_conversion,evaluator,created_by,created_at,updated_at)
       VALUES ('EX-'||lpad(nextval('lumi_ex_code_seq')::text,3,'0'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING *`,
      [i.projectId, i.title.trim(), i.hypothesis.trim(), i.baseline.trim(), i.metricUnit.trim(), i.metricSource.trim(), i.observationDays, i.minSample, i.capAmount, i.maxLoss, i.currency, i.stopCondition.trim(), i.scaleCondition.trim(), i.targetMetricMin ?? null, i.stopSpendNoConversion ?? null, i.evaluator.trim(), i.actorRef, iso(i.now)]);
    await audit(t, "experiment.created", i.actorRef, { experimentId: e.id, code: e.code }, i.now);
    return { experiment: e };
  });
}
/** Locking is the point of no return: from here the criteria cannot change (also enforced by a trigger). Only the owner locks. */
export async function lockExperiment(db: Db, a: { actorRef: string; experimentId: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  return db.tx(async (t) => {
    const [e] = await t.query<any>(`SELECT * FROM lumi_experiments WHERE id=$1 FOR UPDATE`, [a.experimentId]);
    if (!e) throw new LumiError("NOT_FOUND", 404);
    if (e.state === "LOCKED") return { experiment: e, alreadyProcessed: true as const };
    if (e.state !== "DRAFT") throw new LumiError("INVALID_TRANSITION", 409, { state: e.state });
    await t.query(`UPDATE lumi_experiments SET state='LOCKED',locked_by=$2,locked_at=$3,updated_at=$3 WHERE id=$1`, [a.experimentId, a.actorRef, iso(a.now)]);
    await audit(t, "experiment.locked", a.actorRef, { experimentId: a.experimentId }, a.now);
    return { experiment: (await t.query<any>(`SELECT * FROM lumi_experiments WHERE id=$1`, [a.experimentId]))[0], alreadyProcessed: false as const };
  });
}
const criteriaOf = (e: any): ExpCriteria => ({ cap_amount: Number(e.cap_amount), max_loss: Number(e.max_loss), min_sample: e.min_sample, observation_days: e.observation_days, target_metric_min: e.target_metric_min === null ? null : Number(e.target_metric_min), stop_spend_no_conversion: e.stop_spend_no_conversion === null ? null : Number(e.stop_spend_no_conversion) });
const resultsOf = async (t: Db, id: string): Promise<ExpResult[]> => (await t.query<any>(`SELECT to_char(observed_on,'YYYY-MM-DD') AS observed_on, spend, conversions, metric_value FROM lumi_experiment_results WHERE experiment_id=$1 ORDER BY observed_on`, [id])).map((r: any) => ({ observed_on: r.observed_on, spend: Number(r.spend), conversions: r.conversions, metric_value: r.metric_value === null ? null : Number(r.metric_value) }));

export async function recordExperimentResult(db: Db, a: { actorRef: string; experimentId: string; observedOn: string; spend: number; conversions: number; metricValue?: number; note?: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (!DATE_RE.test(a.observedOn ?? "") || !(a.spend >= 0) || !Number.isInteger(a.conversions) || a.conversions < 0) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["observed_on(YYYY-MM-DD)|spend(>=0)|conversions(số nguyên >=0)"] });
  return db.tx(async (t) => {
    const [e] = await t.query<any>(`SELECT * FROM lumi_experiments WHERE id=$1 FOR UPDATE`, [a.experimentId]);
    if (!e) throw new LumiError("NOT_FOUND", 404);
    if (e.state === "DRAFT") throw new LumiError("NOT_LOCKED", 409); // results only count against criteria that were fixed first
    if (e.state !== "LOCKED") throw new LumiError("EXPERIMENT_CLOSED", 409, { state: e.state }); // a stopped branch takes no more data
    await t.query(`INSERT INTO lumi_experiment_results(experiment_id,observed_on,spend,conversions,metric_value,note,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [a.experimentId, a.observedOn, a.spend, a.conversions, a.metricValue ?? null, a.note ?? null, a.actorRef, iso(a.now)]);
    const v = evaluateExperiment(criteriaOf(e), await resultsOf(t, a.experimentId));
    if (v.verdict === "STOP" || v.verdict === "SCALE_CANDIDATE") {
      await t.query(`UPDATE lumi_experiments SET state=$2,updated_at=$3 WHERE id=$1`, [a.experimentId, v.verdict === "STOP" ? "STOPPED" : "SCALE_PROPOSED", iso(a.now)]);
      await enqueueNotify(t, `notify:experiment:${a.experimentId}:${v.verdict}`, { type: v.verdict === "STOP" ? "EXPERIMENT_STOPPED" : "EXPERIMENT_SCALE_PROPOSED", code: e.code }, a.now);
    }
    await audit(t, "experiment.result", a.actorRef, { experimentId: a.experimentId, verdict: v.verdict }, a.now);
    return { verdict: v };
  });
}
export async function decideExperiment(db: Db, a: { actorRef: string; experimentId: string; decision: "APPROVE_SCALE" | "REJECT" | "CLOSE"; note?: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.note ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["note"] });
  return db.tx(async (t) => {
    const [e] = await t.query<any>(`SELECT * FROM lumi_experiments WHERE id=$1 FOR UPDATE`, [a.experimentId]);
    if (!e) throw new LumiError("NOT_FOUND", 404);
    let to: string;
    if (a.decision === "CLOSE") { if (e.state !== "LOCKED") throw new LumiError("INVALID_TRANSITION", 409, { state: e.state }); const v = evaluateExperiment(criteriaOf(e), await resultsOf(t, e.id)); to = v.verdict === "INSUFFICIENT_EVIDENCE" || v.verdict === "RUNNING" ? "INSUFFICIENT" : "COMPLETED"; }
    else { if (e.state !== "SCALE_PROPOSED") throw new LumiError("INVALID_TRANSITION", 409, { state: e.state }); to = a.decision === "APPROVE_SCALE" ? "COMPLETED" : "COMPLETED"; }
    await t.query(`UPDATE lumi_experiments SET state=$2,decision_note=$3,updated_at=$4 WHERE id=$1`, [e.id, to, `${a.decision}: ${a.note!.trim()}${a.decision === "APPROVE_SCALE" ? " (Chủ đồng ý hướng mở rộng; ngân sách/giấy ủy quyền phải cấp RIÊNG, kết quả tốt không tự cấp thêm ngân sách)" : ""}`, iso(a.now)]);
    await audit(t, "experiment.decided", a.actorRef, { experimentId: e.id, decision: a.decision, to }, a.now);
    return { state: to };
  });
}
export async function listExperiments(db: Db) {
  const rows = await db.query<any>(`SELECT e.*,p.name AS project_name FROM lumi_experiments e JOIN lumi_projects p ON p.id=e.project_id ORDER BY e.created_at DESC LIMIT 100`);
  const out: any[] = [];
  for (const e of rows) { const results = await resultsOf(db, e.id); out.push({ ...e, cap_amount: Number(e.cap_amount), max_loss: Number(e.max_loss), results, verdict: e.state === "DRAFT" ? null : evaluateExperiment(criteriaOf(e), results) }); }
  return out;
}
