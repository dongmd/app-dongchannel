// Dong-Lumi preview: lõi nghiệp vụ mô phỏng. Hàm thuần theo nghĩa "không I/O": nhận state, sửa tại chỗ, trả kết quả.
// Không gọi model, không gửi Telegram, không đụng Postgres/Hermes.
import { fold, inferDue, inferOutput, inferProject, makeTitle, parseIntent } from "./telegram.ts";
import {
  CURRENCIES,
  OWNER_ID,
  VIDEO_STATUSES,
  type Chat,
  type Currency,
  type VideoStatus,
  type DemoState,
  type HistoryEvent,
  type Member,
  type MemoryScope,
  type Output,
  type OutputVersion,
  type Permission,
  type Project,
  type Task,
  type TaskStatus,
  type TgCard,
  type Via,
} from "./types.ts";

export const START_DELAY_MS = 1_500;
export const DELIVER_DELAY_MS = 3_000;

export type Action =
  | { type: "member.create"; name: string; avatar: string; role: string; description: string; projectIds: string[]; permission: "assistant" | "pm" }
  | { type: "member.update"; id: string; name?: string; avatar?: string; role?: string; description?: string; projectIds?: string[]; permission?: "assistant" | "pm" }
  | { type: "member.archive"; id: string }
  | { type: "member.restore"; id: string }
  | { type: "member.connect"; id: string; connected: boolean }
  | { type: "project.setPm"; projectId: string; memberId: string }
  | { type: "project.create"; name: string; area: string; goal: string }
  | { type: "results.add"; projectId: string; periodStart: string; periodEnd: string; currency: Currency; spend: number | null; commissionReported: number | null; note?: string }
  | { type: "results.remove"; id: string }
  | { type: "video.create"; projectId: string; title: string; status?: VideoStatus }
  | { type: "video.update"; id: string; status?: VideoStatus; scheduledAt?: string | null }
  | { type: "task.setVideo"; taskId: string; videoId: string | null }
  | { type: "task.create"; projectId: string; title: string; request?: string; outputWanted?: string; due?: string; ownerId: string; via: Via; clientRequestId?: string }
  | { type: "task.retry"; taskId: string }
  | { type: "task.cancel"; taskId: string; reason: string }
  | { type: "task.assign"; taskId: string; ownerId: string; via: Via }
  | { type: "task.move"; taskId: string; to: "ready" | "doing" | "done" }
  | { type: "task.comment"; taskId: string; text: string; via: Via }
  | { type: "task.requestRevision"; taskId: string; text: string; via: Via; version?: number }
  | { type: "task.approveOutput"; taskId: string; via: Via; version?: number }
  | { type: "task.rejectOutput"; taskId: string; text: string; via: Via; version?: number }
  | { type: "memory.review"; id: string; decision: "accept" | "reject"; text?: string; scope?: MemoryScope }
  | { type: "action.review"; id: string; decision: "approve" | "reject" }
  | { type: "tg.send"; chat: Chat; text: string }
  | { type: "tg.draftStep"; draftId: string; step: "main" | "pick_project" | "pick_assignee" }
  | { type: "tg.draftSetProject"; draftId: string; projectId: string }
  | { type: "tg.draftSetAssignee"; draftId: string; assigneeId: string }
  | { type: "tg.draftConfirm"; draftId: string }
  | { type: "tg.draftCancel"; draftId: string }
  | { type: "tg.convert"; messageId: string }
  | { type: "tg.feedbackPrompt"; taskId: string; chat: Chat };

export interface Result {
  ok: boolean;
  /** "already" = bấm lại, không làm gì thêm. "stale" = nút cũ. */
  code?: "already" | "stale" | "invalid" | "not_found" | "need_project";
  message?: string;
  id?: string;
  taskId?: string;
}

const ok = (extra: Partial<Result> = {}): Result => ({ ok: true, ...extra });
const fail = (code: NonNullable<Result["code"]>, message: string): Result => ({ ok: false, code, message });

// ---------- tiện ích ----------
const iso = (ms: number) => new Date(ms).toISOString();
const nextId = (s: DemoState, prefix: string) => `${prefix}-${++s.seq.id}`;
export const memberById = (s: DemoState, id: string) => s.members.find((m) => m.id === id);
export const projectById = (s: DemoState, id: string) => s.projects.find((p) => p.id === id);
export const taskById = (s: DemoState, id: string) => s.tasks.find((t) => t.id === id);
const outputOf = (s: DemoState, t: Task) => s.outputs.find((o) => o.id === t.outputId);
const owner = (s: DemoState) => memberById(s, OWNER_ID)!;
const chatLabel = (c: Chat) => (c === "aff" ? "Telegram · AFF" : "Telegram · YouTube");
const botOfChat = (s: DemoState, c: Chat) => s.members.find((m) => m.profileKey === c && m.status === "active");

