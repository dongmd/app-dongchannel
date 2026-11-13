/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/** Đợt 8 (nhóm 1) HTTP handlers: capacity/transfer, preparation fund board, plan lead change, knowledge graph / conflicts / link check. User-only; roles enforced in the domain calls. */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { changePlanLead, fundsOverview, leadHistory, listCapacity, setAssistantPaused, setCapacity, setPrepFund, transferWork } from "./capacity-funds";
import { checkKnowledgeLinks, knowledgeConflicts, knowledgeGraph, lastLinkChecks } from "./kn-extras";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };
const ok = (data: any, status = 200): ApiRes => ({ status, data });

export const HANDLERS_IMP08: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  async listCapacity(ctx, req) { user(req); return ok(await listCapacity(ctx.db)); },
  async setCapacity(ctx, req) {
    const u = user(req); const c = req.body?.capacity;
    return ok(await setCapacity(ctx.db, { actorRef: u.actorRef, assistantId: uuid(req.params.id, "assistant_id"), capacity: c === null || c === "" || c === undefined ? null : Number(c), now: ctx.now() }));
  },
  async setAssistantPaused(ctx, req) {
    const u = user(req); if (typeof req.body?.paused !== "boolean") throw new LumiError("VALIDATION_ERROR", 400, { missing: ["paused(boolean)"] });
    return ok(await setAssistantPaused(ctx.db, { actorRef: u.actorRef, assistantId: uuid(req.params.id, "assistant_id"), paused: req.body.paused, now: ctx.now() }));
  },
  async transferWork(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    return ok(await transferWork(ctx.db, { actorRef: u.actorRef, fromId: uuid(b.from_id, "from_id"), toId: uuid(b.to_id, "to_id"), taskIds: Array.isArray(b.task_ids) ? b.task_ids.map(String) : undefined, reason: String(b.reason ?? ""), now: ctx.now() }));
  },
  async listFunds(ctx, req) { user(req); return ok(await fundsOverview(ctx.db)); },
  async setPrepFund(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    return ok(await setPrepFund(ctx.db, { actorRef: u.actorRef, scope: String(b.scope ?? ""), assistantId: b.assistant_id ? uuid(b.assistant_id, "assistant_id") : undefined, amount: Number(b.amount), periodStart: String(b.period_start ?? ""), periodEnd: String(b.period_end ?? ""), note: typeof b.note === "string" ? b.note : undefined, now: ctx.now() }), 201);
  },
  async changePlanLead(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    return ok(await changePlanLead(ctx.db, { actorRef: u.actorRef, planId: uuid(req.params.id, "plan_id"), newLeadId: uuid(b.new_lead_id, "new_lead_id"), reason: String(b.reason ?? ""), now: ctx.now() }));
  },
  async planLeadHistory(ctx, req) { user(req); return ok({ history: await leadHistory(ctx.db, uuid(req.params.id, "plan_id")) }); },
  async knowledgeGraph(ctx, req) { user(req); return ok(await knowledgeGraph(ctx.db)); },
  async knowledgeConflicts(ctx, req) { user(req); return ok(await knowledgeConflicts(ctx.db)); },
  async lastLinkChecks(ctx, req) { user(req); return ok({ checks: await lastLinkChecks(ctx.db) }); },
  async checkKnowledgeLinks(ctx, req) { const u = user(req); return ok(await checkKnowledgeLinks(ctx.db, { actorRef: u.actorRef, limit: req.body?.limit ? Number(req.body.limit) : undefined, now: ctx.now() })); },
};
