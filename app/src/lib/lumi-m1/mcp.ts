/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC payloads are validated field by field */
/**
 * Minimal MCP server logic (JSON-RPC 2.0 over HTTP) for the Hermes test profile. LEAST PRIVILEGE BY CONSTRUCTION:
 *  - exactly three tools; there is NO tool to confirm a draft, approve/decide, adopt, cancel, retry, dispatch or read anything else;
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

export const MCP_TOOLS = [
  {
    name: "knowledge_context",
    description: "Đọc bản mô tả của ĐÚNG lượt chạy được giao (tiêu đề, mô tả, yêu cầu sửa, bản trước). Gọi đầu tiên khi bắt đầu một lượt chạy. Không đọc được thứ gì khác.",
    inputSchema: { type: "object", properties: { run_id: { type: "string", description: "run_id trong lệnh được giao" } }, required: ["run_id"], additionalProperties: false },
  },
  {
    name: "outputs_submit",
    description: "Nộp đầu ra (một lần duy nhất) cho đúng lượt chạy được giao. Không có quyền duyệt hay hoàn thành việc.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, content: { type: "string", description: "Nội dung đầu ra, tối đa 20000 ký tự" } }, required: ["run_id", "content"], additionalProperties: false },
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
      return text(`Việc ${run.code} (${run.run_kind}) — dự án ${run.project ?? "?"}\nTiêu đề: ${run.title}\nMô tả: ${run.description ?? "(không có)"}\nĐầu ra mong đợi: ${run.expected_output ?? "(không nêu)"}${instr}${prev}\nKhi xong, gọi outputs_submit đúng MỘT lần với run_id=${runId}.`);
    }
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim() || content.length > 20000) return text("content rỗng hoặc quá 20000 ký tự.", true);
    const r = await handle("submitOutput", ctx, { principal: p, params: { id: run.task_id }, body: { run_id: runId, content, idempotency_key: `mcp:run:${runId}` }, headers: noHeaders });
    if (r.error) return text(`Không nộp được: ${r.error.code}`, true);
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
        return reply(text("Lỗi hệ thống", true)); // never leak internals to the model
      }
    }
    default: return err(-32601, "Method not found");
  }
}
