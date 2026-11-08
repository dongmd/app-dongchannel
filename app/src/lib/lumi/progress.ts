/**
 * "Tiến trình": ONE plain sentence per goal that says where the work is, who has the ball (the bot or the owner) and what the owner does next.
 * Pure function over RECORDED facts (plan status, planning run state/time, task statuses, run counts). It never estimates progress it cannot see:
 * while a bot is working the bar shows elapsed time against the run limit, not a percentage.
 */
import type { CheckItem } from "./progress-checklist";
export type Tone = "info" | "action" | "warn" | "error" | "done";
export type Who = "BOT" | "OWNER" | "NONE";

export interface ProgressInput {
  goal: { code: string; title: string; status: string };
  plan: { id: string; code: string; status: string; current_version: number | null } | null;
  version: { version: number; state: string } | null;
  planningTask: { code: string; status: string; error_code: string | null; needs_decision: boolean } | null;
  planningRun: { state: string; attempt_no: number; created_at: string; started_at: string | null; deadline_at: string | null; error_code: string | null; error_message: string | null } | null;
  runLimitSeconds: number | null;
  leadReady: boolean;
  leadName: string | null;
  runs: { used: number; cap: number | null } | null;
  tasks: { code: string; title: string; status: string; needs_decision: boolean; error_code: string | null }[];
}
export interface Step { key: string; label: string; state: "done" | "current" | "todo" }
export interface Progress {
  goal_code: string; goal_title: string; plan_code: string | null; plan_id: string | null;
  stage: string; tone: Tone; who: Who; headline: string; detail: string;
  next: { label: string; href: string | null } | null;
  run: { since: string; limit_seconds: number | null } | null;
  runs: { used: number; cap: number | null } | null;
  tasks: { done: number; total: number } | null;
  steps: Step[];
  /** Detailed checklist with a status per step (filled by the data layer, which knows the submission attempts). */
  checklist: CheckItem[] | null;
}

const STEP_LABELS = ["Mục tiêu", "Bot lập kế hoạch", "Bạn duyệt kế hoạch", "Bot thực hiện", "Hoàn tất"];
const TERMINAL_RUN = ["FAILED", "TIMED_OUT", "CANCELLED", "ABANDONED"];
const mk = (current: number, allDone = false): Step[] => STEP_LABELS.map((label, i) => ({ key: String(i), label, state: allDone || i < current ? "done" : i === current ? "current" : "todo" }));
const secs = (a: string, b: Date) => Math.max(0, Math.round((b.getTime() - new Date(a).getTime()) / 1000));
export const fmtDuration = (s: number) => (s < 60 ? `${s} giây` : `${Math.floor(s / 60)} phút ${String(s % 60).padStart(2, "0")} giây`);

