import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_STALE_SECONDS, ageText, describeNotification, profileCard, workerCard, type ProfileStatus } from "./admin";

const NOW = Date.parse("2026-11-07T10:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const live: ProfileStatus = { profile: "aff", gateway: "running", telegram: "connected", cron: [{ name: "ops-hub-alerts", enabled: true, last_run_at: ago(120), last_status: "ok", last_error: null, next_run_at: ago(-180) }] };

describe("IMP-02 quản trị: thẻ trạng thái chỉ hiện điều đã quan sát (ADM-01/07/08)", () => {
  it("ageText; không có dữ liệu = 'chưa có', không bịa 'vừa xong'", () => {
    assert.equal(ageText(null, NOW), "chưa có"); assert.equal(ageText(ago(30), NOW), "30 giây trước"); assert.equal(ageText(ago(600), NOW), "10 phút trước"); assert.equal(ageText(ago(7200), NOW), "2 giờ trước");
  });
  it("worker: chưa có tín hiệu ⇒ unknown; tươi ⇒ ok; có lỗi ⇒ warn; quá một chu kỳ kiểm ⇒ down (Ngắt ⇒ báo mất kết nối ≤ 1 chu kỳ)", () => {
    assert.equal(workerCard(null, NOW).level, "unknown");
    assert.equal(workerCard({ at: ago(20), mode: "real", serves: ["aff-trial"] }, NOW).level, "ok");
    assert.equal(workerCard({ at: ago(20), mode: "real", serves: ["a"], lastError: "x" }, NOW).level, "warn");
    assert.equal(workerCard({ at: ago(SNAPSHOT_STALE_SECONDS + 1), mode: "real", serves: ["a"] }, NOW).level, "down");
    assert.equal(workerCard({ at: ago(SNAPSHOT_STALE_SECONDS - 1), mode: "real", serves: ["a"] }, NOW).level, "ok");
  });
  it("profile Hermes: gateway chạy + Telegram nối + cron ok ⇒ ok; gateway dừng ⇒ down; Telegram rớt ⇒ warn; cron lỗi/tắt ⇒ warn", () => {
    assert.equal(profileCard(live, ago(10), NOW).level, "ok");
    assert.equal(profileCard({ ...live, gateway: "stopped" }, ago(10), NOW).level, "down");
    assert.equal(profileCard({ ...live, telegram: "disconnected" }, ago(10), NOW).level, "warn");
    assert.equal(profileCard({ ...live, cron: [{ ...live.cron[0]!, last_status: "error", last_error: "timeout" }] }, ago(10), NOW).level, "warn");
    assert.equal(profileCard({ ...live, cron: [{ ...live.cron[0]!, enabled: false }] }, ago(10), NOW).level, "warn");
  });
  it("ngắt Hermes: ảnh chụp cũ KHÔNG hiện như hiện tại; chưa có ảnh chụp ⇒ unknown; profile không có gateway là bình thường", () => {
    const stale = profileCard(live, ago(SNAPSHOT_STALE_SECONDS + 5), NOW);
    assert.equal(stale.level, "down"); assert.match(stale.lines[0]!, /Mất kết nối/); assert.equal(stale.lines.length, 1);
    assert.equal(profileCard(live, null, NOW).level, "unknown");
    const trial = profileCard({ profile: "aff-trial", gateway: null, telegram: null, cron: [] }, ago(5), NOW);
    assert.equal(trial.level, "ok"); assert.match(trial.lines[0]!, /Không có gateway/);
  });
  it("thông báo: mô tả đúng và nói thật việc gửi Telegram (chưa nối ≠ đã gửi)", () => {
    const base = { id: "1", created_at: ago(5), href: null };
    const d = describeNotification({ ...base, type: "OUTPUT_READY", taskCode: "DL-002", version: 1, state: "DONE", last_error: "NOT_DELIVERED: stub" });
    assert.match(d.text, /DL-002.*bản 1/); assert.match(d.delivery, /chưa gửi Telegram/); assert.doesNotMatch(d.delivery, /đã gửi/);
    assert.equal(describeNotification({ ...base, type: "PLAN_READY", planCode: "PL-1", version: 2, state: "DONE", last_error: null }).delivery, "đã gửi Telegram");
    assert.equal(describeNotification({ ...base, type: "PLAN_DONE", planCode: "PL-1", state: "DEAD", last_error: "boom" }).delivery, "gửi Telegram lỗi");
    assert.match(describeNotification({ ...base, type: "LA", state: "PENDING", last_error: null }).text, /Sự kiện LA/);
  });
});
