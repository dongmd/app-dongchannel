/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/** Đợt 7 HTTP handlers (autonomy matrix, integration readiness). User-only; roles are enforced in the domain calls. Merged into HANDLERS by handlers.ts. */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { listAutonomyMatrix, setAutonomyRule } from "./autonomy-matrix";
import { integrationsStatus } from "./integrations";
import { decideRoute, listSignals, proposeRoute, scoreSignal, submitSignal } from "./opportunities";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };

export const HANDLERS_IMP07: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  async listAutonomyMatrix(ctx, req) { user(req); return { status: 200, data: await listAutonomyMatrix(ctx.db) }; },
  async setAutonomyRule(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    if (!b.action_type || !b.mode) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["action_type", "mode"].filter((k) => !b[k]) });
    return { status: 200, data: await setAutonomyRule(ctx.db, { actorRef: u.actorRef, actionType: String(b.action_type), mode: String(b.mode), note: typeof b.note === "string" ? b.note : undefined, now: ctx.now() }) };
  },
  async listSignals(ctx, req) { user(req); return { status: 200, data: await listSignals(ctx.db) }; },
  async submitSignal(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    if (!b.kind || !b.title) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["kind", "title"].filter((k) => !b[k]) });
    return { status: 201, data: await submitSignal(ctx.db, { actorRef: u.actorRef, kind: String(b.kind), title: String(b.title), summary: typeof b.summary === "string" ? b.summary : undefined, url: typeof b.url === "string" && b.url ? b.url : undefined, language: typeof b.language === "string" ? b.language : undefined, now: ctx.now() }) };
  },
  async scoreSignal(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    if (typeof b.values !== "object" || b.values === null) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["values"] });
    return { status: 200, data: await scoreSignal(ctx.db, { actorRef: u.actorRef, signalId: uuid(req.params.id, "signal_id"), values: b.values, penaltyReasons: typeof b.penalty_reasons === "object" ? b.penalty_reasons : undefined, now: ctx.now() }) };
  },
  async proposeRoute(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    if (!b.route_type || !b.reason) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["route_type", "reason"].filter((k) => !b[k]) });
    return { status: 201, data: await proposeRoute(ctx.db, { actorRef: u.actorRef, signalId: uuid(req.params.id, "signal_id"), routeType: String(b.route_type), reason: String(b.reason), fitScore: b.fit_score === undefined || b.fit_score === "" ? undefined : Number(b.fit_score), now: ctx.now() }) };
  },
  async decideRoute(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    if (!["ACCEPT", "REJECT"].includes(b.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    return { status: 200, data: await decideRoute(ctx.db, { actorRef: u.actorRef, routeId: uuid(req.params.id, "route_id"), decision: b.decision, notes: typeof b.notes === "string" ? b.notes : undefined, now: ctx.now() }) };
  },
  async integrationsStatus(ctx, req) { user(req); return { status: 200, data: await integrationsStatus(ctx.db) }; },
};
