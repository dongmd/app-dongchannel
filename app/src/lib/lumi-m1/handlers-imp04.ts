/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/**
 * IMP-04/05 HTTP handlers (knowledge, meetings, cost summary), kept apart from handlers.ts. Same rules: user-only (a bot reaches this only through the MCP tools),
 * writes need the role named in the domain call, reads are open to any signed-in role. Merged into HANDLERS by handlers.ts.
 */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { archiveKnowledge, compareVersions, createSource, decideKnowledge, getKnowledge, knowledgeReads, proposeKnowledge, restoreKnowledgeVersion, reviseKnowledge, searchKnowledge, traceForItem, traceForTask } from "./knowledge";
import { closeMeeting, contribute, decideConclusion, getMeeting, listMeetings, openMeeting, pendingMeetingProposals, synthesizeMeeting } from "./meetings";
import { buildCostSummary } from "./cost-summary";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const need = (b: any, fields: string[]) => { const missing = fields.filter((f) => b?.[f] === undefined || b?.[f] === null || b?.[f] === ""); if (missing.length) throw new LumiError("VALIDATION_ERROR", 400, { missing }); };
const ok = (data: any, status = 200): ApiRes => ({ status, data });
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };
const idem = (req: ApiReq) => { const k = req.headers.get("idempotency-key"); if (!k || k.length < 8 || k.length > 128) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] }); return k; };
const date = (v: unknown, n: string) => { const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${n}(invalid)`] }); return d; };
const sources = (v: any) => (Array.isArray(v) ? v.map((s: any) => ({ sourceId: str(s?.source_id), title: str(s?.title), kind: s?.kind, ref: str(s?.ref), content: str(s?.content), supports: str(s?.supports) })) : undefined);

export const HANDLERS_IMP04: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  // ── knowledge (KNW, CMP-01)
  async searchKnowledge(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    const rows = await searchKnowledge(ctx.db, { viewer: { kind: "user", role: u.role }, q: str(b.q), scope: str(b.scope), projectId: b.project_id ? uuid(b.project_id, "project_id") : undefined, kind: str(b.kind), status: str(b.status), now: ctx.now() });
    return ok({ items: rows, role: u.role });
  },
  async proposeKnowledge(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["kind", "scope", "title", "content"]);
    const r = await proposeKnowledge(ctx.db, { actorRef: u.actorRef, kind: b.kind, scope: b.scope, scopeRef: str(b.scope_ref), title: String(b.title), content: String(b.content), reason: str(b.reason), confidence: b.confidence, manualEntry: b.manual_entry === true, sources: sources(b.sources), supersedesItemId: b.supersedes_item_id ? uuid(b.supersedes_item_id, "supersedes_item_id") : undefined, sharedWith: Array.isArray(b.shared_with) ? b.shared_with.map((x: unknown) => uuid(x, "shared_with")) : undefined, effectiveUntil: b.effective_until ? date(b.effective_until, "effective_until") : undefined, now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { item: r.item, version: r.version, warnings: r.warnings, already_processed: true } } : ok({ item: r.item, version: r.version, warnings: r.warnings }, 201);
  },
  async getKnowledge(ctx, req) {
    const u = user(req); const id = uuid(req.params.id, "item_id");
    const g = await getKnowledge(ctx.db, { viewer: { kind: "user", role: u.role }, itemId: id, now: ctx.now() });
    return ok({ ...g, used_by: await traceForItem(ctx.db, id), reads: u.role === "VIEWER" ? [] : await knowledgeReads(ctx.db, id) });
  },
  async reviseKnowledge(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    return ok(await reviseKnowledge(ctx.db, { actorRef: u.actorRef, itemId: uuid(req.params.id, "item_id"), title: str(b.title), content: str(b.content), reason: b.reason === undefined ? undefined : String(b.reason), confidence: b.confidence, sources: sources(b.sources), effectiveUntil: b.effective_until === null ? null : b.effective_until ? date(b.effective_until, "effective_until") : undefined, now: ctx.now() }), 201);
  },
  async restoreKnowledge(ctx, req) {
    const u = user(req); need(req.body, ["version"]);
    return ok(await restoreKnowledgeVersion(ctx.db, { actorRef: u.actorRef, itemId: uuid(req.params.id, "item_id"), version: Number(req.body.version), now: ctx.now() }), 201);
  },
  async decideKnowledge(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["version", "decision"]);
    if (!["APPROVE", "REJECT"].includes(b.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    const r = await decideKnowledge(ctx.db, { actorRef: u.actorRef, itemId: uuid(req.params.id, "item_id"), version: Number(b.version), decision: b.decision, reason: str(b.reason), supersedeItemId: b.supersede_item_id ? uuid(b.supersede_item_id, "supersede_item_id") : undefined, edit: b.edit && typeof b.edit === "object" ? { title: str(b.edit.title), content: str(b.edit.content) } : undefined, unsupported: Array.isArray(b.unsupported) ? b.unsupported.map(String) : undefined, now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { item: r.item, already_processed: true } } : ok({ item: r.item });
  },
  async archiveKnowledge(ctx, req) {
    const u = user(req); need(req.body, ["reason"]);
    const r = await archiveKnowledge(ctx.db, { actorRef: u.actorRef, itemId: uuid(req.params.id, "item_id"), reason: String(req.body.reason), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { already_processed: true } } : ok({});
  },
  async compareKnowledge(ctx, req) {
    user(req); need(req.body, ["a", "b"]);
    return ok(await compareVersions(ctx.db, uuid(req.params.id, "item_id"), Number(req.body.a), Number(req.body.b)));
  },
  async createSource(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["title", "kind"]);
    return ok({ source: await createSource(ctx.db, { actorRef: u.actorRef, title: String(b.title), kind: b.kind, ref: str(b.ref), content: str(b.content), now: ctx.now() }) }, 201);
  },
  async taskKnowledge(ctx, req) {
    user(req);
    return ok({ loaded: await traceForTask(ctx.db, uuid(req.params.id, "task_id")) });
  },
  // ── meetings (MTG)
  async listMeetings(ctx, req) { user(req); return ok({ meetings: await listMeetings(ctx.db), proposals: await pendingMeetingProposals(ctx.db) }); },
  async getMeeting(ctx, req) { user(req); return ok(await getMeeting(ctx.db, String(req.params.code))); },
  async openMeeting(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["title", "question", "reason", "chair_assistant_id", "closes_at", "max_rounds", "max_runs", "end_conditions", "inputs"]);
    const r = await openMeeting(ctx.db, {
      actorRef: u.actorRef, idempotencyKey: idem(req), title: String(b.title), question: String(b.question), reason: b.reason, planId: b.plan_id ? uuid(b.plan_id, "plan_id") : undefined, projectId: b.project_id ? uuid(b.project_id, "project_id") : undefined,
      chairAssistantId: uuid(b.chair_assistant_id, "chair_assistant_id"), backupChairAssistantId: b.backup_chair_assistant_id ? uuid(b.backup_chair_assistant_id, "backup_chair_assistant_id") : undefined,
      participants: Array.isArray(b.participants) ? b.participants.map((p: any) => ({ assistantId: p.assistant_id ? uuid(p.assistant_id, "assistant_id") : undefined, owner: p.owner === true, role: p.role, expertise: str(p.expertise) })) : [],
      closesAt: date(b.closes_at, "closes_at"), maxRounds: Number(b.max_rounds), maxRuns: Number(b.max_runs), maxCost: b.max_cost === undefined || b.max_cost === null || b.max_cost === "" ? undefined : Number(b.max_cost), currency: str(b.currency),
      endConditions: String(b.end_conditions), inputs: Array.isArray(b.inputs) ? b.inputs.map((x: any) => ({ kind: x.kind, ref: String(x.ref), version: Number(x.version) })) : [], now: ctx.now(),
    });
    return r.alreadyProcessed ? { status: 200, data: { meeting: r.meeting, already_processed: true } } : ok({ meeting: r.meeting }, 201);
  },
  async contributeMeeting(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["stance"]);
    const r = await contribute(ctx.db, { meetingCode: String(req.params.code), actorRef: u.actorRef, round: b.round === undefined ? undefined : Number(b.round), stance: String(b.stance), evidence: str(b.evidence), risks: str(b.risks), estimate: str(b.estimate), objection: str(b.objection), proposal: str(b.proposal), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { late: r.late, already_processed: true } } : ok({ late: r.late }, 201);
  },
  async synthesizeMeeting(ctx, req) {
    const u = user(req); const b = req.body; need(b, ["summary", "lines", "conclusions"]);
    return ok(await synthesizeMeeting(ctx.db, { meetingCode: String(req.params.code), actorRef: u.actorRef, summary: String(b.summary), lines: b.lines, conclusions: b.conclusions, now: ctx.now() }), 201);
  },
  async closeMeeting(ctx, req) {
    const u = user(req); need(req.body, ["reason"]);
    const r = await closeMeeting(ctx.db, { meetingCode: String(req.params.code), actorRef: u.actorRef, reason: String(req.body.reason), outcome: req.body.outcome, now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { already_processed: true } } : ok({});
  },
  async decideConclusion(ctx, req) {
    const u = user(req); need(req.body, ["decision"]);
    if (!["APPROVE", "REJECT"].includes(req.body.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    const r = await decideConclusion(ctx.db, { actorRef: u.actorRef, conclusionId: uuid(req.params.id, "conclusion_id"), decision: req.body.decision, now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { already_processed: true } } : ok({ conclusion: r.conclusion, note: (r as any).note ?? null });
  },
  // ── cost (ECO-03): what was MEASURED, what is unknown and why
  async costSummary(ctx, req) { user(req); return ok(await buildCostSummary(ctx.db)); },
};
