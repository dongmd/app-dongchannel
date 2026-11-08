import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveProgress, plainExpectedOutput, splitRequest, type ProgressInput } from "./progress";

const NOW = new Date("2026-11-08T08:00:00Z");
const at = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const base = (over: Partial<ProgressInput> = {}): ProgressInput => ({
  goal: { code: "GL-1", title: "Mục tiêu", status: "ACTIVE" }, plan: { id: "p1", code: "PL-1", status: "DRAFTING", current_version: null }, version: null,
  planningTask: { code: "DL-1", status: "RUNNING", error_code: null, needs_decision: false },
  planningRun: { state: "RUNNING", attempt_no: 1, created_at: at(100), started_at: at(90), deadline_at: new Date(NOW.getTime() + 500_000).toISOString(), error_code: null, error_message: null },
  runLimitSeconds: 600, leadReady: true, leadName: "AFF", runs: { used: 1, cap: 8 }, tasks: [], ...over,
});
const stage = (i: ProgressInput) => deriveProgress(i, NOW);

describe("Tiến trình (deriveProgress) — chỉ dựa trên dữ liệu đã ghi", () => {
  it("không có kế hoạch ⇒ đến lượt Chủ yêu cầu lập; mục tiêu đã đóng ⇒ xong", () => {
    const p = stage(base({ plan: null, planningTask: null, planningRun: null }));
    assert.deepEqual([p.stage, p.who], ["NO_PLAN", "OWNER"]);
    assert.equal(stage(base({ goal: { code: "GL-1", title: "x", status: "CLOSED" } })).stage, "GOAL_CLOSED");
  });
  it("bot đang chạy ⇒ BOT làm, hiện thời gian đã chạy/giới hạn, không có việc cho Chủ, không có phần trăm", () => {
    const p = stage(base());
    assert.deepEqual([p.stage, p.who, p.next], ["RUN_ACTIVE", "BOT", null]);
    assert.deepEqual(p.run, { since: at(90), limit_seconds: 600 });
    assert.ok(!/%/.test(p.headline + p.detail));
    assert.match(p.detail, /1\/8/);
  });
  it("quá hạn ⇒ cảnh báo; lệnh chưa được nhận quá 2 phút ⇒ cảnh báo; chưa quá ⇒ thông tin", () => {
    assert.equal(stage(base({ planningRun: { ...base().planningRun!, deadline_at: at(5) } })).stage, "RUN_OVERDUE");
    const q = (age: number) => stage(base({ planningRun: { state: "PENDING", attempt_no: 1, created_at: at(age), started_at: null, deadline_at: null, error_code: null, error_message: null } }));
    assert.deepEqual([q(30).stage, q(30).tone, q(200).tone], ["RUN_QUEUED", "info", "warn"]);
  });
  it("không chắc đã gửi ⇒ Chủ quyết định và nói rõ KHÔNG tự gửi lại; lỗi lượt ⇒ đỏ kèm mã lỗi", () => {
    const u = stage(base({ planningRun: { ...base().planningRun!, state: "DISPATCH_UNCERTAIN" } }));
    assert.deepEqual([u.stage, u.who], ["RUN_UNCERTAIN", "OWNER"]); assert.match(u.detail, /KHÔNG tự gửi lại/);
    const f = stage(base({ planningRun: { ...base().planningRun!, state: "TIMED_OUT", error_code: "RUN_DEADLINE", error_message: "Quá hạn" } }));
    assert.deepEqual([f.stage, f.tone], ["PLANNING_FAILED", "error"]); assert.match(f.headline, /RUN_DEADLINE/);
  });
  it("trợ lý chưa sẵn sàng và chưa có lượt ⇒ chỉ Tổ chức; hết hạn mức lượt ⇒ dừng, không xin thêm", () => {
    const w = stage(base({ planningRun: null, leadReady: false }));
    assert.deepEqual([w.stage, w.next?.href], ["WAITING_ASSISTANT", "/lumi/org"]);
    const c = stage(base({ runs: { used: 8, cap: 8 } }));
    assert.equal(c.stage, "CAP_REACHED"); assert.match(c.detail, /không tự xin thêm/);
  });
  it("chờ duyệt kế hoạch ⇒ Chủ, kèm liên kết tới trang kế hoạch", () => {
    const p = stage(base({ plan: { id: "p1", code: "PL-1", status: "PENDING_APPROVAL", current_version: 2 }, version: { version: 2, state: "SUBMITTED" } }));
    assert.deepEqual([p.stage, p.who, p.next?.href], ["AWAITING_APPROVAL", "OWNER", "/lumi/plans/p1"]); assert.match(p.headline, /phiên bản 2/);
  });
  it("thực hiện: chờ duyệt đầu ra ưu tiên hơn đang làm; lỗi việc ⇒ đỏ; đang làm ⇒ BOT; đếm việc xong", () => {
    const ex = (tasks: ProgressInput["tasks"]) => stage(base({ plan: { id: "p1", code: "PL-1", status: "EXECUTING", current_version: 1 }, tasks }));
    const t = (code: string, status: string, extra: object = {}) => ({ code, title: code, status, needs_decision: false, error_code: null, ...extra });
    const r = ex([t("A", "COMPLETED"), t("B", "WAITING_REVIEW"), t("C", "RUNNING")]);
    assert.deepEqual([r.stage, r.who, r.tasks], ["TASK_REVIEW", "OWNER", { done: 1, total: 3 }]);
    assert.equal(ex([t("A", "FAILED", { error_code: "X" })]).tone, "error");
    assert.deepEqual([ex([t("A", "RUNNING")]).stage, ex([t("A", "RUNNING")]).who], ["TASK_RUNNING", "BOT"]);
    assert.equal(ex([t("A", "COMPLETED")]).stage, "TASKS_DONE");
  });
  it("tạm dừng ngân sách, hoãn, hoàn tất, hủy đều có câu và việc kế tiếp rõ ràng", () => {
    const s = (status: string) => stage(base({ plan: { id: "p1", code: "PL-1", status, current_version: 1 } }));
    assert.equal(s("PAUSED_ADJUSTMENT").stage, "PAUSED"); assert.equal(s("DEFERRED").stage, "DEFERRED");
    assert.deepEqual([s("DONE").stage, s("DONE").steps.every((x) => x.state === "done")], ["PLAN_DONE", true]);
    assert.equal(s("CANCELLED").stage, "PLAN_ENDED");
  });
  it("lệnh gửi bot: phần dễ đọc tách khỏi khối kỹ thuật (không mất nội dung); việc thường giữ nguyên", () => {
    const t = ["Lập Plan & Cost cho mục tiêu GL-2.", "Kết quả mong muốn: X", "CÁCH LÀM: nghiên cứu, rồi gọi plan_submit_version(run_id, body) schema=1"].join("\n");
    const s = splitRequest(t);
    assert.equal(s.readable, ["Lập Plan & Cost cho mục tiêu GL-2.", "Kết quả mong muốn: X"].join("\n"));
    assert.ok(s.technical?.startsWith("CÁCH LÀM:") && s.technical.includes("plan_submit_version"));
    assert.deepEqual(splitRequest("Soạn mô tả"), { readable: "Soạn mô tả", technical: null });
    assert.ok(!/plan_submit_version/.test(plainExpectedOutput("Một phiên bản Plan & Cost nộp bằng plan_submit_version")));
    assert.equal(plainExpectedOutput("Bản nháp"), "Bản nháp");
  });
});
