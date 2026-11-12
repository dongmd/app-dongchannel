/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 7 — Money OS intake inside Dong-Lumi, on the existing opportunity tables and the existing pure policies (signal-policy, scoring-policy).
 *   MOS-04 mode 2: the owner pastes a signal in the app → normalised, de-duplicated by a deterministic key, stored as an UNVERIFIED signal (a signal is not a verified fact).
 *   MOS-05: a score 0..100 per dimension with the config version, every component and every penalty reason visible and reconciled to the total — never just one number.
 *   MOS-02: one signal may have several routes; an ACCEPTED route is a direction, never an approval to spend or publish.
 * The other eight intake modes need outside systems (Telegram bot, scheduled discovery, network connectors, web, site feedback) and are not connected here.
 */
import { LumiError, audit, requireRole, type Db } from "./core";
import { canonicalKeyFor, normalise, ROUTE_TYPES } from "../content/signal-policy";
import { ALL_DIMENSIONS, SCORING_CONFIG_V0, scoreOpportunity, type Dimension, type DimensionInput } from "../content/scoring-policy";

const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SIGNAL_KINDS = ["AFFILIATE_PROGRAM", "PRODUCT", "KEYWORD", "TREND", "CONTENT_GAP", "YOUTUBE_NICHE", "YOUTUBE_VIDEO", "COMPETITOR_SIGNAL", "OWNER_IDEA", "OTHER"] as const;
export { ROUTE_TYPES };

export async function submitSignal(db: Db, a: { actorRef: string; kind: string; title: string; summary?: string; url?: string; language?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  if (!(SIGNAL_KINDS as readonly string[]).includes(a.kind)) bad.push(`kind(${SIGNAL_KINDS.join("|")})`);
  if (typeof a.title !== "string" || a.title.trim().length < 3 || a.title.length > 300) bad.push("title(3..300)");
  if (a.summary !== undefined && a.summary.length > 4000) bad.push("summary(<=4000)");
  if (a.url !== undefined && !/^https?:\/\//.test(a.url)) bad.push("url(http/https)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  const key = canonicalKeyFor(a.kind, a.url ?? a.title);
  const n = normalise({ canonicalKey: key, kind: a.kind, originMode: "OWNER_APP", title: a.title });
  if (!n.ok) throw new LumiError("VALIDATION_ERROR", 400, { errors: [n.reason] });
  return db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`signal:${key}`]);
    const [orig] = await t.query<any>(`SELECT id,title,status FROM opportunity_signals WHERE canonical_key=$1 ORDER BY created_at LIMIT 1`, [key]);
    if (orig) { await audit(t, "opportunity.signal_duplicate", a.actorRef, { originalId: orig.id }, a.now); return { signal: null as any, duplicate: true, original: orig }; } // the same observation collapses: it is not stored or scored twice
    const [s] = await t.query<any>(
      `INSERT INTO opportunity_signals(canonical_key,kind,origin_mode,owner_seed_text,title,summary,language,status,confidence,discovered_at,metadata,created_at,updated_at,captured_by)
       VALUES ($1,$2::signal_kind,'OWNER_APP'::signal_origin_mode,$3,$4,$5,$6,'NEW'::signal_status,'UNKNOWN'::signal_confidence,$7,$8::jsonb,$7,$7,$9) RETURNING id,title,status`,
      [key, a.kind, [a.title, a.url].filter(Boolean).join(" | "), n.signal.title, a.summary ?? null, a.language ?? null, iso(a.now), JSON.stringify({ url: a.url ?? null, submitted_by: a.actorRef }), a.actorRef]);
    await audit(t, "opportunity.signal_submitted", a.actorRef, { signalId: s.id }, a.now);
    return { signal: s, duplicate: false, original: null };
  });
}

export async function scoreSignal(db: Db, a: { actorRef: string; signalId: string; values: Record<string, DimensionInput>; penaltyReasons?: Record<string, string>; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (!UUID.test(a.signalId)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["signal_id(uuid)"] });
  for (const k of Object.keys(a.values ?? {})) if (!(ALL_DIMENSIONS as readonly string[]).includes(k)) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`dimension(${k})`] });
  const r = scoreOpportunity({ values: a.values as Partial<Record<Dimension, DimensionInput>>, penaltyReasons: a.penaltyReasons as any }, SCORING_CONFIG_V0);
  if (!r.ok) throw new LumiError("VALIDATION_ERROR", 400, { errors: [r.reason] });
  if (!r.breakdown.reconciles) throw new LumiError("INTERNAL", 500, { reason: "score does not reconcile" });
  return db.tx(async (t) => {
    const [s] = await t.query<any>(`SELECT id FROM opportunity_signals WHERE id=$1 FOR UPDATE`, [a.signalId]);
    if (!s) throw new LumiError("NOT_FOUND", 404);
    await t.query(`INSERT INTO lumi_signal_scores(signal_id,config_version,score,breakdown,scored_by,scored_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`, [s.id, r.breakdown.configVersion, r.breakdown.normalisedScore, JSON.stringify(r.breakdown), a.actorRef, iso(a.now)]);
    const hist = await t.query<any>(`SELECT config_version AS version, score::float AS score, scored_at AS at, scored_by AS by FROM lumi_signal_scores WHERE signal_id=$1 ORDER BY scored_at`, [s.id]);
    await audit(t, "opportunity.scored", a.actorRef, { signalId: s.id, score: r.breakdown.normalisedScore }, a.now);
    return { breakdown: r.breakdown, history: hist };
  });
}

