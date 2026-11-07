import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeed } from "./seed";
import { openTasks } from "./selectors";
import { filterTasks, normalizeText, statusCounts } from "./task-filter";

const NOW = Date.parse("2026-11-07T08:00:00Z");
const s = createSeed(NOW);

describe("IMP-02 việc xuyên dự án (PRJ-06): lọc và đếm", () => {
  it("bỏ dấu khi tìm; từ khóa tìm theo mã, tiêu đề, yêu cầu, người nhận, dự án", () => {
    assert.equal(normalizeText("Đẹp Lắm"), "dep lam");
    const t = s.tasks[0]!;
    const word = normalizeText(t.title).split(/\s+/).find((w) => w.length > 3)!;
    assert.ok(filterTasks(s, { q: word }, NOW).some((x) => x.id === t.id));
    assert.ok(filterTasks(s, { q: t.id }, NOW).some((x) => x.id === t.id));
    assert.equal(filterTasks(s, { q: "zzzkhongco" }, NOW).length, 0);
  });

  it("lọc kết hợp (AND): dự án + người nhận + trạng thái + nguồn", () => {
    const t = s.tasks.find((x) => x.status !== "done")!;
    const r = filterTasks(s, { projectId: t.projectId, ownerId: t.ownerId, status: t.status, source: t.source.kind }, NOW);
    assert.ok(r.length >= 1 && r.every((x) => x.projectId === t.projectId && x.ownerId === t.ownerId && x.status === t.status && x.source.kind === t.source.kind));
    assert.equal(filterTasks(s, { projectId: t.projectId, status: t.status }, NOW).length >= r.length, true, "thêm điều kiện chỉ làm kết quả hẹp hơn");
  });

  it("khớp số đếm Dashboard cùng phạm vi: status 'open' ≡ openTasks(); tổng các trạng thái = tổng danh sách", () => {
    for (const projectId of [undefined, ...s.projects.map((p) => p.id)]) {
      const mine = filterTasks(s, { projectId, status: "open" }, NOW);
      assert.deepEqual(mine.map((x) => x.id).sort(), openTasks(s, { projectId }).map((x) => x.id).sort(), `phạm vi ${projectId ?? "tất cả"}`);
      const all = filterTasks(s, { projectId }, NOW);
      const c = statusCounts(all);
      assert.equal(c.new + c.ready + c.doing + c.review + c.done, c.total);
      assert.equal(c.total - c.done, mine.length);
    }
  });

  it("lọc hạn: quá hạn chỉ gồm việc có hạn đã qua và chưa xong; 'chưa có hạn' tách khỏi 'có hạn'", () => {
    const withDue = { ...s, tasks: s.tasks.map((t, i) => (i === 0 ? { ...t, status: "doing" as const, due: new Date(NOW - 86400_000).toISOString() } : i === 1 ? { ...t, status: "doing" as const, due: new Date(NOW + 86400_000).toISOString() } : { ...t, due: undefined })) };
    assert.deepEqual(filterTasks(withDue, { due: "overdue" }, NOW).map((x) => x.id), [withDue.tasks[0]!.id]);
    assert.equal(filterTasks(withDue, { due: "has" }, NOW).length, 2);
    assert.equal(filterTasks(withDue, { due: "none" }, NOW).length, withDue.tasks.length - 2);
  });
});