function addHistory(s: DemoState, t: Task, nowMs: number, by: Member, via: Via, kind: HistoryEvent["kind"], text?: string, version?: number) {
  t.history.push({
    id: nextId(s, "h"),
    at: iso(nowMs),
    byId: by.id,
    byName: by.name,
    via,
    kind,
    ...(text ? { text } : {}),
    ...(version ? { version } : {}),
  });
  t.updatedAt = iso(nowMs);
}

function tgText(s: DemoState, chat: Chat, text: string, nowMs: number) {
  s.tgMessages.push({ id: nextId(s, "tg"), chat, from: "bot", at: iso(nowMs), text });
}
function tgCard(s: DemoState, chat: Chat, card: TgCard, nowMs: number, text?: string) {
  s.tgMessages.push({ id: nextId(s, "tg"), chat, from: "bot", at: iso(nowMs), ...(text ? { text } : {}), card });
}
const chatOfTask = (s: DemoState, t: Task): Chat | undefined => memberById(s, t.ownerId)?.profileKey;

export function canReceiveTasks(m: Member | undefined, projectId: string): boolean {
  if (!m || m.status !== "active") return false;
  return m.kind === "human" || m.projectIds.includes(projectId);
}

// ---------- đầu ra mô phỏng ----------
function buildVersion(task: Task, project: Project, v: number, note: string | undefined, prev: OutputVersion | undefined, nowMs: number): OutputVersion {
  const f = fold(`${task.title} ${task.request} ${task.outputWanted}`);
  let title: string;
  let sections: OutputVersion["sections"];
  if (prev) {
    sections = prev.sections.map((sec) => ({
      ...sec,
      body: `${sec.body.split("\n\nĐiều chỉnh theo góp ý:")[0]}\n\nĐiều chỉnh theo góp ý: «${note ?? ""}»`,
    }));
    title = prev.title.replace(/ \(bản \d+\)/, "") + ` (bản ${v})`;
  } else if (/quang cao|google search/.test(f)) {
    title = `Ba mẫu quảng cáo cho ${project.name} (nội dung mẫu mô phỏng)`;
    sections = [
      { heading: "Góc 1 · Tiết kiệm thời gian", body: "Tiêu đề: Làm việc nhanh hơn mỗi ngày\nMô tả: Gom việc về một chỗ, bắt đầu miễn phí. Xem demo 2 phút.", meta: "Nhắm: người đang quá tải việc" },
      { heading: "Góc 2 · So sánh", body: "Tiêu đề: Thay nhiều công cụ bằng một\nMô tả: So sánh tính năng và giá. Xem bảng so sánh chi tiết.", meta: "Nhắm: người đang dùng giải pháp rời rạc" },
      { heading: "Góc 3 · Dùng thử không rủi ro", body: "Tiêu đề: Dùng thử, hủy bất kỳ lúc nào\nMô tả: Không cần thẻ để bắt đầu. Cài nhanh và thấy hiệu quả ngay.", meta: "Nhắm: người còn ngại trả phí" },
    ];
  } else if (/dan y|kich ban|video/.test(f)) {
    title = `Dàn ý cho «${task.title}» (nội dung mẫu mô phỏng)`;
    sections = [
      { heading: "Mở bài", body: "Câu hỏi móc và hứa hẹn kết quả cụ thể." },
      { heading: "Nội dung chính", body: "Ba đến năm ý, mỗi ý có ví dụ và kết quả." },
      { heading: "Kết", body: "Tóm tắt, kêu gọi đăng ký, gợi ý video tiếp theo." },
    ];
  } else {
    title = `Bản nháp: ${task.outputWanted} (nội dung mẫu mô phỏng)`;
    sections = [
      { heading: "Tóm tắt", body: `Bản tóm tắt mô phỏng cho yêu cầu: «${task.request || task.title}».` },
      { heading: "Đề xuất bước tiếp theo", body: "Xem lại, góp ý hoặc duyệt để chốt nội dung." },
    ];
  }
  return { v, title, sections, createdAt: iso(nowMs), ...(note ? { revisionNote: note } : {}) };
}

function pendingNote(task: Task): string | undefined {
  for (let i = task.history.length - 1; i >= 0; i--) {
    const h = task.history[i]!;
    if (h.kind === "output") return undefined;
    if (h.kind === "revision_requested") return h.text;
  }
  return undefined;
}

