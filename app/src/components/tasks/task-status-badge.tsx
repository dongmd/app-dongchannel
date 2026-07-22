import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/lib/db/schema/tasks";

// Badge màu + text (không dùng màu đơn độc — PRD mục 6).
const STATUS_LABEL: Record<TaskStatus, { label: string; tone: "muted" | "primary" | "warning" | "destructive" | "success" }> = {
  CAPTURED: { label: "Đã bắt", tone: "muted" },
  QUEUED: { label: "Chờ chạy", tone: "muted" },
  RUNNING: { label: "Đang chạy", tone: "primary" },
  WAITING_REVIEW: { label: "Chờ duyệt", tone: "warning" },
  APPROVED: { label: "Đã duyệt", tone: "success" },
  REVISION_REQUESTED: { label: "Sửa lại", tone: "warning" },
  REJECTED: { label: "Từ chối", tone: "destructive" },
  COMPLETED: { label: "Hoàn thành", tone: "success" },
  FAILED: { label: "Lỗi", tone: "destructive" },
  CANCELLED: { label: "Đã huỷ", tone: "muted" },
  SYNC_DELAYED: { label: "Đồng bộ chậm", tone: "warning" },
  IMPORTED: { label: "Đã nhập", tone: "muted" },
};

const TONE_STYLES: Record<"muted" | "primary" | "warning" | "destructive" | "success", string> = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/15 text-primary",
  warning: "bg-amber-500/15 text-amber-500",
  destructive: "bg-destructive/15 text-destructive",
  success: "bg-primary/15 text-primary", // giữ palette (success == primary teal per TDD)
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const def = STATUS_LABEL[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONE_STYLES[def.tone],
      )}
      aria-label={`Trạng thái: ${def.label}`}
    >
      {def.label}
    </span>
  );
}
