import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks, type TaskReviewStatus, type TaskStatus } from "@/lib/db/schema/tasks";
import { auditEvents } from "@/lib/db/schema/audit";
import { createNotification } from "@/lib/notifications/create";

// AC02 — chỉ cho phép review từ IMPORTED hoặc WAITING_REVIEW.
// (V1 cho phép review IMPORTED trực tiếp — backfill flow. DC-010+ khi có extractor
// thật thì task sẽ tự chuyển IMPORTED → WAITING_REVIEW trước.)
const REVIEWABLE_FROM: TaskStatus[] = ["IMPORTED", "WAITING_REVIEW"];

export type ReviewAction = "approve" | "request_revision" | "reject";

const NEXT_STATUS: Record<ReviewAction, { status: TaskStatus; reviewStatus: TaskReviewStatus }> = {
  approve: { status: "APPROVED", reviewStatus: "APPROVED" },
  request_revision: { status: "REVISION_REQUESTED", reviewStatus: "REVISION_REQUESTED" },
  reject: { status: "REJECTED", reviewStatus: "REJECTED" },
};

const ACTION_AUDIT: Record<ReviewAction, string> = {
  approve: "task.approve",
  request_revision: "task.request_revision",
  reject: "task.reject",
};

export interface ReviewInput {
  taskId: string;
  action: ReviewAction;
  actorId: string; // email
  reason?: string;
  ifUnmodifiedSince?: Date; // AC05 — optimistic lock
  requestId: string;
}

export interface ReviewOk {
  ok: true;
  task: {
    id: string;
    code: string;
    status: TaskStatus;
    reviewStatus: TaskReviewStatus;
    updatedAt: Date;
  };
}

export interface ReviewErr {
  ok: false;
  code: "NOT_FOUND" | "INVALID_TRANSITION" | "CONFLICT" | "VALIDATION_ERROR";
  message: string;
}

export type ReviewResult = ReviewOk | ReviewErr;

export async function reviewTask(input: ReviewInput): Promise<ReviewResult> {
  // AC04 — reason yêu cầu cho revision/reject.
  if (input.action !== "approve") {
    const trimmed = (input.reason ?? "").trim();
    if (trimmed.length < 3) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "Yêu cầu sửa và Từ chối cần lý do (ít nhất 3 ký tự).",
      };
    }
  }

  return await db.transaction(async (tx) => {
    // Lock row + get current state
    const [current] = await tx
      .select({
        id: tasks.id,
        code: tasks.code,
        status: tasks.status,
        reviewStatus: tasks.reviewStatus,
        updatedAt: tasks.updatedAt,
        completedAt: tasks.completedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for("update")
      .limit(1);

    if (!current) {
      return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy nhiệm vụ." };
    }

    // AC05 — optimistic lock
    if (input.ifUnmodifiedSince) {
      const clientMs = Math.floor(input.ifUnmodifiedSince.getTime() / 1000);
      const serverMs = Math.floor(current.updatedAt.getTime() / 1000);
      if (clientMs !== serverMs) {
        return {
          ok: false,
          code: "CONFLICT",
          message: "Nhiệm vụ đã bị người khác cập nhật, tải lại trang.",
        };
      }
    }

    // AC02 — guard transition
    if (!REVIEWABLE_FROM.includes(current.status)) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message: `Không thể review khi trạng thái = ${current.status}. Chỉ IMPORTED/WAITING_REVIEW mới cho phép.`,
      };
    }

    const next = NEXT_STATUS[input.action];
    const now = new Date();
    const shouldSetCompleted =
      input.action === "approve" || input.action === "reject"
        ? current.completedAt ?? now
        : current.completedAt;

    const [updated] = await tx
      .update(tasks)
      .set({
        status: next.status,
        reviewStatus: next.reviewStatus,
        completedAt: shouldSetCompleted,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, current.id), eq(tasks.updatedAt, current.updatedAt)))
      .returning({
        id: tasks.id,
        code: tasks.code,
        status: tasks.status,
        reviewStatus: tasks.reviewStatus,
        updatedAt: tasks.updatedAt,
      });

    if (!updated) {
      // Row đã bị update giữa SELECT FOR UPDATE và UPDATE (race hiếm với transaction lock).
      return {
        ok: false,
        code: "CONFLICT",
        message: "Cập nhật xung đột, thử lại.",
      };
    }

    // AC06 — audit event
    await tx.insert(auditEvents).values({
      actorType: "user",
      actorId: input.actorId,
      action: ACTION_AUDIT[input.action],
      entityType: "task",
      entityId: current.id,
      beforeJson: {
        status: current.status,
        reviewStatus: current.reviewStatus,
      },
      afterJson: {
        status: updated.status,
        reviewStatus: updated.reviewStatus,
        reason: input.reason ?? null,
      },
      requestId: input.requestId,
    });

    // AC02 — noti fire-and-forget (không block transaction). Chỉ notify khi
    // chuyển sang REVISION_REQUESTED (owner cần xử lý task tiếp).
    if (input.action === "request_revision") {
      queueMicrotask(() => {
        void createNotification({
          type: "task.revision_requested",
          entityType: "task",
          entityId: updated.id,
          title: `${updated.code}: cần sửa`,
          body: input.reason ?? undefined,
          href: `/tasks/${updated.id}`,
        });
      });
    }
    return { ok: true, task: updated };
  });
}
