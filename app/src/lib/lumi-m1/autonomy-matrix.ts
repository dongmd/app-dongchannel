/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 7 — APR-07: the autonomy matrix is CONFIGURATION, set by the owner, with history. Three modes per action type:
 *   AUTO  — the assistant may do it without asking (only for types that spend nothing and publish nothing),
 *   GRANT — needs an owner grant / approval (the existing grant + request flow decides),
 *   OFF   — never.
 * Types that spend money, publish, or are destructive can never be AUTO. The matrix never creates a permission by itself: AUTO still passes through the stop switches and is logged.
 */
import { LumiError, audit, requireRole, type Db } from "./core";

const iso = (d: Date) => d.toISOString();

export const ACTION_TYPES: Record<string, { label: string; risky: boolean; def: "AUTO" | "GRANT" }> = {
  research: { label: "Khám phá / nghiên cứu", risky: false, def: "AUTO" },
  verify_evidence: { label: "Kiểm lại bằng chứng", risky: false, def: "AUTO" },
  create_opportunity: { label: "Tạo cơ hội (đề xuất)", risky: false, def: "AUTO" },
  draft_content: { label: "Soạn nội dung / kịch bản (bản nháp)", risky: false, def: "AUTO" },
  draft_ads: { label: "Tạo bản nháp Google Ads (chưa chạy)", risky: false, def: "AUTO" },
  start_paid_campaign: { label: "Bắt đầu chiến dịch trả phí", risky: true, def: "GRANT" },
  raise_budget: { label: "Tăng ngân sách", risky: true, def: "GRANT" },
  publish_wordpress: { label: "Xuất bản WordPress", risky: true, def: "GRANT" },
  post_youtube: { label: "Đăng YouTube", risky: true, def: "GRANT" },
  destructive_admin: { label: "Thao tác quản trị phá hủy", risky: true, def: "GRANT" },
};

export async function effectiveMode(db: Db, actionType: string): Promise<{ mode: "AUTO" | "GRANT" | "OFF"; known: boolean }> {
  const meta = ACTION_TYPES[actionType];
  const [r] = await db.query<any>(`SELECT mode FROM lumi_autonomy_rules WHERE action_type=$1 ORDER BY set_at DESC, id DESC LIMIT 1`, [actionType]);
  // unknown action types are never auto: they need a grant, as before this matrix existed
  if (!meta) return { mode: r?.mode === "OFF" ? "OFF" : "GRANT", known: false };
  const mode = (r?.mode ?? meta.def) as "AUTO" | "GRANT" | "OFF";
  return { mode: meta.risky && mode === "AUTO" ? "GRANT" : mode, known: true };
}

export async function setAutonomyRule(db: Db, a: { actorRef: string; actionType: string; mode: string; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const meta = ACTION_TYPES[a.actionType];
  if (!meta) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`action_type(${Object.keys(ACTION_TYPES).join("|")})`] });
  if (!["AUTO", "GRANT", "OFF"].includes(a.mode)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["mode(AUTO|GRANT|OFF)"] });
  if (a.mode === "AUTO" && meta.risky) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`${a.actionType}: loại này chi tiền/xuất bản/phá hủy nên không bao giờ được đặt «tự động»`] });
  const [r] = await db.query<any>(`INSERT INTO lumi_autonomy_rules(action_type,mode,set_by,note,set_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [a.actionType, a.mode, a.actorRef, a.note ?? null, iso(a.now)]);
  await audit(db, "autonomy.rule", a.actorRef, { actionType: a.actionType, mode: a.mode }, a.now);
  return { rule: r };
}

export async function listAutonomyMatrix(db: Db) {
  const rules = await db.query<any>(`SELECT action_type,mode,set_by,note,set_at FROM lumi_autonomy_rules ORDER BY set_at DESC, id DESC`);
  const out: any[] = [];
  for (const [type, meta] of Object.entries(ACTION_TYPES)) {
    const hist = rules.filter((r: any) => r.action_type === type);
    const eff = await effectiveMode(db, type);
    out.push({ action_type: type, label: meta.label, risky: meta.risky, default_mode: meta.def, mode: eff.mode, is_default: hist.length === 0, set_by: hist[0]?.set_by ?? null, set_at: hist[0]?.set_at ?? null, history: hist.slice(0, 5) });
  }
  return { matrix: out, note: "Ma trận chỉ quyết định bot có cần xin hay không; nó không tự cấp quyền hay ngân sách. Loại chi tiền/xuất bản/phá hủy luôn cần giấy ủy quyền hoặc duyệt từng lần. Mọi quyết định (kể cả tự động) được ghi vào nhật ký hành động." };
}
