/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are validated field by field below */
/**
 * HTTP contract of TDD 8.6/8.7 as framework-free functions. Route files under app/api/v1 are thin adapters:
 * they resolve the principal (session or service token), call `handle`, and wrap the result. Keeping this layer free of
 * Next lets the SAME code be exercised in-process against a real PostgreSQL server (pg-server tests).
 *
 * Principals:
 *  - user: signed-in person; role comes from the canonical allowlist (resolved by the adapter), mirrored into lumi_actors.
 *  - bot: authenticated by `x-dc-service-token` (constant-time compare) => actor_ref `bot:<slug>`. A bot can NEVER hold
 *    OWNER/ADMIN powers: user-only operations reject it with 403 before touching the core.
 */
import {
  ackRun, adoptLateOutput, cancelTask, confirmDraft, createDraft, decide, discardLateOutput, LumiError, patchDraft, roleOf,
  setDispatchEnabled, setFlag, startRun, submitOutput, acceptHumanTask, type Db, type HermesPort, type Role,
} from "./core";
import { createTask, transitionTask, upsertActor } from "./core-web";
import { createGrant, declareCapability, decideActionRequest, decideProposal, revokeGrant, setAutonomyLimits } from "./autonomy";
import { cancelPlan, closeGoal, companyOverview, createGoal, createPlan, decidePlan, getPlanDetail, reconcileLedger, recordLedger, revisePlan, setPlansEnabled, type PlanDecision } from "./plans";

export type Principal =
  | { kind: "user"; actorRef: string; role: Role }
  | { kind: "bot"; slug: string; actorRef: string };

export interface ApiCtx {
  db: Db;
  hermes: HermesPort;
  now: () => Date;
  /** Rate limiter keyed by actor; returns false when the actor is over its budget. Default: none (adapter supplies one). */
  allow?: (key: string) => boolean;
  /** Draft lifetime for intake (seconds). */
  draftTtlSeconds?: number;
}
export interface ApiReq {
  principal: Principal | null;
  params: Record<string, string>;
  body: any;
  headers: { get(name: string): string | null };
  rawLength?: number;
}
export interface ApiRes { status: number; data: any; error?: { code: string; message: string; details?: any } }

const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "Cần đăng nhập hoặc token dịch vụ",
  FORBIDDEN: "Không đủ quyền",
  NOT_FOUND: "Không tìm thấy",
  VALIDATION_ERROR: "Dữ liệu không hợp lệ",
  STALE_VERSION: "Dữ liệu đã thay đổi, hãy tải lại",
  INVALID_TRANSITION: "Chuyển trạng thái không hợp lệ",
  ALREADY_DECIDED: "Đối tượng đã có quyết định khác",
  GONE: "Đã hết hạn",
  RUN_ACTIVE: "Đang có lần chạy mở",
  RETRY_LIMIT: "Hết lượt thử lại do lỗi",
  REVISION_LIMIT: "Hết vòng sửa",
  CONFIG_INCOMPLETE: "Cấu hình thực thi chưa đủ",
  PROFILE_TOOLS_UNKNOWN: "Không đọc được công cụ của profile",
  PROFILE_EXCEEDS_ALLOWLIST: "Profile có công cụ ngoài danh sách cho phép",
  DAILY_CAP: "Hết hạn mức chạy trong ngày",
  RATE_LIMITED: "Quá nhiều yêu cầu",
  PAYLOAD_TOO_LARGE: "Thân yêu cầu quá lớn",
  M1_DISABLED: "Luồng M1 đang tắt (cờ m1_enabled)",
  PLANS_DISABLED: "Tính năng kế hoạch đang tắt (cờ plans_enabled)",
  PLAN_EXISTS: "Mục tiêu này đã có kế hoạch đang chạy",
  PLAN_CLOSED: "Kế hoạch đã kết thúc",
  PLAN_LIVE: "Mục tiêu còn kế hoạch đang chạy; hủy hoặc hoàn tất kế hoạch trước",
  PLANNING_OPEN: "Đang có việc lập kế hoạch chưa xong",
  NO_BUDGET: "Không đủ ngân sách khả dụng cho phần cam kết",
  CEILING_BELOW_USED: "Trần mới thấp hơn phần đã dùng và cam kết",
  TASK_LOCKED: "Việc đã chạy không được sửa hoặc bỏ",
  PROJECT_NOT_ACTIVE: "Dự án không còn hoạt động",
  RUN_NOT_OPEN: "Lượt chạy không còn mở",
  NOT_LEAD: "Bạn không phải trưởng kế hoạch",
};