export function deriveProgress(i: ProgressInput, now: Date): Progress {
  const base = { goal_code: i.goal.code, goal_title: i.goal.title, plan_code: i.plan?.code ?? null, plan_id: i.plan?.id ?? null, run: null as Progress["run"], runs: i.runs, tasks: null as Progress["tasks"] };
  const out = (p: Omit<Progress, keyof typeof base | "checklist">): Progress => ({ ...base, checklist: null, ...p });
  const planHref = i.plan ? `/lumi/plans/${i.plan.id}` : null;
  const capHit = i.runs?.cap != null && i.runs.used >= i.runs.cap;
  const runsText = i.runs ? ` Lượt chạy đã dùng: ${i.runs.used}${i.runs.cap != null ? `/${i.runs.cap}` : ""}.` : "";

  if (i.goal.status === "CLOSED") return out({ stage: "GOAL_CLOSED", tone: "done", who: "NONE", headline: "Mục tiêu đã đóng", detail: "Không còn việc phải làm.", next: null, steps: mk(4, true) });
  if (!i.plan) return out({ stage: "NO_PLAN", tone: "action", who: "OWNER", headline: "Mục tiêu đã tạo, chưa có kế hoạch", detail: "Bot chưa được giao lập kế hoạch.", next: { label: "Bấm «Yêu cầu bot lập kế hoạch» ở thẻ mục tiêu", href: "/lumi/company" }, steps: mk(0) });

  const st = i.plan.status;
  if (st === "DRAFTING" || st === "NEEDS_REVISION") {
    const verb = st === "NEEDS_REVISION" ? "sửa" : "lập";
    const run = i.planningRun; const t = i.planningTask;
    const lead = i.leadName ?? "Bot";
    if ((run && TERMINAL_RUN.includes(run.state)) || t?.status === "FAILED" || t?.needs_decision) {
      const code = run?.error_code ?? t?.error_code ?? "không rõ";
      return out({ stage: "PLANNING_FAILED", tone: "error", who: "OWNER", headline: `Lượt ${verb} kế hoạch bị lỗi (${code})`, detail: `${run?.error_message ?? "Hệ thống đã dừng lượt này và KHÔNG tự chạy lại."}${runsText}`, next: { label: "Mở kế hoạch để xem lỗi, giao lại hoặc hủy", href: planHref }, steps: mk(1) });
    }
    if (run?.state === "SUCCEEDED") return out({ stage: "PLANNING_NO_SUBMIT", tone: "warn", who: "OWNER", headline: `${lead} kết thúc lượt nhưng chưa nộp phiên bản kế hoạch hợp lệ`, detail: `Chưa có gì để duyệt.${runsText}`, next: { label: "Mở kế hoạch để giao lại hoặc hủy", href: planHref }, steps: mk(1) });
    if (!run) {
      if (!i.leadReady) return out({ stage: "WAITING_ASSISTANT", tone: "warn", who: "OWNER", headline: `${lead} chưa sẵn sàng nhận việc`, detail: "Trợ lý chưa kết nối hoặc giao việc đang tắt nên chưa có lượt chạy nào.", next: { label: "Mở Tổ chức để kiểm tra kết nối và bật giao việc", href: "/lumi/org" }, steps: mk(1) });
      return out({ stage: "WAITING_RUN", tone: "info", who: "BOT", headline: "Đang chờ tạo lượt chạy lập kế hoạch", detail: runsText.trim() || "Hệ thống sắp giao việc.", next: null, steps: mk(1) });
    }
    if (capHit) return out({ stage: "CAP_REACHED", tone: "error", who: "OWNER", headline: "Đã dùng hết số lượt chạy được duyệt", detail: `Hệ thống dừng, không tự xin thêm.${runsText}`, next: { label: "Xem kết quả và phần còn thiếu ở trang kế hoạch", href: planHref }, steps: mk(1) });
    const age = secs(run.created_at, now);
    if (run.state === "PENDING") return out({ stage: "RUN_QUEUED", tone: age > 120 ? "warn" : "info", who: "BOT", headline: age > 120 ? "Lệnh đã tạo nhưng chưa được worker nhận (quá 2 phút)" : "Đã tạo lệnh, đang chờ worker nhận", detail: `${age > 120 ? "Có thể worker đang tắt; hãy báo kỹ thuật. " : ""}Đã chờ ${fmtDuration(age)}.${runsText}`, next: null, steps: mk(1) });
    if (run.state === "DISPATCHED") return out({ stage: "RUN_SENT", tone: "info", who: "BOT", headline: `Đã gửi lệnh tới ${lead}, chờ bot xác nhận bắt đầu`, detail: `Đã chờ ${fmtDuration(age)}.${runsText}`, next: null, steps: mk(1) });
    if (run.state === "DISPATCH_UNCERTAIN") return out({ stage: "RUN_UNCERTAIN", tone: "warn", who: "OWNER", headline: "Không chắc bot đã nhận lệnh", detail: `Hệ thống KHÔNG tự gửi lại để tránh chạy hai lần và tốn tiền.${runsText}`, next: { label: "Mở kế hoạch để quyết định giao lại hay hủy", href: planHref }, steps: mk(1) });
    const since = run.started_at ?? run.created_at; const over = run.deadline_at ? now.getTime() > new Date(run.deadline_at).getTime() : false;
    const p = out({ stage: over ? "RUN_OVERDUE" : "RUN_ACTIVE", tone: over ? "warn" : "info", who: "BOT", headline: over ? `${lead} chạy quá hạn; hệ thống sắp đóng lượt` : `${lead} đang ${verb} kế hoạch`, detail: `${over ? "Nếu không nộp, lượt sẽ đóng với lỗi quá hạn và chờ bạn quyết. " : "Bạn chưa cần làm gì. "}Khi bot nộp xong sẽ có nút duyệt ở đây.${runsText}`, next: null, steps: mk(1) });
    p.run = { since, limit_seconds: i.runLimitSeconds }; return p;
  }
  if (st === "PENDING_APPROVAL") return out({ stage: "AWAITING_APPROVAL", tone: "action", who: "OWNER", headline: `Kế hoạch ${i.plan.code} phiên bản ${i.version?.version ?? i.plan.current_version ?? "?"} đang chờ bạn duyệt`, detail: "Đọc nội dung, phạm vi, ngân sách rồi duyệt theo 2 bước. Bot không làm gì khi chưa được duyệt.", next: { label: "Xem và duyệt kế hoạch", href: planHref }, steps: mk(2) });
  if (st === "DEFERRED") return out({ stage: "DEFERRED", tone: "warn", who: "OWNER", headline: "Kế hoạch đã hoãn", detail: "Bạn có thể khôi phục để duyệt lại hoặc hủy.", next: { label: "Mở kế hoạch", href: planHref }, steps: mk(2) });
  if (st === "PAUSED_ADJUSTMENT") return out({ stage: "PAUSED", tone: "warn", who: "OWNER", headline: "Kế hoạch tạm dừng chờ điều chỉnh ngân sách", detail: "Chi phí đã ghi vượt phần cam kết. Việc chưa chạy sẽ không chạy cho tới khi bạn quyết.", next: { label: "Mở kế hoạch để điều chỉnh hoặc hủy", href: planHref }, steps: mk(3) });
  if (st === "EXECUTING") {
    const total = i.tasks.length; const done = i.tasks.filter((x) => x.status === "COMPLETED").length;
    const failed = i.tasks.find((x) => x.status === "FAILED" || x.status === "REJECTED" || x.needs_decision);
    const review = i.tasks.find((x) => x.status === "WAITING_REVIEW");
    const running = i.tasks.find((x) => x.status === "RUNNING");
    const waiting = i.tasks.find((x) => ["QUEUED", "WAITING_ASSISTANT", "CAPTURED"].includes(x.status));
    const counts = { done, total };
    let p: Progress;
    if (capHit && !running) p = out({ stage: "CAP_REACHED", tone: "error", who: "OWNER", headline: "Đã dùng hết số lượt chạy được duyệt", detail: `${done}/${total} việc xong. Hệ thống dừng, không tự xin thêm.${runsText}`, next: { label: "Xem kết quả và phần còn thiếu", href: planHref }, steps: mk(3) });
    else if (review) p = out({ stage: "TASK_REVIEW", tone: "action", who: "OWNER", headline: `Đầu ra việc ${review.code} đang chờ bạn duyệt`, detail: `${review.title}. ${done}/${total} việc đã xong.${runsText}`, next: { label: "Mở Chờ duyệt → Đầu ra công việc", href: "/lumi/approvals?tab=output" }, steps: mk(3) });
    else if (failed) p = out({ stage: "TASK_FAILED", tone: "error", who: "OWNER", headline: `Việc ${failed.code} gặp vấn đề${failed.error_code ? ` (${failed.error_code})` : ""}`, detail: `${failed.title}. ${done}/${total} việc đã xong.${runsText}`, next: { label: "Mở kế hoạch để giao lại hoặc hủy", href: planHref }, steps: mk(3) });
    else if (running) p = out({ stage: "TASK_RUNNING", tone: "info", who: "BOT", headline: `Bot đang làm việc ${running.code}`, detail: `${running.title}. ${done}/${total} việc đã xong. Bạn chưa cần làm gì.${runsText}`, next: null, steps: mk(3) });
    else if (waiting) p = out({ stage: "TASK_QUEUED", tone: "info", who: "BOT", headline: `Việc ${waiting.code} đang chờ đến lượt`, detail: `${waiting.title}. ${done}/${total} việc đã xong.${runsText}`, next: null, steps: mk(3) });
    else p = out({ stage: "TASKS_DONE", tone: "info", who: "NONE", headline: "Các việc đã xong, hệ thống đang tổng kết kế hoạch", detail: `${done}/${total} việc xong.`, next: null, steps: mk(3) });
    p.tasks = counts; return p;
  }
  if (st === "DONE" || st === "PARTIAL_DONE") return out({ stage: "PLAN_DONE", tone: "done", who: "OWNER", headline: st === "DONE" ? "Kế hoạch hoàn tất" : "Kế hoạch hoàn tất một phần", detail: "Xem báo cáo ở trang kế hoạch. Kết quả kinh doanh chưa được đánh giá tự động.", next: { label: "Đóng mục tiêu ở thẻ mục tiêu (chọn kết quả)", href: "/lumi/company" }, steps: mk(4, true) });
  return out({ stage: "PLAN_ENDED", tone: "done", who: "OWNER", headline: st === "REJECTED" ? "Kế hoạch đã bị từ chối" : "Kế hoạch đã hủy", detail: "Bạn có thể yêu cầu bot lập kế hoạch mới hoặc đóng mục tiêu.", next: { label: "Mở thẻ mục tiêu", href: "/lumi/company" }, steps: mk(1) });
}

/**
 * Task requests created by the system for a bot carry a long technical block ("CÁCH LÀM: … plan_submit_version(run_id, body) … schema=1 …").
 * The owner reads the plain part; the technical block is kept (it is what the bot was told) but folded away.
 */
export function splitRequest(text: string): { readable: string; technical: string | null } {
  const i = text.indexOf("CÁCH LÀM:");
  if (i < 0) return { readable: text, technical: null };
  return { readable: text.slice(0, i).trim(), technical: text.slice(i).trim() };
}
export const plainExpectedOutput = (text: string): string => (/plan_submit_version/.test(text) ? "Một phiên bản Plan & Cost để bạn duyệt (bot nộp qua công cụ của hệ thống)" : text);
