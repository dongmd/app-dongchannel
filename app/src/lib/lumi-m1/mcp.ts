/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC payloads are validated field by field */
/**
 * Minimal MCP server logic (JSON-RPC 2.0 over HTTP) for the Hermes test profile. LEAST PRIVILEGE BY CONSTRUCTION:
 *  - a small FIXED tool set (no tool to approve/decide, confirm, adopt, cancel, retry, dispatch); there is NO tool to confirm a draft, approve/decide, adopt, cancel, retry, dispatch or read anything else;
 *  - the caller is a bot principal bound to ONE assistant (service token). Identity of the bot is never taken from tool arguments;
 *  - tasks_intake only creates a DRAFT (same code path as POST /tasks/intake); a person confirms on the web (TDD 8.6.9);
 *  - outputs_submit takes the TASK from the run, uses a server-derived idempotency key (one submission per run) and the core
 *    checks the run belongs to this bot; the model cannot pick another task or run;
 *  - knowledge_context returns only the brief of the run's own task (there is no knowledge base before M3).
 * Arguments come from a language model, so they are treated as untrusted input.
 */
import { createHash } from "node:crypto";
import { ackRun, LumiError } from "./core";
import { handle, type ApiCtx, type Principal } from "./handlers";
import { addPlanItem, proposeProject, requestAction, taskPlanContext, updatePlanItem } from "./autonomy";
import { recordPlanRejection, submitPlanVersion } from "./plans";
import { fieldHint } from "./plan-schema";
import { proposeHandoff, proposeReassign, respondHandoff } from "./coordination";
import { proposeKnowledge, searchKnowledge } from "./knowledge";
import { packText } from "./knowledge-pack";
import { contribute, respondAction, synthesizeMeeting } from "./meetings";

