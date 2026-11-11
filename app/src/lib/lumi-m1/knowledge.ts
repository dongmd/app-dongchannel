/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * IMP-04 knowledge base (KNW-01..07, 09, 11..14; CMP-01; PLN-11 partly). Model: SOURCE (immutable) → NOTE → DECISION (says why) → RULE (what to do).
 * Every item has a scope (company / area / project / personal), versions, who changed it and through which channel. A bot can only PROPOSE
 * (never activate); only the OWNER approves. Rules are INSTRUCTIONS: approving one changes what a bot is told, never what it may do or spend.
 */
import { audit, LumiError, requireRole, type Db } from "./core";
import { uniqueViolation } from "./assistants";
import { normalizeText, READABLE_SQL } from "./knowledge-pack";

const iso = (d: Date) => d.toISOString();
export const KINDS = ["NOTE", "DECISION", "RULE"] as const;
export const SCOPES = ["COMPANY", "AREA", "PROJECT", "PERSONAL"] as const;
export const AREAS = ["AFFILIATE", "YOUTUBE", "WEBSITE", "OTHER"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Title and body are normalised separately and joined by a newline, so the title can be compared on its own (same-title conflicts). */
const searchTextOf = (title: string, content: string) => normalizeText(title) + "\n" + normalizeText(content);

export interface SourceInput { sourceId?: string; title?: string; kind?: "URL" | "DOCUMENT" | "NOTE" | "MANUAL" | "BOT_CITED"; ref?: string; content?: string; supports?: string }
export interface ProposeInput {
  actorRef: string; assistantId?: string; kind: (typeof KINDS)[number]; scope: (typeof SCOPES)[number]; scopeRef?: string; title: string; content: string;
  reason?: string; confidence?: "LOW" | "MEDIUM" | "HIGH"; manualEntry?: boolean; sources?: SourceInput[]; supersedesItemId?: string; sharedWith?: string[];
  effectiveUntil?: Date; channel?: string; now: Date;
}

// ───────────────────────── sources (immutable)
export async function createSource(db: Db, a: { actorRef: string; title: string; kind: SourceInput["kind"]; ref?: string; content?: string; capturedAt?: Date; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  return db.tx((t) => insertSource(t, a.actorRef, { title: a.title, kind: a.kind ?? "NOTE", ref: a.ref, content: a.content }, a.now, a.capturedAt));
}
async function insertSource(t: Db, actorRef: string, s: SourceInput, now: Date, capturedAt?: Date) {
  const bad: string[] = [];
  if (typeof s.title !== "string" || s.title.trim().length < 3 || s.title.length > 200) bad.push("source.title(3..200)");
  if (!["URL", "DOCUMENT", "NOTE", "MANUAL", "BOT_CITED"].includes(s.kind ?? "")) bad.push("source.kind");
  if (s.ref !== undefined && s.ref.length > 1000) bad.push("source.ref(<=1000)");
  if (s.content !== undefined && s.content.length > 20000) bad.push("source.content(<=20000)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  const [r] = await t.query<any>(
    `INSERT INTO lumi_knowledge_sources(code,title,kind,ref,content,captured_at,created_by,created_at) VALUES ('SRC-'||lpad(nextval('lumi_ksrc_code_seq')::text,3,'0'),$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [s.title!.trim(), s.kind, s.ref ?? null, s.content ?? null, iso(capturedAt ?? now), actorRef, iso(now)]);
  return r;
}

// ───────────────────────── scope rules
async function validateScope(t: Db, i: { scope: string; scopeRef?: string }) {
  if (!SCOPES.includes(i.scope as any)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["scope"] });
  if (i.scope === "COMPANY") { if (i.scopeRef) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["scope_ref(không dùng với phạm vi công ty)"] }); return null; }
  if (i.scope === "PERSONAL") return "owner";
  if (i.scope === "AREA") { if (!AREAS.includes(i.scopeRef as any)) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`scope_ref(mảng: ${AREAS.join("/")})`] }); return i.scopeRef!; }
  if (!i.scopeRef || !UUID.test(i.scopeRef) || !(await t.query(`SELECT 1 FROM lumi_projects WHERE id=$1 AND status='ACTIVE'`, [i.scopeRef])).length) throw new LumiError("NOT_FOUND", 404, { what: "project" });
  return i.scopeRef;
}
/** A bot may only propose inside what it can read: a project it belongs to, or that project's area. Company and personal knowledge are the owner's. */
async function botMayPropose(t: Db, assistantId: string, scope: string, scopeRef: string | null): Promise<boolean> {
  if (scope === "PROJECT") return (await t.query(`SELECT 1 FROM lumi_project_members WHERE assistant_id=$1 AND project_id=$2`, [assistantId, scopeRef])).length > 0;
  if (scope === "AREA") return (await t.query(`SELECT 1 FROM lumi_project_members m JOIN lumi_projects p ON p.id=m.project_id WHERE m.assistant_id=$1 AND p.area=$2`, [assistantId, scopeRef])).length > 0;
  return false;
}

async function attachSources(t: Db, actorRef: string, itemId: string, version: number, sources: SourceInput[] | undefined, now: Date, isBot: boolean) {
  let n = 0;
  for (const s of sources ?? []) {
    let id = s.sourceId;
    if (id) { if (!UUID.test(id) || !(await t.query(`SELECT 1 FROM lumi_knowledge_sources WHERE id=$1`, [id])).length) throw new LumiError("NOT_FOUND", 404, { what: "source" }); }
    else id = (await insertSource(t, actorRef, { ...s, kind: isBot ? "BOT_CITED" : s.kind ?? "NOTE" }, now)).id; // a source a bot cites is labelled as such: it is NOT verified
    await t.query(`INSERT INTO lumi_knowledge_links(item_id,version,source_id,supports) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [itemId, version, id, s.supports?.slice(0, 500) ?? null]);
    n += 1;
  }
  return n;
}

/** KNW-04: a proposal needs a source or a stated reason, or is marked manual entry. A DECISION needs both a reason and a source/evidence (KNW-01). */
export function supportGap(kind: string, v: { reason: string | null; manual_entry: boolean }, links: number): string | null {
  const reason = (v.reason ?? "").trim().length >= 10;
  if (kind === "DECISION") { if (!reason) return "Quyết định phải ghi lý do (≥ 10 ký tự)."; if (links < 1 && !v.manual_entry) return "Quyết định phải có ít nhất một nguồn/bằng chứng (hoặc đánh dấu nhập tay)."; return null; }
  if (links < 1 && !reason && !v.manual_entry) return "Chưa có nguồn hoặc lý do xác định (hoặc đánh dấu nhập tay): không thể duyệt.";
  return null;
}

// ───────────────────────── propose / revise
export async function proposeKnowledge(db: Db, i: ProposeInput) {
  const isBot = i.actorRef.startsWith("bot:");
  if (!isBot) await requireRole(db, i.actorRef, ["OWNER", "ADMIN"]);
  else if (!i.assistantId) throw new LumiError("FORBIDDEN", 403);
  const bad: string[] = [];
  if (!KINDS.includes(i.kind)) bad.push("kind(NOTE|DECISION|RULE)");
  if (typeof i.title !== "string" || i.title.trim().length < 3 || i.title.length > 200) bad.push("title(3..200)");
  if (typeof i.content !== "string" || i.content.trim().length < 3 || i.content.length > 8000) bad.push("content(3..8000)");
  if (i.reason !== undefined && i.reason.length > 2000) bad.push("reason(<=2000)");
  if (i.confidence !== undefined && !["LOW", "MEDIUM", "HIGH"].includes(i.confidence)) bad.push("confidence");
  if (isBot && i.manualEntry) bad.push("manual_entry(chỉ người nhập tay)");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  try {
    return await db.tx(async (t) => {
      const scopeRef = await validateScope(t, i);
      await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`kn-propose:${i.actorRef}:${i.scope}:${i.scopeRef ?? ""}:${i.kind}:${normalizeText(i.title ?? "")}`]); // the same proposal sent at once is ONE proposal
      if (isBot) {
        if (!(await botMayPropose(t, i.assistantId!, i.scope, scopeRef))) throw new LumiError("FORBIDDEN", 403, { reason: "scope" });
        if (!(i.sources?.length) && (i.reason ?? "").trim().length < 10) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["sources|reason(cần ít nhất một nguồn hoặc lý do ≥ 10 ký tự)"] });
      }
      let sup: any = null;
      if (i.supersedesItemId) {
        [sup] = await t.query<any>(`SELECT * FROM lumi_knowledge_items WHERE id=$1 FOR UPDATE`, [i.supersedesItemId]);
        if (!sup) throw new LumiError("NOT_FOUND", 404, { what: "supersedes" });
        if (sup.status !== "ACTIVE" || sup.scope !== i.scope || (sup.scope_ref ?? null) !== (scopeRef ?? null)) throw new LumiError("SUPERSEDE_INVALID", 409, { status: sup.status });
      }
      // the same proposal sent again (retry, paraphrase-free duplicate) is one proposal
      const dup = await t.query<any>(
        `SELECT i.*, v.search_text FROM lumi_knowledge_items i JOIN lumi_knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version
          WHERE i.proposed_by=$1 AND i.status='PROPOSED' AND i.scope=$2 AND coalesce(i.scope_ref,'')=coalesce($3,'') AND i.kind=$4`, [i.actorRef, i.scope, scopeRef, i.kind]);
      const same = dup.find((d: any) => d.search_text === searchTextOf(i.title, i.content));
      if (same) return { item: same, version: same.current_version, warnings: [] as string[], alreadyProcessed: true as const };
      const warnings: string[] = [];
      const rej = await t.query<any>(
        `SELECT v.decided_at, v.decision_reason, i.code FROM lumi_knowledge_versions v JOIN lumi_knowledge_items i ON i.id=v.item_id
          WHERE v.state='REJECTED' AND i.scope=$1 AND coalesce(i.scope_ref,'')=coalesce($2,'') AND v.search_text=$3 ORDER BY v.decided_at DESC LIMIT 1`, [i.scope, scopeRef, searchTextOf(i.title, i.content)]);
      if (rej[0]) warnings.push(`Đề xuất này trùng nội dung với ${rej[0].code} đã bị từ chối ngày ${new Date(rej[0].decided_at).toISOString().slice(0, 10)}: ${rej[0].decision_reason}`);
      const [item] = await t.query<any>(
        `INSERT INTO lumi_knowledge_items(code,kind,scope,scope_ref,status,current_version,supersedes_item_id,shared_with,proposed_by,created_at,updated_at) VALUES ('KN-'||lpad(nextval('lumi_kn_code_seq')::text,3,'0'),$1,$2,$3,'PROPOSED',1,$4,$5::jsonb,$6,$7,$7) RETURNING *`,
        [i.kind, i.scope, scopeRef, sup?.id ?? null, JSON.stringify(i.scope === "PERSONAL" ? (i.sharedWith ?? []) : []), i.actorRef, iso(i.now)]);
      await t.query(
        `INSERT INTO lumi_knowledge_versions(item_id,version,title,content,reason,confidence,manual_entry,search_text,effective_until,created_by,channel,created_at) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [item.id, i.title.trim(), i.content.trim(), i.reason?.trim() ?? null, i.confidence ?? null, i.manualEntry === true, searchTextOf(i.title, i.content), i.effectiveUntil ? iso(i.effectiveUntil) : null, i.actorRef, i.channel ?? (isBot ? "BOT" : "WEB"), iso(i.now)]);
      const links = await attachSources(t, i.actorRef, item.id, 1, i.sources, i.now, isBot);
      const gap = supportGap(i.kind, { reason: i.reason ?? null, manual_entry: i.manualEntry === true }, links);
      if (gap) warnings.push(gap);
      await audit(t, "knowledge.proposed", i.actorRef, { itemId: item.id, code: item.code, scope: i.scope, kind: i.kind }, i.now);
      return { item, version: 1, warnings, alreadyProcessed: false as const };
    });
  } catch (e) { throw uniqueViolation(e, []) ?? e; }
}

export async function reviseKnowledge(db: Db, a: { actorRef: string; assistantId?: string; itemId: string; title?: string; content?: string; reason?: string; confidence?: "LOW" | "MEDIUM" | "HIGH"; sources?: SourceInput[]; effectiveUntil?: Date | null; fromVersion?: number; now: Date }) {
  const isBot = a.actorRef.startsWith("bot:");
  if (!isBot) await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  return db.tx(async (t) => {
    const [it] = await t.query<any>(`SELECT * FROM lumi_knowledge_items WHERE id=$1 FOR UPDATE`, [a.itemId]);
    if (!it) throw new LumiError("NOT_FOUND", 404);
    if (it.status === "ARCHIVED" || it.status === "SUPERSEDED") throw new LumiError("INVALID_TRANSITION", 409, { status: it.status });
    if (isBot && !(it.proposed_by === a.actorRef && it.status === "PROPOSED")) throw new LumiError("FORBIDDEN", 403); // a bot edits only its OWN pending proposal
    const base = (await t.query<any>(`SELECT * FROM lumi_knowledge_versions WHERE item_id=$1 AND version=$2`, [a.itemId, a.fromVersion ?? it.current_version]))[0];
    if (!base) throw new LumiError("NOT_FOUND", 404, { what: "version" });
    const title = (a.title ?? base.title).trim(); const content = (a.content ?? base.content).trim();
    if (title.length < 3 || title.length > 200 || content.length < 3 || content.length > 8000) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["title(3..200)|content(3..8000)"] });
    const next = it.current_version + 1;
    // an older pending proposal is replaced by this one (its text stays in the history)
    await t.query(`UPDATE lumi_knowledge_versions SET state='SUPERSEDED' WHERE item_id=$1 AND state='PROPOSED'`, [a.itemId]);
    await t.query(
      `INSERT INTO lumi_knowledge_versions(item_id,version,title,content,reason,confidence,manual_entry,search_text,effective_until,created_by,channel,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [a.itemId, next, title, content, a.reason !== undefined ? a.reason.trim() : base.reason, a.confidence ?? base.confidence, !isBot && base.manual_entry, searchTextOf(title, content),
        a.effectiveUntil === null ? null : a.effectiveUntil ? iso(a.effectiveUntil) : base.effective_until, a.actorRef, isBot ? "BOT" : "WEB", iso(a.now)]);
    if (a.sources?.length) await attachSources(t, a.actorRef, a.itemId, next, a.sources, a.now, isBot);
    else await t.query(`INSERT INTO lumi_knowledge_links(item_id,version,source_id,supports) SELECT item_id,$3,source_id,supports FROM lumi_knowledge_links WHERE item_id=$1 AND version=$2`, [a.itemId, base.version, next]);
    await t.query(`UPDATE lumi_knowledge_items SET current_version=$2,status=CASE WHEN approved_version IS NULL THEN 'PROPOSED' ELSE status END,updated_at=$3 WHERE id=$1`, [a.itemId, next, iso(a.now)]);
    await audit(t, "knowledge.revised", a.actorRef, { itemId: a.itemId, version: next, from: base.version }, a.now);
    return { itemId: a.itemId, version: next };
  });
}

