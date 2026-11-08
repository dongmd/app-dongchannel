import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChecklist, sectionOf, type ChecklistInput } from "./progress-checklist";

const run = (state: string, over: object = {}) => ({ state, created_at: "2026-11-08T08:00:00Z", started_at: "2026-11-08T08:00:10Z", finished_at: null, error_code: null, ...over });
const base = (over: Partial<ChecklistInput> = {}): ChecklistInput => ({ planStatus: "DRAFTING", version: null, run: run("RUNNING"), attempts: [], tasks: [], hintFor: (f) => (f.startsWith("schema") ? "phải đúng bằng 1" : ""), ...over });
const by = (c: ReturnType<typeof buildChecklist>, key: string) => c.find((x) => x.key === key)!;

describe("checklist tiến độ nộp kế hoạch", () => {
  it("sectionOf lấy đúng mục gốc của đường dẫn trường", () => {
    assert.deepEqual(["opportunity.evidence[0]", "tasks[2].key", "schema(=1)", "cost.lines[1](low>base)", "body(object)"].map(sectionOf), ["opportunity", "tasks", "schema", "cost", "body"]);
  });
  it("bot đang làm, chưa nộp: các bước trước xong, bước nộp chưa tới lượt, không có mục con", () => {
    const c = buildChecklist(base());
    assert.deepEqual(["goal", "assign", "start", "work", "submit", "approve"].map((k) => by(c, k).state), ["done", "done", "done", "current", "todo", "todo"]);
    assert.equal(by(c, "submit").sub.length, 0);
  });
  it("nộp bị từ chối: nêu số lần, mục nào sai kèm lời giải thích, mục còn lại đạt", () => {
    const c = buildChecklist(base({ attempts: [{ at: "t1", errors: ["schema(=1)"] }, { at: "t2", errors: ["schema(=1)", "opportunity.evidence[0]", "deliverables[1]"] }] }));
    const s = by(c, "submit");
    assert.equal(s.state, "current"); assert.match(s.detail ?? "", /2 lần.*3 mục chưa đạt/);
    assert.deepEqual(s.sub.filter((x) => x.state === "bad").map((x) => x.key), ["schema", "opportunity", "deliverables"]);
    assert.ok(s.sub.filter((x) => x.state === "ok").length === 10);
    assert.match(s.sub.find((x) => x.key === "schema")!.note ?? "", /phải đúng bằng 1/);
    assert.equal(s.at, "t2");
  });
  it("bot dừng mà vẫn chưa có bản hợp lệ ⇒ bước nộp đỏ; lượt lỗi trước khi bắt đầu ⇒ bước bắt đầu đỏ", () => {
    const stopped = buildChecklist(base({ run: run("TIMED_OUT", { error_code: "TIMED_OUT" }), attempts: [{ at: "t", errors: ["tasks"] }] }));
    assert.equal(by(stopped, "submit").state, "bad"); assert.match(by(stopped, "submit").detail ?? "", /Bot đã dừng/);
    const early = buildChecklist(base({ run: run("FAILED", { started_at: null, error_code: "DISPATCH_FAILED" }) }));
    assert.deepEqual([by(early, "start").state, by(early, "work").state], ["bad", "bad"]);
  });
  it("đã có phiên bản hợp lệ ⇒ bước nộp xong (kể cả sau các lần bị từ chối); chờ duyệt là bước hiện tại", () => {
    const c = buildChecklist(base({ planStatus: "PENDING_APPROVAL", version: { version: 1, submitted_at: "ts" }, run: run("SUCCEEDED"), attempts: [{ at: "t", errors: ["schema(=1)"] }] }));
    assert.deepEqual([by(c, "submit").state, by(c, "approve").state], ["done", "current"]);
    assert.match(by(c, "submit").detail ?? "", /sau 1 lần bị từ chối/);
  });
  it("thực hiện và hoàn tất: đếm việc con; kế hoạch hủy ⇒ đỏ", () => {
    const ex = buildChecklist(base({ planStatus: "EXECUTING", version: { version: 1, submitted_at: "ts" }, run: run("SUCCEEDED"), tasks: [{ status: "COMPLETED" }, { status: "RUNNING" }] }));
    assert.deepEqual([by(ex, "approve").state, by(ex, "execute").state, by(ex, "execute").detail], ["done", "current", "1/2 việc đã xong"]);
    assert.equal(by(buildChecklist(base({ planStatus: "DONE", version: { version: 1, submitted_at: "ts" }, run: run("SUCCEEDED") })), "finish").state, "done");
    assert.equal(by(buildChecklist(base({ planStatus: "CANCELLED" })), "finish").state, "bad");
  });
});
