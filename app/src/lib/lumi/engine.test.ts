import assert from "node:assert/strict";
import { test } from "node:test";

import { applyAction, DELIVER_DELAY_MS, START_DELAY_MS, tick } from "./engine.ts";
import { createSeed } from "./seed.ts";
import { colsFor, LABEL_WIDTH, layoutSpots, shortName } from "./office-layout.ts";
import { activeRulesFor, affiliateResults, approvalsHref, memberStates, openTasks, pendingBreakdown, pendingCounts, pendingItems, projectStage, searchMemories, telegramRecent, youtubeSummary } from "./selectors.ts";
import { parseIntent } from "./telegram.ts";
import { OWNER_ID } from "./types.ts";

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);

function run() {
  return createSeed(T0);
}
/** Cho mô phỏng chạy đủ thời gian để trợ lý nhận và giao đầu ra. */
function settle(s: ReturnType<typeof run>, from: number) {
  let t = from;
  for (let i = 0; i < 4; i++) {
    t += START_DELAY_MS + 100;
    tick(s, t);
    t += DELIVER_DELAY_MS + 100;
    tick(s, t);
  }
  return t;
}

test("parseIntent: /viec và 'Giao việc:' là lệnh, còn lại là chat", () => {
  assert.deepEqual(parseIntent("/viec soạn quảng cáo"), { kind: "task", body: "soạn quảng cáo" });
  assert.deepEqual(parseIntent("Giao việc: soạn 3 mẫu"), { kind: "task", body: "soạn 3 mẫu" });
  assert.deepEqual(parseIntent("giao viec: abc"), { kind: "task", body: "abc" });
  assert.equal(parseIntent("xin chào").kind, "chat");
});

test("A: tạo Trợ lý PM, thêm vào hai dự án, giao việc -> chờ kết nối; kết nối rồi mới chạy", () => {
  const s = run();
  const r = applyAction(s, { type: "member.create", name: "Trợ lý PM", avatar: "shield", role: "Điều phối dự án", description: "Chia việc", projectIds: ["p-offer", "p-yt"], permission: "pm" }, T0);
  assert.ok(r.ok && r.id);
  const pm = s.members.find((m) => m.id === r.id)!;
  assert.equal(pm.avatar, "shield");
  assert.deepEqual(pm.projectIds.sort(), ["p-offer", "p-yt"]);
  // Ba trạng thái tách rõ.
  assert.deepEqual({ ...memberStates(s, pm) }, { profile: true, hermes: "none", executing: 0, waiting: 0, pendingReview: 0 });
  // Trùng tên bị chặn.
  assert.equal(applyAction(s, { type: "member.create", name: "trợ lý pm", avatar: "shield", role: "", description: "", projectIds: [], permission: "assistant" }, T0).ok, false);

  const t = applyAction(s, { type: "task.create", projectId: "p-offer", title: "Chia việc tuần này", ownerId: pm.id, via: "web" }, T0 + 1000);
  assert.ok(t.ok);
  const task = s.tasks.find((x) => x.id === t.taskId)!;
  assert.equal(task.status, "new");
  assert.equal(task.waitingConnection, true);
  tick(s, T0 + 60_000);
  assert.equal(task.status, "new", "chưa kết nối thì không tự chạy");

  applyAction(s, { type: "member.connect", id: pm.id, connected: true }, T0 + 61_000);
  assert.equal(task.waitingConnection, false);
  assert.equal(task.status, "ready");
  settle(s, T0 + 61_000);
  assert.equal(task.status, "review");

  // PM có quyền được giao làm PM của dự án; trợ lý thường thì không.
  assert.ok(applyAction(s, { type: "project.setPm", projectId: "p-yt", memberId: pm.id }, T0).ok);
  assert.equal(applyAction(s, { type: "project.setPm", projectId: "p-yt", memberId: "m-aff" }, T0).ok, false);
});