export function fail(e: unknown): ApiRes {
  if (e instanceof LumiError) {
    const status = e.code === "GONE" ? 410 : e.status;
    return { status, data: null, error: { code: e.code, message: MESSAGES[e.code] ?? e.code, details: Object.keys(e.data).length ? e.data : undefined } };
  }
  // Unknown error: never leak internals (SQL text, stack) to the client.
  return { status: 500, data: null, error: { code: "INTERNAL", message: "Lỗi hệ thống" } };
}
const ok = (data: any, status = 200): ApiRes => ({ status, data });
const processed = (data: any): ApiRes => ({ status: 200, data: { ...data, already_processed: true } });

function userOnly(p: Principal | null): Extract<Principal, { kind: "user" }> {
  if (!p) throw new LumiError("UNAUTHORIZED", 401);
  if (p.kind !== "user") throw new LumiError("FORBIDDEN", 403); // bots/service tokens never reach user-only operations
  return p;
}
function botOnly(p: Principal | null): Extract<Principal, { kind: "bot" }> {
  if (!p) throw new LumiError("UNAUTHORIZED", 401);
  if (p.kind !== "bot") throw new LumiError("FORBIDDEN", 403);
  return p;
}
function str(v: unknown): string | undefined { return typeof v === "string" && v.length > 0 ? v : undefined; }
function need(b: any, fields: string[]) {
  const missing = fields.filter((f) => b?.[f] === undefined || b?.[f] === null || b?.[f] === "");
  if (missing.length) throw new LumiError("VALIDATION_ERROR", 400, { missing });
}
function idemKey(req: ApiReq): string {
  const k = req.headers.get("idempotency-key");
  if (!k || k.length < 8 || k.length > 128) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["Idempotency-Key"] });
  return k;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new LumiError("VALIDATION_ERROR", 400, { missing: [`${name}(uuid)`] });
  return v;
}

