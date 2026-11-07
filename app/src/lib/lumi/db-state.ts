/* eslint-disable @typescript-eslint/no-explicit-any -- rows come from raw SQL read models (lumi-m1/core*.ts) */
/**
 * Dữ liệu THẬT cho giao diện Dong-Lumi (/lumi) ở chế độ LUMI_DATA=db.
 *
 * Hai việc, cùng một khe cắm với bản preview (/api/lumi/state, /api/lumi/action) nên mọi màn hình có sẵn được tái dùng:
 *  1. `buildDbState`: chiếu PostgreSQL (lumi_* + tasks) thành `DemoState`. Không có dữ liệu mô phỏng nào được trộn vào.
 *  2. `applyDbAction`: ánh xạ thao tác trên giao diện sang lõi M1 thật (cùng đường với API /api/v1): quyền, chống trùng, kiểm toán
 *     đều do lõi quyết định. Thao tác chưa có trong M1 trả lỗi rõ ràng, không giả vờ thành công.
 */
import type { Db, HermesPort } from "../lumi-m1/core";
import { LumiError, cancelDraft, confirmDraft, decide, listOpenDrafts, patchDraft, startRun, cancelTask, upsertActorRef } from "../lumi-m1/core";
import { createTask } from "../lumi-m1/core-web";
import { OWNER_ID } from "./types";
import type { Action, Result } from "./engine";
import type { DemoState, HistoryEvent, Member, Output, Project, RealRun, Task, TaskStatus, TgDraft } from "./types";

export interface DbUser { actorRef: string; email: string; role: "OWNER" | "ADMIN" | "VIEWER" }
export interface DbStateOpts { hermesMode: string; telegramBot?: string; now?: Date }

const AREA: Record<string, string> = { AFFILIATE: "Affiliate", YOUTUBE: "YouTube", WEBSITE: "Website", OTHER: "Khác" };
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);
const botId = (slug: string) => `bot-${slug}`;