function deliver(s: DemoState, task: Task, nowMs: number) {
  const bot = memberById(s, task.ownerId);
  if (!bot) return;
  const project = projectById(s, task.projectId)!;
  let out = outputOf(s, task);
  if (!out) {
    out = { id: `o-${task.id.slice(3)}`, taskId: task.id, versions: [], state: "draft" } satisfies Output;
    s.outputs.push(out);
    task.outputId = out.id;
  }
  const v = out.versions.length + 1;
  const note = pendingNote(task);
  out.versions.push(buildVersion(task, project, v, note, out.versions[out.versions.length - 1], nowMs));
  out.state = "draft";
  task.status = "review";
  delete task.deliverAt;
  addHistory(s, task, nowMs, bot, "system", "output", v === 1 ? "Gửi bản 1 để duyệt" : `Gửi bản ${v} theo góp ý`, v);
  const chat = bot.profileKey;
  if (chat) tgCard(s, chat, { type: "status", taskId: task.id, version: v }, nowMs);
}

/** Đưa mô phỏng tiến lên theo đồng hồ. Trả true nếu có thay đổi. */
export function tick(s: DemoState, nowMs: number): boolean {
  let changed = false;
  for (const t of s.tasks) {
    const bot = memberById(s, t.ownerId);
    if (!bot || bot.kind !== "bot" || bot.status !== "active" || bot.hermes !== "connected") continue;
    if (t.status === "ready" && t.readyAt && nowMs >= Date.parse(t.readyAt) + START_DELAY_MS) {
      t.status = "doing";
      t.startedAt = iso(nowMs);
      t.deliverAt = iso(nowMs + DELIVER_DELAY_MS);
      addHistory(s, t, nowMs, bot, "system", "started");
      changed = true;
    } else if (t.status === "doing" && t.deliverAt && nowMs >= Date.parse(t.deliverAt)) {
      deliver(s, t, nowMs);
      changed = true;
    }
  }
  if (changed) s.rev++;
  return changed;
}

// ---------- việc ----------
function placeTask(s: DemoState, t: Task, nowMs: number) {
  const o = memberById(s, t.ownerId)!;
  t.waitingConnection = false;
  if (o.kind === "human") {
    t.status = "doing";
    t.startedAt = iso(nowMs);
  } else if (o.hermes === "connected") {
    t.status = "ready";
    t.readyAt = iso(nowMs);
  } else {
    t.status = "new";
    t.waitingConnection = true;
  }
}

function createTask(
  s: DemoState,
  nowMs: number,
  a: { projectId: string; title: string; request?: string; outputWanted?: string; due?: string; ownerId: string; via: Via; sourceLabel?: string; sourceChat?: Chat; botName?: string; by?: Member; videoId?: string },
): Result {
  const project = projectById(s, a.projectId);
  if (!project || project.status !== "active") return fail("not_found", "Không thấy dự án.");
  const title = a.title.trim();
  if (!title) return fail("invalid", "Cần tiêu đề việc.");
  const assignee = memberById(s, a.ownerId);
  if (!canReceiveTasks(assignee, a.projectId)) return fail("invalid", "Người nhận chưa tham gia dự án này hoặc đã lưu trữ.");
  const by = a.by ?? owner(s);
  const id = `DL-${String(++s.seq.task).padStart(3, "0")}`;
  const label = a.sourceLabel ?? (a.via === "telegram" ? "Telegram" : "Web");
  const task: Task = {
    id,
    projectId: a.projectId,
    title,
    request: (a.request ?? "").trim() || title,
    outputWanted: (a.outputWanted ?? "").trim() || "Bản nháp kết quả",
    ...(a.due ? { due: a.due } : {}),
    ownerId: assignee!.id,
    ownerName: assignee!.name,
    source: { kind: a.via === "telegram" ? "telegram" : "web", label, ...(a.sourceChat ? { chat: a.sourceChat } : {}), ...(a.botName ? { botName: a.botName } : {}) },
    ...(a.videoId ? { videoId: a.videoId } : {}),
    status: "new",
    waitingConnection: false,
    createdAt: iso(nowMs),
    updatedAt: iso(nowMs),
    history: [],
  };
  s.tasks.push(task);
  addHistory(s, task, nowMs, by, a.via, "created", `Tạo việc từ ${label}`);
  addHistory(s, task, nowMs, by, a.via, "assigned", `Giao cho ${assignee!.name}`);
  placeTask(s, task, nowMs);
  if (task.waitingConnection) addHistory(s, task, nowMs, by, "system", "status", "Chờ kết nối trợ lý");
  const chat = assignee!.profileKey;
  if (chat && a.via === "web") tgText(s, chat, `Việc mới ${id} từ web: «${task.title}» (${project.name}). Mình sẽ báo khi có đầu ra.`, nowMs);
  return ok({ id, taskId: id });
}