/** Every page of the contract. `bot-or-user` operations pick behaviour by principal kind. */
export const HANDLERS: Record<string, (ctx: ApiCtx, req: ApiReq) => Promise<ApiRes>> = {
  // 8.6.1 — bot only. actor_ref is the human who typed the message; it must be a known OWNER/ADMIN (checked in core).
  async intake(ctx, req) {
    const bot = botOnly(req.principal);
    const b = req.body;
    need(b, ["source_key", "actor_ref", "text"]);
    const [asst] = await ctx.db.query<any>(`SELECT id,slug,connection_state FROM lumi_assistants WHERE slug=$1 AND status='ACTIVE'`, [bot.slug]);
    if (!asst || asst.connection_state !== "VERIFIED") throw new LumiError("FORBIDDEN", 403);
    // The token proves WHICH bot is talking; the actor must additionally be in the allowed list (lumi_actors) — core enforces role.
    const r = await createDraft(ctx.db, { sourceKey: String(b.source_key), channel: "TELEGRAM", actorRef: String(b.actor_ref), assistantId: asst.id, text: String(b.text), ttlSeconds: ctx.draftTtlSeconds ?? 900, now: ctx.now() });
    if ("noTask" in r) return ok({ no_task: true });
    const d = r.draft;
    const view = {
      draft_id: d.id, version: d.version, state: d.state, expires_at: d.expires_at, parsed: d.parsed, missing: d.missing,
      confirm: { reply_hint: `OK ${d.id.slice(0, 8)}`, draft_id: d.id },
    };
    return r.created ? ok(view, 201) : ok(view, 200);
  },
  // 8.6.2
  async patchDraft(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["version"]);
    const out = await patchDraft(ctx.db, u.actorRef, uuid(req.params.draftId, "draft_id"), Number(b.version), { projectId: str(b.project_id), assigneeId: str(b.assignee_id), title: str(b.title) }, ctx.now());
    return ok({ draft_id: out.id, version: out.version, parsed: out.parsed, missing: out.missing });
  },
  // 8.6.3 — user (web) or bot relaying the identity of the person who answered (Telegram text "OK <code>").
  // Refusal order follows W-V2TDD P3-R03: malformed → rate limit (in handle) → role → unknown / wrong user (IDENTICAL answer) → replay → expiry → act.
  async confirm(ctx, req) {
    const p = req.principal; if (!p) throw new LumiError("UNAUTHORIZED", 401);
    let actorRef: string;
    if (p.kind === "user") actorRef = p.actorRef;
    else { need(req.body, ["actor_ref"]); actorRef = String(req.body.actor_ref); } // bot relays; the actor must still be OWNER/ADMIN
    const role = await roleOf(ctx.db, actorRef);
    if (role !== "OWNER" && role !== "ADMIN") throw new LumiError("FORBIDDEN", 403); // independent of whether any draft exists
    let id = req.params.draftId ?? "";
    if (!UUID.test(id)) {
      // Telegram path may send only the 8-char code shown in the hint; resolve it only among the requester's own drafts (any state, so a repeated confirm is idempotent).
      const rows = await ctx.db.query<any>(`SELECT id FROM lumi_intake_drafts WHERE id::text LIKE $1 AND actor_ref=$2`, [`${id.toLowerCase()}%`, actorRef]);
      if (rows.length !== 1) throw new LumiError("NOT_FOUND", 404);
      id = rows[0].id;
    }
    let r;
    try { r = await confirmDraft(ctx.db, actorRef, id, ctx.now()); }
    catch (e) {
      // "Unknown" and "somebody else's draft" must be byte-identical so ids cannot be probed.
      if (e instanceof LumiError && e.code === "FORBIDDEN") throw new LumiError("NOT_FOUND", 404);
      throw e;
    }
    const data = { task: { id: r.task.id, code: r.task.code, status: r.task.status }, link: `/work/${r.task.id}` };
    return r.alreadyProcessed ? processed(data) : ok(data, 201);
  },
  // 8.6.4
  async createTask(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body;
    need(b, ["project_id", "title"]);
    if (!b.assignee_id && !b.assignee_actor_ref) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["assignee_id"] });
    const key = idemKey(req);
    if (b.client_request_id && b.client_request_id !== key) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["client_request_id(must equal Idempotency-Key)"] });
    const r = await createTask(ctx.db, { actorRef: u.actorRef, clientRequestId: key, projectId: uuid(b.project_id, "project_id"), assigneeId: b.assignee_id ? uuid(b.assignee_id, "assignee_id") : undefined, assigneeActorRef: str(b.assignee_actor_ref), title: String(b.title), description: str(b.description), due: str(b.due), expectedOutput: str(b.expected_output), now: ctx.now() });
    return r.alreadyProcessed ? processed({ task: r.task }) : ok({ task: r.task }, 201);
  },
  // 8.6.5 — bot (with run_id) or the HUMAN assignee (session, no run_id)
  async submitOutput(ctx, req) {
    const p = req.principal; if (!p) throw new LumiError("UNAUTHORIZED", 401);
    const b = req.body; need(b, ["content", "idempotency_key"]);
    const taskId = uuid(req.params.id, "task_id");
    if (p.kind === "bot") need(b, ["run_id"]);
    const r: any = await submitOutput(ctx.db, { taskId, runId: p.kind === "bot" ? uuid(b.run_id, "run_id") : undefined, actorRef: p.actorRef, content: String(b.content).slice(0, 50_000), idempotencyKey: String(b.idempotency_key), now: ctx.now(), final: b.final === false ? false : undefined });
    const data = { output_id: r.output.id, version: r.output.version, late: r.late === true, ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}) };
    return r.alreadyProcessed ? processed(data) : ok(data, 201);
  },
  // 8.6.6 (mounted at /tasks/{id}/runs because legacy /tasks/{id}/retry already exists; see TDD 8.6.6)
  async startRun(ctx, req) {
    const u = userOnly(req.principal); idemKey(req);
    const b = req.body; need(b, ["mode", "expected_status"]);
    if (!["RETRY", "REVISION", "REASSIGN"].includes(b.mode)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["mode"] });
    await startRun(ctx.db, { actorRef: u.actorRef, taskId: uuid(req.params.id, "task_id"), mode: b.mode, expectedStatus: String(b.expected_status), instruction: str(b.instruction), forceOverLimit: b.force_over_limit === true && (str(b.reason)?.length ?? 0) >= 3, now: ctx.now() });
    return ok({ ok: true }, 201);
  },
  // 8.6.7 — OWNER only (core enforces; bot rejected here first)
  async decide(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["kind", "object_id", "object_version", "decision", "channel"]);
    if (b.kind !== "OUTPUT") throw new LumiError("VALIDATION_ERROR", 400, { missing: ["kind(OUTPUT)"] });
    if (!["APPROVE", "REVISE", "REJECT"].includes(b.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    const r = await decide(ctx.db, { actorRef: u.actorRef, outputId: uuid(b.object_id, "object_id"), objectVersion: Number(b.object_version), decision: b.decision, reason: str(b.reason), channel: "WEB", now: ctx.now() });
    return r.alreadyProcessed ? processed({ decision: r.approval.decision }) : ok({ decision: r.approval.decision });
  },
  // 8.6.8
  async transition(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["to", "expected_status"]);
    const r = await transitionTask(ctx.db, { actorRef: u.actorRef, taskId: uuid(req.params.id, "task_id"), to: String(b.to), expectedStatus: String(b.expected_status), reason: str(b.reason), now: ctx.now() });
    return ok(r);
  },
  // 8.7
  async adopt(ctx, req) {
    const u = userOnly(req.principal); idemKey(req);
    const b = req.body; need(b, ["expected_task_status"]);
    const r = await adoptLateOutput(ctx.db, { actorRef: u.actorRef, taskId: uuid(req.params.id, "task_id"), outputId: uuid(req.params.outputId, "output_id"), expectedStatus: String(b.expected_task_status), now: ctx.now() });
    return r.alreadyProcessed ? processed({}) : ok({});
  },
  async discard(ctx, req) {
    const u = userOnly(req.principal);
    await discardLateOutput(ctx.db, u.actorRef, uuid(req.params.outputId, "output_id"));
    return ok({});
  },
  // Human assignee accepts a task (HUMAN owner_kind)
  async accept(ctx, req) {
    const u = userOnly(req.principal);
    const r = await acceptHumanTask(ctx.db, u.actorRef, uuid(req.params.id, "task_id"), ctx.now());
    return r.alreadyProcessed ? processed({}) : ok({});
  },
  // Bot/Hermes confirms it started a run (TDD 8.5 ack_deadline)
  async ack(ctx, req) {
    const bot = botOnly(req.principal);
    const r = await ackRun(ctx.db, bot.slug, uuid(req.params.runId, "run_id"), ctx.now(), str(req.body?.session_ref));
    return r.alreadyProcessed ? processed({}) : ok({});
  },
  // Admin: switch dispatch on/off for an assistant (OWNER; refuses when execution config / profile tools are not acceptable)
  async setDispatch(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["enabled"]);
    await setDispatchEnabled(ctx.db, ctx.hermes, u.actorRef, uuid(req.params.id, "assistant_id"), b.enabled === true, ctx.now());
    return ok({ enabled: b.enabled === true });
  },
  async setFlag(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["key", "value"]);
    if (!["emergency_stop", "m1_enabled", "plans_enabled"].includes(b.key)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["key"] });
    if (b.key === "plans_enabled") await setPlansEnabled(ctx.db, u.actorRef, b.value === true, ctx.now());
    else await setFlag(ctx.db, u.actorRef, b.key, b.value === true, ctx.now());
    return ok({ key: b.key, value: b.value === true });
  },
  // ── Autonomy (TDD 8.11): owner-only. Bots never reach these (userOnly).
  async declareCapability(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["mode"]);
    if (!["RESTRICTED", "DECLARED_FULL"].includes(b.mode)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["mode"] });
    await declareCapability(ctx.db, ctx.hermes, u.actorRef, uuid(req.params.id, "assistant_id"), b.mode, b.acknowledged === true, ctx.now());
    return ok({ mode: b.mode, dispatch_enabled: false });
  },
  async setAutonomyLimits(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body;
    await setAutonomyLimits(ctx.db, u.actorRef, uuid(req.params.id, "assistant_id"), { maxContinuations: b.max_continuations, maxSubtasks: b.max_subtasks }, ctx.now());
    return ok({});
  },
  async createGrant(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["assistant_id", "project_id", "account_ref", "action_type", "valid_until"]);
    const vu = new Date(b.valid_until); if (Number.isNaN(vu.getTime())) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["valid_until(invalid)"] });
    const n = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
    const g = await createGrant(ctx.db, u.actorRef, { assistantId: uuid(b.assistant_id, "assistant_id"), projectId: uuid(b.project_id, "project_id"), accountRef: String(b.account_ref), actionType: String(b.action_type), currency: str(b.currency), perActionMax: n(b.per_action_max), budgetTotal: n(b.budget_total), countLimit: n(b.count_limit), askIfAmountOver: n(b.ask_if_amount_over), validUntil: vu, note: str(b.note) }, ctx.now());
    return ok({ grant_id: g.id }, 201);
  },
  async revokeGrant(ctx, req) {
    const u = userOnly(req.principal);
    await revokeGrant(ctx.db, u.actorRef, uuid(req.params.id, "grant_id"), ctx.now());
    return ok({});
  },
  async decideAction(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["decision"]);
    if (!["APPROVE", "DENY"].includes(b.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    const r = await decideActionRequest(ctx.db, u.actorRef, uuid(req.params.id, "request_id"), b.decision, str(b.note), ctx.now());
    return r.alreadyProcessed ? processed({ state: r.state }) : ok({ state: r.state });
  },
  async decideProposal(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["decision"]);
    if (!["ACTIVATE", "REJECT"].includes(b.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    const r = await decideProposal(ctx.db, u.actorRef, uuid(req.params.id, "project_id"), b.decision, ctx.now());
    return r.alreadyProcessed ? processed({}) : ok({});
  },
  // ── IMP-01: goals, plans, ledger (TDD 14.11.B.5). All user-only; bots reach plans only through the MCP tool plan_submit_version.
  async listGoals(ctx, req) {
    userOnly(req.principal);
    return ok(await companyOverview(ctx.db));
  },
  async createGoal(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["project_id", "title", "outcome"]);
    const key = idemKey(req);
    const n = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
    const d = (v: unknown) => { if (v === undefined || v === null || v === "") return undefined; const x = new Date(String(v)); if (Number.isNaN(x.getTime())) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["date(invalid)"] }); return x; };
    const r = await createGoal(ctx.db, { actorRef: u.actorRef, key, title: String(b.title), outcome: String(b.outcome), projectId: uuid(b.project_id, "project_id"), metrics: b.metrics, constraints: b.constraints, maxLoss: n(b.max_loss), currency: str(b.currency), periodStart: d(b.period_start), periodEnd: d(b.period_end), now: ctx.now() });
    return r.alreadyProcessed ? processed({ goal: r.goal }) : ok({ goal: r.goal }, 201);
  },
  async closeGoal(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["result"]);
    const r = await closeGoal(ctx.db, { actorRef: u.actorRef, goalId: uuid(req.params.id, "goal_id"), result: String(b.result), note: str(b.note), now: ctx.now() });
    return r.alreadyProcessed ? processed({ goal: r.goal }) : ok({ goal: r.goal });
  },
  async createPlan(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["goal_id", "lead_assistant_id"]);
    const r = await createPlan(ctx.db, { actorRef: u.actorRef, key: idemKey(req), goalId: uuid(b.goal_id, "goal_id"), leadAssistantId: uuid(b.lead_assistant_id, "lead_assistant_id"), now: ctx.now() });
    return r.alreadyProcessed ? processed({ plan: r.plan }) : ok({ plan: r.plan }, 201);
  },
  async planDetail(ctx, req) {
    userOnly(req.principal);
    const d = await getPlanDetail(ctx.db, uuid(req.params.id, "plan_id"));
    if (!d) throw new LumiError("NOT_FOUND", 404);
    return ok(d);
  },
  async decidePlan(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["version", "content_hash", "decision"]);
    if (!["APPROVE", "REVISE", "REJECT", "DEFER", "RESUME"].includes(b.decision)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["decision"] });
    const r = await decidePlan(ctx.db, { actorRef: u.actorRef, planId: uuid(req.params.id, "plan_id"), version: Number(b.version), contentHash: String(b.content_hash), decision: b.decision as PlanDecision, reason: str(b.reason), now: ctx.now() });
    return r.alreadyProcessed ? processed({ plan: r.plan, decision: r.decision }) : ok({ plan: r.plan, decision: r.decision });
  },
  async revisePlan(ctx, req) {
    const u = userOnly(req.principal);
    need(req.body, ["instruction"]);
    const r = await revisePlan(ctx.db, { actorRef: u.actorRef, planId: uuid(req.params.id, "plan_id"), instruction: String(req.body.instruction), now: ctx.now() });
    return ok({ task_id: r.task.id }, 201);
  },
  async cancelPlan(ctx, req) {
    const u = userOnly(req.principal);
    const r = await cancelPlan(ctx.db, { actorRef: u.actorRef, planId: uuid(req.params.id, "plan_id"), reason: String(req.body?.reason ?? ""), now: ctx.now() });
    return r.alreadyProcessed ? processed({ plan: r.plan }) : ok({ plan: r.plan });
  },
  async recordLedger(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["category", "amount", "currency", "source"]);
    const r = await recordLedger(ctx.db, { actorRef: u.actorRef, planId: uuid(req.params.id, "plan_id"), key: idemKey(req), category: String(b.category), amount: Number(b.amount), currency: String(b.currency), source: String(b.source), budgetKind: b.budget_kind === "PREPARE" ? "PREPARE" : "EXECUTE", taskId: b.task_id ? uuid(b.task_id, "task_id") : undefined, note: str(b.note), now: ctx.now() });
    return r.created ? ok({ created: true }, 201) : processed({ created: false });
  },
  async reconcileLedger(ctx, req) {
    const u = userOnly(req.principal);
    const b = req.body; need(b, ["entry_ids", "reconciliation_key"]);
    if (!Array.isArray(b.entry_ids)) throw new LumiError("VALIDATION_ERROR", 400, { missing: ["entry_ids(array)"] });
    const r = await reconcileLedger(ctx.db, { actorRef: u.actorRef, planId: uuid(req.params.id, "plan_id"), entryIds: b.entry_ids.map((x: unknown) => uuid(x, "entry_id")), reconciliationKey: String(b.reconciliation_key), now: ctx.now() });
    return ok(r);
  },
  async cancel(ctx, req) {
    const u = userOnly(req.principal);
    await cancelTask(ctx.db, u.actorRef, uuid(req.params.id, "task_id"), String(req.body?.reason ?? ""), ctx.now());
    return ok({});
  },
};