/** Restoring an old version creates a NEW version (it still needs approval); nothing is overwritten. */
export async function restoreKnowledgeVersion(db: Db, a: { actorRef: string; itemId: string; version: number; now: Date }) {
  return reviseKnowledge(db, { actorRef: a.actorRef, itemId: a.itemId, fromVersion: a.version, now: a.now });
}

// ───────────────────────── owner decisions
export async function decideKnowledge(db: Db, a: { actorRef: string; itemId: string; version: number; decision: "APPROVE" | "REJECT"; reason?: string; supersedeItemId?: string; edit?: { title?: string; content?: string }; unsupported?: string[]; channel?: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (a.decision === "REJECT" && (a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3 ký tự)"] });
  return db.tx(async (t) => {
    const [it] = await t.query<any>(`SELECT * FROM lumi_knowledge_items WHERE id=$1 FOR UPDATE`, [a.itemId]);
    if (!it) throw new LumiError("NOT_FOUND", 404);
    // two items of the same title and scope approved at the same moment must not both become ACTIVE: approvals are serialized per (scope, ref, kind, title)
    const [ttl] = await t.query<any>(`SELECT v.title FROM lumi_knowledge_versions v WHERE v.item_id=$1 AND v.version=$2`, [a.itemId, a.version]);
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`kn-approve:${it.scope}:${it.scope_ref ?? ""}:${it.kind}:${normalizeText(ttl?.title ?? "")}`]);
    let [v] = await t.query<any>(`SELECT * FROM lumi_knowledge_versions WHERE item_id=$1 AND version=$2 FOR UPDATE`, [a.itemId, a.version]);
    if (!v) throw new LumiError("NOT_FOUND", 404, { what: "version" });
    const target = a.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (v.state === target) return { item: it, alreadyProcessed: true as const };
    if (v.state !== "PROPOSED" || a.version !== it.current_version) throw new LumiError("STALE_VERSION", 409, { state: v.state, current: it.current_version });
    if (it.status === "ARCHIVED") throw new LumiError("INVALID_TRANSITION", 409, { status: it.status });
    const reasonOf = (x: any) => ({ reason: x.reason as string | null, manual_entry: x.manual_entry as boolean });
    if (a.decision === "REJECT") {
      await t.query(`UPDATE lumi_knowledge_versions SET state='REJECTED',decided_by=$3,decided_at=$4,decision_reason=$5 WHERE item_id=$1 AND version=$2`, [a.itemId, a.version, a.actorRef, iso(a.now), a.reason!.trim()]);
      await t.query(`UPDATE lumi_knowledge_items SET status=CASE WHEN approved_version IS NULL THEN 'REJECTED' ELSE status END,updated_at=$2 WHERE id=$1`, [a.itemId, iso(a.now)]);
      await audit(t, "knowledge.rejected", a.actorRef, { itemId: a.itemId, version: a.version }, a.now);
      return { item: (await t.query<any>(`SELECT * FROM lumi_knowledge_items WHERE id=$1`, [a.itemId]))[0], alreadyProcessed: false as const };
    }
    // APPROVE. The owner may edit first: the original proposal stays in the history and the edited text becomes the approved version.
    let version = a.version;
    if (a.edit && (a.edit.title !== undefined || a.edit.content !== undefined)) {
      const title = (a.edit.title ?? v.title).trim(); const content = (a.edit.content ?? v.content).trim();
      if (title.length < 3 || content.length < 3 || content.length > 8000) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["edit"] });
      version = it.current_version + 1;
      await t.query(`UPDATE lumi_knowledge_versions SET state='SUPERSEDED' WHERE item_id=$1 AND version=$2`, [a.itemId, a.version]);
      await t.query(
        `INSERT INTO lumi_knowledge_versions(item_id,version,title,content,reason,confidence,manual_entry,search_text,effective_until,created_by,channel,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [a.itemId, version, title, content, v.reason, v.confidence, v.manual_entry, searchTextOf(title, content), v.effective_until, a.actorRef, a.channel ?? "WEB", iso(a.now)]);
      await t.query(`INSERT INTO lumi_knowledge_links(item_id,version,source_id,supports) SELECT item_id,$3,source_id,supports FROM lumi_knowledge_links WHERE item_id=$1 AND version=$2`, [a.itemId, a.version, version]);
      await t.query(`UPDATE lumi_knowledge_items SET current_version=$2 WHERE id=$1`, [a.itemId, version]);
      [v] = await t.query<any>(`SELECT * FROM lumi_knowledge_versions WHERE item_id=$1 AND version=$2`, [a.itemId, version]);
    }
    const [{ n }] = await t.query<any>(`SELECT count(*)::int AS n FROM lumi_knowledge_links WHERE item_id=$1 AND version=$2`, [a.itemId, version]);
    const gap = supportGap(it.kind, reasonOf(v), n);
    if (gap) throw new LumiError("NEEDS_SUPPORT", 422, { message: gap });
    // a new item must not silently contradict an ACTIVE one of the same title and scope: the owner replaces it explicitly
    const supId = a.supersedeItemId ?? it.supersedes_item_id ?? null;
    const clash = await t.query<any>(
      `SELECT i.id,i.code FROM lumi_knowledge_items i JOIN lumi_knowledge_versions cv ON cv.item_id=i.id AND cv.version=i.approved_version
        WHERE i.status='ACTIVE' AND i.id<>$1 AND i.scope=$2 AND coalesce(i.scope_ref,'')=coalesce($3,'') AND i.kind=$4 AND split_part(cv.search_text, chr(10), 1) = $5`, [it.id, it.scope, it.scope_ref, it.kind, normalizeText(v.title)]);
    const unresolved = clash.filter((c: any) => c.id !== supId);
    if (unresolved.length && !it.approved_version) throw new LumiError("CONFLICT_ACTIVE", 409, { items: unresolved.map((c: any) => c.code) });
    if (supId) {
      const [old] = await t.query<any>(`SELECT * FROM lumi_knowledge_items WHERE id=$1 FOR UPDATE`, [supId]);
      if (!old || old.id === it.id || old.status !== "ACTIVE" || old.scope !== it.scope || (old.scope_ref ?? null) !== (it.scope_ref ?? null)) throw new LumiError("SUPERSEDE_INVALID", 409, { status: old?.status ?? null });
      await t.query(`UPDATE lumi_knowledge_items SET status='SUPERSEDED',updated_at=$2 WHERE id=$1`, [old.id, iso(a.now)]);
      await t.query(`UPDATE lumi_knowledge_items SET supersedes_item_id=$2 WHERE id=$1`, [it.id, old.id]);
    }
    if (it.approved_version) await t.query(`UPDATE lumi_knowledge_versions SET state='SUPERSEDED' WHERE item_id=$1 AND version=$2 AND state='APPROVED'`, [it.id, it.approved_version]);
    await t.query(`UPDATE lumi_knowledge_versions SET state='APPROVED',decided_by=$3,decided_at=$4,unsupported=$5::jsonb WHERE item_id=$1 AND version=$2`, [it.id, version, a.actorRef, iso(a.now), JSON.stringify(a.unsupported ?? [])]);
    await t.query(`UPDATE lumi_knowledge_items SET status='ACTIVE',approved_version=$2,updated_at=$3 WHERE id=$1`, [it.id, version, iso(a.now)]);
    await audit(t, "knowledge.approved", a.actorRef, { itemId: it.id, version, supersedes: supId }, a.now);
    return { item: (await t.query<any>(`SELECT * FROM lumi_knowledge_items WHERE id=$1`, [it.id]))[0], alreadyProcessed: false as const };
  });
}

export async function archiveKnowledge(db: Db, a: { actorRef: string; itemId: string; reason: string; now: Date }) {
  if (a.actorRef.startsWith("bot:")) throw new LumiError("FORBIDDEN", 403);
  await requireRole(db, a.actorRef, ["OWNER"]);
  if ((a.reason ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason"] });
  return db.tx(async (t) => {
    const [it] = await t.query<any>(`SELECT * FROM lumi_knowledge_items WHERE id=$1 FOR UPDATE`, [a.itemId]);
    if (!it) throw new LumiError("NOT_FOUND", 404);
    if (it.status === "ARCHIVED") return { alreadyProcessed: true as const };
    await t.query(`UPDATE lumi_knowledge_items SET status='ARCHIVED',archived_by=$2,archived_at=$3,updated_at=$3 WHERE id=$1`, [a.itemId, a.actorRef, iso(a.now)]);
    await audit(t, "knowledge.archived", a.actorRef, { itemId: a.itemId, reason: a.reason }, a.now);
    return { alreadyProcessed: false as const };
  });
}

// ───────────────────────── read side
export type Viewer = { kind: "user"; role: string } | { kind: "bot"; assistantId: string };

/** KNW-06: keyword search with accent folding; bots see only what they may read and only ACTIVE items; every bot read is logged. */
export async function searchKnowledge(db: Db, o: { viewer: Viewer; q?: string; scope?: string; projectId?: string; kind?: string; status?: string; limit?: number; now: Date }) {
  const params: any[] = []; const where: string[] = [];
  const p = (v: any) => { params.push(v); return `$${params.length}`; };
  const bot = o.viewer.kind === "bot";
  if (bot) { where.push(`i.status='ACTIVE'`); where.push(READABLE_SQL(p((o.viewer as any).assistantId), null)); }
  else if (o.status) where.push(`i.status=${p(o.status)}`);
  if (o.scope) where.push(`i.scope=${p(o.scope)}`);
  if (o.kind) where.push(`i.kind=${p(o.kind)}`);
  if (o.projectId) where.push(`(i.scope='PROJECT' AND i.scope_ref=${p(o.projectId)})`);
  for (const term of normalizeText(o.q ?? "").split(" ").filter(Boolean).slice(0, 8)) where.push(`v.search_text LIKE '%' || ${p(term.replace(/[%_\\]/g, "\\$&"))} || '%'`);
  const rows = await db.query<any>(
    `SELECT i.id,i.code,i.kind,i.scope,i.scope_ref,i.status,i.current_version,i.approved_version,i.proposed_by,i.updated_at,v.title,v.content,v.reason,v.confidence,v.state AS version_state,v.version,
            (SELECT coalesce(json_agg(json_build_object('code',s.code,'title',s.title,'kind',s.kind,'ref',s.ref) ORDER BY s.code),'[]'::json) FROM lumi_knowledge_links l JOIN lumi_knowledge_sources s ON s.id=l.source_id WHERE l.item_id=i.id AND l.version=v.version) AS sources,
            (SELECT count(DISTINCT r.task_id)::int FROM lumi_run_knowledge rk JOIN lumi_task_runs r ON r.id=rk.run_id WHERE rk.item_id=i.id) AS tasks_used
       FROM lumi_knowledge_items i JOIN lumi_knowledge_versions v ON v.item_id=i.id AND v.version=${bot ? "i.approved_version" : "coalesce(i.approved_version,i.current_version)"}
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.updated_at DESC LIMIT ${Math.min(o.limit ?? 50, 100)}`, params);
  if (bot) for (const r of rows) await db.query(`INSERT INTO lumi_knowledge_reads(assistant_id,item_id,version,via,at) VALUES ($1,$2,$3,'SEARCH',$4)`, [(o.viewer as any).assistantId, r.id, r.version, iso(o.now)]);
  return rows;
}

export async function getKnowledge(db: Db, o: { viewer: Viewer; itemId: string; now: Date }) {
  const [it] = await db.query<any>(`SELECT * FROM lumi_knowledge_items i WHERE i.id=$1`, [o.itemId]);
  if (!it) throw new LumiError("NOT_FOUND", 404);
  if (o.viewer.kind === "bot") {
    const ok = it.status === "ACTIVE" && (await db.query<any>(`SELECT 1 FROM lumi_knowledge_items i WHERE i.id=$1 AND ${READABLE_SQL("$2", null)}`, [o.itemId, o.viewer.assistantId])).length > 0;
    if (!ok) throw new LumiError("NOT_FOUND", 404); // identical answer for "missing" and "not yours to read"
    await db.query(`INSERT INTO lumi_knowledge_reads(assistant_id,item_id,version,via,at) VALUES ($1,$2,$3,'TOOL',$4)`, [o.viewer.assistantId, o.itemId, it.approved_version, iso(o.now)]);
  }
  const versions = await db.query<any>(
    `SELECT v.version,v.title,v.content,v.reason,v.confidence,v.manual_entry,v.state,v.unsupported,v.effective_until,v.created_by,v.channel,v.created_at,v.decided_by,v.decided_at,v.decision_reason,
            (SELECT coalesce(json_agg(json_build_object('code',s.code,'title',s.title,'kind',s.kind,'ref',s.ref,'supports',l.supports) ORDER BY s.code),'[]'::json) FROM lumi_knowledge_links l JOIN lumi_knowledge_sources s ON s.id=l.source_id WHERE l.item_id=v.item_id AND l.version=v.version) AS sources
       FROM lumi_knowledge_versions v WHERE v.item_id=$1 ${o.viewer.kind === "bot" ? "AND v.version=$2" : ""} ORDER BY v.version DESC`, o.viewer.kind === "bot" ? [o.itemId, it.approved_version] : [o.itemId]);
  const chain = await db.query<any>(`WITH RECURSIVE c AS (SELECT id,code,status,supersedes_item_id,0 AS d FROM lumi_knowledge_items WHERE id=$1 UNION ALL SELECT i.id,i.code,i.status,i.supersedes_item_id,c.d+1 FROM lumi_knowledge_items i JOIN c ON i.id=c.supersedes_item_id WHERE c.d < 20) SELECT code,status FROM c ORDER BY d`, [o.itemId]);
  return { item: it, versions, supersedes_chain: chain };
}

/** Plain line diff (LCS) between two versions: small texts only, so O(n·m) is fine. */
export function lineDiff(a: string, b: string): { type: "same" | "add" | "del"; text: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  const L: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { type: "same" | "add" | "del"; text: string }[] = []; let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ type: "same", text: x[i]! }); i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ type: "del", text: x[i++]! });
    else out.push({ type: "add", text: y[j++]! });
  }
  while (i < x.length) out.push({ type: "del", text: x[i++]! });
  while (j < y.length) out.push({ type: "add", text: y[j++]! });
  return out;
}
export async function compareVersions(db: Db, itemId: string, a: number, b: number) {
  const vs = await db.query<any>(`SELECT version,title,content FROM lumi_knowledge_versions WHERE item_id=$1 AND version = ANY($2::int[])`, [itemId, [a, b]]);
  const va = vs.find((v: any) => v.version === a), vb = vs.find((v: any) => v.version === b);
  if (!va || !vb) throw new LumiError("NOT_FOUND", 404);
  return { a: va, b: vb, diff: lineDiff(`${va.title}\n${va.content}`, `${vb.title}\n${vb.content}`) };
}

// ───────────────────────── traceability (KNW-14)
/** From a task: every run's loaded (item, version), and a warning when a newer approved version exists now. */
export async function traceForTask(db: Db, taskId: string) {
  return db.query<any>(
    `SELECT r.attempt_no, r.created_at AS run_at, rk.item_id, i.code, i.kind, i.scope, rk.version AS used_version, i.approved_version AS current_version, i.status,
            (i.approved_version IS NOT NULL AND i.approved_version > rk.version) AS changed_since, v.title
       FROM lumi_task_runs r JOIN lumi_run_knowledge rk ON rk.run_id=r.id JOIN lumi_knowledge_items i ON i.id=rk.item_id
       LEFT JOIN lumi_knowledge_versions v ON v.item_id=rk.item_id AND v.version=rk.version
      WHERE r.task_id=$1 ORDER BY r.attempt_no, i.code`, [taskId]);
}
/** From an item: for each version, the tasks that used exactly that version. */
export async function traceForItem(db: Db, itemId: string) {
  return db.query<any>(
    `SELECT rk.version, k.code AS task_code, k.title AS task_title, r.attempt_no, r.created_at AS run_at
       FROM lumi_run_knowledge rk JOIN lumi_task_runs r ON r.id=rk.run_id JOIN tasks k ON k.id=r.task_id WHERE rk.item_id=$1 ORDER BY rk.version, r.created_at`, [itemId]);
}
export async function knowledgeReads(db: Db, itemId: string) {
  return db.query<any>(`SELECT a.slug,r.version,r.via,r.at FROM lumi_knowledge_reads r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE r.item_id=$1 ORDER BY r.at DESC LIMIT 100`, [itemId]);
}
