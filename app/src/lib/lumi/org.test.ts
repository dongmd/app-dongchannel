import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMPANY_FUNCTIONS, STAGE_RESPONSIBILITIES, DECISION_LEAD, assistantStates, derivePermissionLevels, whyCannotTakeWork, type AssistantLike } from "./org";

const base: AssistantLike = {
  status: "ACTIVE", connection_state: "NONE", dispatch_enabled: false, capability_mode: "RESTRICTED", tool_allowlist: ["knowledge.context", "outputs.submit"],
  max_runs_per_day: 8, run_deadline_seconds: 600, hermes_profile: "x", active_grants: 0, runs_in_flight: 0,
};

describe("IMP-02 màn Tổ chức: hàm thuần (ORG-01/02/04)", () => {
  it("ORG-01: đủ 12 chức năng, mỗi cái có người/hệ thống đảm nhận hoặc 'chưa kích hoạt' kèm đầu mối quyết định; chức năng chưa kích hoạt không tạo hồ sơ bot", () => {
    assert.equal(COMPANY_FUNCTIONS.length, 12);
    assert.deepEqual(COMPANY_FUNCTIONS.map((f) => f.code), Array.from({ length: 12 }, (_, i) => `DEP-${String(i + 1).padStart(2, "0")}`));
    for (const f of COMPANY_FUNCTIONS) {
      assert.ok(f.holder.trim().length > 0, `${f.code} thiếu người/hệ thống`);
      if (f.inactive) assert.ok(f.note && /chưa kích hoạt/i.test(f.note), `${f.code} chưa kích hoạt phải ghi rõ`);
    }
    assert.deepEqual(COMPANY_FUNCTIONS.filter((f) => f.inactive).map((f) => f.code), ["DEP-04", "DEP-07", "DEP-08"]);
    assert.match(DECISION_LEAD, /Chủ/);
  });

  it("ORG-02: ba trạng thái tách riêng — hồ sơ / kết nối / thực thi", () => {
    assert.deepEqual(assistantStates(base), { profile: "Đã tạo hồ sơ", connection: "Chưa kết nối", execution: "Giao việc tắt" });
    assert.deepEqual(assistantStates({ ...base, connection_state: "VERIFIED", dispatch_enabled: true }), { profile: "Đã tạo hồ sơ", connection: "Đã kết nối (đã kiểm thật)", execution: "Đang bật giao việc" });
    assert.equal(assistantStates({ ...base, connection_state: "FAILED" }).connection, "Kiểm tra lỗi");
    assert.equal(assistantStates({ ...base, runs_in_flight: 1, dispatch_enabled: true }).execution, "Đang chạy");
    assert.equal(assistantStates({ ...base, status: "ARCHIVED" }).profile, "Đã lưu trữ");
  });

  it("ORG-04: Q0–Q4 là nhãn dẫn xuất từ cấu hình thật; không có mức nào bật nếu cấu hình chưa có; mục chưa ép được ghi 'chỉ là lời dặn'", () => {
    const rows = derivePermissionLevels(base);
    assert.deepEqual(rows.map((r) => r.level), ["Q0", "Q1", "Q2", "Q3", "Q4"]);
    assert.deepEqual(rows.map((r) => r.active), [false, false, false, false, true]); // chưa kết nối, chưa giao việc, không ủy quyền
    const live = derivePermissionLevels({ ...base, connection_state: "VERIFIED", dispatch_enabled: true, active_grants: 2 });
    assert.deepEqual(live.map((r) => r.active), [true, true, false, true, true]);
    assert.match(live[3]!.basis, /2 giấy ủy quyền/);
    const full = derivePermissionLevels({ ...base, connection_state: "VERIFIED", dispatch_enabled: true, capability_mode: "DECLARED_FULL", capability_ack_at: "2026-11-07T08:00:00Z", max_subtasks: 3 });
    assert.equal(full[0]!.active, false); assert.equal(full[2]!.active, true);
    assert.equal(full[2]!.enforcement, "Chỉ là lời dặn / chưa kiểm chứng"); assert.match(full[2]!.caveat, /không bị app chặn/);
    assert.match(live[1]!.caveat, /chưa đo/); // money is explicitly not enforced
    const noAck = derivePermissionLevels({ ...base, capability_mode: "DECLARED_FULL", capability_ack_at: null });
    assert.equal(noAck[2]!.active, false, "công cụ rộng chưa có xác nhận thì Q2 không bật");
  });

  it("lý do một trợ lý chưa nhận việc được: lưu trữ / chưa kết nối / kiểm lỗi / tắt giao việc / tạm dừng; nhận được thì null", () => {
    assert.match(whyCannotTakeWork({ ...base, status: "ARCHIVED" })!, /lưu trữ/);
    assert.match(whyCannotTakeWork(base)!, /Chưa kết nối/);
    assert.match(whyCannotTakeWork({ ...base, connection_state: "FAILED", connection_error: "PROFILE_EXCEEDS_ALLOWLIST: terminal" })!, /PROFILE_EXCEEDS_ALLOWLIST/);
    assert.match(whyCannotTakeWork({ ...base, connection_state: "VERIFIED" })!, /Giao việc đang tắt/);
    assert.match(whyCannotTakeWork({ ...base, connection_state: "VERIFIED", dispatch_enabled: true, dispatch_paused: true })!, /tạm dừng/);
    assert.equal(whyCannotTakeWork({ ...base, connection_state: "VERIFIED", dispatch_enabled: true }), null);
  });

  it("ORG-04: bảng trách nhiệm S1–S6 đủ sáu giai đoạn, mỗi giai đoạn có AFF/YT/trưởng kế hoạch/quyền; không có cột quyền mới", () => {
    assert.deepEqual(STAGE_RESPONSIBILITIES.map((r) => r.stage), ["S1", "S2", "S3", "S4", "S5", "S6"]);
    for (const r of STAGE_RESPONSIBILITIES) for (const k of ["aff", "yt", "lead", "level"] as const) assert.ok(r[k].length >= (k === "level" ? 2 : 10), `${r.stage}.${k}`);
    assert.match(STAGE_RESPONSIBILITIES[1]!.lead, /không tự duyệt kế hoạch mình lập/);
  });
});
