/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows over the minimal Db interface */
/**
 * Đợt 6 — công cụ vận hành: cài đặt (ADM-06), hộp thư ý tưởng (CNV-03), mẫu công việc (SKL-01..04), soát kiến thức (KNW-08), hết hạn đề xuất (APR-06), tìm kiếm (SRC-01).
 * Principles kept: nothing here grants a permission or a budget; a template/idea never takes effect without the owner; expiry only drops what nobody decided and keeps the history.
 */
import { LumiError, audit, enqueueNotify, requireRole, type Db } from "./core";
import { createTask } from "./core-web";
import { proposeKnowledge, searchKnowledge } from "./knowledge";
import { normalizeText } from "./knowledge-pack";

const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// ───────────────────────── ADM-06 settings: every threshold lives here, with a range, never hard-coded in the UI
export const SETTINGS = {
  proposal_expiry_days: { def: 7, min: 1, max: 90, label: "Đề xuất chờ quá bao nhiêu ngày thì tự bỏ", unit: "ngày" },
  knowledge_review_days: { def: 90, min: 7, max: 730, label: "Kiến thức quá bao nhiêu ngày chưa soát thì đánh dấu cũ", unit: "ngày" },
  routine_fail_threshold: { def: 3, min: 1, max: 20, label: "Routine lỗi liên tiếp bao nhiêu lần thì dừng và báo Chủ", unit: "lần" },
  routine_catchup_hours: { def: 6, min: 1, max: 48, label: "Cửa sổ chạy bù khi routine lỡ mốc", unit: "giờ" },
} as const;
export type SettingKey = keyof typeof SETTINGS;

export async function getSettingNumber(db: Db, key: SettingKey): Promise<number> {
  const [r] = await db.query<any>(`SELECT value FROM lumi_setting_values WHERE key=$1 ORDER BY set_at DESC, id DESC LIMIT 1`, [key]);
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : SETTINGS[key].def;
}
export async function listSettings(db: Db) {
  const out: any[] = [];
  for (const [key, s] of Object.entries(SETTINGS)) {
    const hist = await db.query<any>(`SELECT value,set_by,set_at FROM lumi_setting_values WHERE key=$1 ORDER BY set_at DESC, id DESC LIMIT 5`, [key]);
    out.push({ key, ...s, value: await getSettingNumber(db, key as SettingKey), is_default: hist.length === 0, set_by: hist[0]?.set_by ?? null, set_at: hist[0]?.set_at ?? null, history: hist });
  }
  return { settings: out, timezone: "Asia/Ho_Chi_Minh", note: "Múi giờ hiển thị mặc định là Asia/Ho_Chi_Minh; mỗi routine có múi giờ riêng. Giới hạn chi phí đặt ở màn Tài chính." };
}
export async function setSetting(db: Db, a: { actorRef: string; key: string; value: number; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const s = (SETTINGS as Record<string, (typeof SETTINGS)[SettingKey]>)[a.key];
  if (!s) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["key"] });
  if (!Number.isInteger(a.value) || a.value < s.min || a.value > s.max) throw new LumiError("VALIDATION_ERROR", 400, { errors: [`value(${s.min}..${s.max})`] });
  await db.query(`INSERT INTO lumi_setting_values(key,value,set_by,set_at) VALUES ($1,$2,$3,$4)`, [a.key, String(a.value), a.actorRef, iso(a.now)]);
  await audit(db, "setting.set", a.actorRef, { key: a.key, value: a.value }, a.now);
  return { key: a.key, value: a.value };
}

