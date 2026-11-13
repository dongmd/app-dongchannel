/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 8 (nhóm 1) — KNW-10 knowledge graph, KNW-08 broken-link check and conflict finder.
 * The link check is the only place the app calls an outside address on its own: owner/admin triggered, http(s) only, public addresses only (SSRF guard), short timeout, no redirects followed, results stored.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { LumiError, audit, requireRole, type Db } from "./core";
import { normalizeText } from "./knowledge-pack";

const iso = (d: Date) => d.toISOString();

// ───────────────────────── KNW-10
export async function knowledgeGraph(db: Db) {
  const items = await db.query<any>(`SELECT i.id,i.code,i.kind,i.scope,i.status,v.title FROM lumi_knowledge_items i JOIN lumi_knowledge_versions v ON v.item_id=i.id AND v.version=i.current_version WHERE i.status IN ('ACTIVE','PROPOSED','SUPERSEDED') ORDER BY i.code LIMIT 300`);
  const ids = items.map((x: any) => x.id);
  const links = await db.query<any>(`SELECT DISTINCT l.item_id, s.id AS source_id, s.code AS source_code, s.title AS source_title FROM lumi_knowledge_links l JOIN lumi_knowledge_sources s ON s.id=l.source_id WHERE l.item_id = ANY($1::uuid[])`, [ids]);
  const sup = await db.query<any>(`SELECT i.id, i.supersedes_item_id FROM lumi_knowledge_items i WHERE i.supersedes_item_id IS NOT NULL AND i.id = ANY($1::uuid[])`, [ids]);
  const used = await db.query<any>(`SELECT item_id, count(*)::int n FROM lumi_run_knowledge WHERE item_id = ANY($1::uuid[]) GROUP BY item_id`, [ids]);
  const nodes: any[] = items.map((x: any) => ({ id: x.id, type: "ITEM", code: x.code, label: x.title, kind: x.kind, scope: x.scope, status: x.status, runs_used: used.find((u: any) => u.item_id === x.id)?.n ?? 0 }));
  const seen = new Set<string>();
  for (const l of links) if (!seen.has(l.source_id)) { seen.add(l.source_id); nodes.push({ id: l.source_id, type: "SOURCE", code: l.source_code, label: l.source_title }); }
  const edges = [...links.map((l: any) => ({ from: l.item_id, to: l.source_id, rel: "CITES" })), ...sup.filter((s: any) => ids.includes(s.supersedes_item_id)).map((s: any) => ({ from: s.id, to: s.supersedes_item_id, rel: "SUPERSEDES" }))];
  return { nodes, edges, note: "Nút = mục kiến thức và nguồn; cạnh = «trích dẫn nguồn» hoặc «thay thế». Chỉ hiện tối đa 300 mục; mục đã lưu trữ/bác bỏ không hiện." };
}

// ───────────────────────── KNW-08 conflicts: same title in different scopes with different content
export async function knowledgeConflicts(db: Db) {
  const rows = await db.query<any>(`SELECT i.id,i.code,i.scope,i.scope_ref,i.kind,v.title,v.content FROM lumi_knowledge_items i JOIN lumi_knowledge_versions v ON v.item_id=i.id AND v.version=i.approved_version WHERE i.status='ACTIVE'`);
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.kind}:${normalizeText(r.title)}`; (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
  const out: any[] = [];
  for (const g of by.values()) {
    const distinct = new Set(g.map((x) => normalizeText(x.content)));
    if (g.length > 1 && distinct.size > 1) out.push({ title: g[0].title, kind: g[0].kind, items: g.map((x) => ({ id: x.id, code: x.code, scope: x.scope })) });
  }
  return { conflicts: out, note: "Chỉ phát hiện cùng loại + cùng tiêu đề + nội dung khác nhau ở các phạm vi khác nhau. Mâu thuẫn về ý nghĩa giữa các mục khác tiêu đề cần người đọc; app chưa tự suy luận." };
}

// ───────────────────────── KNW-08 broken links (outside call, guarded)
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("::ffff:"); }
  return true;
}
export async function checkUrl(url: string, deps: { lookup?: (h: string) => Promise<string[]>; fetchFn?: typeof fetch } = {}): Promise<{ ok: boolean; status: number | null; reason: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, status: null, reason: "URL_INVALID" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, status: null, reason: "SCHEME_NOT_ALLOWED" };
  if (u.username || u.password) return { ok: false, status: null, reason: "CREDENTIALS_IN_URL" };
  const lookup = deps.lookup ?? (async (h: string) => (await dns.lookup(h, { all: true })).map((a) => a.address));
  let addrs: string[];
  try { addrs = net.isIP(u.hostname) ? [u.hostname] : await lookup(u.hostname); } catch { return { ok: false, status: null, reason: "DNS_FAILED" }; }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) return { ok: false, status: null, reason: "ADDRESS_NOT_PUBLIC" };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await (deps.fetchFn ?? fetch)(u.toString(), { method: "HEAD", redirect: "manual", signal: ctl.signal, headers: { "user-agent": "dong-lumi-link-check/1" } });
    const redirect = res.status >= 300 && res.status < 400;
    return { ok: res.status < 400 || redirect, status: res.status, reason: redirect ? "REDIRECT" : res.status < 400 ? "OK" : "HTTP_ERROR" };
  } catch { return { ok: false, status: null, reason: "UNREACHABLE" }; } finally { clearTimeout(timer); }
}
export async function checkKnowledgeLinks(db: Db, a: { actorRef: string; limit?: number; now: Date }, deps: Parameters<typeof checkUrl>[1] = {}) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const src = await db.query<any>(`SELECT DISTINCT s.id,s.code,s.title,s.ref FROM lumi_knowledge_sources s JOIN lumi_knowledge_links l ON l.source_id=s.id JOIN lumi_knowledge_items i ON i.id=l.item_id WHERE s.kind='URL' AND s.ref ~ '^https?://' AND i.status='ACTIVE' ORDER BY s.code LIMIT $1`, [Math.min(a.limit ?? 20, 50)]);
  const out: any[] = [];
  for (const s of src) {
    const r = await checkUrl(s.ref, deps);
    await db.query(`INSERT INTO lumi_link_checks(source_id,url,ok,status,reason,checked_by,checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [s.id, s.ref, r.ok, r.status, r.reason, a.actorRef, iso(a.now)]);
    out.push({ code: s.code, title: s.title, url: s.ref, ...r });
  }
  await audit(db, "knowledge.link_check", a.actorRef, { checked: out.length, broken: out.filter((x) => !x.ok).length }, a.now);
  return { checked: out.length, results: out };
}
export async function lastLinkChecks(db: Db) {
  return db.query<any>(`SELECT DISTINCT ON (c.source_id) c.source_id,c.url,c.ok,c.status,c.reason,c.checked_at,s.code,s.title FROM lumi_link_checks c JOIN lumi_knowledge_sources s ON s.id=c.source_id ORDER BY c.source_id, c.checked_at DESC`);
}
void LumiError;
