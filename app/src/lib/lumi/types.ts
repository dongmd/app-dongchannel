// Dong-Lumi preview: kiểu dữ liệu demo dùng chung cho web, Telegram mô phỏng và Văn phòng 2D/3D.
// Đây là dữ liệu MÔ PHỎNG (không phải Postgres, không phải Hermes). Xem TDD.md mục "Preview".

export type MemberKind = "human" | "bot";
/** owner = Chủ; pm = được giao làm PM dự án; assistant = trợ lý thường. */
export type Permission = "owner" | "pm" | "assistant";
export type Chat = "aff" | "yt";

export interface Member {
  id: string;
  kind: MemberKind;
  name: string;
  /** Khóa avatar trong AVATARS (components/lumi/avatar.tsx). */
  avatar: string;
  role: string;
  description: string;
  projectIds: string[];
  status: "active" | "archived";
  permission: Permission;
  /** Bot: đã kết nối Hermes (mô phỏng) hay chưa. Người: luôn "connected". */
  hermes: "none" | "connected";
  /** Telegram mô phỏng: bot nào của chat nào. */
  profileKey?: Chat;
  createdAt: string;
  archivedAt?: string;
}

export interface Project {
  id: string;
  /** Chế độ dữ liệu thật: mã UUID trong PostgreSQL (id ở trên là slug dùng cho đường dẫn). API ghi nhận UUID. */
  uuid?: string;
  /** IMP-03: the owner allows the project's PM bot to apply its own reassign proposals (default off). */
  pmAuto?: boolean;
  name: string;
  area: string; // "Affiliate" | "YouTube" | ...
  goal: string;
  pmId: string;
  status: "active" | "archived";
}

export type TaskStatus = "new" | "ready" | "doing" | "review" | "done";
export const TASK_STATUSES: TaskStatus[] = ["new", "ready", "doing", "review", "done"];

export interface Source {
  kind: "web" | "telegram";
  /** Hiển thị: "Web" | "Telegram · AFF" | "Telegram · YouTube". */
  label: string;
  /** Telegram mô phỏng: cuộc chat và tên bot nhận tin lúc tạo việc (giữ nguyên dù bot đổi tên sau này). */
  chat?: Chat;
  botName?: string;
}

