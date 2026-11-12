// Văn phòng v2 (OFC-07/OFC-08): trạng thái hiển thị của từng thành viên và bảng họp, tính thuần từ dữ liệu có sẵn (không tự bịa trạng thái).
import { memberOpenTasks, memberStates, pendingCounts } from "./selectors.ts";
import type { DemoState, Member } from "./types.ts";

export type OfficeStatus = "working" | "review" | "blocked" | "idle" | "archived";
export interface OfficeMemberView {
  status: OfficeStatus;
  label: string;
  /** Việc đang làm hoặc số đầu ra chờ duyệt, hiện trong bong bóng; null khi không có gì để nói. */
  bubble: string | null;
  review: number;
}

const ORDER = { doing: 0, ready: 1, new: 2, review: 3, done: 4 } as const;

export function officeMemberView(s: DemoState, m: Member): OfficeMemberView {
  if (m.status === "archived") return { status: "archived", label: "Đã lưu trữ", bubble: null, review: 0 };
  if (m.kind === "human") {
    const n = pendingCounts(s).total;
    return n > 0 ? { status: "review", label: `${n} chờ bạn duyệt`, bubble: `${n} mục chờ bạn duyệt`, review: n } : { status: "idle", label: "Trực tuyến", bubble: null, review: 0 };
  }
  const st = memberStates(s, m);
  const current = [...memberOpenTasks(s, m.id)].sort((a, b) => ORDER[a.status] - ORDER[b.status])[0];
  if (st.executing > 0) return { status: "working", label: "Đang làm", bubble: current?.title ?? null, review: st.pendingReview };
  if (st.waiting > 0) return { status: "blocked", label: "Chờ kết nối", bubble: current?.title ?? null, review: st.pendingReview };
  if (st.pendingReview > 0) return { status: "review", label: "Chờ duyệt", bubble: `${st.pendingReview} đầu ra chờ duyệt`, review: st.pendingReview };
  return { status: "idle", label: "Rảnh", bubble: null, review: 0 };
}

export interface MeetingRow {
  code: string;
  title: string;
  state: string;
  outcome: string;
  contributions: number;
  pending_owner: number;
  closes_at?: string;
  chair_name?: string;
}
export interface MeetingBoard {
  open: MeetingRow[];
  /** Kết luận đang chờ Chủ, gộp theo cuộc họp. */
  pendingOwner: { code: string; title: string; n: number }[];
  recent: MeetingRow[];
  /** Ba cột bảng trên tường phòng họp: tiêu đề, số lượng, tối đa 3 dòng. */
  columns: { key: "open" | "owner" | "recent"; title: string; count: number; lines: string[] }[];
}
const short = (t: string, n = 34) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Bảng họp: cuộc họp đang mở, kết luận chờ Chủ, cuộc họp đã xong gần đây. `null` nghĩa là chưa có dữ liệu họp (khác với 0 cuộc họp). */
export function meetingBoard(rows: MeetingRow[] | null): MeetingBoard {
  const list = rows ?? [];
  const open = list.filter((m) => m.state === "OPEN");
  const pendingOwner = list.filter((m) => m.pending_owner > 0).map((m) => ({ code: m.code, title: m.title, n: m.pending_owner }));
  const recent = list.filter((m) => m.state !== "OPEN").slice(0, 5);
  return {
    open,
    pendingOwner,
    recent,
    columns: [
      { key: "open", title: "Đang họp", count: open.length, lines: open.slice(0, 3).map((m) => short(`${m.code} · ${m.title}`)) },
      { key: "owner", title: "Chờ Chủ duyệt", count: pendingOwner.reduce((a, b) => a + b.n, 0), lines: pendingOwner.slice(0, 3).map((m) => short(`${m.code} · ${m.n} kết luận`)) },
      { key: "recent", title: "Đã họp", count: recent.length, lines: recent.slice(0, 3).map((m) => short(`${m.code} · ${m.title}`)) },
    ],
  };
}

/** Thành viên ngồi ở bàn họp: người tham dự của cuộc họp đang mở, khớp theo slug trợ lý (id thành viên là `bot-<slug>`); Chủ không có slug. */
export function seatedMemberIds(participants: { slug?: string | null; role?: string }[], humanId: string): string[] {
  const ids = participants.map((p) => (p.role === "OWNER_OPTIONAL" || !p.slug ? humanId : `bot-${p.slug}`));
  return [...new Set(ids)];
}