export async function proposeRoute(db: Db, a: { actorRef: string; signalId: string; routeType: string; reason: string; fitScore?: number; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (!(ROUTE_TYPES as readonly string[]).includes(a.routeType)) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`route_type(${ROUTE_TYPES.join("|")})`] });
  if (typeof a.reason !== "string" || a.reason.trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  if (a.fitScore !== undefined && !(a.fitScore >= 0 && a.fitScore <= 100)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["fit_score(0..100)"] });
  const [s] = await db.query<any>(`SELECT id,status FROM opportunity_signals WHERE id=$1`, [a.signalId]);
  if (!s) throw new LumiError("NOT_FOUND", 404);
  if (s.status === "DISCARDED") throw new LumiError("INVALID_TRANSITION", 409, { from: s.status });
  const [exists] = await db.query<any>(`SELECT id,status FROM opportunity_routes WHERE signal_id=$1 AND route_type=$2::route_type`, [s.id, a.routeType]);
  if (exists) throw new LumiError("INVALID_TRANSITION", 409, { reason: "Tuyến này đã có cho tín hiệu", status: exists.status });
  const [r] = await db.query<any>(`INSERT INTO opportunity_routes(signal_id,route_type,fit_score,reason,status,created_at,updated_at) VALUES ($1,$2::route_type,$3,$4,'PROPOSED'::route_status,$5,$5) RETURNING *`, [s.id, a.routeType, a.fitScore ?? null, a.reason.trim(), iso(a.now)]);
  return { route: r };
}
export async function decideRoute(db: Db, a: { actorRef: string; routeId: string; decision: "ACCEPT" | "REJECT"; notes?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (a.decision === "REJECT" && (a.notes ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["notes(>=3)"] });
  return db.tx(async (t) => {
    const [r] = await t.query<any>(`SELECT * FROM opportunity_routes WHERE id=$1 FOR UPDATE`, [a.routeId]);
    if (!r) throw new LumiError("NOT_FOUND", 404);
    if (r.status !== "PROPOSED") throw new LumiError("INVALID_TRANSITION", 409, { from: r.status });
    const [u] = await t.query<any>(`UPDATE opportunity_routes SET status=$2::route_status,decided_by=$3,decided_at=$4,notes=$5,updated_at=$4 WHERE id=$1 RETURNING *`, [r.id, a.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED", a.actorRef, iso(a.now), a.notes ?? null]);
    if (a.decision === "ACCEPT") await t.query(`UPDATE opportunity_signals SET status='ROUTED',updated_at=$2 WHERE id=$1 AND status='NEW'`, [r.signal_id, iso(a.now)]);
    return { route: u, note: "Chấp nhận tuyến là chọn hướng đi, KHÔNG phải phê duyệt chi tiền hay xuất bản." };
  });
}
export async function listSignals(db: Db) {
  const sigs = await db.query<any>(`SELECT id,canonical_key,kind,origin_mode,title,summary,status,confidence,discovered_at,metadata FROM opportunity_signals WHERE origin_mode='OWNER_APP' ORDER BY discovered_at DESC LIMIT 200`);
  const ids = sigs.map((s: any) => s.id);
  const routes = await db.query<any>(`SELECT id,signal_id,route_type,fit_score,reason,status,decided_by,notes FROM opportunity_routes WHERE signal_id = ANY($1::uuid[])`, [ids]);
  const scores = await db.query<any>(`SELECT DISTINCT ON (signal_id) signal_id, config_version, score::float AS score, breakdown, scored_at, (SELECT count(*)::int FROM lumi_signal_scores x WHERE x.signal_id=lumi_signal_scores.signal_id) AS n FROM lumi_signal_scores WHERE signal_id = ANY($1::uuid[]) ORDER BY signal_id, scored_at DESC`, [ids]);
  return {
    signals: sigs.map((s: any) => { const sc = scores.find((x: any) => x.signal_id === s.id); return { ...s, overall_score: sc?.score ?? null, scoring_version: sc?.config_version ?? null, score_breakdown: sc?.breakdown ?? null, score_count: sc?.n ?? 0, routes: routes.filter((r: any) => r.signal_id === s.id) }; }),
    dimensions: ALL_DIMENSIONS, config_version: SCORING_CONFIG_V0.version,
    note: "Tín hiệu chỉ là gợi ý chưa xác minh (độ tin cậy «chưa rõ»), không phải sự thật. Điểm luôn kèm từng thành phần và phiên bản chấm, mỗi lần chấm lại được giữ; thiếu dữ liệu ghi «chưa biết», không tính 0. Chỉ nhập tay trong ứng dụng; 8 chế độ vào còn lại cần hệ thống ngoài chưa kết nối.",
  };
}
