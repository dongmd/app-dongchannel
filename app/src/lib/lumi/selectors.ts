import { fold } from "./telegram.ts";
import type { DemoState, Member, Memory, Output, Project, Task, Video } from "./types.ts";

export const STATUS_LABEL = {
  new: "Mới",
  ready: "Sẵn sàng",
  doing: "Đang làm",
  review: "Chờ duyệt",
  done: "Hoàn tất",
} as const;

/** DSH-03: ONE label for an output that is waiting for the owner; it disappears as soon as the output is approved. */
export const NEW_OUTPUT_LABEL = "Đầu ra mới nhận";
export const SCOPE_LABEL = { project: "Riêng dự án", area: "Dùng chung một mảng", personal: "Cá nhân" } as const;

export const byTimeDesc = <T extends { at?: string; updatedAt?: string }>(a: T, b: T) =>
  Date.parse(b.updatedAt ?? b.at ?? "") - Date.parse(a.updatedAt ?? a.at ?? "");

export function member(s: DemoState, id: string): Member | undefined {
  return s.members.find((m) => m.id === id);
}
export function project(s: DemoState, id: string): Project | undefined {
  return s.projects.find((p) => p.id === id);
}
export function outputOfTask(s: DemoState, t: Task): Output | undefined {
  return s.outputs.find((o) => o.id === t.outputId);
}

/** Tên hiển thị của người phụ trách: lấy tên hiện tại; nếu đã lưu trữ thì thêm nhãn nhưng vẫn giữ tên. */
export function ownerLabel(s: DemoState, t: Task): string {
  const m = member(s, t.ownerId);
  return m && m.status === "archived" ? `${t.ownerName} (đã lưu trữ)` : (m?.name ?? t.ownerName);
}

export function memberTasks(s: DemoState, memberId: string): Task[] {
  return s.tasks.filter((t) => t.ownerId === memberId);
}
export function memberOpenTasks(s: DemoState, memberId: string): Task[] {
  return memberTasks(s, memberId).filter((t) => t.status !== "done");
}

/** Ba trạng thái tách rõ: đã tạo hồ sơ, đã kết nối Hermes, đang thực thi. */
export function memberStates(s: DemoState, m: Member) {
  const doing = s.tasks.filter((t) => t.ownerId === m.id && t.status === "doing").length;
  return {
    profile: true as const,
    hermes: m.kind === "human" ? ("human" as const) : m.hermes,
    executing: doing,
    waiting: s.tasks.filter((t) => t.ownerId === m.id && t.waitingConnection).length,
    pendingReview: s.tasks.filter((t) => t.ownerId === m.id && t.status === "review").length,
  };
}

/**
 * Đếm mục chờ duyệt, tách rõ ba loại: ghi nhớ, đầu ra công việc, hành động bên ngoài.
 * `total` là tổng cả ba loại. Có `projectId` thì chỉ đếm mục thuộc dự án đó; có `memberId` thì chỉ đếm mục của trợ lý đó
 * (người phụ trách đầu ra, người đề xuất ghi nhớ, người yêu cầu hành động).
 */
export function pendingCounts(s: DemoState, projectId?: string, memberId?: string) {
  const memory = s.memories.filter((m) => m.status === "proposed" && (!projectId || m.projectId === projectId) && (!memberId || m.proposedBy === memberId)).length;
  const output = s.tasks.filter((t) => t.status === "review" && (!projectId || t.projectId === projectId) && (!memberId || t.ownerId === memberId)).length;
  const action = s.actions.filter((a) => a.status === "pending" && (!projectId || a.projectId === projectId) && (!memberId || a.requestedBy === memberId)).length;
  return { memory, output, action, total: memory + output + action };
}

export const PENDING_LABEL = { memory: "ghi nhớ", output: "đầu ra", action: "hành động bên ngoài" } as const;
/** Văn bản mô tả tổng: "7 mục: 3 ghi nhớ + 2 đầu ra + 2 hành động bên ngoài". */
export function pendingBreakdown(c: ReturnType<typeof pendingCounts>): string {
  return `${c.total} mục: ${c.memory} ${PENDING_LABEL.memory} + ${c.output} ${PENDING_LABEL.output} + ${c.action} ${PENDING_LABEL.action}`;
}
/** Đường dẫn danh sách Chờ duyệt đã lọc theo loại (và dự án). */
export function approvalsHref(tab: "memory" | "output" | "action", projectId?: string): string {
  return `/lumi/approvals?tab=${tab}${projectId ? `&project=${projectId}` : ""}`;
}

