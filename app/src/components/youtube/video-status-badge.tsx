import type { VideoStatus } from "@/lib/db/schema/youtube";
import { VIDEO_STATUS_LABELS } from "@/lib/youtube/labels";
import { cn } from "@/lib/utils";

const TONE: Record<VideoStatus, string> = {
  IDEA: "bg-muted text-muted-foreground",
  VALIDATING: "bg-amber-500/15 text-amber-500",
  APPROVED: "bg-primary/15 text-primary",
  SCRIPTING: "bg-primary/15 text-primary",
  PRODUCING: "bg-primary/20 text-primary",
  SCHEDULED: "bg-primary/25 text-primary",
  PUBLISHED: "bg-primary/30 text-primary",
  REVIEWED: "bg-muted text-muted-foreground",
};

export function VideoStatusBadge({ status }: { status: VideoStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONE[status],
      )}
      aria-label={`Trạng thái video: ${VIDEO_STATUS_LABELS[status]}`}
    >
      {VIDEO_STATUS_LABELS[status]}
    </span>
  );
}
