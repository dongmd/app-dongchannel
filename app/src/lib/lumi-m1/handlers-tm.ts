/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/** Đợt 8 (nhóm 3) HTTP handlers: turn-based meetings (MTG-04). User-only; the owner opens/closes; bots take turns only through the MCP tool. */
import { LumiError } from "./core";
import type { ApiCtx, ApiReq, ApiRes } from "./handlers";
import { closeTurnMeeting, listTurnMeetings, openTurnMeeting } from "./turn-meetings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, name: string): string => { if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] }); return v; };
const user = (req: ApiReq) => { if (!req.principal) throw new LumiError("UNAUTHORIZED", 401); if (req.principal.kind !== "user") throw new LumiError("FORBIDDEN", 403); return req.principal; };

export const HANDLERS_TM: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  async listTurnMeetings(ctx, req) { user(req); return { status: 200, data: { meetings: await listTurnMeetings(ctx.db), note: "Mỗi lượt là một lần chạy bot (có phí). Chi phí chỉ tính số ĐO THẬT; lượt chưa đo đếm riêng. Họp dừng khi chạm số lượt, trần chi phí, hạn giờ hoặc một vòng không có lập trường mới; «chưa kết luận» là kết quả bình thường. Kết luận chỉ là bản ghi cho Chủ, không tự có hiệu lực." } }; },
  async openTurnMeeting(ctx, req) {
    const u = user(req); const b = req.body ?? {};
    return { status: 201, data: await openTurnMeeting(ctx.db, { actorRef: u.actorRef, title: String(b.title ?? ""), question: String(b.question ?? ""), projectId: uuid(b.project_id, "project_id"), speakerIds: Array.isArray(b.speaker_ids) ? b.speaker_ids.map(String) : [], maxTurns: Number(b.max_turns), maxCost: b.max_cost === undefined || b.max_cost === "" ? undefined : Number(b.max_cost), closesAt: new Date(String(b.closes_at ?? "")), now: ctx.now() }) };
  },
  async closeTurnMeeting(ctx, req) { const u = user(req); const r = await closeTurnMeeting(ctx.db, { actorRef: u.actorRef, code: String(req.params.code ?? ""), reason: String(req.body?.reason ?? ""), now: ctx.now() }); return { status: 200, data: r.alreadyProcessed ? { already_processed: true } : { closed: true } }; },
};