export function latestDecision(s: DemoState, projectId: string): Memory | undefined {
  return s.memories
    .filter((m) => m.kind === "decision" && m.status === "active" && m.projectId === projectId)
    .sort(byTimeDesc)[0];
}

const NEXT_ORDER = { doing: 0, ready: 1, new: 2 } as const;
export function nextTask(s: DemoState, projectId: string): Task | undefined {
  return s.tasks
    .filter((t) => t.projectId === projectId && (t.status === "doing" || t.status === "ready" || t.status === "new"))
    .sort((a, b) => NEXT_ORDER[a.status as keyof typeof NEXT_ORDER] - NEXT_ORDER[b.status as keyof typeof NEXT_ORDER] || Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

export function projectSummary(s: DemoState, projectId: string) {
  const p = project(s, projectId)!;
  const review = s.tasks.filter((t) => t.projectId === projectId && t.status === "review");
  const actions = s.actions.filter((a) => a.projectId === projectId && a.status === "pending");
  const memories = s.memories.filter((m) => m.projectId === projectId && m.status === "proposed");
  return {
    project: p,
    decision: latestDecision(s, projectId),
    next: nextTask(s, projectId),
    pm: member(s, p.pmId),
    review,
    actions,
    memories,
    members: s.members.filter((m) => m.status === "active" && (m.kind === "human" || m.projectIds.includes(projectId))),
    open: s.tasks.filter((t) => t.projectId === projectId && t.status !== "done").length,
  };
}

/** Quy tắc đang áp dụng cho một dự án: riêng dự án + cùng mảng + cá nhân. Quy tắc riêng dự án khác không lọt vào. */
export function activeRulesFor(s: DemoState, projectId: string): Memory[] {
  const p = project(s, projectId);
  if (!p) return [];
  return s.memories.filter(
    (m) =>
      m.kind === "rule" &&
      m.status === "active" &&
      ((m.scope === "project" && m.projectId === projectId) || (m.scope === "area" && m.area === p.area) || m.scope === "personal"),
  );
}

export function searchMemories(s: DemoState, query: string, projectId?: string): Memory[] {
  const q = fold(query.trim());
  return s.memories
    .filter((m) => m.status !== "rejected")
    .filter((m) => !projectId || m.projectId === projectId || m.scope === "personal" || (m.scope === "area" && m.area === project(s, projectId)?.area))
    .filter((m) => !q || fold(`${m.text} ${m.content} ${m.reason} ${m.evidence.map((e) => `${e.label} ${e.note}`).join(" ")}`).includes(q))
    .sort(byTimeDesc);
}

export interface FeedItem {
  kind: "decide" | "done" | "project";
  key: string;
  title: string;
  meta: string;
  href: string;
  at: string;
}

export function todayFeed(s: DemoState) {
  const decide: FeedItem[] = [
    ...s.tasks
      .filter((t) => t.status === "review")
      .map((t) => ({ kind: "decide" as const, key: `t-${t.id}`, title: t.title, meta: `Đầu ra chờ duyệt · ${project(s, t.projectId)?.name} · ${ownerLabel(s, t)}`, href: `/lumi/projects/${t.projectId}?task=${t.id}`, at: t.updatedAt })),
    ...s.memories
      .filter((m) => m.status === "proposed")
      .map((m) => ({ kind: "decide" as const, key: `m-${m.id}`, title: `Ghi nhớ: ${m.text}`, meta: `Đề xuất ghi nhớ · ${m.projectId ? project(s, m.projectId)?.name : "Cá nhân"}`, href: `/lumi/approvals?tab=memory&id=${m.id}`, at: m.at })),
    ...s.actions
      .filter((a) => a.status === "pending")
      .map((a) => ({ kind: "decide" as const, key: `a-${a.id}`, title: a.title, meta: `Hành động bên ngoài · ${project(s, a.projectId)?.name}`, href: `/lumi/approvals?tab=action&id=${a.id}`, at: a.at })),
  ].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));

  const done: FeedItem[] = s.tasks
    .flatMap((t) =>
      t.history
        .filter((h) => h.kind === "output")
        .map((h) => ({ kind: "done" as const, key: `o-${t.id}-${h.version ?? 0}`, title: `${t.title}${h.version && h.version > 1 ? ` (bản ${h.version})` : ""}`, meta: `${h.byName} vừa gửi đầu ra · ${project(s, t.projectId)?.name}`, href: `/lumi/projects/${t.projectId}?task=${t.id}`, at: h.at })),
    )
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    .slice(0, 6);

  const projects: FeedItem[] = s.projects
    .filter((p) => p.status === "active")
    .map((p) => {
      const sum = projectSummary(s, p.id);
      return { kind: "project" as const, key: `p-${p.id}`, title: p.name, meta: sum.next ? `Việc tiếp theo: ${sum.next.title}` : `${sum.open} việc đang mở`, href: `/lumi/projects/${p.id}`, at: p.id };
    });
  return { decide, done, projects };
}