/** Video cụ thể của một dự án YouTube: đơn vị để đếm, không đếm theo số việc. */
export type VideoStatus = "idea" | "scripting" | "producing" | "scheduled" | "published";
export const VIDEO_STATUSES: VideoStatus[] = ["idea", "scripting", "producing", "scheduled", "published"];
export interface Video {
  id: string;
  projectId: string;
  title: string;
  status: VideoStatus;
  /** Lịch đăng (ISO) khi status = scheduled. */
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Kết quả quảng cáo Affiliate theo kỳ, do Chủ nhập tay trong preview (luôn là MÔ PHỎNG).
 * `null` nghĩa là chưa có dữ liệu, khác với 0 là đã đo và bằng 0.
 */
export const CURRENCIES = ["USD", "VND", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];
export interface AdResult {
  id: string;
  projectId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  currency: Currency;
  spend: number | null;
  commissionReported: number | null;
  note?: string;
  simulated: true;
  updatedAt: string;
}

export type Via = "web" | "telegram" | "system";

export interface HistoryEvent {
  id: string;
  at: string;
  byId: string;
  /** Tên lúc ghi: lưu trữ trợ lý vẫn giữ được tên trong lịch sử. */
  byName: string;
  via: Via;
  kind:
    | "created"
    | "assigned"
    | "started"
    | "output"
    | "comment"
    | "revision_requested"
    | "approved"
    | "status"
    | "connection";
  text?: string;
  version?: number;
}

export interface Task {
  id: string; // DL-001
  projectId: string;
  title: string;
  request: string;
  outputWanted: string;
  due?: string;
  ownerId: string;
  ownerName: string;
  source: Source;
  status: TaskStatus;
  /** Trợ lý chưa kết nối Hermes: việc nằm ở "Mới" với nhãn "Chờ kết nối trợ lý". */
  waitingConnection: boolean;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  startedAt?: string;
  /** Mô phỏng: thời điểm trợ lý "giao" đầu ra. */
  deliverAt?: string;
  outputId?: string;
  /** Việc thuộc video cụ thể nào (YouTube). Việc không gắn video thì không được đếm là video. */
  videoId?: string;
  history: HistoryEvent[];
  /** Chỉ có ở chế độ dữ liệu thật (LUMI_DATA=db): trạng thái thật, lượt chạy, lỗi. */
  real?: RealTask;
}

/** Lượt chạy của một việc (lumi_task_runs) để hiển thị chi tiết kỹ thuật. */
export interface RealRun {
  n: number;
  kind: string;
  state: string;
  remoteStop: string;
  errorCode?: string;
  at: string;
}
/** Phần thật của một việc: giữ nguyên trạng thái PostgreSQL (nhiều hơn 5 cột của bảng việc). */
export interface RealTask {
  uuid: string;
  status: string;
  needsDecision: boolean;
  errorCode?: string;
  errorMessage?: string;
  holdReason?: string;
  revisionRound: number;
  runs: RealRun[];
  lateOutputs: number;
  /** Việc con (kế hoạch) do trợ lý ghi và số điểm dừng đã lưu. */
  children: { code: string; title: string; status: string; note?: string }[];
  checkpoints: number;
}
/** Bối cảnh thật của phiên: vai trò, công tắc, trợ lý và chế độ Hermes. */
export interface RealContext {
  role: "OWNER" | "ADMIN" | "VIEWER";
  email: string;
  m1Enabled: boolean;
  emergencyStop: boolean;
  hermesMode: string;
  assistants: { id: string; name: string; slug: string; connection_state: string; dispatch_enabled: boolean; hermes_profile: string | null }[];
  telegramBot?: string;
  /** IMP-01: tính năng kế hoạch bật chưa, và các phiên bản kế hoạch đang chờ Chủ duyệt. */
  plansEnabled?: boolean;
  /** IMP-02: số thông báo chưa đọc của chính người đăng nhập (hộp thông báo ở Quản trị). */
  notifUnread?: number;
  plansPending?: { planId: string; code: string; version: number; goalTitle: string; submittedAt: string }[];
}

export interface OutputSection {
  heading: string;
  body: string;
  meta?: string;
}
export interface OutputVersion {
  v: number;
  title: string;
  sections: OutputSection[];
  createdAt: string;
  revisionNote?: string;
}
export interface Output {
  id: string;
  taskId: string;
  versions: OutputVersion[];
  state: "draft" | "changes_requested" | "approved";
  approvedVersion?: number;
}

export type MemoryKind = "decision" | "rule";
export type MemoryScope = "project" | "area" | "personal";
export interface Memory {
  id: string;
  kind: MemoryKind;
  text: string;
  content: string;
  reason: string;
  evidence: { label: string; note: string }[];
  at: string;
  projectId?: string;
  area?: string;
  scope: MemoryScope;
  status: "proposed" | "active" | "rejected";
  taskIds: string[];
  proposedBy?: string;
  /** Quy tắc đề xuất rút ra từ quyết định nào (liên kết nguồn). */
  sourceMemoryId?: string;
}

export interface ActionRequest {
  id: string;
  projectId: string;
  taskId?: string;
  title: string;
  detail: string;
  requestedBy: string;
  at: string;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
}

export interface TgDraft {
  id: string;
  chat: Chat;
  sourceText: string;
  title: string;
  outputWanted: string;
  due?: string;
  projectId?: string;
  assigneeId: string;
  step: "main" | "pick_project" | "pick_assignee";
  state: "pending" | "created" | "cancelled";
  taskId?: string;
}

export type TgCard =
  | { type: "draft"; draftId: string }
  | { type: "status"; taskId: string; version: number }
  | { type: "convert"; sourceMessageId: string; draftId?: string }
  | { type: "feedback_prompt"; taskId: string };

export interface TgMessage {
  id: string;
  chat: Chat;
  from: "owner" | "bot";
  at: string;
  text?: string;
  card?: TgCard;
}

export interface DemoState {
  schema: 1;
  rev: number;
  resetAt: string;
  members: Member[];
  projects: Project[];
  tasks: Task[];
  outputs: Output[];
  memories: Memory[];
  actions: ActionRequest[];
  tgDrafts: TgDraft[];
  tgMessages: TgMessage[];
  tgAwaiting: Partial<Record<Chat, string>>;
  videos: Video[];
  adResults: AdResult[];
  seq: { task: number; member: number; id: number };
  /** "db" = dữ liệu thật từ PostgreSQL; vắng mặt = preview mô phỏng. */
  mode?: "db";
  real?: RealContext;
}

export const OWNER_ID = "m-owner";
