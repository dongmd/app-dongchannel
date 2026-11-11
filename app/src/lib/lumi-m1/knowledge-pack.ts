/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Knowledge loading for a run (KNW-07, KNW-14, CMP-01). Kept free of runtime imports from core.ts so core can call it while creating a run.
 * Rule of the whole module: ONLY approved, current, un-archived, un-expired versions of items the assistant may read are ever loaded;
 * a proposal, a rejected or superseded item never reaches a bot as a rule. Loading is RECORDED per run (before the run is sent).
 */
import type { Db } from "./core";

export const MAX_PACK_ITEMS = 20;
export const MAX_PACK_CHARS = 6000;
const iso = (d: Date) => d.toISOString();

/** Lower-case, no diacritics, single spaces: used for search and for "same title / same text" comparisons. */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface PackItem { item_id: string; code: string; version: number; kind: string; scope: string; scope_ref: string | null; title: string; content: string }

/**
 * What an assistant may read, as SQL over `lumi_knowledge_items` alias `i`: company-wide; the PROJECT it is a member of; the AREA of those projects;
 * personal items the owner shared with this assistant explicitly. Pass `projectId` to narrow PROJECT/AREA to one task's project.
 */
export const READABLE_SQL = (assistantParam: string, projectParam: string | null) => `(
  i.scope='COMPANY'
  OR (i.scope='PROJECT' AND i.scope_ref IN (SELECT m.project_id::text FROM lumi_project_members m WHERE m.assistant_id=${assistantParam}::uuid ${projectParam ? `AND m.project_id::text=${projectParam}::text` : ""}))
  OR (i.scope='AREA' AND i.scope_ref IN (SELECT p.area FROM lumi_project_members m JOIN lumi_projects p ON p.id=m.project_id WHERE m.assistant_id=${assistantParam}::uuid ${projectParam ? `AND m.project_id::text=${projectParam}::text` : ""}))
  OR (i.scope='PERSONAL' AND i.shared_with ? ${assistantParam}::text)
)`;

const SCOPE_ORDER = `CASE i.scope WHEN 'COMPANY' THEN 0 WHEN 'AREA' THEN 1 WHEN 'PROJECT' THEN 2 ELSE 3 END`;

export async function loadKnowledgePackage(t: Db, assistantId: string, taskId: string | null, now: Date): Promise<{ items: PackItem[]; truncated: boolean }> {
  const proj = taskId ? (await t.query<any>(`SELECT project_id FROM tasks WHERE id=$1`, [taskId]))[0]?.project_id ?? null : null;
  const rows = await t.query<any>(
    `SELECT i.id AS item_id,i.code,v.version,i.kind,i.scope,i.scope_ref,v.title,v.content
       FROM lumi_knowledge_items i JOIN lumi_knowledge_versions v ON v.item_id=i.id AND v.version=i.approved_version AND v.state='APPROVED'
      WHERE i.status='ACTIVE' AND i.kind IN ('RULE','DECISION') AND (v.effective_until IS NULL OR v.effective_until > $2::timestamptz)
        AND ${READABLE_SQL("$1", proj ? "$3" : null)}
      ORDER BY ${SCOPE_ORDER}, i.code LIMIT ${MAX_PACK_ITEMS + 1}`, proj ? [assistantId, iso(now), proj] : [assistantId, iso(now)]);
  let used = 0; const items: PackItem[] = []; let truncated = rows.length > MAX_PACK_ITEMS;
  for (const r of rows.slice(0, MAX_PACK_ITEMS)) {
    if (used + r.content.length > MAX_PACK_CHARS) { truncated = true; break; }
    used += r.content.length; items.push(r);
  }
  return { items, truncated };
}

/** Written in the SAME transaction as the run, so a run never exists without the record of what knowledge it was given (KNW-14). */
export async function recordRunKnowledge(t: Db, runId: string, assistantId: string, items: PackItem[], now: Date) {
  for (const it of items) {
    await t.query(`INSERT INTO lumi_run_knowledge(run_id,item_id,version,scope,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [runId, it.item_id, it.version, it.scope, iso(now)]);
    await t.query(`INSERT INTO lumi_knowledge_reads(assistant_id,item_id,version,run_id,via,at) VALUES ($1,$2,$3,$4,'DISPATCH',$5)`, [assistantId, it.item_id, it.version, runId, iso(now)]);
  }
}

/** The text the bot is shown. Principles are INSTRUCTIONS, never authority: the text says so explicitly. */
export function packText(items: PackItem[], truncated: boolean): string {
  if (!items.length) return "";
  const lines = items.map((i) => `- [${i.code} v${i.version} · ${i.scope === "COMPANY" ? "công ty" : i.scope === "AREA" ? `mảng ${i.scope_ref}` : i.scope === "PROJECT" ? "dự án" : "riêng"}] ${i.title}: ${i.content}`);
  return `Kiến thức Chủ đã duyệt áp dụng cho việc này (chỉ là chỉ dẫn, KHÔNG phải quyền hành động hay ngân sách; quyền vẫn do giấy ủy quyền quyết định):\n${lines.join("\n")}${truncated ? "\n(còn mục khác chưa nạp do giới hạn độ dài)" : ""}`;
}