// ───────────────────────── CNV-03 idea inbox
export async function createIdea(db: Db, a: { actorRef: string; title: string; body?: string; link?: string; channel?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const bad: string[] = [];
  if (typeof a.title !== "string" || a.title.trim().length < 3 || a.title.length > 200) bad.push("title(3..200)");
  if (a.body !== undefined && a.body.length > 4000) bad.push("body(<=4000)");
  if (a.link !== undefined && !/^https?:\/\//.test(a.link)) bad.push("link(http/https)");
  if (!a.body && !a.link) bad.push("body hoặc link");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
  const [r] = await db.query<any>(`INSERT INTO lumi_ideas(title,body,link,channel,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [a.title.trim(), a.body ?? null, a.link ?? null, a.channel ?? "WEB", a.actorRef, iso(a.now)]);
  return { idea: r };
}
export async function classifyIdea(db: Db, a: { actorRef: string; ideaId: string; cls: string; projectId?: string; assigneeId?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (!["NOTE", "SOURCE", "TASK"].includes(a.cls)) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["class(NOTE|SOURCE|TASK)"] });
  if (a.cls === "TASK" && (!isUuid(a.projectId) || !isUuid(a.assigneeId))) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["project_id", "assignee_id"] });
  const [i] = await db.query<any>(`SELECT * FROM lumi_ideas WHERE id=$1`, [a.ideaId]);
  if (!i) throw new LumiError("NOT_FOUND", 404);
  if (a.cls === "SOURCE" && !i.link) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["link (nguồn cần liên kết)"] });
  const up = await db.query<any>(`UPDATE lumi_ideas SET status='CLASSIFIED',class=$2,project_id=$3,assignee_id=$4,classified_by=$5,classified_at=$6 WHERE id=$1 AND status IN ('NEW','CLASSIFIED') RETURNING *`, [a.ideaId, a.cls, a.projectId ?? null, a.assigneeId ?? null, a.actorRef, iso(a.now)]);
  if (!up.length) throw new LumiError("INVALID_TRANSITION", 409, { from: i.status });
  return { idea: up[0] };
}
/** Accepting is the owner's decision (the confirm card); it creates a PROPOSED knowledge item (never edits existing knowledge) or a task through the normal path. */
export async function acceptIdea(db: Db, a: { actorRef: string; ideaId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  const claim = await db.query<any>(`UPDATE lumi_ideas SET status='ACCEPTED',decided_by=$2,decided_at=$3 WHERE id=$1 AND status='CLASSIFIED' RETURNING *`, [a.ideaId, a.actorRef, iso(a.now)]);
  if (!claim.length) { const [i] = await db.query<any>(`SELECT status FROM lumi_ideas WHERE id=$1`, [a.ideaId]); if (!i) throw new LumiError("NOT_FOUND", 404); throw new LumiError("INVALID_TRANSITION", 409, { from: i.status }); }
  const i = claim[0];
  try {
    let ref: string;
    if (i.class === "TASK") {
      const r = await createTask(db, { actorRef: a.actorRef, clientRequestId: `idea-${i.id}`, projectId: i.project_id, assigneeId: i.assignee_id, title: i.title, description: [i.body, i.link].filter(Boolean).join("\n"), now: a.now });
      ref = r.task.code;
    } else {
      const content = [i.body, i.link ? `Liên kết: ${i.link}` : null].filter(Boolean).join("\n");
      const r: any = await proposeKnowledge(db, { actorRef: a.actorRef, kind: "NOTE", scope: i.project_id ? "PROJECT" : "COMPANY", scopeRef: i.project_id ?? undefined, title: i.title, content, reason: `Từ hộp thư ý tưởng ${i.code}`, manualEntry: i.class !== "SOURCE", sources: i.class === "SOURCE" ? [{ kind: "URL", title: i.title, ref: i.link }] : undefined, now: a.now });
      ref = r.item?.code ?? r.code ?? "kiến thức";
    }
    await db.query(`UPDATE lumi_ideas SET result_ref=$2 WHERE id=$1`, [i.id, ref]);
    return { idea: { ...i, result_ref: ref } };
  } catch (e) {
    await db.query(`UPDATE lumi_ideas SET status='CLASSIFIED',decided_by=NULL,decided_at=NULL WHERE id=$1`, [i.id]);
    throw e;
  }
}
export async function discardIdea(db: Db, a: { actorRef: string; ideaId: string; reason: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (typeof a.reason !== "string" || a.reason.trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["reason(>=3)"] });
  const up = await db.query<any>(`UPDATE lumi_ideas SET status='DISCARDED',decision_note=$2,decided_by=$3,decided_at=$4 WHERE id=$1 AND status IN ('NEW','CLASSIFIED') RETURNING *`, [a.ideaId, a.reason.trim(), a.actorRef, iso(a.now)]);
  if (!up.length) throw new LumiError("INVALID_TRANSITION", 409);
  return { idea: up[0] };
}
export async function listIdeas(db: Db) {
  return db.query<any>(`SELECT i.*, p.name AS project_name, a.name AS assignee_name FROM lumi_ideas i LEFT JOIN lumi_projects p ON p.id=i.project_id LEFT JOIN lumi_assistants a ON a.id=i.assignee_id ORDER BY CASE i.status WHEN 'NEW' THEN 0 WHEN 'CLASSIFIED' THEN 1 ELSE 2 END, i.created_at DESC LIMIT 200`);
}

// ───────────────────────── SKL templates: immutable versions, owner approves, only the approved version is used
const DATE_RE = /(\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\bngày \d{1,2}\b|\bhôm (qua|nay)\b|\btuần (trước|này)\b)/i;
const DIARY_RE = /\b(đã làm|đã thử|hôm qua|hôm nay|tuần trước|lần trước|vừa xong)\b/i;
/** SKL-04: "a lesson, not a diary" — a warning before approval, never a hard block */
export function contentWarnings(v: { description?: string; steps?: string; when_to_use?: string }): string[] {
  const text = [v.description, v.steps, v.when_to_use].filter(Boolean).join("\n");
  const w: string[] = [];
  if (DATE_RE.test(text)) w.push("Nội dung có ngày cụ thể: mẫu nên là bài học dùng lại được, không gắn với một ngày.");
  if (DIARY_RE.test(text)) w.push("Nội dung có vẻ kể lại việc đã làm (nhật ký) thay vì hướng dẫn cho lần sau.");
  return w;
}
interface TplInput { description: string; whenToUse: string; steps: string; inputs: string; outputs: string; defaultTitle: string; defaultAssigneeId?: string; allowedAssistantIds?: string[] }
function validateTpl(i: TplInput) {
  const bad: string[] = [];
  const len = (v: unknown, lo: number, hi: number) => typeof v === "string" && v.trim().length >= lo && v.length <= hi;
  if (!len(i.description, 3, 2000)) bad.push("description(3..2000)");
  if (!len(i.whenToUse, 3, 1000)) bad.push("when_to_use(3..1000)");
  if (!len(i.steps, 3, 4000)) bad.push("steps(3..4000)");
  if (!len(i.inputs, 1, 1000)) bad.push("inputs(1..1000)");
  if (!len(i.outputs, 1, 1000)) bad.push("outputs(1..1000)");
  if (!len(i.defaultTitle, 3, 200)) bad.push("default_title(3..200)");
  if (i.defaultAssigneeId !== undefined && !isUuid(i.defaultAssigneeId)) bad.push("default_assignee_id(uuid)");
  if ((i.allowedAssistantIds ?? []).some((x) => !isUuid(x))) bad.push("allowed_assistant_ids(uuid[])");
  if (bad.length) throw new LumiError("VALIDATION_ERROR", 400, { errors: bad });
}
const verInsert = (t: Db, id: string, version: number, i: TplInput, by: string, now: Date) =>
  t.query<any>(`INSERT INTO lumi_task_template_versions(template_id,version,description,when_to_use,steps,inputs,outputs,default_title,default_assignee_id,allowed_assistant_ids,proposed_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11,$12) RETURNING *`, [id, version, i.description.trim(), i.whenToUse.trim(), i.steps.trim(), i.inputs.trim(), i.outputs.trim(), i.defaultTitle.trim(), i.defaultAssigneeId ?? null, i.allowedAssistantIds ?? [], by, iso(now)]);

export async function createTemplate(db: Db, a: TplInput & { actorRef: string; name: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  if (typeof a.name !== "string" || a.name.trim().length < 3 || a.name.length > 120) throw new LumiError("VALIDATION_ERROR", 400, { errors: ["name(3..120)"] });
  validateTpl(a);
  return db.tx(async (t) => {
    const [tp] = await t.query<any>(`INSERT INTO lumi_task_templates(name,created_by,created_at) VALUES ($1,$2,$3) RETURNING *`, [a.name.trim(), a.actorRef, iso(a.now)]);
    const [v] = await verInsert(t, tp.id, 1, a, a.actorRef, a.now);
    return { template: tp, version: v, warnings: contentWarnings({ description: a.description, steps: a.steps, when_to_use: a.whenToUse }) };
  });
}
export async function proposeTemplateVersion(db: Db, a: TplInput & { actorRef: string; templateId: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  validateTpl(a);
  return db.tx(async (t) => {
    const [tp] = await t.query<any>(`SELECT * FROM lumi_task_templates WHERE id=$1 AND state='ACTIVE' FOR UPDATE`, [a.templateId]);
    if (!tp) throw new LumiError("NOT_FOUND", 404);
    const [m] = await t.query<any>(`SELECT max(version)::int v FROM lumi_task_template_versions WHERE template_id=$1`, [tp.id]);
    const version = (m?.v ?? 0) + 1;
    const [v] = await verInsert(t, tp.id, version, a, a.actorRef, a.now);
    await t.query(`UPDATE lumi_task_templates SET current_version=$2 WHERE id=$1`, [tp.id, version]);
    return { version: v, warnings: contentWarnings({ description: a.description, steps: a.steps, when_to_use: a.whenToUse }) };
  });
}
export async function decideTemplateVersion(db: Db, a: { actorRef: string; templateId: string; version: number; decision: "APPROVE" | "REJECT"; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER"]);
  if (a.decision === "REJECT" && (a.note ?? "").trim().length < 3) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["note(>=3)"] });
  return db.tx(async (t) => {
    const [tp] = await t.query<any>(`SELECT * FROM lumi_task_templates WHERE id=$1 FOR UPDATE`, [a.templateId]);
    if (!tp) throw new LumiError("NOT_FOUND", 404);
    const [v] = await t.query<any>(`SELECT * FROM lumi_task_template_versions WHERE template_id=$1 AND version=$2 FOR UPDATE`, [tp.id, a.version]);
    if (!v) throw new LumiError("NOT_FOUND", 404);
    if (v.state !== "PROPOSED") return { version: v, alreadyProcessed: true as const };
    if (a.decision === "APPROVE") {
      await t.query(`UPDATE lumi_task_template_versions SET state='SUPERSEDED' WHERE template_id=$1 AND state='APPROVED'`, [tp.id]);
      await t.query(`UPDATE lumi_task_templates SET approved_version=$2 WHERE id=$1`, [tp.id, a.version]);
    }
    const [u] = await t.query<any>(`UPDATE lumi_task_template_versions SET state=$3,decided_by=$4,decided_at=$5,decision_note=$6 WHERE template_id=$1 AND version=$2 RETURNING *`, [tp.id, a.version, a.decision === "APPROVE" ? "APPROVED" : "REJECTED", a.actorRef, iso(a.now), a.note ?? null]);
    return { version: u, alreadyProcessed: false as const };
  });
}
/** restoring an older version = a NEW proposed version with the old content (history is never rewritten) */
export async function restoreTemplateVersion(db: Db, a: { actorRef: string; templateId: string; version: number; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const [v] = await db.query<any>(`SELECT * FROM lumi_task_template_versions WHERE template_id=$1 AND version=$2`, [a.templateId, a.version]);
  if (!v) throw new LumiError("NOT_FOUND", 404);
  return proposeTemplateVersion(db, { actorRef: a.actorRef, templateId: a.templateId, description: v.description, whenToUse: v.when_to_use, steps: v.steps, inputs: v.inputs, outputs: v.outputs, defaultTitle: v.default_title, defaultAssigneeId: v.default_assignee_id ?? undefined, allowedAssistantIds: v.allowed_assistant_ids, now: a.now });
}
export async function listTemplates(db: Db) {
  const tps = await db.query<any>(`SELECT * FROM lumi_task_templates ORDER BY created_at`);
  const vs = await db.query<any>(`SELECT * FROM lumi_task_template_versions ORDER BY template_id, version DESC`);
  const uses = await db.query<any>(`SELECT template_id, count(*)::int n FROM lumi_task_template_uses GROUP BY template_id`);
  return tps.map((t: any) => ({ ...t, uses: uses.find((u: any) => u.template_id === t.id)?.n ?? 0, versions: vs.filter((v: any) => v.template_id === t.id).map((v: any) => ({ ...v, warnings: contentWarnings({ description: v.description, steps: v.steps, when_to_use: v.when_to_use }) })) }));
}
/** SKL-03 + SKL-01: a bot outside the allowed list cannot be given a task from the template; the task records the template and version used */
export async function createTaskFromTemplate(db: Db, a: { actorRef: string; templateId: string; projectId: string; assigneeId?: string; key: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const [tp] = await db.query<any>(`SELECT v.*, t.id AS tpl_id, t.code, t.approved_version FROM lumi_task_templates t JOIN lumi_task_template_versions v ON v.template_id=t.id AND v.version=t.approved_version WHERE t.id=$1 AND t.state='ACTIVE'`, [a.templateId]);
  if (!tp) throw new LumiError("NOT_FOUND", 404, { what: "phiên bản đã duyệt của mẫu" });
  const assigneeId = a.assigneeId ?? tp.default_assignee_id;
  if (!assigneeId) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["assignee_id"] });
  if ((tp.allowed_assistant_ids ?? []).length > 0 && !(tp.allowed_assistant_ids as string[]).includes(assigneeId)) throw new LumiError("FORBIDDEN", 403, { reason: "Bot này không nằm trong danh sách được phép dùng mẫu" });
  const r = await createTask(db, { actorRef: a.actorRef, clientRequestId: a.key, projectId: a.projectId, assigneeId, title: tp.default_title, description: `${tp.description}\n\nCác bước:\n${tp.steps}\n\nĐầu vào: ${tp.inputs}`, expectedOutput: tp.outputs, now: a.now } as any);
  await db.query(`INSERT INTO lumi_task_template_uses(task_id,template_id,version,used_by,used_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [r.task.id, tp.tpl_id, tp.approved_version, a.actorRef, iso(a.now)]);
  return { task: r.task, template: tp.code, version: tp.approved_version, alreadyProcessed: "alreadyProcessed" in r && r.alreadyProcessed };
}

// ───────────────────────── KNW-08 dated figures and periodic review
const FIGURE_RE = /(\d[\d.,]*\s?(%|usd|\$|đ\b|vnd|triệu|nghìn|k\b|tr\b))|(\$\s?\d)/i;
const ASOF_RE = /(tính đến|as of|cập nhật ngày|số liệu ngày|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|tháng \d{1,2}|quý [1-4]|năm 20\d\d)/i;
export async function knowledgeReviewReport(db: Db, now: Date) {
  const days = await getSettingNumber(db, "knowledge_review_days");
  const rows = await db.query<any>(
    `SELECT i.id,i.code,i.scope,v.title,v.content,v.version, (SELECT max(reviewed_at) FROM lumi_knowledge_reviews r WHERE r.item_id=i.id) AS last_review, v.decided_at, v.created_at
       FROM lumi_knowledge_items i JOIN lumi_knowledge_versions v ON v.item_id=i.id AND v.version=i.approved_version WHERE i.status='ACTIVE' ORDER BY i.code`);
  const items = rows.map((r: any) => {
    const flags: string[] = [];
    if (FIGURE_RE.test(r.content) && !ASOF_RE.test(r.content)) flags.push("NO_DATE");
    const last = new Date(r.last_review ?? r.decided_at ?? r.created_at);
    const age = Math.floor((now.getTime() - last.getTime()) / 86400_000);
    if (age > days) flags.push("STALE");
    return { id: r.id, code: r.code, title: r.title, scope: r.scope, version: r.version, flags, age_days: age, last_review: r.last_review };
  }).filter((x: any) => x.flags.length > 0);
  return { review_days: days, items, note: "Chỉ soát được số liệu thiếu ngày và nội dung quá hạn soát. Kiểm liên kết gãy và mâu thuẫn giữa các mục chưa làm (app không tự truy cập liên kết ngoài)." };
}
export async function markKnowledgeReviewed(db: Db, a: { actorRef: string; itemId: string; note?: string; now: Date }) {
  await requireRole(db, a.actorRef, ["OWNER", "ADMIN"]);
  const [i] = await db.query<any>(`SELECT id,approved_version FROM lumi_knowledge_items WHERE id=$1 AND status='ACTIVE'`, [a.itemId]);
  if (!i) throw new LumiError("NOT_FOUND", 404);
  await db.query(`INSERT INTO lumi_knowledge_reviews(item_id,version,reviewed_by,note,reviewed_at) VALUES ($1,$2,$3,$4,$5)`, [i.id, i.approved_version, a.actorRef, a.note ?? null, iso(a.now)]);
  return { ok: true };
}

// ───────────────────────── APR-06 expiry: only what nobody decided; history kept; nothing is ever approved by expiry
export async function expiryTick(db: Db, now: Date): Promise<{ knowledge: number; templates: number; ideas: number }> {
  const days = await getSettingNumber(db, "proposal_expiry_days");
  const cutoff = iso(new Date(now.getTime() - days * 86400_000));
  const reason = `Hết hạn đề xuất sau ${days} ngày không ai quyết định (APR-06)`;
  const kv = await db.query<any>(`UPDATE lumi_knowledge_versions SET state='WITHDRAWN',decided_by='system:expiry',decided_at=$2,decision_reason=$3 WHERE state='PROPOSED' AND created_at < $1 RETURNING item_id`, [cutoff, iso(now), reason]);
  if (kv.length) await db.query(`UPDATE lumi_knowledge_items SET status='REJECTED' WHERE id = ANY($1::uuid[]) AND status='PROPOSED' AND approved_version IS NULL`, [kv.map((x: any) => x.item_id)]);
  const tv = await db.query<any>(`UPDATE lumi_task_template_versions SET state='EXPIRED',decided_by='system:expiry',decided_at=$2,decision_note=$3 WHERE state='PROPOSED' AND created_at < $1 RETURNING id`, [cutoff, iso(now), reason]);
  const id = await db.query<any>(`UPDATE lumi_ideas SET status='DISCARDED',decided_by='system:expiry',decided_at=$2,decision_note=$3 WHERE status IN ('NEW','CLASSIFIED') AND created_at < $1 RETURNING id`, [cutoff, iso(now), reason]);
  const n = kv.length + tv.length + id.length;
  if (n > 0) { await audit(db, "proposal.expire", "system:expiry", { knowledge: kv.length, templates: tv.length, ideas: id.length }, now); await enqueueNotify(db, `notify:expiry:${iso(now).slice(0, 13)}`, { type: "PROPOSALS_EXPIRED", count: n }, now); }
  return { knowledge: kv.length, templates: tv.length, ideas: id.length };
}

// ───────────────────────── SRC-01 global search, grouped by type, accent-insensitive, by viewer permission
export type SearchViewer = { kind: "user"; actorRef: string } | { kind: "bot"; assistantId: string };
export async function globalSearch(db: Db, a: { viewer: SearchViewer; q: string; types?: string[]; now: Date }) {
  const terms = normalizeText(a.q ?? "").split(" ").filter(Boolean).slice(0, 8);
  if (terms.length === 0) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["q"] });
  if (a.viewer.kind !== "user") throw new LumiError("FORBIDDEN", 403);
  const want = (t: string) => !a.types || a.types.length === 0 || a.types.includes(t);
  const hit = (...fields: (string | null | undefined)[]) => { const n = normalizeText(fields.filter(Boolean).join(" ")); return terms.every((x) => n.includes(x)); };
  const groups: { type: string; label: string; items: { code: string; title: string; sub?: string; href: string }[] }[] = [];
  const add = (type: string, label: string, rows: any[], pick: (r: any) => { code: string; title: string; sub?: string; href: string } | null, f: (r: any) => (string | null | undefined)[]) => {
    const items = rows.filter((r) => hit(...f(r))).slice(0, 10).map(pick).filter(Boolean) as any[];
    if (items.length) groups.push({ type, label, items });
  };
  if (want("TASK")) add("TASK", "Việc", await db.query(`SELECT code,title,description,status FROM tasks ORDER BY created_at DESC LIMIT 1000`), (r) => ({ code: r.code, title: r.title, sub: r.status, href: "/lumi/work" }), (r) => [r.code, r.title, r.description]);
  if (want("GOAL")) add("GOAL", "Mục tiêu", await db.query(`SELECT code,title,outcome FROM lumi_goals ORDER BY created_at DESC LIMIT 500`), (r) => ({ code: r.code, title: r.title, href: "/lumi/company" }), (r) => [r.code, r.title, r.outcome]);
  if (want("PLAN")) add("PLAN", "Kế hoạch", await db.query(`SELECT p.code,g.title AS goal,p.status,p.id FROM lumi_plans p JOIN lumi_goals g ON g.id=p.goal_id ORDER BY p.created_at DESC LIMIT 500`), (r) => ({ code: r.code, title: r.goal, sub: r.status, href: `/lumi/plans/${r.id}` }), (r) => [r.code, r.goal]);
  if (want("KNOWLEDGE")) {
    const kn: any = await searchKnowledge(db, { viewer: { kind: "user", role: "VIEWER" }, q: a.q, limit: 10, now: a.now });
    const rows: any[] = Array.isArray(kn) ? kn : kn.items ?? kn.results ?? [];
    if (rows.length) groups.push({ type: "KNOWLEDGE", label: "Kiến thức", items: rows.slice(0, 10).map((r) => ({ code: r.code, title: r.title, sub: r.status, href: "/lumi/knowledge" })) });
  }
  if (want("MEETING")) add("MEETING", "Cuộc họp", await db.query(`SELECT code,title,question,state FROM lumi_meetings ORDER BY created_at DESC LIMIT 300`), (r) => ({ code: r.code, title: r.title, sub: r.state, href: "/lumi/meetings" }), (r) => [r.code, r.title, r.question]);
  if (want("ASSISTANT")) add("ASSISTANT", "Trợ lý", await db.query(`SELECT slug,name,role_label FROM lumi_assistants WHERE status='ACTIVE'`), (r) => ({ code: r.slug, title: r.name, sub: r.role_label, href: "/lumi/org" }), (r) => [r.slug, r.name, r.role_label]);
  if (want("PROJECT")) add("PROJECT", "Dự án", await db.query(`SELECT slug,name,area FROM lumi_projects`), (r) => ({ code: r.slug, title: r.name, sub: r.area, href: "/lumi/work" }), (r) => [r.slug, r.name]);
  if (want("IDEA")) add("IDEA", "Ý tưởng", await db.query(`SELECT code,title,body,status FROM lumi_ideas ORDER BY created_at DESC LIMIT 300`), (r) => ({ code: r.code, title: r.title, sub: r.status, href: "/lumi/ideas" }), (r) => [r.code, r.title, r.body]);
  if (want("TEMPLATE")) add("TEMPLATE", "Mẫu công việc", await db.query(`SELECT t.code,t.name,v.description FROM lumi_task_templates t JOIN lumi_task_template_versions v ON v.template_id=t.id AND v.version=t.current_version`), (r) => ({ code: r.code, title: r.name, href: "/lumi/templates" }), (r) => [r.code, r.name, r.description]);
  if (want("EXPERIMENT")) add("EXPERIMENT", "Thử nghiệm", await db.query(`SELECT code,title,hypothesis,state FROM lumi_experiments ORDER BY created_at DESC LIMIT 300`), (r) => ({ code: r.code, title: r.title, sub: r.state, href: "/lumi/finance" }), (r) => [r.code, r.title, r.hypothesis]);
  if (want("ROUTINE")) add("ROUTINE", "Routine", await db.query(`SELECT code,name FROM lumi_routines`), (r) => ({ code: r.code, title: r.name, href: "/lumi/routines" }), (r) => [r.code, r.name]);
  return { q: a.q, groups, total: groups.reduce((s, g) => s + g.items.length, 0), note: "Tìm trong 1000 mục gần nhất mỗi loại; không bỏ dấu cũng tìm được. Chưa tìm trong hội thoại Hermes, nội dung website, video/offer (chưa có trong ứng dụng)." };
}
