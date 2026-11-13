/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/** Đợt 6 HTTP handlers (settings, ideas, templates, routines, knowledge review, global search). User-only; roles are enforced in the domain calls. Merged into HANDLERS by handlers.ts. */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { acceptIdea, classifyIdea, createIdea, createTaskFromTemplate, createTemplate, decideTemplateVersion, discardIdea, globalSearch, knowledgeReviewReport, listIdeas, listSettings, listTemplates, markKnowledgeReviewed, proposeTemplateVersion, restoreTemplateVersion, setSetting } from "./ops-tools";
import { createRoutine, listRoutines, runRoutineNow, setRoutineEnabled, setRoutinesPaused, updateRoutine } from "./ops-routines";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const need = (b: any, fields: string[]) => { const missing = fields.filter((f) => b?.[f] === undefined || b?.[f] === null || b?.[f] === ""); if (missing.length) throw new LumiError("VALIDATION_ERROR", 400, { missing }); };
const ok = (data: any, status = 200): ApiRes => ({ status, data });
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };
const idem = (req: ApiReq) => { const k = req.headers.get("idempotency-key"); if (!k || k.length < 8 || k.length > 128) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] }); return k; };
const tplFields = (b: any) => ({ description: String(b.description ?? ""), whenToUse: String(b.when_to_use ?? ""), steps: String(b.steps ?? ""), inputs: String(b.inputs ?? ""), outputs: String(b.outputs ?? ""), defaultTitle: String(b.default_title ?? ""), defaultAssigneeId: b.default_assignee_id ? uuid(b.default_assignee_id, "default_assignee_id") : undefined, allowedAssistantIds: Array.isArray(b.allowed_assistant_ids) ? b.allowed_assistant_ids.map((x: unknown) => uuid(x, "allowed_assistant_ids")) : [] });
const routineFields = (b: any) => ({ name: str(b.name), kind: str(b.kind), scheduleKind: str(b.schedule_kind), timeOfDay: str(b.time_of_day), weekday: num(b.weekday), timezone: str(b.timezone), projectId: b.project_id ? uuid(b.project_id, "project_id") : undefined, assigneeId: b.assignee_id ? uuid(b.assignee_id, "assignee_id") : undefined, templateId: b.template_id ? uuid(b.template_id, "template_id") : undefined, title: str(b.title), description: str(b.description), message: str(b.message), maxRunsPerDay: num(b.max_runs_per_day), deadlineMinutes: num(b.deadline_minutes), purpose: str(b.purpose) });