function approveOutput(s: DemoState, nowMs: number, taskId: string, via: Via, version?: number): Result {
  const t = taskById(s, taskId);
  const out = t && outputOf(s, t);
  if (!t || !out) return fail("not_found", "Không thấy đầu ra.");
  if (out.state === "approved") return ok({ code: "already", taskId, message: "Đã duyệt trước đó." });
  if (version !== undefined && version !== out.versions.length) return fail("stale", "Nút này thuộc bản cũ. Hãy dùng bản mới nhất.");
  if (t.status !== "review") return fail("invalid", "Việc này chưa có đầu ra chờ duyệt.");
  out.state = "approved";
  out.approvedVersion = out.versions.length;
  t.status = "done";
  addHistory(s, t, nowMs, owner(s), via, "approved", `Duyệt bản ${out.approvedVersion}. Chỉ chốt nội dung, không kích hoạt hành động bên ngoài.`, out.approvedVersion);
  const chat = chatOfTask(s, t);
  if (chat && via === "web") tgText(s, chat, `✅ ${t.id} đã được duyệt trên web (bản ${out.approvedVersion}).`, nowMs);
  return ok({ taskId });
}

function requestRevision(s: DemoState, nowMs: number, taskId: string, text: string, via: Via, version?: number): Result {
  const t = taskById(s, taskId);
  const out = t && outputOf(s, t);
  const note = text.trim();
  if (!t || !out) return fail("not_found", "Không thấy đầu ra.");
  if (!note) return fail("invalid", "Cần nội dung góp ý.");
  if (out.state === "changes_requested" && t.status === "doing") return ok({ code: "already", taskId, message: "Đã gửi yêu cầu sửa trước đó." });
  if (version !== undefined && version !== out.versions.length) return fail("stale", "Nút này thuộc bản cũ.");
  if (t.status !== "review") return fail("invalid", "Chỉ yêu cầu sửa khi đầu ra đang chờ duyệt.");
  out.state = "changes_requested";
  t.status = "doing";
  t.deliverAt = iso(nowMs + DELIVER_DELAY_MS);
  addHistory(s, t, nowMs, owner(s), via, "revision_requested", note, out.versions.length);
  const chat = chatOfTask(s, t);
  if (chat && via === "web") tgText(s, chat, `Đã nhận yêu cầu sửa ${t.id} từ web: «${note}». Mình sẽ gửi bản mới.`, nowMs);
  return ok({ taskId });
}

// ---------- Telegram ----------
function makeDraft(s: DemoState, chat: Chat, sourceText: string, body: string, nowMs: number): { draftId: string } {
  const active = s.projects.filter((p) => p.status === "active");
  const project = inferProject(body, active);
  const bot = botOfChat(s, chat) ?? owner(s);
  const due = inferDue(body);
  const id = nextId(s, "d");
  s.tgDrafts.push({
    id,
    chat,
    sourceText,
    title: makeTitle(body),
    outputWanted: inferOutput(body),
    ...(due ? { due } : {}),
    ...(project ? { projectId: project.id } : {}),
    assigneeId: bot.id,
    step: project ? "main" : "pick_project",
    state: "pending",
  });
  tgCard(s, chat, { type: "draft", draftId: id }, nowMs);
  return { draftId: id };
}

function botReply(s: DemoState, chat: Chat, text: string): string {
  if (/google\s*search/i.test(text)) {
    const d = s.memories.find((m) => m.kind === "decision" && m.status === "active" && /google search/i.test(m.text));
    if (d) {
      const p = d.projectId ? projectById(s, d.projectId) : undefined;
      return `Mình nhớ quyết định «${d.text}»${p ? ` của dự án ${p.name}` : ""}: ${d.content} (trả lời mô phỏng, không gọi model)`;
    }
  }
  const who = chat === "aff" ? "Trợ lý AFF" : "Trợ lý YouTube";
  return `${who} (mô phỏng): mình đã ghi nhận «${text.length > 80 ? `${text.slice(0, 77)}…` : text}». Không gọi model trong bản preview. Nếu đây là việc cần làm, bấm «Chuyển thành việc».`;
}