test("lưu trữ trợ lý giữ tên trong lịch sử, việc đang mở về Chủ", () => {
  const s = run();
  const r = applyAction(s, { type: "task.create", projectId: "p-offer", title: "X", ownerId: "m-aff", via: "web" }, T0);
  const task = s.tasks.find((x) => x.id === r.taskId)!;
  assert.equal(task.ownerName, "Trợ lý AFF");
  applyAction(s, { type: "member.archive", id: "m-aff" }, T0 + 10);
  assert.equal(task.ownerId, OWNER_ID);
  assert.ok(task.history.some((h) => /Trợ lý AFF/.test(h.text ?? "")), "lịch sử của việc mở vẫn nhắc tên trợ lý đã lưu trữ");
  const done = s.tasks.find((x) => x.id === "DL-001")!;
  assert.equal(done.ownerName, "Trợ lý AFF");
  assert.ok(done.history.some((h) => h.byName === "Trợ lý AFF"), "việc đã xong giữ nguyên tên người phụ trách");
  assert.equal(applyAction(s, { type: "task.create", projectId: "p-offer", title: "Y", ownerId: "m-aff", via: "web" }, T0).ok, false);
  assert.equal(applyAction(s, { type: "member.archive", id: OWNER_ID }, T0).ok, false);
});

test("B: Telegram -> thẻ xác nhận -> việc -> sửa từ web -> duyệt từ Telegram; bấm lại không trùng", () => {
  const s = run();
  applyAction(s, { type: "tg.send", chat: "aff", text: "Giao việc: soạn 3 mẫu quảng cáo Google Search cho Test offer US" }, T0);
  const draft = s.tgDrafts[0]!;
  assert.equal(draft.projectId, "p-offer");
  assert.equal(draft.assigneeId, "m-aff");
  assert.equal(draft.outputWanted, "3 mẫu quảng cáo");
  assert.equal(draft.step, "main");

  const c1 = applyAction(s, { type: "tg.draftConfirm", draftId: draft.id }, T0 + 1000);
  assert.ok(c1.ok && c1.taskId);
  const before = s.tasks.length;
  const c2 = applyAction(s, { type: "tg.draftConfirm", draftId: draft.id }, T0 + 1100);
  assert.equal(c2.code, "already");
  assert.equal(s.tasks.length, before, "bấm xác nhận lần hai không tạo việc trùng");
  const task = s.tasks.find((x) => x.id === c1.taskId)!;
  assert.equal(task.source.label, "Telegram · AFF");

  // Trợ lý chạy mô phỏng và giao bản 1.
  tick(s, T0 + 1000 + START_DELAY_MS + 10);
  assert.equal(task.status, "doing");
  tick(s, T0 + 1000 + START_DELAY_MS + 10 + DELIVER_DELAY_MS + 10);
  assert.equal(task.status, "review");
  const out = s.outputs.find((o) => o.id === task.outputId)!;
  assert.equal(out.versions.length, 1);
  assert.equal(out.versions[0]!.sections.length, 3, "ba góc quảng cáo");
  const t1 = T0 + 20_000;

  // Yêu cầu sửa từ web, bấm lại không nhân đôi.
  assert.ok(applyAction(s, { type: "task.requestRevision", taskId: task.id, text: "Ngắn hơn, nhấn mạnh dùng thử", via: "web" }, t1).ok);
  assert.equal(applyAction(s, { type: "task.requestRevision", taskId: task.id, text: "Ngắn hơn, nhấn mạnh dùng thử", via: "web" }, t1 + 5).code, "already");
  assert.equal(task.status, "doing");
  tick(s, t1 + DELIVER_DELAY_MS + 10);
  assert.equal(task.status, "review");
  assert.equal(out.versions.length, 2);
  assert.match(out.versions[1]!.sections[0]!.body, /Điều chỉnh theo góp ý/);

  // Nút bản 1 đã cũ; duyệt bản 2 từ Telegram.
  assert.equal(applyAction(s, { type: "task.approveOutput", taskId: task.id, via: "telegram", version: 1 }, t1 + 4000).code, "stale");
  assert.equal(task.status, "review");
  assert.ok(applyAction(s, { type: "task.approveOutput", taskId: task.id, via: "telegram", version: 2 }, t1 + 4100).ok);
  assert.equal(task.status, "done");
  assert.equal(out.state, "approved");
  assert.equal(applyAction(s, { type: "task.approveOutput", taskId: task.id, via: "telegram", version: 2 }, t1 + 4200).code, "already");
  assert.equal(task.history.filter((h) => h.kind === "approved").length, 1, "không duyệt trùng");
  // Lịch sử ghi đúng nguồn.
  assert.ok(task.history.some((h) => h.kind === "revision_requested" && h.via === "web"));
  assert.ok(task.history.some((h) => h.kind === "approved" && h.via === "telegram"));
});

