import { cn } from "@/lib/utils";

const LABEL: Record<string, { label: string; tone: "muted" | "primary" | "warning" | "destructive" | "success" }> = {
  CAPTURED: { label: "Đã bắt", tone: "muted" },
  WAITING_ASSISTANT: { label: "Chờ trợ lý sẵn sàng", tone: "warning" },
  QUEUED: { label: "Chờ chạy", tone: "muted" },
  RUNNING: { label: "Đang chạy", tone: "primary" },
  WAITING_REVIEW: { label: "Chờ duyệt", tone: "warning" },
  REVISION_REQUESTED: { label: "Cần sửa", tone: "warning" },
  REJECTED: { label: "Từ chối", tone: "destructive" },
  APPROVED: { label: "Đã duyệt", tone: "success" },
  COMPLETED: { label: "Hoàn thành", tone: "success" },
  FAILED: { label: "Lỗi", tone: "destructive" },
  ON_HOLD: { label: "Tạm giữ", tone: "warning" },
  CANCELLED: { label: "Đã hủy", tone: "muted" },
};
const TONE = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/15 text-primary",
  warning: "bg-amber-500/15 text-amber-500",
  destructive: "bg-destructive/15 text-destructive",
  success: "bg-primary/15 text-primary",
} as const;

export function WorkStatusBadge({ status }: { status: string }) {
  const d = LABEL[status] ?? { label: status, tone: "muted" as const };
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[d.tone])} aria-label={`Trạng thái: ${d.label}`}>{d.label}</span>;
}
