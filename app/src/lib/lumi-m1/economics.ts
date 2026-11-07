/**
 * Pure economics (PRD ECO-01, PLN-04; TDD 12.1). No DB, no clock, no I/O.
 *
 * Rules that the tests pin down:
 *  - `null` is "unknown", never 0 (SR-02). A metric computed with an unknown material cost is returned PROVISIONAL with the list of
 *    what is missing; it is never presented as a complete result and never named "lợi nhuận".
 *  - One currency per call. Mixed currencies are the caller's job to split (SR-12).
 *  - Revenue is counted once; reversals are applied to the confirmed commission before this function is called.
 */
export const COST_CATEGORIES = ["AI", "TOOL", "ADS", "PRODUCTION", "ASSET", "OUTSOURCE", "FEE", "COORD", "SHARED", "OTHER"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface EconomicsInput {
  currency: string;
  /** Commission confirmed by the network after reversals; null = not known / not connected. */
  confirmedCommission: number | null;
  /** Direct costs by category. A missing key or null = unknown (NOT zero); 0 = known to be zero. */
  costs: Partial<Record<Exclude<CostCategory, "SHARED">, number | null>>;
  /** Shared costs allocated to this scope under a rule the owner approved; null = not allocated / unknown. */
  sharedAllocated: number | null;
  /** Cash actually received / paid in the period; null = unknown. */
  cashIn: number | null;
  cashOut: number | null;
  /** Categories whose absence makes a result provisional (default: AI). */
  material?: readonly CostCategory[];
}

export interface Metric { value: number | null; provisional: boolean; missing: string[] }
export interface EconomicsResult {
  currency: string;
  /** confirmed commission − ads (the "70" of the check vector). */
  confirmedMinusAds: Metric;
  /** confirmed − ads − recorded tool/production/asset/outsourcing/fee/other costs, AI NOT included ("Đóng góp affiliate đã xác nhận trước AI"). */
  contributionBeforeAI: Metric;
  /** confirmed − ALL direct costs including AI ("Đóng góp dự án sau chi trực tiếp"). */
  contributionAfterDirect: Metric;
  /** after direct − shared allocated ("Kết quả vận hành toàn doanh nghiệp" for the scope). */
  operatingResult: Metric;
  /** cashIn − cashOut ("Dòng tiền thuần"). */
  netCashFlow: Metric;
}

const NON_AI_DIRECT = ["TOOL", "PRODUCTION", "ASSET", "OUTSOURCE", "FEE", "OTHER", "COORD"] as const;
const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function build(base: number | null, parts: { name: string; v: number | null | undefined; material: boolean }[]): Metric {
  const missing: string[] = [];
  let value: number | null = base;
  for (const p of parts) {
    if (!num(p.v)) { if (p.material) missing.push(p.name); continue; }
    if (value !== null) value -= p.v;
  }
  // Unknown NON-material parts do not make a result provisional by themselves, but base unknown makes the whole thing unknown.
  return { value: value === null ? null : round(value), provisional: missing.length > 0 || base === null, missing: base === null ? ["commission"] .concat(missing) : missing };
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function computeEconomics(i: EconomicsInput): EconomicsResult {
  const material = new Set<string>(i.material ?? ["AI"]);
  const c = i.costs;
  const nm = (k: string) => material.has(k);
  const confirmedMinusAds = build(i.confirmedCommission, [{ name: "ADS", v: c.ADS, material: nm("ADS") }]);
  const contributionBeforeAI = build(i.confirmedCommission, [
    { name: "ADS", v: c.ADS, material: nm("ADS") },
    ...NON_AI_DIRECT.map((k) => ({ name: k, v: c[k], material: nm(k) })),
  ]);
  const contributionAfterDirect = build(i.confirmedCommission, [
    { name: "AI", v: c.AI, material: nm("AI") },
    { name: "ADS", v: c.ADS, material: nm("ADS") },
    ...NON_AI_DIRECT.map((k) => ({ name: k, v: c[k], material: nm(k) })),
  ]);
  const operatingResult = build(contributionAfterDirect.value, [{ name: "SHARED", v: i.sharedAllocated, material: nm("SHARED") }]);
  operatingResult.provisional = operatingResult.provisional || contributionAfterDirect.provisional;
  operatingResult.missing = Array.from(new Set([...contributionAfterDirect.missing, ...operatingResult.missing]));
  const netCashFlow: Metric = num(i.cashIn) && num(i.cashOut) ? { value: round(i.cashIn - i.cashOut), provisional: false, missing: [] } : { value: null, provisional: true, missing: [num(i.cashIn) ? "" : "cashIn", num(i.cashOut) ? "" : "cashOut"].filter(Boolean) };
  return { currency: i.currency, confirmedMinusAds, contributionBeforeAI, contributionAfterDirect, operatingResult, netCashFlow };
}

// ───────────────────────── budget ledger arithmetic (the invariants the DB counters must keep)
export interface LedgerLine { entry_type: "CEILING" | "COMMIT" | "RELEASE" | "ACTUAL" | "ADJUST"; amount: number | null }
export interface BudgetView { ceiling: number | null; committed: number; actual: number; reserve: number; unknownCount: number; available: number | null }

/** Recomputes every counter from the ledger. The stored counters must always equal this (tested after random operation sequences). */
export function ledgerToBudget(lines: readonly LedgerLine[], reserve = 0): BudgetView {
  let ceiling: number | null = null, committed = 0, actual = 0, unknown = 0;
  for (const l of lines) {
    switch (l.entry_type) {
      case "CEILING": ceiling = l.amount; break;
      case "COMMIT": committed += l.amount ?? 0; break;
      case "RELEASE": committed -= l.amount ?? 0; break;
      case "ACTUAL": if (l.amount === null) unknown += 1; else actual += l.amount; break;
      case "ADJUST": actual += l.amount ?? 0; break;
    }
  }
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return { ceiling, committed: r(committed), actual: r(actual), reserve, unknownCount: unknown, available: ceiling === null ? null : r(ceiling - actual - committed - reserve) };
}