test("Telegram: chưa rõ dự án thì hỏi bằng nút; chat thường có nút Chuyển thành việc (một lần)", () => {
  const s = run();
  applyAction(s, { type: "tg.send", chat: "aff", text: "/viec tìm thêm offer SaaS" }, T0);
  const d = s.tgDrafts[0]!;
  assert.equal(d.projectId, undefined);
  assert.equal(d.step, "pick_project");
  assert.equal(applyAction(s, { type: "tg.draftConfirm", draftId: d.id }, T0).code, "need_project");
  assert.ok(applyAction(s, { type: "tg.draftSetProject", draftId: d.id, projectId: "p-offer" }, T0).ok);
  assert.ok(applyAction(s, { type: "tg.draftSetAssignee", draftId: d.id, assigneeId: OWNER_ID }, T0).ok);
  const r = applyAction(s, { type: "tg.draftConfirm", draftId: d.id }, T0);
  assert.equal(s.tasks.find((t) => t.id === r.taskId)!.status, "doing", "Chủ tự nhận việc");

  applyAction(s, { type: "tg.send", chat: "yt", text: "Nên đặt tiêu đề video thế nào?" }, T0);
  const conv = s.tgMessages.filter((m) => m.card?.type === "convert").at(-1)!;
  const n = s.tasks.length;
  assert.equal(applyAction(s, { type: "tg.convert", messageId: conv.id }, T0).ok, true);
  assert.equal(applyAction(s, { type: "tg.convert", messageId: conv.id }, T0).code, "already");
  assert.equal(s.tgDrafts.length, 2);
  assert.equal(s.tasks.length, n);
  // Hủy thẻ
  const d2 = s.tgDrafts[1]!;
  applyAction(s, { type: "tg.draftCancel", draftId: d2.id }, T0);
  assert.equal(applyAction(s, { type: "tg.draftConfirm", draftId: d2.id }, T0).ok, false);
});

test("Telegram: yêu cầu sửa bằng tin nhắn kế tiếp", () => {
  const s = run();
  assert.ok(applyAction(s, { type: "tg.feedbackPrompt", taskId: "DL-002", chat: "aff" }, T0).ok);
  assert.equal(applyAction(s, { type: "tg.feedbackPrompt", taskId: "DL-002", chat: "aff" }, T0).code, "already");
  applyAction(s, { type: "tg.send", chat: "aff", text: "Thêm một góc về giá" }, T0 + 5);
  assert.equal(s.tasks.find((t) => t.id === "DL-002")!.status, "doing");
  assert.equal(s.tgAwaiting.aff, undefined);
});

