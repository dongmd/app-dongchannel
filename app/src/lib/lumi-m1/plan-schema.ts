/**
 * Plan & Cost body schema v1 (TDD 14.11.B.4). Pure: no DB. The app REJECTS an invalid body with the list of bad fields; it never
 * repairs it. Bot-written content is DATA: it is stored and shown, never executed or interpreted as an instruction.
 */
import { createHash } from "node:crypto";
import { COST_CATEGORIES } from "./economics";

export const PLAN_SOURCES = ["ESTIMATED", "MEASURED", "BOT_DECLARED", "PROVIDER_STATEMENT", "MANUAL"] as const;
export const CONFIDENCE = ["LOW", "MEDIUM", "HIGH"] as const;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CUR_RE = /^[A-Z]{3,5}$/;

export interface PlanTask {
  key: string; title: string; description: string; deliverable_key: string; assignee_slug: string; expected_output: string; acceptance: string;
  due_in_days: number | null; budget_alloc: { amount: number | null; currency: string } | null; depends_on: string[];
}
export interface PlanBody {
  schema: 1; summary: string;
  opportunity: { evidence: { claim: string; ref: string; as_of: string }[]; confidence: (typeof CONFIDENCE)[number] | null };
  scope: { in: string[]; out: string[] };
  deliverables: { key: string; title: string; acceptance: string }[];
  tasks: PlanTask[];
  milestones: { key: string; after_task_key: string; label: string }[];
  cost: { currency: string; ceiling_requested: number; lines: { category: string; low: number | null; base: number | null; high: number | null; source: string; as_of: string; confidence: string | null }[]; unknown_note: string | null };
  prepare_spent: { amount: number | null; note: string };
  grants_requested: [];
  stop_conditions: string[]; risks: string[]; alternatives: string[];
}

export interface ValidateCtx {
  maxTasks: number;
  /** slug → can this assistant take plan work now (ACTIVE, connected, dispatch enabled)? */
  assistants: ReadonlyMap<string, boolean>;
}
export interface ValidateResult { ok: boolean; errors: string[]; body?: PlanBody; hash?: string; ceiling?: number; currency?: string; est?: { low: number | null; base: number | null; high: number | null } }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, min = 1, max = 20000): v is string => typeof v === "string" && v.trim().length >= min && v.length <= max;
const numOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const strArr = (v: unknown, minItems: number): v is string[] => Array.isArray(v) && v.length >= minItems && v.every((x) => str(x, 1, 2000));

