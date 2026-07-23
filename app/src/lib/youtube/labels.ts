// Client-safe constants cho YouTube pipeline.
import type { VideoStatus } from "@/lib/db/schema/youtube";

export const VIDEO_STATUS_LABELS: Record<VideoStatus, string> = {
  IDEA: "Ý tưởng",
  VALIDATING: "Đang validate",
  APPROVED: "Đã duyệt",
  SCRIPTING: "Viết script",
  PRODUCING: "Đang sản xuất",
  SCHEDULED: "Đã schedule",
  PUBLISHED: "Đã đăng",
  REVIEWED: "Đã review",
};

const ALLOWED_TRANSITIONS: Record<VideoStatus, VideoStatus[]> = {
  IDEA: ["VALIDATING", "REVIEWED"],
  VALIDATING: ["APPROVED", "IDEA", "REVIEWED"],
  APPROVED: ["SCRIPTING", "VALIDATING", "REVIEWED"],
  SCRIPTING: ["PRODUCING", "APPROVED", "REVIEWED"],
  PRODUCING: ["SCHEDULED", "SCRIPTING", "REVIEWED"],
  SCHEDULED: ["PUBLISHED", "PRODUCING", "REVIEWED"],
  PUBLISHED: ["REVIEWED"],
  REVIEWED: [],
};

export function nextStatuses(current: VideoStatus): VideoStatus[] {
  return ALLOWED_TRANSITIONS[current] ?? [];
}

export function allowedTransitionsGraph(): Record<VideoStatus, VideoStatus[]> {
  return ALLOWED_TRANSITIONS;
}