export const MCP_TOOLS = [
  {
    name: "knowledge_context",
    description: "Đọc bản mô tả của ĐÚNG lượt chạy được giao (tiêu đề, mô tả, yêu cầu sửa, bản trước). Gọi đầu tiên khi bắt đầu một lượt chạy. Không đọc được thứ gì khác.",
    inputSchema: { type: "object", properties: { run_id: { type: "string", description: "run_id trong lệnh được giao" } }, required: ["run_id"], additionalProperties: false },
  },
  {
    name: "outputs_submit",
    description: "Nộp đầu ra (một lần duy nhất) cho đúng lượt chạy được giao. Không có quyền duyệt hay hoàn thành việc.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, content: { type: "string", description: "Nội dung đầu ra, tối đa 20000 ký tự" }, final: { type: "boolean", description: "true (mặc định) = đầu ra cuối để Chủ duyệt. false = ĐIỂM DỪNG: lưu tiến độ và hệ thống mở lần chạy tiếp (trong giới hạn)." } }, required: ["run_id", "content"], additionalProperties: false },
  },
  {
    name: "plan_add",
    description: "Ghi một bước của kế hoạch thành việc con của việc đang làm (một cấp, có giới hạn số lượng). Dùng để lập kế hoạch và báo tiến độ.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, title: { type: "string" }, description: { type: "string" } }, required: ["run_id", "title"], additionalProperties: false },
  },
  {
    name: "plan_update",
    description: "Cập nhật trạng thái một việc con của bạn: RUNNING, COMPLETED, FAILED hoặc SKIPPED, kèm ghi chú ngắn.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, code: { type: "string", description: "Mã việc con, ví dụ DL-012" }, state: { type: "string", enum: ["RUNNING", "COMPLETED", "FAILED", "SKIPPED"] }, note: { type: "string" } }, required: ["run_id", "code", "state"], additionalProperties: false },
  },
  {
    name: "project_propose",
    description: "Đề xuất một cơ hội/dự án MỚI ở trạng thái ĐỀ XUẤT (kèm bằng chứng). Chưa kích hoạt, chưa chi tiền, chưa cam kết gì; Chủ quyết định kích hoạt.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, name: { type: "string" }, area: { type: "string", enum: ["AFFILIATE", "YOUTUBE", "WEBSITE", "OTHER"] }, goal: { type: "string" }, evidence: { type: "string", description: "Bằng chứng và nguồn, tối thiểu 10 ký tự" } }, required: ["run_id", "name", "area", "goal", "evidence"], additionalProperties: false },
  },
  {
    name: "actions_request",
    description: "XIN QUYỀN trước một hành động ra bên ngoài (chi tiền, đăng, nộp đăng ký, xóa…). Trả ĐƯỢC PHÉP (trong quyền Chủ đã cấp), CẦN CHỦ QUYẾT ĐỊNH hoặc KHÔNG ĐƯỢC. Chỉ thực hiện khi được phép. Dự án lấy từ việc đang làm.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, action_type: { type: "string" }, account_ref: { type: "string", description: "Tài khoản/đối tượng, ví dụ google-ads:123, wordpress:dongchannel.com" }, amount: { type: "number" }, currency: { type: "string" }, summary: { type: "string" }, params: { type: "object" }, request_id: { type: "string", description: "Mã yêu cầu đã được Chủ duyệt, để dùng quyền một lần" } }, required: ["run_id", "action_type", "account_ref", "summary"], additionalProperties: true },
  },
  {
    name: "plan_submit_version",
    description: "Chỉ khi việc của bạn là LẬP PLAN & COST: nộp một phiên bản kế hoạch (body theo lược đồ v1, xem mô tả việc). Công cụ KIỂM LƯỢC ĐỒ và trả danh sách trường lỗi nếu sai — sửa và gọi lại trong cùng lượt. Không có quyền duyệt kế hoạch hay chi tiền; Chủ duyệt.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, body: { type: "object", description: "Plan & Cost v1 (schema=1): summary, opportunity, scope, deliverables, tasks, milestones, cost, prepare_spent, grants_requested=[], stop_conditions, risks, alternatives" } }, required: ["run_id", "body"], additionalProperties: true },
  },
  {
    name: "handoff_propose",
    description: "Bàn giao một phần việc cho TRỢ LÝ KHÁC qua ứng dụng (không nhắn trực tiếp giữa bot). Chỉ khi mức quyền của bạn cho phép và là việc của bạn. Hệ thống kiểm tra bên nhận trước khi tạo; nếu bị từ chối sẽ nêu lý do và gợi ý. Việc mới ở trạng thái CHỜ cho đến khi đầu ra của việc hiện tại được Chủ duyệt.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, to: { type: "string", description: "slug của trợ lý nhận, ví dụ yt" }, title: { type: "string" }, request: { type: "string", description: "Yêu cầu rõ ràng cho bên nhận (3..4000 ký tự)" }, expected_output: { type: "string" }, acceptance: { type: "string" }, required_skill: { type: "string" } }, required: ["run_id", "to", "title", "request"], additionalProperties: false },
  },
  {
    name: "handoff_respond",
    description: "Bên NHẬN trả lời một bàn giao trong chính lượt chạy của việc được bàn giao: ACCEPT, REJECT (kèm lý do) hoặc NEED_INFO (kèm câu hỏi). Từ chối hay xin thêm thông tin sẽ chuyển cho Chủ quyết định; không tự đẩy lại cho bên gửi.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, handoff_code: { type: "string", description: "Mã bàn giao, ví dụ HO-001" }, decision: { type: "string", enum: ["ACCEPT", "REJECT", "NEED_INFO"] }, text: { type: "string" } }, required: ["run_id", "handoff_code", "decision"], additionalProperties: false },
  },
  {
    name: "pm_propose_reassign",
    description: "Chỉ dành cho PM của dự án: ĐỀ XUẤT đổi người nhận một việc trong dự án. Chủ duyệt (trừ khi Chủ đã bật tự áp dụng cho dự án này). Không có quyền tự đổi.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, task_code: { type: "string", description: "Mã việc, ví dụ DL-012" }, to: { type: "string", description: "slug trợ lý nhận" }, reason: { type: "string" } }, required: ["run_id", "task_code", "to", "reason"], additionalProperties: false },
  },
  {
    name: "knowledge_propose",
    description: "ĐỀ XUẤT một ghi chú/quyết định/quy tắc vào kho kiến thức (không bao giờ có hiệu lực ngay: Chủ duyệt). Phải có ít nhất một nguồn hoặc lý do ≥ 10 ký tự. Chỉ trong dự án/mảng bạn tham gia. Ghi dữ kiện dự án qua công cụ này, không qua bộ nhớ riêng.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, kind: { type: "string", enum: ["NOTE", "DECISION", "RULE"] }, scope: { type: "string", enum: ["PROJECT", "AREA"] }, scope_ref: { type: "string", description: "Mặc định: dự án của việc đang làm. AREA: AFFILIATE|YOUTUBE|WEBSITE|OTHER" }, title: { type: "string" }, content: { type: "string" }, reason: { type: "string" }, confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] }, sources: { type: "array", items: { type: "object", properties: { title: { type: "string" }, ref: { type: "string" }, supports: { type: "string" } } } }, supersedes_code: { type: "string", description: "Mã mục đang hiệu lực mà đề xuất này muốn thay thế, ví dụ KN-003" } }, required: ["run_id", "kind", "title", "content"], additionalProperties: false },
  },
  {
    name: "knowledge_search",
    description: "Tìm trong kiến thức ĐÃ DUYỆT mà bạn được phép đọc (từ khóa, có bỏ dấu). Mỗi lần đọc được ghi nhật ký.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, q: { type: "string" }, kind: { type: "string", enum: ["NOTE", "DECISION", "RULE"] } }, required: ["run_id", "q"], additionalProperties: false },
  },
  {
    name: "meeting_contribute",
    description: "Chỉ trong việc 'Họp MT-nnn: đóng góp ý kiến': nộp đóng góp có cấu trúc (lập trường, bằng chứng, rủi ro, ước tính, phản đối, đề xuất). Không có chat tự do. Im lặng không được coi là đồng ý.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, round: { type: "integer" }, stance: { type: "string" }, evidence: { type: "string" }, risks: { type: "string" }, estimate: { type: "string" }, objection: { type: "string" }, proposal: { type: "string" } }, required: ["run_id", "stance"], additionalProperties: false },
  },
  {
    name: "meeting_synthesize",
    description: "Chỉ CHỦ TRÌ, trong việc 'Họp MT-nnn: tổng hợp biên bản': nộp biên bản (mỗi dòng trỏ về mã đóng góp gốc) và danh sách kết luận. Hệ thống tự phân loại từng kết luận (ghi nhận / quyết định nội bộ trong biên / đề xuất cần Chủ); bạn không tự quyết định loại. Kết luận không tự mở rộng ngân sách hay quyền.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, summary: { type: "string" }, lines: { type: "array", items: { type: "object", properties: { text: { type: "string" }, contribution_ids: { type: "array", items: { type: "string" } } }, required: ["text", "contribution_ids"] } }, conclusions: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["RECORD", "ACTION_ITEM", "REASSIGN_TASK", "BUDGET_CHANGE", "GRANT_REQUEST", "SCOPE_CHANGE", "EXTERNAL_COMMITMENT", "KNOWLEDGE"] }, text: { type: "string" }, depends_on_expertise: { type: "string" }, payload: { type: "object" } }, required: ["type", "text"] } } }, required: ["run_id", "summary", "lines", "conclusions"], additionalProperties: false },
  },
  {
    name: "meeting_action_respond",
    description: "Trả lời một nhiệm vụ sau họp giao cho bạn: ACCEPT hoặc DECLINE (kèm lý do). Việc chỉ được gửi cho bạn sau khi bạn nhận.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, meeting_code: { type: "string" }, item_key: { type: "string" }, decision: { type: "string", enum: ["ACCEPT", "DECLINE"] }, reason: { type: "string" } }, required: ["run_id", "meeting_code", "item_key", "decision"], additionalProperties: false },
  },
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const noHeaders = { get: () => null };
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export function intakeSourceKey(slug: string, actorRef: string, body: string, now: Date): string {
  // Server-derived: a model-supplied key would let a paraphrase create a second draft. Same actor + same text on the same UTC day = one draft.
  const norm = body.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return `mcp:${slug}:${actorRef}:${now.toISOString().slice(0, 10)}:${createHash("sha256").update(norm).digest("hex").slice(0, 24)}`;
}

export interface McpOptions { actorFor?: (slug: string) => string | undefined } // kept for compatibility; intake no longer goes through the model

/**
 * Draft intake for a chat message, called by the GATEWAY HOOK (deterministic, no model) — not by a model tool.
 * Why: a language model was observed to claim it had called the intake tool (and to invent its result) without calling it.
 * Identity is the platform's own sender id (`user_id` from the Hermes gateway), not anything the model wrote. The same draft is
 * produced for the same actor + text on the same UTC day (server-derived key), so retries and duplicates never create a second draft.
 * Returns the exact text to show the person; it is built here from the real result, never by a model.
 */
export async function intakeFromChat(ctx: ApiCtx, p: Extract<Principal, { kind: "bot" }>, platformUserId: string, body: string): Promise<{ ok: boolean; reply: string; draftId?: string }> {
  const actor = `telegram:${platformUserId.replace(/[^0-9a-zA-Z_-]/g, "")}`;
  if (!platformUserId || !body.trim()) return { ok: false, reply: "Thiếu người gửi hoặc nội dung." };
  if (body.length > 4000) return { ok: false, reply: "Tin quá dài (tối đa 4000 ký tự)." };
  const r = await handle("intake", ctx, { principal: p, params: {}, body: { source_key: intakeSourceKey(p.slug, actor, body, ctx.now()), actor_ref: actor, text: body }, headers: noHeaders });
  if (r.error) return { ok: false, reply: r.error.code === "FORBIDDEN" ? "Bạn không có quyền giao việc qua bot này." : `Không tạo được bản nháp (${r.error.code}).` };
  if (r.data.no_task) return { ok: true, reply: "Không phải lệnh giao việc rõ ràng. Hãy bắt đầu bằng «Giao việc: …» và nêu tên dự án và người nhận." };
  const miss = (r.data.missing as string[]).length ? ` Còn thiếu: ${(r.data.missing as string[]).join(", ")} (sửa trên web).` : "";
  return { ok: true, draftId: r.data.draft_id, reply: `Đã tạo BẢN NHÁP (chưa phải việc), mã ${r.data.confirm.reply_hint}.${miss} Mở Dong-Lumi → Telegram & kết nối và bấm Xác nhận để tạo việc.` };
}

async function callTool(ctx: ApiCtx, p: Extract<Principal, { kind: "bot" }>, name: string, args: any, _opts: McpOptions) {
  if (["handoff_propose", "handoff_respond", "pm_propose_reassign"].includes(name)) {
    const runId = typeof args?.run_id === "string" ? args.run_id : "";
    if (!UUID.test(runId)) return text("run_id không hợp lệ.", true);
    const [run] = await ctx.db.query<any>(`SELECT r.id,r.state,r.task_id,r.assistant_id,a.slug FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id WHERE r.id=$1`, [runId]);
    if (!run || run.slug !== p.slug) return text("Không tìm thấy lượt chạy được giao cho bạn.", true);
    if (!["DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"].includes(run.state)) return text(`Lượt chạy không còn mở (trạng thái ${run.state}). Dừng ngay.`, true);
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const target = async (slug: string) => (await ctx.db.query<any>(`SELECT id FROM lumi_assistants WHERE slug=$1 AND status='ACTIVE'`, [slug]))[0];
    const key = (...parts: string[]) => `mcp:${name}:${runId}:${createHash("sha256").update(parts.join("\u0001").normalize("NFC")).digest("hex").slice(0, 24)}`;
    try {
      if (name === "handoff_propose") {
        const to = await target(s(args.to));
        if (!to) return text("Không có trợ lý nhận với mã đó (hoặc đã lưu trữ). Không bàn giao.", true);
        const r = await proposeHandoff(ctx.db, { sourceTaskId: run.task_id, toAssistantId: to.id, title: s(args.title), request: s(args.request), expectedOutput: s(args.expected_output) || undefined, acceptance: s(args.acceptance) || undefined, requiredSkill: s(args.required_skill) || undefined, by: { actorRef: p.actorRef, assistantId: run.assistant_id }, idempotencyKey: key(s(args.to), s(args.title), s(args.request)), now: ctx.now() });
        return text(`${r.alreadyProcessed ? "Bàn giao này đã tạo trước đó" : "Đã tạo bàn giao"} ${r.handoff.code} → việc ${r.task.code} (đang CHỜ đầu ra của việc hiện tại được Chủ duyệt). Không nhắn trực tiếp cho bên nhận; tiếp tục phần việc của bạn.`);
      }
      if (name === "handoff_respond") {
        const [h] = await ctx.db.query<any>(`SELECT code FROM lumi_handoffs WHERE code=$1 AND new_task_id=$2`, [s(args.handoff_code), run.task_id]);
        if (!h) return text("Bàn giao này không thuộc việc của lượt chạy hiện tại.", true);
        if (!["ACCEPT", "REJECT", "NEED_INFO"].includes(s(args.decision))) return text("decision phải là ACCEPT, REJECT hoặc NEED_INFO.", true);
        const r = await respondHandoff(ctx.db, { botAssistantId: run.assistant_id, actorRef: p.actorRef, handoffCode: h.code, decision: s(args.decision) as any, text: s(args.text) || undefined, now: ctx.now() });
        return text(r.alreadyProcessed ? "Đã trả lời như vậy trước đó." : r.handoff.state === "ACCEPTED" ? "Đã nhận bàn giao. Làm việc rồi nộp đầu ra như bình thường." : `Đã ghi (${r.handoff.state}); việc chuyển cho Chủ quyết định. Dừng lượt này, không nộp đầu ra.`);
      }
      const to = await target(s(args.to));
      if (!to) return text("Không có trợ lý nhận với mã đó (hoặc đã lưu trữ).", true);
      const r = await proposeReassign(ctx.db, { pmAssistantId: run.assistant_id, actorRef: p.actorRef, taskCode: s(args.task_code), toAssistantId: to.id, reason: s(args.reason), idempotencyKey: key(s(args.task_code), s(args.to), s(args.reason)), now: ctx.now() });
      return text(`${r.alreadyProcessed ? "Đề xuất đã có" : "Đã ghi đề xuất"} (${r.proposal.state}). Chủ quyết định; bạn không tự đổi được.`);
    } catch (e) {
      if (e instanceof LumiError && e.code === "CHECK_FAILED") {
        const rs = ((e.data.reasons as { code: string; text: string; suggestion: string }[]) ?? []).map((x) => `- ${x.code}: ${x.text} Gợi ý: ${x.suggestion}`).join("\n");
        return text(`BÀN GIAO BỊ TỪ CHỐI (chưa tạo gì). Lý do:\n${rs}\nChủ đã được báo. Không thử đi vòng; tiếp tục phần việc của bạn.`, true);
      }
      if (e instanceof LumiError) return text(`Không thực hiện được: ${e.code}${e.data && Object.keys(e.data).length ? " " + JSON.stringify(e.data) : ""}`, true);
      throw e;
    }
  }
  if (["knowledge_propose", "knowledge_search", "meeting_contribute", "meeting_synthesize", "meeting_action_respond"].includes(name)) {
    const runId = typeof args?.run_id === "string" ? args.run_id : "";
    if (!UUID.test(runId)) return text("run_id không hợp lệ.", true);
    const [run] = await ctx.db.query<any>(`SELECT r.id,r.state,r.task_id,r.assistant_id,a.slug,t.project_id FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id JOIN tasks t ON t.id=r.task_id WHERE r.id=$1`, [runId]);
    if (!run || run.slug !== p.slug) return text("Không tìm thấy lượt chạy được giao cho bạn.", true);
    if (!["DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"].includes(run.state)) return text(`Lượt chạy không còn mở (trạng thái ${run.state}). Dừng ngay.`, true);
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    try {
      if (name === "knowledge_propose") {
        const scope = s(args.scope) || "PROJECT";
        let supersedes: string | undefined;
        if (s(args.supersedes_code)) { const [x] = await ctx.db.query<any>(`SELECT id FROM lumi_knowledge_items WHERE code=$1`, [s(args.supersedes_code)]); if (!x) return text("Không có mục kiến thức để thay thế với mã đó.", true); supersedes = x.id; }
        const r = await proposeKnowledge(ctx.db, { actorRef: p.actorRef, assistantId: run.assistant_id, kind: s(args.kind) as any, scope: scope as any, scopeRef: s(args.scope_ref) || (scope === "PROJECT" ? run.project_id : undefined), title: s(args.title), content: s(args.content), reason: s(args.reason) || undefined, confidence: (s(args.confidence) || undefined) as any, sources: Array.isArray(args.sources) ? args.sources.map((x: any) => ({ title: s(x?.title), ref: s(x?.ref) || undefined, supports: s(x?.supports) || undefined })) : undefined, supersedesItemId: supersedes, now: ctx.now() });
        return text(`${r.alreadyProcessed ? "Đề xuất này đã có" : "Đã ghi đề xuất"} ${r.item.code} (CHỜ CHỦ DUYỆT; chưa có hiệu lực, bạn không dùng nó như quy tắc).${r.warnings.length ? `\nLưu ý: ${r.warnings.join(" | ")}` : ""}`);
      }
      if (name === "knowledge_search") {
        const rows = await searchKnowledge(ctx.db, { viewer: { kind: "bot", assistantId: run.assistant_id }, q: s(args.q), kind: s(args.kind) || undefined, limit: 8, now: ctx.now() });
        return text(rows.length ? rows.map((r: any) => `- [${r.code} v${r.version}] ${r.title}: ${String(r.content).slice(0, 600)}`).join("\n") : "Không có kiến thức đã duyệt phù hợp mà bạn được phép đọc.");
      }
      if (name === "meeting_contribute") {
        const [m] = await ctx.db.query<any>(`SELECT m.code FROM lumi_meeting_participants mp JOIN lumi_meetings m ON m.id=mp.meeting_id WHERE mp.task_id=$1`, [run.task_id]);
        if (!m) return text("Việc này không phải việc đóng góp cho một cuộc họp.", true);
        const r = await contribute(ctx.db, { meetingCode: m.code, actorRef: p.actorRef, assistantId: run.assistant_id, round: Number.isInteger(args.round) ? args.round : undefined, stance: s(args.stance), evidence: s(args.evidence) || undefined, risks: s(args.risks) || undefined, estimate: s(args.estimate) || undefined, objection: s(args.objection) || undefined, proposal: s(args.proposal) || undefined, now: ctx.now() });
        return text(r.alreadyProcessed ? "Đóng góp này đã được ghi trước đó. Dừng." : r.late ? "Đã lưu đóng góp MUỘN (họp đã quá hạn/đóng): không đổi kết luận đã ghi. Dừng." : "Đã ghi đóng góp. Dừng lại, không làm gì thêm.");
      }
      if (name === "meeting_synthesize") {
        const [m] = await ctx.db.query<any>(`SELECT code FROM lumi_meetings WHERE synth_task_id=$1`, [run.task_id]);
        if (!m) return text("Việc này không phải việc tổng hợp biên bản của một cuộc họp.", true);
        const r = await synthesizeMeeting(ctx.db, { meetingCode: m.code, actorRef: p.actorRef, assistantId: run.assistant_id, summary: s(args.summary), lines: Array.isArray(args.lines) ? args.lines : [], conclusions: Array.isArray(args.conclusions) ? args.conclusions : [], now: ctx.now() });
        return text(`Đã ghi biên bản v${r.note_version}. Kết quả cuộc họp: ${r.outcome}${r.missing_expertise.length ? ` (thiếu ý kiến chuyên môn: ${r.missing_expertise.join(", ")})` : ""}. Hệ thống đã phân loại kết luận: ${r.applied} nội bộ đã áp dụng, ${r.pending} đề xuất chờ Chủ, ${r.blocked} bị chặn. Dừng lại.`);
      }
      const r = await respondAction(ctx.db, { meetingCode: s(args.meeting_code), itemKey: s(args.item_key), assistantId: run.assistant_id, actorRef: p.actorRef, decision: s(args.decision) as any, reason: s(args.reason) || undefined, now: ctx.now() });
      return text(r.alreadyProcessed ? "Đã trả lời như vậy trước đó." : s(args.decision) === "ACCEPT" ? "Đã nhận nhiệm vụ; việc được gửi cho bạn như một việc thường." : "Đã từ chối kèm lý do; trưởng kế hoạch/Chủ sẽ xử lý.");
    } catch (e) {
      if (e instanceof LumiError && e.code === "VALIDATION_ERROR") return text(`Dữ liệu chưa hợp lệ: ${JSON.stringify(e.data)}`, true);
      if (e instanceof LumiError) return text(`Không thực hiện được: ${e.code}${e.data && Object.keys(e.data).length ? " " + JSON.stringify(e.data) : ""}`, true);
      throw e;
    }
  }
  if (name === "plan_submit_version") {
    const runId = typeof args?.run_id === "string" ? args.run_id : "";
    if (!UUID.test(runId)) return text("run_id không hợp lệ.", true);
    try {
      const r = await submitPlanVersion(ctx.db, { runId, botSlug: p.slug, body: args?.body, now: ctx.now() });
      return text(r.alreadyProcessed ? `Lượt này đã nộp phiên bản ${r.version.version} trước đó; không nộp lại. Dừng.` : `Đã nộp phiên bản ${r.version.version}, chờ Chủ duyệt. Dừng lại, không làm gì thêm.`);
    } catch (e) {
      if (e instanceof LumiError && e.code === "VALIDATION_ERROR") await recordPlanRejection(ctx.db, { runId, errors: (e.data.errors as string[]) ?? [], now: ctx.now() }).catch(() => undefined);
      if (e instanceof LumiError && e.code === "VALIDATION_ERROR") return text(`Body KHÔNG hợp lệ, chưa lưu gì. Sửa các trường sau rồi gọi lại plan_submit_version:\n${((e.data.errors as string[]) ?? []).map((x) => { const h = fieldHint(x); return h ? `- ${x}: cần ${h}` : `- ${x}`; }).join("\n")}`, true);
      if (e instanceof LumiError) return text(`Không nộp được: ${e.code}${e.data && Object.keys(e.data).length ? " " + JSON.stringify(e.data) : ""}`, true);
      throw e;
    }
  }
  if (["plan_add", "plan_update", "project_propose", "actions_request"].includes(name)) {
    const runId = typeof args?.run_id === "string" ? args.run_id : "";
    if (!UUID.test(runId)) return text("run_id không hợp lệ.", true);
    const [run] = await ctx.db.query<any>(`SELECT r.id,r.state,r.task_id,r.assistant_id,a.slug,t.project_id FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id JOIN tasks t ON t.id=r.task_id WHERE r.id=$1`, [runId]);
    if (!run || run.slug !== p.slug) return text("Không tìm thấy lượt chạy được giao cho bạn.", true);
    if (!["DISPATCHED", "DISPATCH_UNCERTAIN", "RUNNING"].includes(run.state)) return text(`Lượt chạy không còn mở (trạng thái ${run.state}). Dừng ngay.`, true);
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    try {
      if (name === "plan_add") { const r = await addPlanItem(ctx.db, { assistantId: run.assistant_id, runId, title: s(args.title), description: s(args.description) || undefined, now: ctx.now() }); return text(`${r.alreadyProcessed ? "Đã có" : "Đã ghi"} việc con ${r.item.code} (${r.item.status}).`); }
      if (name === "plan_update") { const r = await updatePlanItem(ctx.db, { assistantId: run.assistant_id, runId, code: s(args.code), state: s(args.state) as any, note: s(args.note) || undefined, now: ctx.now() }); return text(r.alreadyProcessed ? "Trạng thái đã đúng như vậy." : "Đã cập nhật."); }
      if (name === "project_propose") { const r = await proposeProject(ctx.db, { assistantId: run.assistant_id, name: s(args.name), area: s(args.area), goal: s(args.goal), evidence: s(args.evidence), now: ctx.now() }); return text(`${r.alreadyProcessed ? "Đề xuất trùng tên đã có" : "Đã ghi đề xuất"} (trạng thái ĐỀ XUẤT; chưa kích hoạt, Chủ quyết định).`); }
      const d = await requestAction(ctx.db, { assistantId: run.assistant_id, projectId: run.project_id, accountRef: s(args.account_ref), actionType: s(args.action_type), amount: typeof args.amount === "number" ? args.amount : undefined, currency: s(args.currency) || undefined, summary: s(args.summary), params: args.params, taskId: run.task_id, runId, requestId: s(args.request_id) || undefined, now: ctx.now() });
      if (d.decision === "ALLOW") return text(`ĐƯỢC PHÉP (${d.reason}). Thực hiện đúng phạm vi đã xin, không hơn.`);
      if (d.decision === "ASK") return text(`CẦN CHỦ QUYẾT ĐỊNH (${d.basis}). Mã yêu cầu ${d.requestId}. KHÔNG thực hiện hành động này. Làm tiếp phần việc khác; khi Chủ đã duyệt, gọi lại với request_id này và đúng các tham số cũ.`);
      return text(`KHÔNG ĐƯỢC PHÉP (${d.reason}). Dừng hành động này.`, true);
    } catch (e) {
      if (e instanceof LumiError) return text(`Không thực hiện được: ${e.code}${e.data && Object.keys(e.data).length ? " " + JSON.stringify(e.data) : ""}`, true);
      throw e;
    }
  }
  if (name === "knowledge_context" || name === "outputs_submit") {
    const runId = typeof args?.run_id === "string" ? args.run_id : "";
    if (!UUID.test(runId)) return text("run_id không hợp lệ.", true);
    const [run] = await ctx.db.query<any>(`SELECT r.*, a.slug, t.code, t.title, t.description, t.expected_output, t.current_output_id, p.name AS project FROM lumi_task_runs r JOIN lumi_assistants a ON a.id=r.assistant_id JOIN tasks t ON t.id=r.task_id LEFT JOIN lumi_projects p ON p.id=t.project_id WHERE r.id=$1`, [runId]);
    if (!run || run.slug !== p.slug) return text("Không tìm thấy lượt chạy được giao cho bạn.", true); // identical answer for unknown and someone else's
    if (name === "knowledge_context") {
      if (["DISPATCHED", "DISPATCH_UNCERTAIN"].includes(run.state)) await ackRun(ctx.db, p.slug, runId, ctx.now()); // first call = Hermes confirms it started
      else if (run.state !== "RUNNING") return text(`Lượt chạy không còn mở (trạng thái ${run.state}). Dừng ngay, không nộp gì.`, true);
      let prev = "";
      if (run.run_kind === "REVISION" && run.current_output_id) {
        const [o] = await ctx.db.query<any>(`SELECT version,content FROM lumi_task_outputs WHERE id=$1`, [run.current_output_id]);
        const [ap] = await ctx.db.query<any>(`SELECT reason FROM lumi_approvals WHERE object_id=$1 AND decision='REVISE' ORDER BY decided_at DESC LIMIT 1`, [run.current_output_id]);
        prev = `\nBản trước (v${o?.version}):\n${o?.content ?? ""}\nLý do chủ yêu cầu sửa: ${ap?.reason ?? "(không ghi)"}`;
      }
      const instr = run.instruction_snapshot?.instruction ? `\nHướng dẫn thêm: ${run.instruction_snapshot.instruction}` : "";
      const kn = run.instruction_snapshot?.knowledge; const knText = kn?.items?.length ? `\n${packText(kn.items.map((i: any) => ({ ...i, item_id: i.code, scope_ref: null })), kn.truncated === true)}` : "";
      const plan = await taskPlanContext(ctx.db, run.task_id);
      const cps = plan.checkpoints.length ? `\nĐiểm dừng trước (tiếp tục từ đây, đừng làm lại):\n${plan.checkpoints.map((c: any) => `- v${c.version}: ${c.content}`).join("\n")}` : "";
      const items = plan.items.length ? `\nKế hoạch hiện có:\n${plan.items.map((i: any) => `- ${i.code} [${i.status}] ${i.title}`).join("\n")}` : "";
      return text(`Việc ${run.code} (${run.run_kind}) — dự án ${run.project ?? "?"}\nTiêu đề: ${run.title}\nMô tả: ${run.description ?? "(không có)"}\nĐầu ra mong đợi: ${run.expected_output ?? "(không nêu)"}${instr}${prev}${cps}${items}${knText}\nKhi xong, gọi outputs_submit (final=true) đúng MỘT lần với run_id=${runId}. Việc dài: gọi outputs_submit với final=false để lưu điểm dừng.`);
    }
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim() || content.length > 20000) return text("content rỗng hoặc quá 20000 ký tự.", true);
    const r = await handle("submitOutput", ctx, { principal: p, params: { id: run.task_id }, body: { run_id: runId, content, idempotency_key: `mcp:run:${runId}`, final: args?.final === false ? false : true }, headers: noHeaders });
    if (r.error) return text(`Không nộp được: ${r.error.code}`, true);
    if (r.data.checkpoint === "CONTINUING") return text(`Đã lưu điểm dừng (bản ${r.data.version}). Hệ thống sẽ mở lần chạy tiếp; dừng lượt này.`);
    if (r.data.checkpoint === "LIMIT_REACHED") return text(`Đã lưu điểm dừng (bản ${r.data.version}) nhưng hết số lần tiếp tục cho phép: việc chuyển sang chờ Chủ quyết định. Dừng lại.`);
    return text(r.data.late ? "Đã lưu kết quả muộn (lượt chạy đã đóng); chủ sẽ quyết định có dùng hay không." : r.data.already_processed ? "Lượt chạy này đã nộp trước đó; không nộp lại." : `Đã nộp bản ${r.data.version}. Dừng lại, không làm gì thêm.`);
  }
  return text(`Công cụ không tồn tại: ${name}`, true);
}

/** One JSON-RPC message. Returns null for notifications. `principal` must already be authenticated (bot). */
export async function handleRpc(ctx: ApiCtx, principal: Extract<Principal, { kind: "bot" }>, msg: any, opts: McpOptions = { actorFor: () => undefined }): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: any) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(-32600, "Invalid Request");
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({ protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "dong-lumi-m1", version: "0.1.0" } });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: MCP_TOOLS });
    case "tools/call": {
      try { return reply(await callTool(ctx, principal, String(msg.params?.name), msg.params?.arguments ?? {}, opts)); }
      catch (e) {
        if (e instanceof LumiError) return reply(text(`Lỗi ${e.code}`, true));
        console.error("[mcp] tool error", (e as Error)?.message ?? e); // server log only (no secrets in SQL errors); the model gets a generic text
        return reply(text("Lỗi hệ thống", true)); // never leak internals to the model
      }
    }
    default: return err(-32601, "Method not found");
  }
}