function tgSend(s: DemoState, nowMs: number, chat: Chat, raw: string): Result {
  const text = raw.trim();
  if (!text) return fail("invalid", "Tin nhắn trống.");
  const mid = nextId(s, "tg");
  s.tgMessages.push({ id: mid, chat, from: "owner", at: iso(nowMs), text });

  const awaiting = s.tgAwaiting[chat];
  if (awaiting) {
    delete s.tgAwaiting[chat];
    const r = requestRevision(s, nowMs, awaiting, text, "telegram");
    tgText(s, chat, r.ok ? `Đã ghi góp ý cho ${awaiting}. Trợ lý sẽ gửi bản sửa.` : `Không gửi được góp ý: ${r.message}`, nowMs);
    return r;
  }
  const intent = parseIntent(text);
  if (intent.kind === "task") {
    if (!intent.body) {
      tgText(s, chat, "Bạn muốn giao việc gì? Ví dụ: «Giao việc: soạn 3 mẫu quảng cáo Google Search cho Test offer US».", nowMs);
      return ok();
    }
    makeDraft(s, chat, text, intent.body, nowMs);
    return ok();
  }
  tgCard(s, chat, { type: "convert", sourceMessageId: mid }, nowMs, botReply(s, chat, text));
  return ok();
}

function draftOf(s: DemoState, id: string) {
  return s.tgDrafts.find((d) => d.id === id);
}

// ---------- điểm vào ----------
export function applyAction(s: DemoState, a: Action, nowMs: number): Result {
  const r = dispatch(s, a, nowMs);
  if (r.ok && r.code !== "already") s.rev++;
  return r;
}

