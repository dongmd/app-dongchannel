/**
 * Checklist of the plan workflow with a status per step. Pure over RECORDED facts: run times, plan status, the plan version, and every REJECTED
 * submission attempt (the app records the list of bad fields each time the bot's submission is refused). Sections the validator did not flag in the last
 * refused attempt are shown as passing, because the validator reports ALL bad fields in one pass.
 */
export type CheckState = "done" | "current" | "todo" | "bad";
export interface Attempt { at: string; errors: string[] }
export interface CheckSub { key: string; label: string; state: "ok" | "bad"; note: string | null }
export interface CheckItem { key: string; label: string; state: CheckState; at: string | null; detail: string | null; sub: CheckSub[] }

export interface ChecklistInput {
  planStatus: string | null;
  version: { version: number; submitted_at: string | null } | null;
  run: { state: string; created_at: string; started_at: string | null; finished_at: string | null; error_code: string | null } | null;
  attempts: Attempt[];
  tasks: { status: string }[];
  hintFor: (field: string) => string;
}

export const SECTIONS: { key: string; label: string }[] = [
  { key: "schema", label: "Phiên bản lược đồ" }, { key: "summary", label: "Tóm tắt" }, { key: "opportunity", label: "Cơ hội và bằng chứng" },
  { key: "scope", label: "Phạm vi (làm / không làm)" }, { key: "deliverables", label: "Đầu ra" }, { key: "tasks", label: "Danh sách việc" },
  { key: "milestones", label: "Mốc" }, { key: "cost", label: "Chi phí dự kiến" }, { key: "prepare_spent", label: "Chi phí chuẩn bị đã dùng" },
  { key: "grants_requested", label: "Quyền xin thêm (phải để trống)" }, { key: "stop_conditions", label: "Điều kiện dừng" }, { key: "risks", label: "Rủi ro" },
  { key: "alternatives", label: "Phương án khác" },
];
const SECTION_KEYS = new Set(SECTIONS.map((s) => s.key));
/** "opportunity.evidence[0]" → "opportunity"; "tasks[2].key" → "tasks"; "body(object)" → "body". */
export const sectionOf = (err: string): string => err.split(/[.[(]/, 1)[0] ?? err;

const RUN_FAILED = ["FAILED", "TIMED_OUT", "CANCELLED", "ABANDONED"];
const mk = (key: string, label: string, state: CheckState, at: string | null = null, detail: string | null = null, sub: CheckSub[] = []): CheckItem => ({ key, label, state, at, detail, sub });

export function buildChecklist(i: ChecklistInput): CheckItem[] {
  const run = i.run;
  const st = i.planStatus ?? "";
  const failedRun = !!run && RUN_FAILED.includes(run.state);
  const activeRun = !!run && ["PENDING", "DISPATCHED", "RUNNING"].includes(run.state);
  const submitted = !!i.version;
  const out: CheckItem[] = [];

  out.push(mk("goal", "Mục tiêu đã tạo", "done"));
  out.push(mk("assign", "Lệnh lập kế hoạch đã giao cho bot", run ? "done" : "current", run?.created_at ?? null, run ? null : "Chưa có lượt chạy"));
  out.push(mk("start", "Bot xác nhận bắt đầu", run?.started_at ? "done" : run && activeRun ? "current" : failedRun && !run?.started_at ? "bad" : "todo", run?.started_at ?? null,
    failedRun && !run?.started_at ? `Lượt chạy kết thúc trước khi bot bắt đầu (${run?.error_code ?? run?.state})` : null));

  const worked = submitted || i.attempts.length > 0 || run?.state === "SUCCEEDED";
  out.push(mk("work", "Bot nghiên cứu và soạn kế hoạch", worked ? "done" : run?.state === "RUNNING" ? "current" : failedRun ? "bad" : "todo", null,
    failedRun && !worked ? `Lượt chạy dừng với lỗi ${run?.error_code ?? run?.state} khi chưa nộp được gì` : null));

  // submission: the part the owner cannot see otherwise
  const last = i.attempts[i.attempts.length - 1];
  if (submitted) {
    out.push(mk("submit", "Bot nộp kế hoạch hợp lệ", "done", i.version!.submitted_at,
      `Phiên bản ${i.version!.version} đã qua kiểm tra lược đồ${i.attempts.length ? `, sau ${i.attempts.length} lần bị từ chối trước đó` : ""}.`));
  } else if (last) {
    const bad = new Map<string, string[]>();
    for (const e of last.errors) { const k = SECTION_KEYS.has(sectionOf(e)) ? sectionOf(e) : "other"; bad.set(k, [...(bad.get(k) ?? []), e]); }
    const sub: CheckSub[] = SECTIONS.map((s) => {
      const errs = bad.get(s.key);
      return { key: s.key, label: s.label, state: errs ? "bad" : "ok", note: errs ? `${errs.join("; ")}${i.hintFor(errs[0]!) ? `. Cần: ${i.hintFor(errs[0]!)}` : ""}` : null } as CheckSub;
    });
    if (bad.has("other")) sub.push({ key: "other", label: "Mục khác", state: "bad", note: (bad.get("other") ?? []).join("; ") });
    const nBad = sub.filter((s) => s.state === "bad").length;
    out.push(mk("submit", "Bot nộp kế hoạch", activeRun ? "current" : "bad", last.at,
      `Đã nộp ${i.attempts.length} lần, chưa lần nào hợp lệ. Lần gần nhất bị từ chối: ${nBad} mục chưa đạt. ${activeRun ? "Bot đang sửa." : "Bot đã dừng, chưa có bản hợp lệ."}`, sub));
  } else {
    out.push(mk("submit", "Bot nộp kế hoạch", worked ? "current" : "todo", null, activeRun ? "Chưa nộp lần nào (bot đang làm)." : null));
  }

  out.push(mk("approve", "Bạn duyệt kế hoạch",
    ["EXECUTING", "PAUSED_ADJUSTMENT", "DONE", "PARTIAL_DONE"].includes(st) ? "done" : st === "PENDING_APPROVAL" ? "current" : st === "REJECTED" ? "bad" : "todo", null,
    st === "PENDING_APPROVAL" ? "Đang chờ bạn." : st === "REJECTED" ? "Bạn đã từ chối." : null));

  const done = i.tasks.filter((t) => t.status === "COMPLETED").length;
  out.push(mk("execute", "Bot thực hiện các việc con", st === "DONE" || st === "PARTIAL_DONE" ? "done" : st === "EXECUTING" || st === "PAUSED_ADJUSTMENT" ? "current" : "todo", null,
    i.tasks.length ? `${done}/${i.tasks.length} việc đã xong` : null));
  out.push(mk("finish", "Hoàn tất kế hoạch", st === "DONE" || st === "PARTIAL_DONE" ? "done" : st === "CANCELLED" ? "bad" : "todo", null, st === "CANCELLED" ? "Kế hoạch đã hủy." : null));
  return out;
}