test("C: ghi nhớ riêng dự án không thành quy tắc của dự án khác; ba loại duyệt tách nhau", () => {
  const s = run();
  const found = searchMemories(s, "google search");
  assert.ok(found.length >= 2, "thấy cả quyết định và đề xuất");
  assert.ok(found.some((m) => m.kind === "decision" && m.evidence.length > 0 && m.reason));
  const before = pendingCounts(s);
  assert.ok(applyAction(s, { type: "memory.review", id: "mem-p1", decision: "accept", text: "Khi thử offer mới, chạy Google Search trước.", scope: "project" }, T0).ok);
  assert.equal(applyAction(s, { type: "memory.review", id: "mem-p1", decision: "accept", scope: "personal" }, T0).code, "already");
  assert.equal(s.memories.find((m) => m.id === "mem-p1")!.scope, "project");
  assert.equal(activeRulesFor(s, "p-offer").some((m) => m.id === "mem-p1"), true);
  assert.equal(activeRulesFor(s, "p-yt").some((m) => m.id === "mem-p1"), false);
  assert.equal(searchMemories(s, "google search", "p-yt").some((m) => m.id === "mem-p1"), false);
  assert.equal(pendingCounts(s).memory, before.memory - 1);
  assert.equal(pendingCounts(s).action, before.action, "duyệt ghi nhớ không đụng hành động bên ngoài");

  // Phạm vi mảng: lan sang dự án cùng mảng; cá nhân: lan tới mọi dự án.
  applyAction(s, { type: "memory.review", id: "mem-p2", decision: "accept", scope: "area" }, T0);
  assert.equal(activeRulesFor(s, "p-yt").some((m) => m.id === "mem-p2"), true);
  assert.equal(activeRulesFor(s, "p-offer").some((m) => m.id === "mem-p2"), false);
  applyAction(s, { type: "memory.review", id: "mem-p3", decision: "accept", scope: "personal" }, T0);
  assert.equal(activeRulesFor(s, "p-offer").some((m) => m.id === "mem-p3"), true);
});

test("duyệt đầu ra không kích hoạt hành động bên ngoài", () => {
  const s = run();
  const act = s.actions.filter((a) => a.status === "pending").length;
  assert.ok(applyAction(s, { type: "task.approveOutput", taskId: "DL-002", via: "web" }, T0).ok);
  assert.equal(s.actions.filter((a) => a.status === "pending").length, act);
  assert.ok(applyAction(s, { type: "action.review", id: "act-1", decision: "approve" }, T0).ok);
  assert.equal(applyAction(s, { type: "action.review", id: "act-1", decision: "reject" }, T0).code, "already");
  assert.equal(s.actions.find((a) => a.id === "act-1")!.status, "approved");
});

test("việc tạo từ web cho trợ lý Hermes thật: có tin nhắn Telegram phản ánh khi giao đầu ra", () => {
  const s = run();
  const r = applyAction(s, { type: "task.create", projectId: "p-yt", title: "Ý tưởng tiêu đề", ownerId: "m-yt", via: "web" }, T0);
  settle(s, T0);
  const task = s.tasks.find((t) => t.id === r.taskId)!;
  assert.equal(task.status, "review");
  assert.ok(s.tgMessages.some((m) => m.chat === "yt" && m.card?.type === "status" && m.card.taskId === task.id));
  assert.equal(task.source.label, "Web");
});