/** 12 trạng thái thật → 5 cột của bảng việc; trạng thái thật vẫn nằm ở `task.real.status`. */
export function uiStatus(status: string): TaskStatus {
  switch (status) {
    case "RUNNING": return "doing";
    case "QUEUED": case "REVISION_REQUESTED": return "ready";
    case "WAITING_REVIEW": return "review";
    case "COMPLETED": case "APPROVED": case "CANCELLED": return "done";
    default: return "new"; // CAPTURED, WAITING_ASSISTANT, FAILED, ON_HOLD, REJECTED: cần người xem
  }
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export async function buildDbState(db: Db, user: DbUser, o: DbStateOpts): Promise<DemoState> {
  const now = o.now ?? new Date();
  const assistants = await db.query<any>(`SELECT id,slug,name,description,role_label,avatar,kind,connection_state,dispatch_enabled,hermes_profile,created_at FROM lumi_assistants WHERE status='ACTIVE' ORDER BY created_at`);
  const projectsRaw = await db.query<any>(`SELECT id,slug,name,area,goal,pm_actor_ref,pm_assistant_id FROM lumi_projects WHERE status='ACTIVE' ORDER BY created_at`);
  const tasksRaw = await db.query<any>(
    `SELECT t.*, a.slug AS a_slug, a.name AS a_name, p.slug AS p_slug FROM tasks t JOIN lumi_projects p ON p.id=t.project_id LEFT JOIN lumi_assistants a ON a.id=t.owner_assistant_id ORDER BY t.created_at`,
  );
  const ids = tasksRaw.map((t: any) => t.id);
  const any = (arr: string[]) => (arr.length ? arr : ["00000000-0000-0000-0000-000000000000"]);
  const outsRaw = await db.query<any>(`SELECT id,task_id,version,content,state,late,created_at FROM lumi_task_outputs WHERE task_id = ANY($1::uuid[]) ORDER BY version`, [any(ids)]);
  const apprRaw = await db.query<any>(`SELECT ap.decision,ap.reason,ap.decided_at,ap.channel,ap.object_version,o.task_id FROM lumi_approvals ap JOIN lumi_task_outputs o ON o.id=ap.object_id WHERE o.task_id = ANY($1::uuid[]) ORDER BY ap.decided_at`, [any(ids)]);
  const actsRaw = await db.query<any>(`SELECT task_id,event_type,payload_redacted,occurred_at FROM task_activities WHERE task_id = ANY($1::uuid[]) ORDER BY occurred_at,created_at`, [any(ids)]);
  const runsRaw = await db.query<any>(`SELECT task_id,attempt_no,run_kind,state,remote_stop_state,error_code,created_at,acked_at FROM lumi_task_runs WHERE task_id = ANY($1::uuid[]) ORDER BY attempt_no`, [any(ids)]);
  const flags = await db.query<any>(`SELECT key,value FROM lumi_system_flags`);
  const drafts = await listOpenDrafts(db, now);

  const projectIdBySlug = new Map(projectsRaw.map((p: any) => [p.id, p.slug]));
  const slugOfAssistant = new Map(assistants.map((a: any) => [a.id, a.slug]));
  const owner: Member = {
    id: OWNER_ID, kind: "human", name: user.email, avatar: "crown", role: "Chủ hệ thống", description: "Người đăng nhập hiện tại",
    projectIds: projectsRaw.map((p: any) => p.slug), status: "active", permission: "owner", hermes: "connected", createdAt: iso(now)!,
  };
  const bots: Member[] = assistants.map((a: any) => ({
    id: botId(a.slug), kind: "bot" as const, name: a.name, avatar: a.avatar ?? "bot", role: a.role_label || "Trợ lý", description: a.description ?? "",
    projectIds: projectsRaw.map((p: any) => p.slug), status: "active" as const, permission: a.kind === "PM" ? ("pm" as const) : ("assistant" as const),
    hermes: a.connection_state === "VERIFIED" && a.dispatch_enabled ? ("connected" as const) : ("none" as const), createdAt: iso(a.created_at)!,
  }));
  const projects: Project[] = projectsRaw.map((p: any) => ({
    id: p.slug, name: p.name, area: AREA[p.area] ?? "Khác", goal: p.goal ?? "",
    pmId: p.pm_assistant_id ? botId(slugOfAssistant.get(p.pm_assistant_id) ?? "") : OWNER_ID, status: "active" as const,
  }));

  const outputs: Output[] = [];
  const tasks: Task[] = tasksRaw.map((t: any) => {
    const code = t.code as string;
    const ownerId = t.owner_kind === "BOT" && t.a_slug ? botId(t.a_slug) : OWNER_ID;
    const ownerName = t.owner_kind === "BOT" ? (t.a_name ?? "Trợ lý") : (t.owner_actor_ref ?? user.email);
    const web = String(t.source_key ?? "").startsWith("web:");
    const myRuns = runsRaw.filter((r: any) => r.task_id === t.id);
    const myOuts = outsRaw.filter((x: any) => x.task_id === t.id && !["LATE_SAVED", "DISCARDED"].includes(x.state));
    const myAppr = apprRaw.filter((x: any) => x.task_id === t.id);
    const history: HistoryEvent[] = [];
    let n = 0;
    const ev = (at: unknown, byId: string, byName: string, via: HistoryEvent["via"], kind: HistoryEvent["kind"], text?: string, version?: number) =>
      history.push({ id: `${code}-h${++n}`, at: iso(at)!, byId, byName, via, kind, ...(text ? { text } : {}), ...(version ? { version } : {}) });
    for (const a of actsRaw.filter((x: any) => x.task_id === t.id)) {
      const p = a.payload_redacted ?? {};
      switch (a.event_type) {
        case "task.created": ev(a.occurred_at, OWNER_ID, "Chủ", web ? "web" : "telegram", "created"); break;
        case "task.released": ev(a.occurred_at, "system", "Hệ thống", "system", "status", "Trợ lý đã sẵn sàng, việc được giao"); break;
        case "output.submitted": ev(a.occurred_at, ownerId, ownerName, "system", "output", undefined, p.version); break;
        case "output.late_saved": ev(a.occurred_at, "system", "Hệ thống", "system", "status", "Kết quả đến muộn được lưu, chưa dùng (cần Chủ quyết định)"); break;
        case "output.adopted_late": ev(a.occurred_at, OWNER_ID, "Chủ", "web", "status", "Chủ dùng kết quả đến muộn"); break;
        case "run.revision": ev(a.occurred_at, OWNER_ID, "Chủ", "web", "assigned", "Giao trợ lý sửa theo góp ý"); break;
        case "run.retry": case "run.reassign": ev(a.occurred_at, OWNER_ID, "Chủ", "web", "assigned", "Giao lại"); break;
        case "run.dispatch_uncertain": ev(a.occurred_at, "system", "Hệ thống", "system", "status", "Không chắc lệnh đã tới Hermes: KHÔNG gửi lại, cần Chủ quyết định"); break;
        case "run.remote_stop_confirmed": ev(a.occurred_at, "system", "Hệ thống", "system", "status", "Đã xác nhận dừng lượt chạy phía Hermes"); break;
        case "run.remote_stop_unknown": ev(a.occurred_at, "system", "Hệ thống", "system", "status", "Chưa xác nhận được Hermes đã dừng (app đã ngừng chờ)"); break;
        case "task.cancelled": ev(a.occurred_at, OWNER_ID, "Chủ", "web", "status", `Đã hủy: ${p.reason ?? ""}`); break;
        default: if (!String(a.event_type).startsWith("approval.")) ev(a.occurred_at, "system", "Hệ thống", "system", "status", String(a.event_type));
      }
    }
    for (const r of myRuns) if (r.acked_at) ev(r.acked_at, ownerId, ownerName, "system", "started", r.run_kind === "REVISION" ? "Bắt đầu sửa" : undefined);
    for (const ap of myAppr) {
      const via = String(ap.channel).startsWith("TELEGRAM") ? "telegram" : "web";
      if (ap.decision === "APPROVE") ev(ap.decided_at, OWNER_ID, "Chủ", via, "approved", undefined, ap.object_version);
      else ev(ap.decided_at, OWNER_ID, "Chủ", via, "revision_requested", ap.reason ?? undefined, ap.object_version);
    }
    history.sort((a, b) => a.at.localeCompare(b.at));

    if (myOuts.length) {
      const completed = ["COMPLETED", "APPROVED"].includes(t.status);
      outputs.push({
        id: `out-${code}`, taskId: code,
        versions: myOuts.map((x: any) => ({
          v: x.version, title: `${t.title} · bản ${x.version}`, createdAt: iso(x.created_at)!,
          sections: [{ heading: "Nội dung", body: x.content }],
          // "Sửa theo góp ý" nằm ở bản MỚI: lý do của quyết định REVISE trên bản liền trước.
          ...(myAppr.find((ap: any) => ap.object_version === x.version - 1 && ap.decision === "REVISE")?.reason ? { revisionNote: myAppr.find((ap: any) => ap.object_version === x.version - 1 && ap.decision === "REVISE").reason } : {}),
        })),
        state: completed ? "approved" : t.status === "REVISION_REQUESTED" ? "changes_requested" : "draft",
        ...(completed ? { approvedVersion: myOuts[myOuts.length - 1]!.version } : {}),
      });
    }
    const runs: RealRun[] = myRuns.map((r: any) => ({ n: r.attempt_no, kind: r.run_kind, state: r.state, remoteStop: r.remote_stop_state, ...(r.error_code ? { errorCode: r.error_code } : {}), at: iso(r.created_at)! }));
    return {
      id: code, projectId: t.p_slug, title: t.title, request: t.description ?? t.title, outputWanted: t.expected_output ?? "(không nêu)",
      ...(t.due_at ? { due: new Date(t.due_at).toLocaleDateString("vi-VN") } : {}),
      ownerId, ownerName,
      source: web ? { kind: "web" as const, label: "Web" } : { kind: "telegram" as const, label: `Telegram · ${t.a_name ?? "bot"}`, botName: t.a_name ?? "bot" },
      status: uiStatus(t.status), waitingConnection: t.status === "WAITING_ASSISTANT",
      createdAt: iso(t.created_at)!, updatedAt: iso(t.updated_at)!,
      ...(t.started_at ? { startedAt: iso(t.started_at) } : {}),
      ...(outputs.find((x) => x.taskId === code) ? { outputId: `out-${code}` } : {}),
      history,
      real: {
        uuid: t.id, status: t.status, needsDecision: t.needs_decision === true, revisionRound: t.revision_round,
        ...(t.error_code ? { errorCode: t.error_code } : {}), ...(t.error_message ? { errorMessage: t.error_message } : {}), ...(t.hold_reason ? { holdReason: t.hold_reason } : {}),
        runs, lateOutputs: outsRaw.filter((x: any) => x.task_id === t.id && x.state === "LATE_SAVED").length,
      },
    } satisfies Task;
  });

  const tgDrafts: TgDraft[] = drafts.map((d: any) => ({
    id: d.id, chat: "aff" as const, sourceText: d.raw_text, title: d.parsed?.title ?? d.raw_text, outputWanted: "",
    ...(d.parsed?.project_id ? { projectId: projectIdBySlug.get(d.parsed.project_id) } : {}),
    assigneeId: d.parsed?.assignee_id ? botId(slugOfAssistant.get(d.parsed.assignee_id) ?? "") : OWNER_ID,
    step: "main" as const, state: "pending" as const,
  }));
  const flag = (k: string) => flags.find((f: any) => f.key === k)?.value === true;
  const state: DemoState = {
    schema: 1, rev: 0, resetAt: new Date(0).toISOString(), members: [owner, ...bots], projects, tasks, outputs, memories: [], actions: [],
    tgDrafts, tgMessages: [], tgAwaiting: {}, videos: [], adResults: [], seq: { task: tasks.length, member: 0, id: 0 },
    mode: "db",
    real: {
      role: user.role, email: user.email, m1Enabled: flag("m1_enabled"), emergencyStop: flag("emergency_stop"), hermesMode: o.hermesMode,
      assistants: assistants.map((a: any) => ({ id: a.id, name: a.name, slug: a.slug, connection_state: a.connection_state, dispatch_enabled: a.dispatch_enabled, hermes_profile: a.hermes_profile })),
      ...(o.telegramBot ? { telegramBot: o.telegramBot } : {}),
    },
  };
  state.rev = djb2(JSON.stringify(state)); // đổi khi dữ liệu đổi: giao diện kéo lại mỗi 2 giây và chỉ cập nhật khi rev khác
  return state;
}

// ───────────────────────── thao tác
const NOT_IN_M1 = "Chưa có trong M1 (dữ liệu thật). Thao tác này chưa được nối với PostgreSQL nên không làm gì cả.";
const bad = (message: string, code: NonNullable<Result["code"]> = "invalid"): Result => ({ ok: false, code, message });
const MSG: Record<string, string> = {
  FORBIDDEN: "Bạn không có quyền làm việc này.",
  CONFIG_INCOMPLETE: "Trợ lý chưa đủ cấu hình thực thi (xem mục Telegram & kết nối).",
  M1_DISABLED: "Luồng M1 đang tắt (công tắc tổng).",
  RUN_ACTIVE: "Đang có một lần chạy mở.",
  RETRY_LIMIT: "Hết lượt thử lại do lỗi.",
  REVISION_LIMIT: "Hết số vòng sửa cho phép.",
  DAILY_CAP: "Hết hạn mức chạy trong ngày.",
  GONE: "Bản nháp đã hết hạn.",
  INVALID_TRANSITION: "Trạng thái hiện tại không cho phép thao tác này.",
};

async function taskRow(db: Db, code: string) {
  const [t] = await db.query<any>(`SELECT id,status::text AS status,current_output_id,owner_assistant_id FROM tasks WHERE code=$1 AND project_id IS NOT NULL`, [code]);
  return t as { id: string; status: string; current_output_id: string | null; owner_assistant_id: string | null } | undefined;
}

export async function applyDbAction(db: Db, user: DbUser, a: Action, now: Date = new Date(), _hermes?: HermesPort): Promise<Result> {
  try {
    await upsertActorRef(db, user.actorRef, user.role);
    switch (a.type) {
      case "task.create": {
        const [proj] = await db.query<any>(`SELECT id FROM lumi_projects WHERE slug=$1 AND status='ACTIVE'`, [a.projectId]);
        if (!proj) return bad("Không thấy dự án.", "not_found");
        let assigneeId: string | undefined;
        if (a.ownerId.startsWith("bot-")) {
          const [asst] = await db.query<any>(`SELECT id FROM lumi_assistants WHERE slug=$1 AND status='ACTIVE'`, [a.ownerId.slice(4)]);
          if (!asst) return bad("Không thấy trợ lý.", "not_found");
          assigneeId = asst.id;
        }
        const key = a.clientRequestId ?? `ui-${user.actorRef}-${now.getTime()}`;
        const r = await createTask(db, { actorRef: user.actorRef, clientRequestId: key, projectId: proj.id, assigneeId, assigneeActorRef: assigneeId ? undefined : user.actorRef, title: a.title, description: a.request || undefined, due: undefined, expectedOutput: a.outputWanted || undefined, now });
        return { ok: true, taskId: r.task.code, ...(r.alreadyProcessed ? { code: "already" as const, message: "Yêu cầu lặp: không tạo thêm việc." } : {}) };
      }
      case "task.approveOutput":
      case "task.requestRevision": {
        const t = await taskRow(db, a.taskId);
        if (!t) return bad("Không thấy việc.", "not_found");
        if (!t.current_output_id) return bad("Việc chưa có đầu ra.", "stale");
        const [o] = await db.query<any>(`SELECT id,version FROM lumi_task_outputs WHERE id=$1`, [t.current_output_id]);
        if (a.version !== undefined && a.version !== o.version) return bad("Đã có bản mới hơn, hãy tải lại.", "stale");
        const approve = a.type === "task.approveOutput";
        if (!approve && !a.text.trim()) return bad("Cần ghi lý do yêu cầu sửa.");
        const r = await decide(db, { actorRef: user.actorRef, outputId: o.id, objectVersion: o.version, decision: approve ? "APPROVE" : "REVISE", reason: approve ? undefined : a.text, channel: "WEB", now });
        if (r.alreadyProcessed) return { ok: true, code: "already", message: "Đã xử lý trước đó, không làm lại." };
        if (approve) return { ok: true };
        // Chủ bấm "Gửi yêu cầu sửa" = giao trợ lý sửa ngay: hai bước thật (quyết định REVISE rồi lần chạy REVISION).
        try {
          await startRun(db, { actorRef: user.actorRef, taskId: t.id, mode: "REVISION", expectedStatus: "REVISION_REQUESTED", instruction: a.text, now });
          return { ok: true };
        } catch (e) {
          if (e instanceof LumiError) return { ok: true, message: `Đã ghi yêu cầu sửa nhưng chưa giao được cho trợ lý: ${MSG[e.code] ?? e.code}` };
          throw e;
        }
      }
      case "task.retry": {
        const t = await taskRow(db, a.taskId);
        if (!t) return bad("Không thấy việc.", "not_found");
        await startRun(db, { actorRef: user.actorRef, taskId: t.id, mode: t.status === "REVISION_REQUESTED" ? "REVISION" : "RETRY", expectedStatus: t.status, now });
        return { ok: true };
      }
      case "task.cancel": {
        const t = await taskRow(db, a.taskId);
        if (!t) return bad("Không thấy việc.", "not_found");
        await cancelTask(db, user.actorRef, t.id, a.reason, now);
        return { ok: true };
      }
      case "tg.draftConfirm": {
        const r = await confirmDraft(db, user.actorRef, a.draftId, now);
        return { ok: true, taskId: r.task.code, ...(r.alreadyProcessed ? { code: "already" as const, message: "Bản nháp đã được xác nhận trước đó, không tạo thêm việc." } : {}) };
      }
      case "tg.draftCancel": {
        const r = await cancelDraft(db, user.actorRef, a.draftId, now);
        return r.alreadyProcessed ? { ok: true, code: "already" } : { ok: true };
      }
      case "tg.draftSetProject":
      case "tg.draftSetAssignee": {
        const [d] = await db.query<any>(`SELECT version FROM lumi_intake_drafts WHERE id=$1`, [a.draftId]);
        if (!d) return bad("Không thấy bản nháp.", "not_found");
        if (a.type === "tg.draftSetProject") {
          const [p] = await db.query<any>(`SELECT id FROM lumi_projects WHERE slug=$1`, [a.projectId]);
          if (!p) return bad("Không thấy dự án.", "not_found");
          await patchDraft(db, user.actorRef, a.draftId, d.version, { projectId: p.id }, now);
        } else {
          const [s] = await db.query<any>(`SELECT id FROM lumi_assistants WHERE slug=$1`, [a.assigneeId.replace(/^bot-/, "")]);
          if (!s) return bad("Không thấy trợ lý.", "not_found");
          await patchDraft(db, user.actorRef, a.draftId, d.version, { assigneeId: s.id }, now);
        }
        return { ok: true };
      }
      default:
        return bad(NOT_IN_M1);
    }
  } catch (e) {
    if (e instanceof LumiError) {
      if (e.code === "STALE_VERSION") return bad("Dữ liệu đã đổi, hãy tải lại.", "stale");
      if (e.code === "NOT_FOUND") return bad("Không tìm thấy.", "not_found");
      if (e.code === "VALIDATION_ERROR") return bad(`Thiếu hoặc sai: ${JSON.stringify((e.data as any).missing ?? "")}`);
      return bad(MSG[e.code] ?? `Lỗi ${e.code}`);
    }
    return bad("Lỗi hệ thống");
  }
}
