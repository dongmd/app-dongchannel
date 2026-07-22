import "server-only";
import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  niches,
  videos,
  type VideoRow,
  type VideoStatus,
} from "@/lib/db/schema/youtube";
import { offers } from "@/lib/db/schema/aff";
import { auditEvents } from "@/lib/db/schema/audit";

// AC02 — pipeline graph. Cho phép quay lại 1 bước; không nhảy cóc.
const ALLOWED_TRANSITIONS: Record<VideoStatus, VideoStatus[]> = {
  IDEA: ["VALIDATING", "REVIEWED"],
  VALIDATING: ["APPROVED", "IDEA", "REVIEWED"],
  APPROVED: ["SCRIPTING", "VALIDATING", "REVIEWED"],
  SCRIPTING: ["PRODUCING", "APPROVED", "REVIEWED"],
  PRODUCING: ["SCHEDULED", "SCRIPTING", "REVIEWED"],
  SCHEDULED: ["PUBLISHED", "PRODUCING", "REVIEWED"],
  PUBLISHED: ["REVIEWED"],
  REVIEWED: [], // terminal
};

export function nextStatuses(current: VideoStatus): VideoStatus[] {
  return ALLOWED_TRANSITIONS[current] ?? [];
}

// Filter grouping cho tabs Ideas/Production/Performance.
const IDEAS: VideoStatus[] = ["IDEA", "VALIDATING", "APPROVED"];
const PRODUCTION: VideoStatus[] = ["SCRIPTING", "PRODUCING", "SCHEDULED"];
const PERFORMANCE: VideoStatus[] = ["PUBLISHED", "REVIEWED"];

export type VideoTab = "all" | "ideas" | "production" | "performance";

const TAB_STATUS: Record<VideoTab, VideoStatus[] | null> = {
  all: null,
  ideas: IDEAS,
  production: PRODUCTION,
  performance: PERFORMANCE,
};

export interface VideoListItem {
  id: string;
  workingTitle: string;
  title: string | null;
  status: VideoStatus;
  nicheName: string | null;
  offerName: string | null;
  publishUrl: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

export interface ListVideosInput {
  tab?: VideoTab;
  status?: VideoStatus | "all";
  q?: string;
  limit?: number;
}

export async function listVideos(input: ListVideosInput = {}): Promise<VideoListItem[]> {
  const limit = Math.min(input.limit ?? 50, 200);
  const whereClauses = [];

  // Status filter — trực tiếp (single) hoặc via tab (multi)
  if (input.status && input.status !== "all") {
    whereClauses.push(eq(videos.status, input.status));
  } else if (input.tab && input.tab !== "all") {
    const statuses = TAB_STATUS[input.tab];
    if (statuses) whereClauses.push(inArray(videos.status, statuses));
  }
  if (input.q && input.q.trim().length > 0) {
    whereClauses.push(ilike(videos.workingTitle, `%${input.q.trim()}%`));
  }

  const rows = await db
    .select({
      id: videos.id,
      workingTitle: videos.workingTitle,
      title: videos.title,
      status: videos.status,
      publishUrl: videos.publishUrl,
      publishedAt: videos.publishedAt,
      updatedAt: videos.updatedAt,
      nicheName: niches.name,
      offerName: offers.name,
    })
    .from(videos)
    .leftJoin(niches, eq(videos.nicheId, niches.id))
    .leftJoin(offers, eq(videos.offerId, offers.id))
    .where(whereClauses.length > 0 ? and(...whereClauses) : undefined)
    .orderBy(desc(videos.updatedAt))
    .limit(limit);
  return rows;
}

export interface VideoDetail extends VideoRow {
  nicheName: string | null;
  offerName: string | null;
}

export async function getVideoDetail(id: string): Promise<VideoDetail | null> {
  const [row] = await db
    .select({
      video: videos,
      nicheName: niches.name,
      offerName: offers.name,
    })
    .from(videos)
    .leftJoin(niches, eq(videos.nicheId, niches.id))
    .leftJoin(offers, eq(videos.offerId, offers.id))
    .where(eq(videos.id, id))
    .limit(1);
  if (!row) return null;
  return { ...row.video, nicheName: row.nicheName, offerName: row.offerName };
}

export interface CreateVideoInput {
  workingTitle: string;
  nicheId?: string | null;
  offerId?: string | null;
  hook?: string | null;
  outline?: string | null;
  actorId: string;
  requestId: string;
}

export async function createVideo(input: CreateVideoInput): Promise<
  | { ok: true; video: VideoRow }
  | { ok: false; code: string; message: string }
> {
  if (input.workingTitle.trim().length < 2) {
    return { ok: false, code: "VALIDATION_ERROR", message: "Working title ≥ 2 ký tự." };
  }
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(videos)
      .values({
        workingTitle: input.workingTitle.trim(),
        nicheId: input.nicheId ?? null,
        offerId: input.offerId ?? null,
        hook: input.hook ?? null,
        outline: input.outline ?? null,
        status: "IDEA",
      })
      .returning();
    if (!inserted) return { ok: false, code: "CONFLICT", message: "Không tạo được" };

    await tx.insert(auditEvents).values({
      actorType: "user",
      actorId: input.actorId,
      action: "youtube.video.create",
      entityType: "video",
      entityId: inserted.id,
      beforeJson: null,
      afterJson: { workingTitle: inserted.workingTitle, status: inserted.status },
      requestId: input.requestId,
    });
    return { ok: true, video: inserted };
  });
}

export interface TransitionInput {
  videoId: string;
  toStatus: VideoStatus;
  actorId: string;
  reason?: string;
  publishUrl?: string;
  requestId: string;
}

export type TransitionResult =
  | { ok: true; video: VideoRow }
  | { ok: false; code: "NOT_FOUND" | "INVALID_TRANSITION" | "VALIDATION_ERROR"; message: string };

export async function transitionVideo(input: TransitionInput): Promise<TransitionResult> {
  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(videos)
      .where(eq(videos.id, input.videoId))
      .for("update")
      .limit(1);
    if (!current) return { ok: false, code: "NOT_FOUND", message: "Video không tồn tại." };
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(input.toStatus)) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message: `Không chuyển được từ ${current.status} sang ${input.toStatus}.`,
      };
    }
    // Bắt buộc publish_url khi chuyển sang PUBLISHED
    if (input.toStatus === "PUBLISHED") {
      const url = (input.publishUrl ?? current.publishUrl ?? "").trim();
      if (!url) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "PUBLISHED cần publish_url (VD YouTube link).",
        };
      }
    }

    const now = new Date();
    const [updated] = await tx
      .update(videos)
      .set({
        status: input.toStatus,
        publishUrl: input.publishUrl ?? current.publishUrl,
        publishedAt:
          input.toStatus === "PUBLISHED"
            ? current.publishedAt ?? now
            : current.publishedAt,
        updatedAt: now,
      })
      .where(eq(videos.id, current.id))
      .returning();
    if (!updated) return { ok: false, code: "NOT_FOUND", message: "Update fail." };

    await tx.insert(auditEvents).values({
      actorType: "user",
      actorId: input.actorId,
      action: "youtube.video.transition",
      entityType: "video",
      entityId: current.id,
      beforeJson: { status: current.status },
      afterJson: { status: updated.status, reason: input.reason ?? null, publishUrl: updated.publishUrl },
      requestId: input.requestId,
    });
    return { ok: true, video: updated };
  });
}

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