test("cờ preview: tắt mặc định, và không bao giờ bật khi NEXTAUTH_URL là dongchannel.com", async () => {
  const { isLumiPreviewEnabled, isLumiPreviewPath } = await import("./preview-flag.ts");
  const keep = { p: process.env.DONGLUMI_PREVIEW, u: process.env.NEXTAUTH_URL };
  try {
    delete process.env.DONGLUMI_PREVIEW;
    assert.equal(isLumiPreviewEnabled(), false);
    process.env.DONGLUMI_PREVIEW = "1";
    process.env.NEXTAUTH_URL = "http://localhost:3010";
    assert.equal(isLumiPreviewEnabled(), true);
    process.env.NEXTAUTH_URL = "https://app.dongchannel.com";
    assert.equal(isLumiPreviewEnabled(), false);
    assert.ok(isLumiPreviewPath("/lumi") && isLumiPreviewPath("/api/lumi/state") && !isLumiPreviewPath("/api/v1/tasks"));
  } finally {
    if (keep.p === undefined) delete process.env.DONGLUMI_PREVIEW; else process.env.DONGLUMI_PREVIEW = keep.p;
    if (keep.u === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = keep.u;
  }
});

test("Chờ duyệt: đếm tách ba loại, tổng và lọc theo dự án nhất quán", () => {
  const s = run();
  const all = pendingCounts(s);
  assert.deepEqual({ memory: all.memory, output: all.output, action: all.action }, { memory: 3, output: 2, action: 2 });
  assert.equal(all.total, all.memory + all.output + all.action);
  const a = pendingCounts(s, "p-offer");
  const b = pendingCounts(s, "p-yt");
  // Mục cá nhân (không thuộc dự án nào) chỉ nằm trong tổng, không nằm trong bộ lọc dự án.
  assert.equal(a.output + b.output, all.output);
  assert.equal(a.action + b.action, all.action);
  assert.equal(a.memory + b.memory, all.memory - 1);
  assert.equal(pendingBreakdown(all), "7 mục: 3 ghi nhớ + 2 đầu ra + 2 hành động bên ngoài");
  assert.equal(approvalsHref("output", "p-offer"), "/lumi/approvals?tab=output&project=p-offer");
});

test("Bộ nhớ: quy tắc đề xuất liên kết với quyết định nguồn", () => {
  const s = run();
  for (const m of s.memories.filter((x) => x.kind === "rule" && x.projectId)) {
    const src = s.memories.find((x) => x.id === m.sourceMemoryId);
    assert.ok(src && src.kind === "decision" && src.projectId === m.projectId, `${m.id} phải trỏ tới quyết định cùng dự án`);
  }
});

test("Văn phòng 3D: bố trí 3, 6, 9 thành viên không chồng bàn và nhãn; tên ngắn", () => {
  for (const n of [1, 3, 4, 6, 9, 12]) {
    const sp = layoutSpots(n);
    assert.equal(sp.length, n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = Math.abs(sp[i]!.x - sp[j]!.x);
        const dz = Math.abs(sp[i]!.z - sp[j]!.z);
        // Hai góc làm việc cùng hàng cách nhau hơn bề rộng nhãn; khác hàng cách nhau hơn chiều sâu bàn + ghế.
        assert.ok(dx >= LABEL_WIDTH + 0.5 || dz >= 3.6, `n=${n}: hai góc ${i},${j} quá gần`);
      }
    }
  }
  assert.equal(colsFor(3), 2);
  assert.equal(colsFor(6), 3);
  assert.equal(shortName("Trợ lý AFF"), "AFF");
  assert.equal(shortName("Trợ lý YouTube"), "YouTube");
  assert.equal(shortName("Dong"), "Dong");
  assert.equal(shortName("Trợ lý Phân tích dữ liệu lớn"), "Phân tích d…");
});

test("Dashboard: danh sách cần xử lý khớp số đếm theo ba loại, theo dự án và theo trợ lý", () => {
  const s = run();
  for (const f of [{}, { projectId: "p-offer" }, { projectId: "p-yt" }, { memberId: "m-aff" }, { projectId: "p-offer", memberId: "m-aff" }] as { projectId?: string; memberId?: string }[]) {
    const items = pendingItems(s, f);
    const c = pendingCounts(s, f.projectId, f.memberId);
    assert.equal(items.length, c.total, JSON.stringify(f));
    for (const k of ["output", "memory", "action"] as const) assert.equal(items.filter((i) => i.kind === k).length, c[k], `${JSON.stringify(f)} ${k}`);
  }
  const out = pendingItems(s, { projectId: "p-offer" }).find((i) => i.kind === "output")!;
  assert.equal(out.cta, "Xem 3 mẫu quảng cáo");
  assert.equal(out.href, "/lumi/projects/p-offer?task=DL-002&v=1");
  assert.equal(pendingItems(s).length, pendingCounts(s).total);
});

test("Dashboard: duyệt nội dung không duyệt hành động; yêu cầu sửa đổi phiên bản trong liên kết", () => {
  const s = run();
  const actions = pendingCounts(s).action;
  applyAction(s, { type: "task.requestRevision", taskId: "DL-002", text: "Ngắn hơn", via: "web", version: 1 }, T0);
  assert.equal(pendingItems(s).some((i) => i.kind === "output" && i.key === "t-DL-002"), false, "đang sửa thì không còn chờ duyệt");
  tick(s, T0 + DELIVER_DELAY_MS + 10);
  const again = pendingItems(s).find((i) => i.key === "t-DL-002")!;
  assert.equal(again.version, 2);
  assert.match(again.href, /v=2$/);
  applyAction(s, { type: "task.approveOutput", taskId: "DL-002", via: "web", version: 2 }, T0 + 9000);
  assert.equal(pendingCounts(s).action, actions, "hành động bên ngoài vẫn chờ");
  assert.equal(pendingItems(s).some((i) => i.kind === "action"), true);
});