function dispatch(s: DemoState, a: Action, nowMs: number): Result {
  switch (a.type) {
    case "member.create": {
      const name = a.name.trim();
      if (!name || name.length > 40) return fail("invalid", "Tên trợ lý cần từ 1 đến 40 ký tự.");
      if (!a.avatar) return fail("invalid", "Chọn avatar.");
      if (s.members.some((m) => m.status === "active" && fold(m.name) === fold(name))) return fail("invalid", "Đã có thành viên trùng tên.");
      const projectIds = a.projectIds.filter((id) => projectById(s, id));
      const m: Member = {
        id: `m-${++s.seq.member}`,
        kind: "bot",
        name,
        avatar: a.avatar,
        role: a.role.trim() || "Trợ lý",
        description: a.description.trim(),
        projectIds,
        status: "active",
        permission: (a.permission === "pm" ? "pm" : "assistant") satisfies Permission,
        hermes: "none",
        createdAt: iso(nowMs),
      };
      s.members.push(m);
      return ok({ id: m.id });
    }
    case "member.update": {
      const m = memberById(s, a.id);
      if (!m) return fail("not_found", "Không thấy thành viên.");
      if (a.name !== undefined) {
        const n = a.name.trim();
        if (!n || n.length > 40) return fail("invalid", "Tên cần từ 1 đến 40 ký tự.");
        m.name = n;
      }
      if (a.avatar) m.avatar = a.avatar;
      if (a.role !== undefined) m.role = a.role.trim() || m.role;
      if (a.description !== undefined) m.description = a.description.trim();
      if (a.projectIds && m.kind === "bot") {
        m.projectIds = a.projectIds.filter((id) => projectById(s, id));
        for (const p of s.projects) if (p.pmId === m.id && !m.projectIds.includes(p.id)) p.pmId = OWNER_ID;
      }
      if (a.permission && m.kind === "bot") m.permission = a.permission;
      return ok({ id: m.id });
    }
    case "member.archive": {
      const m = memberById(s, a.id);
      if (!m) return fail("not_found", "Không thấy thành viên.");
      if (m.id === OWNER_ID) return fail("invalid", "Không lưu trữ Chủ.");
      if (m.status === "archived") return ok({ code: "already", id: m.id });
      m.status = "archived";
      m.archivedAt = iso(nowMs);
      for (const p of s.projects) if (p.pmId === m.id) p.pmId = OWNER_ID;
      for (const t of s.tasks) {
        if (t.ownerId === m.id && (t.status === "new" || t.status === "ready" || t.status === "doing")) {
          addHistory(s, t, nowMs, owner(s), "system", "assigned", `${m.name} đã lưu trữ, việc chuyển về Chủ`);
          t.ownerId = OWNER_ID;
          t.ownerName = owner(s).name;
          delete t.deliverAt;
          placeTask(s, t, nowMs);
        }
      }
      return ok({ id: m.id });
    }
    case "member.restore": {
      const m = memberById(s, a.id);
      if (!m) return fail("not_found", "Không thấy thành viên.");
      if (m.status === "active") return ok({ code: "already", id: m.id });
      m.status = "active";
      delete m.archivedAt;
      return ok({ id: m.id });
    }
    case "member.connect": {
      const m = memberById(s, a.id);
      if (!m || m.kind !== "bot") return fail("not_found", "Không thấy trợ lý.");
      const next = a.connected ? "connected" : "none";
      if (m.hermes === next) return ok({ code: "already", id: m.id });
      m.hermes = next;
      if (a.connected) {
        for (const t of s.tasks) {
          if (t.ownerId === m.id && t.waitingConnection) {
            t.waitingConnection = false;
            t.status = "ready";
            t.readyAt = iso(nowMs);
            addHistory(s, t, nowMs, m, "system", "connection", `${m.name} đã kết nối Hermes (mô phỏng), việc sẵn sàng`);
          }
        }
      }
      return ok({ id: m.id });
    }
    case "project.setPm": {
      const p = projectById(s, a.projectId);
      const m = memberById(s, a.memberId);
      if (!p || !m || m.status !== "active") return fail("not_found", "Không thấy dự án hoặc thành viên.");
      if (m.permission === "assistant") return fail("invalid", "Thành viên này chưa có quyền PM.");
      if (m.kind === "bot" && !m.projectIds.includes(p.id)) return fail("invalid", "Thành viên chưa tham gia dự án.");
      if (p.pmId === m.id) return ok({ code: "already" });
      p.pmId = m.id;
      return ok();
    }
    case "project.create": {
      const name = a.name.trim();
      if (!name || name.length > 60) return fail("invalid", "Tên dự án cần từ 1 đến 60 ký tự.");
      if (s.projects.some((p) => p.status === "active" && fold(p.name) === fold(name))) return fail("invalid", "Đã có dự án trùng tên.");
      const id = `p-${++s.seq.id}`;
      s.projects.push({ id, name, area: a.area.trim() || "Khác", goal: a.goal.trim(), pmId: OWNER_ID, status: "active" });
      owner(s).projectIds.push(id);
      return ok({ id });
    }
    case "results.add": {
      const p = projectById(s, a.projectId);
      if (!p || p.status !== "active") return fail("not_found", "Không thấy dự án.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(a.periodEnd) || a.periodStart > a.periodEnd) return fail("invalid", "Kỳ báo cáo không hợp lệ.");
      if (!CURRENCIES.includes(a.currency)) return fail("invalid", "Đơn vị tiền không hỗ trợ.");
      const bad = (v: number | null) => v !== null && (!Number.isFinite(v) || v < 0);
      if (bad(a.spend) || bad(a.commissionReported)) return fail("invalid", "Số tiền phải là số không âm.");
      if (a.spend === null && a.commissionReported === null) return fail("invalid", "Nhập ít nhất một khoản (để trống nghĩa là chưa có dữ liệu).");
      const id = nextId(s, "r");
      s.adResults.push({ id, projectId: p.id, periodStart: a.periodStart, periodEnd: a.periodEnd, currency: a.currency, spend: a.spend, commissionReported: a.commissionReported, ...(a.note?.trim() ? { note: a.note.trim() } : {}), simulated: true, updatedAt: iso(nowMs) });
      return ok({ id });
    }
    case "results.remove": {
      const i = s.adResults.findIndex((r) => r.id === a.id);
      if (i < 0) return fail("not_found", "Không thấy số liệu.");
      s.adResults.splice(i, 1);
      return ok();
    }
    case "video.create": {
      const p = projectById(s, a.projectId);
      const title = a.title.trim();
      if (!p || p.status !== "active") return fail("not_found", "Không thấy dự án.");
      if (!title) return fail("invalid", "Cần tên video.");
      const dup = s.videos.find((v) => v.projectId === p.id && fold(v.title) === fold(title));
      if (dup) return ok({ code: "already", id: dup.id, message: "Video này đã có." });
      const id = `v-${++s.seq.id}`;
      s.videos.push({ id, projectId: p.id, title, status: a.status && VIDEO_STATUSES.includes(a.status) ? a.status : "idea", createdAt: iso(nowMs), updatedAt: iso(nowMs) });
      return ok({ id });
    }
    case "video.update": {
      const v = s.videos.find((x) => x.id === a.id);
      if (!v) return fail("not_found", "Không thấy video.");
      const status = a.status ?? v.status;
      if (!VIDEO_STATUSES.includes(status)) return fail("invalid", "Trạng thái video không hợp lệ.");
      let at: string | undefined = a.scheduledAt === undefined ? v.scheduledAt : (a.scheduledAt ?? undefined);
      if (status === "scheduled") {
        if (!at || Number.isNaN(Date.parse(at))) return fail("invalid", "Video đã lên lịch cần ngày giờ đăng.");
      } else if (status !== "published") at = undefined;
      v.status = status;
      if (at) v.scheduledAt = at;
      else delete v.scheduledAt;
      v.updatedAt = iso(nowMs);
      return ok({ id: v.id });
    }
    case "task.setVideo": {
      const t = taskById(s, a.taskId);
      if (!t) return fail("not_found", "Không thấy việc.");
      if (a.videoId === null) {
        delete t.videoId;
        return ok({ taskId: t.id });
      }
      const v = s.videos.find((x) => x.id === a.videoId);
      if (!v || v.projectId !== t.projectId) return fail("invalid", "Video không thuộc dự án của việc này.");
      if (t.videoId === v.id) return ok({ code: "already", taskId: t.id });
      t.videoId = v.id;
      return ok({ taskId: t.id });
    }
    case "task.create":
      return createTask(s, nowMs, a);
    case "task.assign": {
      const t = taskById(s, a.taskId);
      if (!t) return fail("not_found", "Không thấy việc.");
      const m = memberById(s, a.ownerId);
      if (!canReceiveTasks(m, t.projectId)) return fail("invalid", "Người nhận chưa tham gia dự án hoặc đã lưu trữ.");
      if (t.ownerId === a.ownerId) return ok({ code: "already", taskId: t.id });
      if (t.status === "review" || t.status === "done") return fail("invalid", "Việc đã có đầu ra hoặc đã xong, không đổi người.");
      t.ownerId = m!.id;
      t.ownerName = m!.name;
      delete t.deliverAt;
      addHistory(s, t, nowMs, owner(s), a.via, "assigned", `Giao cho ${m!.name}`);
      placeTask(s, t, nowMs);
      if (t.waitingConnection) addHistory(s, t, nowMs, owner(s), "system", "status", "Chờ kết nối trợ lý");
      return ok({ taskId: t.id });
    }
    case "task.move": {
      const t = taskById(s, a.taskId);
      if (!t) return fail("not_found", "Không thấy việc.");
      const o = memberById(s, t.ownerId);
      if (a.to === "ready" && t.status === "new" && !t.waitingConnection) {
        t.status = "ready";
        if (o?.kind === "bot") t.readyAt = iso(nowMs);
      } else if (a.to === "doing" && (t.status === "ready" || t.status === "new") && !t.waitingConnection) {
        t.status = "doing";
        t.startedAt = iso(nowMs);
        if (o?.kind === "bot") t.deliverAt = iso(nowMs + DELIVER_DELAY_MS);
        if (o) addHistory(s, t, nowMs, o, "system", "started");
      } else if (a.to === "done" && o?.kind === "human" && t.status !== "done") {
        t.status = "done";
      } else {
        return fail("invalid", "Không chuyển được sang trạng thái này.");
      }
      addHistory(s, t, nowMs, owner(s), "web", "status", `Chuyển sang ${a.to}`);
      return ok({ taskId: t.id });
    }
    case "task.comment": {
      const t = taskById(s, a.taskId);
      const text = a.text.trim();
      if (!t) return fail("not_found", "Không thấy việc.");
      if (!text) return fail("invalid", "Cần nội dung góp ý.");
      addHistory(s, t, nowMs, owner(s), a.via, "comment", text);
      return ok({ taskId: t.id });
    }
    case "task.requestRevision":
      return requestRevision(s, nowMs, a.taskId, a.text, a.via, a.version);
    case "task.approveOutput":
      return approveOutput(s, nowMs, a.taskId, a.via, a.version);
    case "task.rejectOutput":
      return fail("invalid", "Từ chối đầu ra kèm lý do chỉ có ở chế độ dữ liệu thật.");
    case "memory.review": {
      const m = s.memories.find((x) => x.id === a.id);
      if (!m) return fail("not_found", "Không thấy ghi nhớ.");
      if (m.status !== "proposed") return ok({ code: "already", id: m.id });
      if (a.decision === "reject") {
        m.status = "rejected";
        return ok({ id: m.id });
      }
      const scope: MemoryScope = a.scope ?? (m.projectId ? "project" : "personal");
      if (scope === "project" && !m.projectId) return fail("invalid", "Ghi nhớ này không gắn dự án.");
      const edited = a.text?.trim();
      if (edited) m.content = edited;
      m.scope = scope;
      if (scope === "area") m.area = projectById(s, m.projectId ?? "")?.area ?? m.area;
      if (scope === "personal") delete m.area;
      m.status = "active";
      m.at = iso(nowMs);
      return ok({ id: m.id });
    }
    case "action.review": {
      const x = s.actions.find((y) => y.id === a.id);
      if (!x) return fail("not_found", "Không thấy yêu cầu.");
      if (x.status !== "pending") return ok({ code: "already", id: x.id });
      x.status = a.decision === "approve" ? "approved" : "rejected";
      x.decidedAt = iso(nowMs);
      return ok({ id: x.id });
    }
    case "tg.send":
      return tgSend(s, nowMs, a.chat, a.text);
    case "tg.draftStep": {
      const d = draftOf(s, a.draftId);
      if (!d) return fail("not_found", "Không thấy thẻ.");
      if (d.state !== "pending") return ok({ code: "already" });
      d.step = a.step;
      return ok();
    }
    case "tg.draftSetProject": {
      const d = draftOf(s, a.draftId);
      const p = projectById(s, a.projectId);
      if (!d || !p) return fail("not_found", "Không thấy thẻ hoặc dự án.");
      if (d.state !== "pending") return ok({ code: "already" });
      d.projectId = p.id;
      d.step = "main";
      const as = memberById(s, d.assigneeId);
      if (!canReceiveTasks(as, p.id)) d.assigneeId = OWNER_ID;
      return ok();
    }
    case "tg.draftSetAssignee": {
      const d = draftOf(s, a.draftId);
      const m = memberById(s, a.assigneeId);
      if (!d || !m) return fail("not_found", "Không thấy thẻ hoặc thành viên.");
      if (d.state !== "pending") return ok({ code: "already" });
      if (m.status !== "active") return fail("invalid", "Thành viên đã lưu trữ.");
      d.assigneeId = m.id;
      d.step = "main";
      return ok();
    }
    case "tg.draftCancel": {
      const d = draftOf(s, a.draftId);
      if (!d) return fail("not_found", "Không thấy thẻ.");
      if (d.state !== "pending") return ok({ code: "already" });
      d.state = "cancelled";
      return ok();
    }
    case "tg.draftConfirm": {
      const d = draftOf(s, a.draftId);
      if (!d) return fail("not_found", "Không thấy thẻ.");
      if (d.state === "created") return ok({ code: "already", taskId: d.taskId, message: "Việc đã được tạo trước đó." });
      if (d.state === "cancelled") return fail("invalid", "Thẻ đã hủy.");
      if (!d.projectId) return fail("need_project", "Chọn dự án trước.");
      const r = createTask(s, nowMs, {
        projectId: d.projectId,
        title: d.title,
        request: d.sourceText.replace(/^\/viec\S*\s*/i, "").replace(/^giao\s+vi[eệ]c\s*:\s*/i, ""),
        outputWanted: d.outputWanted,
        ...(d.due ? { due: d.due } : {}),
        ownerId: d.assigneeId,
        via: "telegram",
        sourceLabel: chatLabel(d.chat),
        sourceChat: d.chat,
        botName: botOfChat(s, d.chat)?.name ?? "Bot",
      });
      if (!r.ok) return r;
      d.state = "created";
      d.taskId = r.taskId!;
      return r;
    }
    case "tg.convert": {
      const msg = s.tgMessages.find((m) => m.id === a.messageId);
      const card = msg?.card;
      if (!msg || !card || card.type !== "convert") return fail("not_found", "Không thấy tin nhắn.");
      if (card.draftId) return ok({ code: "already" });
      const src = s.tgMessages.find((m) => m.id === card.sourceMessageId);
      const { draftId } = makeDraft(s, msg.chat, src?.text ?? "", src?.text ?? "", nowMs);
      card.draftId = draftId;
      return ok({ id: draftId });
    }
    case "tg.feedbackPrompt": {
      const t = taskById(s, a.taskId);
      if (!t) return fail("not_found", "Không thấy việc.");
      if (s.tgAwaiting[a.chat] === t.id) return ok({ code: "already" });
      if (t.status !== "review") return fail("invalid", "Việc này không còn chờ duyệt.");
      s.tgAwaiting[a.chat] = t.id;
      tgCard(s, a.chat, { type: "feedback_prompt", taskId: t.id }, nowMs, `Gõ góp ý của bạn cho ${t.id} (tin nhắn kế tiếp sẽ được gửi làm yêu cầu sửa).`);
      return ok();
    }
    case "task.retry":
    case "task.cancel":
      return fail("invalid", "Chỉ có ở chế độ dữ liệu thật.");
    default: {
      const _x: never = a;
      return fail("invalid", `Hành động không hỗ trợ: ${JSON.stringify(_x)}`);
    }
  }
}

export type { TaskStatus };