const MAX_BODY = 64 * 1024;
const NEW_WORK = new Set(["intake", "confirm", "createTask", "startRun", "setDispatch"]);
export async function handle(name: keyof typeof HANDLERS | string, ctx: ApiCtx, req: ApiReq): Promise<ApiRes> {
  try {
    const h = HANDLERS[name];
    if (!h) return fail(new LumiError("NOT_FOUND", 404));
    if (!req.principal) return fail(new LumiError("UNAUTHORIZED", 401));
    if ((req.rawLength ?? 0) > MAX_BODY) return fail(new LumiError("PAYLOAD_TOO_LARGE", 413));
    if (ctx.allow && !ctx.allow(`${req.principal.actorRef}:${name}`)) return fail(new LumiError("RATE_LIMITED", 429));
    // Master switch (TDD 14.7 L0): while m1_enabled is off, nothing NEW is created or dispatched. Draining/finishing paths stay open.
    if (NEW_WORK.has(name) && !(await ctx.db.query<any>(`SELECT value FROM lumi_system_flags WHERE key='m1_enabled'`))[0]?.value) {
      if (!(name === "setDispatch" && req.body?.enabled !== true)) return fail(new LumiError("M1_DISABLED", 409));
    }
    if (req.principal.kind === "user") await upsertActor(ctx.db, req.principal.actorRef, req.principal.role, "WEB");
    return await h(ctx, req);
  } catch (e) {
    return fail(e);
  }
}

/** Constant-time compare of a presented service token against `slug:token,slug2:token2`; returns the slug or null. */
export function resolveBotToken(presented: string | null | undefined, config: string | undefined): string | null {
  if (!presented || !config) return null;
  let found: string | null = null;
  for (const pair of config.split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const slug = pair.slice(0, i).trim();
    const expected = pair.slice(i + 1).trim();
    if (!expected || expected.length !== presented.length) continue;
    let diff = 0;
    for (let k = 0; k < expected.length; k++) diff |= presented.charCodeAt(k) ^ expected.charCodeAt(k);
    if (diff === 0) found = slug;
  }
  return found;
}