test("Dashboard: dự án mới xuất hiện trong bộ lọc và số đếm; bước hiện tại của từng dự án", () => {
  const s = run();
  const r = applyAction(s, { type: "project.create", name: "Test offer EU", area: "Affiliate", goal: "Thử offer châu Âu" }, T0);
  assert.ok(r.ok && r.id);
  assert.equal(applyAction(s, { type: "project.create", name: "test OFFER eu", area: "Affiliate", goal: "" }, T0).ok, false);
  assert.equal(projectStage(s, r.id!).now, "Đã xong các việc đang mở");
  assert.equal(projectStage(s, "p-offer").now, "Chờ bạn duyệt 3 mẫu quảng cáo (DL-002)");
  assert.match(projectStage(s, "p-yt").now, /^Chờ bạn duyệt dàn ý video/);
  assert.match(projectStage(s, "p-yt").next ?? "", /Viết kịch bản chi tiết/);
  assert.equal(pendingCounts(s, r.id).total, 0);
  assert.equal(openTasks(s, { projectId: r.id }).length, 0);
});

test("Telegram gần nhất: ghi bot nhận lúc tạo và trạng thái mới nhất theo cùng một việc", () => {
  const s = run();
  applyAction(s, { type: "tg.send", chat: "yt", text: "Giao việc: viết tiêu đề cho Kênh tiếng Anh" }, T0);
  const d = s.tgDrafts[0]!;
  applyAction(s, { type: "tg.draftConfirm", draftId: d.id }, T0 + 10);
  applyAction(s, { type: "tg.draftConfirm", draftId: d.id }, T0 + 20);
  const rec = telegramRecent(s);
  assert.equal(rec.length, 2, "DL-002 mẫu và việc mới, không trùng");
  assert.equal(rec[0]!.bot, "Trợ lý YouTube");
  assert.equal(rec[0]!.task.source.chat, "yt");
  assert.equal(rec[0]!.latest, "Sẵn sàng");
  tick(s, T0 + 10 + START_DELAY_MS + 5);
  tick(s, T0 + 10 + START_DELAY_MS + 5 + DELIVER_DELAY_MS + 5);
  assert.equal(telegramRecent(s)[0]!.latest, "Bản 1 chờ bạn duyệt");
  assert.equal(telegramRecent(s, { projectId: "p-offer" }).length, 1);
});

