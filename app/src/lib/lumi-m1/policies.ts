/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-02 / CMP-03: operating policies set by the OWNER, versioned, with NO built-in default (SR-16). A step that needs a policy that is not set is
 * refused with a specific reason instead of silently using a number the system invented.
 */
import { audit, LumiError, requireRole, type Db } from "./core";

export const POLICY_KEYS = ["prepare_fund", "max_loss", "report_cadence_days", "proposal_ttl_days", "meeting_cap", "currency", "owner_hourly_rate"] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];
export const POLICY_LABEL: Record<PolicyKey, string> = {
  prepare_fund: "quỹ chuẩn bị", max_loss: "mức lỗ tối đa", report_cadence_days: "nhịp báo cáo (ngày)", proposal_ttl_days: "hạn đề xuất dự án (ngày)",
  meeting_cap: "trần số lần họp", currency: "đơn vị tiền chính", owner_hourly_rate: "đơn giá thời gian của Chủ",
};
const MONEY = /^[A-Z]{3,5}$/;

/** Returns the problems with a value for a key (empty = valid). `null` means "unset" and is always valid. */
export function validatePolicyValue(key: PolicyKey, v: unknown): string[] {
  if (v === null) return [];
  const bad: string[] = [];
  const intIn = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
  const money = (x: any, positive: boolean) => {
    if (!x || typeof x !== "object") return ["value{amount,currency}"];
    const m: string[] = [];
    if (typeof x.amount !== "number" || !Number.isFinite(x.amount) || x.amount < 0 || (positive && x.amount === 0)) m.push(positive ? "amount(>0)" : "amount(>=0)");
    if (typeof x.currency !== "string" || !MONEY.test(x.currency)) m.push("currency(3..5 chữ in hoa)");
    return m;
  };
  switch (key) {
    case "prepare_fund": case "max_loss": bad.push(...money(v, false)); break;
    case "owner_hourly_rate": bad.push(...money(v, true)); break;
    case "report_cadence_days": case "proposal_ttl_days": if (!intIn(v, 1, 90)) bad.push("value(số nguyên 1..90)"); break;
    case "meeting_cap": if (!intIn(v, 0, 50)) bad.push("value(số nguyên 0..50)"); break;
    case "currency": if (typeof v !== "string" || !MONEY.test(v)) bad.push("value(mã tiền 3..5 chữ in hoa)"); break;
  }
  return bad;
}
const validScope = (s: unknown): s is string => typeof s === "string" && /^(COMPANY|assistant:[a-z0-9-]{2,31}|project:[a-z0-9-]{2,60})$/.test(s);

/** Current value of a policy, or null when it was never set / was unset. */
export async function getPolicy(db: Db, key: PolicyKey, scope = "COMPANY"): Promise<{ value: any; version: number; set_by: string; set_at: string } | null> {
  const [r] = await db.query<any>(`SELECT value,version,set_by,set_at FROM lumi_policies WHERE key=$1 AND scope=$2 ORDER BY version DESC LIMIT 1`, [key, scope]);
  return r && r.value !== null ? r : null;
}
/** The guard other steps call: a missing policy blocks the step with the reason named (never a made-up default). */
export async function requirePolicy(db: Db, key: PolicyKey, scope = "COMPANY") {
  const p = await getPolicy(db, key, scope);
  if (!p) throw new LumiError("POLICY_NOT_SET", 409, { key, scope, label: POLICY_LABEL[key] });
  return p;
}

export async function setPolicy(db: Db, a: { actorRef: string; key: string; scope?: string; value: unknown; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const scope = a.scope ?? "COMPANY";
  const bad: string[] = [];
  if (!(POLICY_KEYS as readonly string[]).includes(a.key)) bad.push("key");
  if (!validScope(scope)) bad.push("scope(COMPANY | assistant:<slug> | project:<slug>)");
  if (a.value === undefined) bad.push("value");
  if (a.note !== undefined && (typeof a.note !== "string" || a.note.length > 500)) bad.push("note(<=500)");
  if (!bad.length) bad.push(...validatePolicyValue(a.key as PolicyKey, a.value));
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`policy:${a.key}:${scope}`]); // two writers cannot both take the next version number
    const [cur] = await t.query<any>(`SELECT value,version FROM lumi_policies WHERE key=$1 AND scope=$2 ORDER BY version DESC LIMIT 1`, [a.key, scope]);
    if (cur && JSON.stringify(cur.value) === JSON.stringify(a.value)) return { version: cur.version, alreadyProcessed: true as const };
    if (!cur && a.value === null) return { version: 0, alreadyProcessed: true as const }; // "unset" of something never set: nothing to record
    const version = (cur?.version ?? 0) + 1;
    await t.query(`INSERT INTO lumi_policies(key,scope,version,value,note,set_by,set_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`, [a.key, scope, version, JSON.stringify(a.value), a.note ?? null, a.actorRef, a.now.toISOString()]);
    await audit(t, "policy.set", a.actorRef, { key: a.key, scope, version, unset: a.value === null }, a.now);
    return { version, alreadyProcessed: false as const };
  });
}

/** Current value per (key, scope) plus the full history, newest first. */
export async function listPolicies(db: Db) {
  const rows = await db.query<any>(`SELECT key,scope,version,value,note,set_by,set_at FROM lumi_policies ORDER BY key,scope,version DESC`);
  const current: any[] = []; const seen = new Set<string>();
  for (const r of rows) { const k = `${r.key}|${r.scope}`; if (seen.has(k)) continue; seen.add(k); if (r.value !== null) current.push(r); }
  return { current, history: rows, keys: POLICY_KEYS.map((k) => ({ key: k, label: POLICY_LABEL[k] })) };
}