// ───────────────────────── Dashboard "Hôm nay" ─────────────────────────

export interface DashFilter {
  projectId?: string;
  memberId?: string;
}

const lowerFirst = (t: string) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);

export const hermesLabel = (m: Member | undefined): string =>
  !m ? "" : m.kind === "human" ? "Chủ hệ thống" : m.hermes === "connected" ? "Đã kết nối Hermes (mô phỏng)" : "Chưa kết nối Hermes";

export interface PendingItem {
  kind: "output" | "memory" | "action";
  key: string;
  projectId?: string;
  projectName: string;
  assistant: string;
  title: string;
  waiting: string;
  cta: string;
  href: string;
  at: string;
  version?: number;
}

/** Các mục cần Chủ xử lý, mỗi dòng có thao tác cụ thể và liên kết tới đúng mục (và đúng phiên bản đầu ra). */
export function pendingItems(s: DemoState, f: DashFilter = {}): PendingItem[] {
  const pname = (id?: string) => (id ? (project(s, id)?.name ?? "Dự án đã xóa") : "Cá nhân");
  const who = (id?: string) => (id ? (member(s, id)?.name ?? "Trợ lý") : "Hệ thống");
  const items: PendingItem[] = [];
  for (const t of s.tasks) {
    if (t.status !== "review" || (f.projectId && t.projectId !== f.projectId) || (f.memberId && t.ownerId !== f.memberId)) continue;
    const out = outputOfTask(s, t);
    const v = out?.versions.length ?? 1;
    items.push({
      kind: "output",
      key: `t-${t.id}`,
      projectId: t.projectId,
      projectName: pname(t.projectId),
      assistant: ownerLabel(s, t),
      title: t.title,
      waiting: `Bản ${v} chờ bạn duyệt nội dung${v > 1 ? " (đã sửa theo góp ý)" : ""}`,
      cta: `Xem ${lowerFirst(t.outputWanted)}`,
      href: `/lumi/projects/${t.projectId}?task=${t.id}&v=${v}`,
      at: t.updatedAt,
      version: v,
    });
  }
  for (const m of s.memories) {
    if (m.status !== "proposed" || (f.projectId && m.projectId !== f.projectId) || (f.memberId && m.proposedBy !== f.memberId)) continue;
    items.push({
      kind: "memory",
      key: `m-${m.id}`,
      ...(m.projectId ? { projectId: m.projectId } : {}),
      projectName: pname(m.projectId),
      assistant: who(m.proposedBy),
      title: m.text,
      waiting: "Quy tắc đề xuất: sửa nội dung và chọn phạm vi áp dụng",
      cta: "Xem đề xuất và chọn phạm vi",
      href: `${approvalsHref("memory", m.projectId)}&id=${m.id}`,
      at: m.at,
    });
  }
  for (const a of s.actions) {
    if (a.status !== "pending" || (f.projectId && a.projectId !== f.projectId) || (f.memberId && a.requestedBy !== f.memberId)) continue;
    items.push({
      kind: "action",
      key: `a-${a.id}`,
      projectId: a.projectId,
      projectName: pname(a.projectId),
      assistant: who(a.requestedBy),
      title: a.title,
      waiting: "Hành động bên ngoài: quyết định riêng, không đi kèm việc duyệt nội dung",
      cta: "Xem yêu cầu hành động",
      href: `${approvalsHref("action", a.projectId)}&id=${a.id}`,
      at: a.at,
    });
  }
  return items.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
}