export const HANDLERS_IMP06: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  // ── settings (ADM-06)
  async listSettings(ctx, req) { user(req); return ok(await listSettings(ctx.db)); },
  async setSetting(ctx, req) { const u = user(req); need(req.body, ["key", "value"]); return ok(await setSetting(ctx.db, { actorRef: u.actorRef, key: String(req.body.key), value: Number(req.body.value), now: ctx.now() })); },
  // ── ideas (CNV-03)
  async listIdeas(ctx, req) { user(req); return ok({ ideas: await listIdeas(ctx.db) }); },
  async createIdea(ctx, req) { const u = user(req); const b = req.body ?? {}; need(b, ["title"]); return ok(await createIdea(ctx.db, { actorRef: u.actorRef, title: String(b.title), body: str(b.body), link: str(b.link), now: ctx.now() }), 201); },
  async classifyIdea(ctx, req) { const u = user(req); need(req.body, ["class"]); return ok(await classifyIdea(ctx.db, { actorRef: u.actorRef, ideaId: uuid(req.params.id, "idea_id"), cls: String(req.body.class), projectId: req.body.project_id ? uuid(req.body.project_id, "project_id") : undefined, assigneeId: req.body.assignee_id ? uuid(req.body.assignee_id, "assignee_id") : undefined, now: ctx.now() })); },
  async acceptIdea(ctx, req) { const u = user(req); return ok(await acceptIdea(ctx.db, { actorRef: u.actorRef, ideaId: uuid(req.params.id, "idea_id"), now: ctx.now() })); },
  async discardIdea(ctx, req) { const u = user(req); need(req.body, ["reason"]); return ok(await discardIdea(ctx.db, { actorRef: u.actorRef, ideaId: uuid(req.params.id, "idea_id"), reason: String(req.body.reason), now: ctx.now() })); },
  // ── templates (SKL)
  async listTemplates(ctx, req) { user(req); return ok({ templates: await listTemplates(ctx.db) }); },
  async createTemplate(ctx, req) { const u = user(req); need(req.body, ["name"]); return ok(await createTemplate(ctx.db, { actorRef: u.actorRef, name: String(req.body.name), ...tplFields(req.body), now: ctx.now() }), 201); },
  async proposeTemplateVersion(ctx, req) { const u = user(req); return ok(await proposeTemplateVersion(ctx.db, { actorRef: u.actorRef, templateId: uuid(req.params.id, "template_id"), ...tplFields(req.body ?? {}), now: ctx.now() }), 201); },
  async decideTemplateVersion(ctx, req) {
    const u = user(req); need(req.body, ["version", "decision"]);
    if (!["APPROVE", "REJECT"].includes(req.body.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    const r = await decideTemplateVersion(ctx.db, { actorRef: u.actorRef, templateId: uuid(req.params.id, "template_id"), version: Number(req.body.version), decision: req.body.decision, note: str(req.body.note), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { version: r.version, already_processed: true } } : ok({ version: r.version });
  },
  async restoreTemplateVersion(ctx, req) { const u = user(req); need(req.body, ["version"]); return ok(await restoreTemplateVersion(ctx.db, { actorRef: u.actorRef, templateId: uuid(req.params.id, "template_id"), version: Number(req.body.version), now: ctx.now() }), 201); },
  async createTaskFromTemplate(ctx, req) {
    const u = user(req); need(req.body, ["project_id"]);
    const r = await createTaskFromTemplate(ctx.db, { actorRef: u.actorRef, templateId: uuid(req.params.id, "template_id"), projectId: uuid(req.body.project_id, "project_id"), assigneeId: req.body.assignee_id ? uuid(req.body.assignee_id, "assignee_id") : undefined, key: idem(req), now: ctx.now() });
    return r.alreadyProcessed ? { status: 200, data: { task: r.task, already_processed: true } } : ok({ task: r.task, template: r.template, version: r.version }, 201);
  },
  // ── routines (RTN, EXE-02)
  async listRoutines(ctx, req) { user(req); return ok(await listRoutines(ctx.db, ctx.now())); },
  async createRoutine(ctx, req) { const u = user(req); need(req.body, ["name", "kind", "schedule_kind", "time_of_day"]); return ok(await createRoutine(ctx.db, { actorRef: u.actorRef, ...routineFields(req.body), now: ctx.now() } as any), 201); },
  async updateRoutine(ctx, req) { const u = user(req); return ok(await updateRoutine(ctx.db, { actorRef: u.actorRef, routineId: uuid(req.params.id, "routine_id"), ...routineFields(req.body ?? {}), now: ctx.now() } as any)); },
  async setRoutineEnabled(ctx, req) { const u = user(req); if (typeof req.body?.enabled !== "boolean") throw new LumiError("VALIDATION_ERROR", 400, { missing: ["enabled(boolean)"] }); return ok(await setRoutineEnabled(ctx.db, { actorRef: u.actorRef, routineId: uuid(req.params.id, "routine_id"), enabled: req.body.enabled, now: ctx.now() })); },
  async runRoutineNow(ctx, req) { const u = user(req); return ok(await runRoutineNow(ctx.db, { actorRef: u.actorRef, routineId: uuid(req.params.id, "routine_id"), now: ctx.now() })); },
  async setRoutinesPaused(ctx, req) { const u = user(req); if (typeof req.body?.paused !== "boolean") throw new LumiError("VALIDATION_ERROR", 400, { missing: ["paused(boolean)"] }); return ok(await setRoutinesPaused(ctx.db, { actorRef: u.actorRef, paused: req.body.paused, now: ctx.now() })); },
  // ── knowledge review (KNW-08)
  async knowledgeReview(ctx, req) { user(req); return ok(await knowledgeReviewReport(ctx.db, ctx.now())); },
  async markKnowledgeReviewed(ctx, req) { const u = user(req); return ok(await markKnowledgeReviewed(ctx.db, { actorRef: u.actorRef, itemId: uuid(req.params.id, "item_id"), note: str(req.body?.note), now: ctx.now() })); },
  // ── global search (SRC-01)
  async globalSearch(ctx, req) {
    const u = user(req); need(req.body, ["q"]);
    return ok(await globalSearch(ctx.db, { viewer: { kind: "user", actorRef: u.actorRef }, q: String(req.body.q), types: Array.isArray(req.body.types) ? req.body.types.map(String) : undefined, now: ctx.now() }));
  },
};