/** Stable JSON (sorted keys) so the same content always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const contentHash = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");

export function validatePlanBody(raw: unknown, ctx: ValidateCtx): ValidateResult {
  const e: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["body(object)"] };
  const b = raw;
  if (b.schema !== 1) e.push("schema(=1)");
  if (!str(b.summary, 20, 2000)) e.push("summary(20..2000)");

  const opp = b.opportunity;
  if (!isObj(opp)) e.push("opportunity");
  else {
    if (!Array.isArray(opp.evidence) || opp.evidence.length < 1) e.push("opportunity.evidence(>=1)");
    else opp.evidence.forEach((x, i) => { if (!isObj(x) || !str(x.claim) || !str(x.ref) || !str(x.as_of)) e.push(`opportunity.evidence[${i}]`); });
    if (!(opp.confidence === null || (CONFIDENCE as readonly unknown[]).includes(opp.confidence))) e.push("opportunity.confidence");
  }
  const scope = b.scope;
  if (!isObj(scope) || !strArr(scope.in, 1) || !strArr(scope.out, 0)) e.push("scope(in>=1,out)");

  const delivKeys = new Set<string>();
  if (!Array.isArray(b.deliverables) || b.deliverables.length < 1) e.push("deliverables(>=1)");
  else b.deliverables.forEach((d, i) => {
    if (!isObj(d) || typeof d.key !== "string" || !KEY_RE.test(d.key) || !str(d.title, 3, 200) || !str(d.acceptance)) { e.push(`deliverables[${i}]`); return; }
    if (delivKeys.has(d.key)) e.push(`deliverables[${i}].key(duplicate)`);
    delivKeys.add(d.key);
  });

  const cost = b.cost;
  let currency = "";
  let ceiling = NaN;
  if (!isObj(cost)) e.push("cost");
  else {
    if (typeof cost.currency !== "string" || !CUR_RE.test(cost.currency)) e.push("cost.currency");
    else currency = cost.currency;
    if (typeof cost.ceiling_requested !== "number" || !Number.isFinite(cost.ceiling_requested) || cost.ceiling_requested < 0) e.push("cost.ceiling_requested(>=0)");
    else ceiling = cost.ceiling_requested;
    if (!Array.isArray(cost.lines)) e.push("cost.lines");
    else cost.lines.forEach((l, i) => {
      if (!isObj(l) || !(COST_CATEGORIES as readonly unknown[]).includes(l.category) || !numOrNull(l.low) || !numOrNull(l.base) || !numOrNull(l.high)
        || !(PLAN_SOURCES as readonly unknown[]).includes(l.source) || !str(l.as_of) || !(l.confidence === null || (CONFIDENCE as readonly unknown[]).includes(l.confidence))) { e.push(`cost.lines[${i}]`); return; }
      const { low, base, high } = l as { low: number | null; base: number | null; high: number | null };
      if (low !== null && base !== null && low > base) e.push(`cost.lines[${i}](low>base)`);
      if (base !== null && high !== null && base > high) e.push(`cost.lines[${i}](base>high)`);
      if (low !== null && high !== null && low > high) e.push(`cost.lines[${i}](low>high)`);
    });
    if (!(cost.unknown_note === null || str(cost.unknown_note))) e.push("cost.unknown_note");
  }

  const taskKeys = new Set<string>();
  let allocSum = 0;
  if (!Array.isArray(b.tasks) || b.tasks.length < 1) e.push("tasks(>=1)");
  else {
    if (b.tasks.length > ctx.maxTasks) e.push(`tasks(<=${ctx.maxTasks})`);
    b.tasks.forEach((t, i) => {
      const p = `tasks[${i}]`;
      if (!isObj(t)) { e.push(p); return; }
      if (typeof t.key !== "string" || !KEY_RE.test(t.key)) e.push(`${p}.key`);
      else if (taskKeys.has(t.key)) e.push(`${p}.key(duplicate)`);
      else taskKeys.add(t.key);
      if (!str(t.title, 3, 200)) e.push(`${p}.title(3..200)`);
      if (typeof t.description !== "string" || t.description.length > 4000) e.push(`${p}.description`);
      if (typeof t.deliverable_key !== "string" || !delivKeys.has(t.deliverable_key)) e.push(`${p}.deliverable_key`);
      if (typeof t.assignee_slug !== "string" || !ctx.assistants.has(t.assignee_slug)) e.push(`${p}.assignee_slug(unknown)`);
      else if (!ctx.assistants.get(t.assignee_slug)) e.push(`${p}.assignee_slug(not_ready)`);
      if (!str(t.expected_output)) e.push(`${p}.expected_output`);
      if (!str(t.acceptance)) e.push(`${p}.acceptance`);
      if (!(t.due_in_days === null || (Number.isInteger(t.due_in_days) && (t.due_in_days as number) > 0))) e.push(`${p}.due_in_days`);
      if (!Array.isArray(t.depends_on) || t.depends_on.length !== 0) e.push(`${p}.depends_on(must_be_empty_in_IMP-01)`);
      const ba = t.budget_alloc;
      if (!(ba === null || (isObj(ba) && numOrNull(ba.amount) && typeof ba.currency === "string"))) e.push(`${p}.budget_alloc`);
      else if (isObj(ba)) {
        if (currency && ba.currency !== currency) e.push(`${p}.budget_alloc.currency(mismatch)`);
        if (typeof ba.amount === "number") allocSum += ba.amount;
      }
    });
  }
  if (Number.isFinite(ceiling) && allocSum > ceiling + 1e-9) e.push("tasks.budget_alloc(sum>ceiling_requested)");

  if (b.milestones !== undefined) {
    if (!Array.isArray(b.milestones)) e.push("milestones");
    else {
      const mk = new Set<string>();
      b.milestones.forEach((m, i) => {
        if (!isObj(m) || typeof m.key !== "string" || !KEY_RE.test(m.key) || typeof m.after_task_key !== "string" || !taskKeys.has(m.after_task_key) || !str(m.label, 1, 200)) { e.push(`milestones[${i}]`); return; }
        if (mk.has(m.key)) e.push(`milestones[${i}].key(duplicate)`);
        mk.add(m.key);
      });
    }
  }
  const pre = b.prepare_spent;
  if (!isObj(pre) || !numOrNull(pre.amount) || typeof pre.note !== "string") e.push("prepare_spent");
  if (!Array.isArray(b.grants_requested) || b.grants_requested.length !== 0) e.push("grants_requested(must_be_empty_in_IMP-01)");
  if (!strArr(b.stop_conditions, 1)) e.push("stop_conditions(>=1)");
  if (!strArr(b.risks, 0)) e.push("risks");
  if (!strArr(b.alternatives, 0)) e.push("alternatives");

  if (e.length) return { ok: false, errors: e };
  const body = { ...(b as unknown as PlanBody), milestones: (b.milestones as PlanBody["milestones"] | undefined) ?? [] };
  const sum = (k: "low" | "base" | "high") => {
    const lines = body.cost.lines;
    if (lines.length === 0 || lines.some((l) => l[k] === null)) return null;
    return lines.reduce((s, l) => s + (l[k] as number), 0);
  };
  return { ok: true, errors: [], body, hash: contentHash(body), ceiling, currency, est: { low: sum("low"), base: sum("base"), high: sum("high") } };
}