/** Dự án đang ở bước nào và cần làm gì tiếp, suy ra từ việc, đầu ra và yêu cầu hành động của chính dự án. */
export function projectStage(s: DemoState, projectId: string): { now: string; next: string | null } {
  const tasks = s.tasks.filter((t) => t.projectId === projectId);
  const review = tasks.filter((t) => t.status === "review");
  const actions = s.actions.filter((a) => a.projectId === projectId && a.status === "pending");
  const doing = tasks.filter((t) => t.status === "doing");
  const nxt = nextTask(s, projectId);
  let now: string;
  if (review.length === 1) now = `Chờ bạn duyệt ${lowerFirst(review[0]!.outputWanted)} (${review[0]!.id})`;
  else if (review.length > 1) now = `Chờ bạn duyệt ${review.length} đầu ra`;
  else if (actions.length > 0) now = `Chờ bạn quyết: ${lowerFirst(actions[0]!.title)}`;
  else if (doing.length > 0) now = `Trợ lý đang làm: ${lowerFirst(doing[0]!.title)}`;
  else if (nxt) now = `Chuẩn bị: ${lowerFirst(nxt.title)}`;
  else now = "Đã xong các việc đang mở";
  const nextOpen = tasks
    .filter((t) => t.status === "doing" || t.status === "ready" || t.status === "new")
    .sort((a, b) => NEXT_ORDER[a.status as keyof typeof NEXT_ORDER] - NEXT_ORDER[b.status as keyof typeof NEXT_ORDER] || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { now, next: nextOpen[0] ? `${nextOpen[0].title} (${nextOpen[0].id})` : null };
}

const OPEN_ORDER = { review: 0, doing: 1, ready: 2, new: 3, done: 4 } as const;
/** Việc mở của mọi dự án, lọc theo dự án hoặc trợ lý; việc chờ duyệt lên đầu. */
export function openTasks(s: DemoState, f: DashFilter = {}): Task[] {
  return s.tasks
    .filter((t) => t.status !== "done" && (!f.projectId || t.projectId === f.projectId) && (!f.memberId || t.ownerId === f.memberId))
    .sort((a, b) => OPEN_ORDER[a.status] - OPEN_ORDER[b.status] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Trạng thái mới nhất của một việc bằng lời, dùng chung cho Dashboard, Telegram mô phỏng và Kanban. */
export function taskLatest(s: DemoState, t: Task): string {
  const out = outputOfTask(s, t);
  const v = out?.versions.length ?? 0;
  if (t.status === "done") return out?.approvedVersion ? `Đã duyệt bản ${out.approvedVersion}` : "Hoàn tất";
  if (t.status === "review") return `Bản ${v} chờ bạn duyệt`;
  if (t.status === "doing" && out?.state === "changes_requested") return `Đang sửa theo góp ý (sau bản ${v})`;
  if (t.waitingConnection) return "Chờ kết nối trợ lý";
  return STATUS_LABEL[t.status];
}

export interface TelegramItem {
  task: Task;
  bot: string;
  at: string;
  projectName: string;
  latest: string;
}
/** Việc vừa giao qua Telegram mô phỏng, mới nhất trước. */
export function telegramRecent(s: DemoState, f: DashFilter = {}, limit = 6): TelegramItem[] {
  return s.tasks
    .filter((t) => t.source.kind === "telegram" && (!f.projectId || t.projectId === f.projectId) && (!f.memberId || t.ownerId === f.memberId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map((t) => ({ task: t, bot: t.source.botName ?? member(s, t.ownerId)?.name ?? "Bot", at: t.createdAt, projectName: project(s, t.projectId)?.name ?? "?", latest: taskLatest(s, t) }));
}

export const VIDEO_LABEL = { idea: "Ý tưởng", scripting: "Viết kịch bản", producing: "Quay dựng", scheduled: "Đã lên lịch", published: "Đã đăng" } as const;

export interface CurrencyResult {
  currency: string;
  spend: number | null;
  commission: number | null;
  /** Hoa hồng ghi nhận trừ chi phí quảng cáo; null khi có kỳ thiếu một trong hai khoản. */
  net: number | null;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
  records: number;
}
export type AffiliateResults =
  | { state: "na" } // dự án đang lọc không thuộc mảng Affiliate
  | { state: "none"; projects: number } // chưa có số liệu nào trong kỳ
  | { state: "data"; byCurrency: CurrencyResult[]; projects: number };

const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Kết quả Affiliate trong N ngày gần nhất, tách theo đơn vị tiền (không cộng khác tiền).
 * Số liệu thiếu (null) khác với 0; "Hoa hồng trừ chi phí quảng cáo" chỉ tính khi mọi kỳ đều có cả hai khoản.
 */
export function affiliateResults(s: DemoState, f: DashFilter, rangeDays: number, nowMs: number): AffiliateResults {
  const aff = s.projects.filter((p) => p.status === "active" && p.area === "Affiliate");
  if (f.projectId && !aff.some((p) => p.id === f.projectId)) return { state: "na" };
  const ids = new Set(f.projectId ? [f.projectId] : aff.map((p) => p.id));
  const cutoff = dayStr(nowMs - rangeDays * 86_400_000);
  const rows = s.adResults.filter((r) => ids.has(r.projectId) && r.periodEnd >= cutoff);
  if (rows.length === 0) return { state: "none", projects: ids.size };
  const map = new Map<string, typeof rows>();
  for (const r of rows) map.set(r.currency, [...(map.get(r.currency) ?? []), r]);
  const byCurrency: CurrencyResult[] = [...map.entries()].map(([currency, rs]) => {
    const sum = (k: "spend" | "commissionReported") => (rs.some((r) => r[k] !== null) ? rs.reduce((a, r) => a + (r[k] ?? 0), 0) : null);
    const spend = sum("spend");
    const commission = sum("commissionReported");
    const complete = rs.every((r) => r.spend !== null && r.commissionReported !== null);
    return {
      currency,
      spend,
      commission,
      net: complete && spend !== null && commission !== null ? commission - spend : null,
      periodStart: rs.reduce((a, r) => (r.periodStart < a ? r.periodStart : a), rs[0]!.periodStart),
      periodEnd: rs.reduce((a, r) => (r.periodEnd > a ? r.periodEnd : a), rs[0]!.periodEnd),
      updatedAt: rs.reduce((a, r) => (r.updatedAt > a ? r.updatedAt : a), rs[0]!.updatedAt),
      records: rs.length,
    };
  });
  return { state: "data", byCurrency, projects: ids.size };
}

export interface VideoRow {
  video: Video;
  tasks: number;
  awaiting: boolean;
}
export type YoutubeSummary =
  | { state: "na" }
  | {
      state: "ok";
      videos: VideoRow[];
      producing: number;
      awaiting: number;
      nextSchedule: Video | null;
      /** Việc mở trong dự án YouTube chưa gắn video cụ thể: không được đếm là video. */
      unlinkedTasks: number;
    };

/** Đếm theo VIDEO cụ thể: ba việc của cùng một video chỉ là một video. */
export function youtubeSummary(s: DemoState, f: DashFilter, nowMs: number): YoutubeSummary {
  const yt = s.projects.filter((p) => p.status === "active" && p.area === "YouTube");
  if (f.projectId && !yt.some((p) => p.id === f.projectId)) return { state: "na" };
  const ids = new Set(f.projectId ? [f.projectId] : yt.map((p) => p.id));
  const videos = s.videos.filter((v) => ids.has(v.projectId));
  const rows: VideoRow[] = videos.map((v) => {
    const ts = s.tasks.filter((t) => t.videoId === v.id);
    return { video: v, tasks: ts.length, awaiting: ts.some((t) => t.status === "review") };
  });
  const upcoming = videos
    .filter((v) => v.status === "scheduled" && v.scheduledAt && Date.parse(v.scheduledAt) >= nowMs)
    .sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
  return {
    state: "ok",
    videos: rows,
    producing: videos.filter((v) => v.status === "scripting" || v.status === "producing").length,
    awaiting: rows.filter((r) => r.awaiting).length,
    nextSchedule: upcoming[0] ?? null,
    unlinkedTasks: s.tasks.filter((t) => ids.has(t.projectId) && t.status !== "done" && !t.videoId).length,
  };
}