test("Kết quả Affiliate: chưa có dữ liệu khác 0; hoa hồng trừ chi phí chỉ tính khi đủ cả hai; không cộng khác tiền", () => {
  const s = run();
  const now = Date.UTC(2026, 10, 5);
  assert.equal(affiliateResults(s, {}, 7, now).state, "none");
  assert.equal(affiliateResults(s, { projectId: "p-yt" }, 7, now).state, "na");

  // 0 là đã đo và bằng 0.
  assert.ok(applyAction(s, { type: "results.add", projectId: "p-offer", periodStart: "2026-10-29", periodEnd: "2026-11-04", currency: "USD", spend: 0, commissionReported: 0 }, now).ok);
  let r = affiliateResults(s, {}, 7, now);
  assert.equal(r.state, "data");
  if (r.state === "data") {
    assert.equal(r.byCurrency[0]!.spend, 0);
    assert.equal(r.byCurrency[0]!.net, 0);
  }
  // Thiếu hoa hồng ở một kỳ: net là null, không tự suy ra.
  applyAction(s, { type: "results.add", projectId: "p-offer", periodStart: "2026-10-29", periodEnd: "2026-11-04", currency: "USD", spend: 25, commissionReported: null }, now);
  r = affiliateResults(s, {}, 7, now);
  if (r.state === "data") {
    const usd = r.byCurrency.find((c) => c.currency === "USD")!;
    assert.equal(usd.spend, 25);
    assert.equal(usd.commission, 0);
    assert.equal(usd.net, null);
  }
  // Khác đơn vị tiền: tách riêng.
  applyAction(s, { type: "results.add", projectId: "p-offer", periodStart: "2026-11-01", periodEnd: "2026-11-04", currency: "VND", spend: 500000, commissionReported: 800000 }, now);
  r = affiliateResults(s, {}, 7, now);
  if (r.state === "data") {
    assert.equal(r.byCurrency.length, 2);
    assert.equal(r.byCurrency.find((c) => c.currency === "VND")!.net, 300000);
  }
  // Ngoài kỳ không tính; đầu vào sai bị chặn.
  assert.equal(affiliateResults(s, {}, 1, Date.UTC(2026, 11, 30)).state, "none");
  assert.equal(applyAction(s, { type: "results.add", projectId: "p-offer", periodStart: "2026-11-04", periodEnd: "2026-11-01", currency: "USD", spend: 1, commissionReported: 1 }, now).ok, false);
  assert.equal(applyAction(s, { type: "results.add", projectId: "p-offer", periodStart: "2026-11-01", periodEnd: "2026-11-04", currency: "USD", spend: null, commissionReported: null }, now).ok, false);
  assert.equal(applyAction(s, { type: "results.add", projectId: "p-offer", periodStart: "2026-11-01", periodEnd: "2026-11-04", currency: "USD", spend: -5, commissionReported: 1 }, now).ok, false);
});

test("YouTube: đếm theo video, ba việc của một video chỉ là một video; việc chưa gắn video không được đếm", () => {
  const s = run();
  const now = Date.UTC(2026, 10, 5);
  let y = youtubeSummary(s, {}, now);
  assert.equal(y.state, "ok");
  if (y.state !== "ok") return;
  assert.equal(y.videos.length, 1);
  assert.equal(y.producing, 1);
  assert.equal(y.awaiting, 1, "DL-003 chờ duyệt thuộc video v-1");
  assert.equal(y.nextSchedule, null);
  assert.equal(y.unlinkedTasks, 0);
  // Thêm hai việc nữa cho cùng một video: vẫn một video.
  for (const title of ["Chọn thumbnail", "Viết mô tả"]) {
    const t = applyAction(s, { type: "task.create", projectId: "p-yt", title, ownerId: "m-yt", via: "web" }, now);
    assert.ok(applyAction(s, { type: "task.setVideo", taskId: t.taskId!, videoId: "v-1" }, now).ok);
  }
  y = youtubeSummary(s, {}, now);
  if (y.state === "ok") {
    assert.equal(y.videos.length, 1);
    assert.equal(y.videos[0]!.tasks, 4);
    assert.equal(y.awaiting, 1);
  }
  // Việc chưa gắn video: không thành video.
  applyAction(s, { type: "task.create", projectId: "p-yt", title: "Ý tưởng chung", ownerId: "m-yt", via: "web" }, now);
  y = youtubeSummary(s, {}, now);
  if (y.state === "ok") {
    assert.equal(y.videos.length, 1);
    assert.equal(y.unlinkedTasks, 1);
  }
  // Lịch đăng: cần ngày giờ; hiện lịch gần nhất trong tương lai.
  assert.equal(applyAction(s, { type: "video.update", id: "v-1", status: "scheduled" }, now).ok, false);
  assert.ok(applyAction(s, { type: "video.update", id: "v-1", status: "scheduled", scheduledAt: "2026-11-12T12:00:00.000Z" }, now).ok);
  y = youtubeSummary(s, {}, now);
  if (y.state === "ok") {
    assert.equal(y.producing, 0);
    assert.equal(y.nextSchedule?.id, "v-1");
  }
  assert.equal(youtubeSummary(s, { projectId: "p-offer" }, now).state, "na");
  assert.equal(applyAction(s, { type: "task.setVideo", taskId: "DL-002", videoId: "v-1" }, now).ok, false, "video khác dự án");
});
