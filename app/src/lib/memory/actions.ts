import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memoryEntries, type MemoryStatus } from "@/lib/db/schema/memory";
import { auditEvents } from "@/lib/db/schema/audit";

export type MemoryAction = "approve" | "reject";

const REVIEWABLE_FROM: MemoryStatus[] = ["PROPOSED"];

const NEXT_STATUS: Record<MemoryAction, MemoryStatus> = {
  approve: "ACTIVE",
  reject: "REJECTED",
};

const ACTION_AUDIT: Record<MemoryAction, string> = {
  approve: "memory.approve",
  reject: "memory.reject",
};

export interface MemoryActionInput {
  memoryId: string;
  action: MemoryAction;
  actorId: string;
  reason?: string;
  requestId: string;
}

export interface MemoryActionOk {
  ok: true;
  memory: { id: string; status: MemoryStatus; title: string };
}

export interface MemoryActionErr {
  ok: false;
  code: "NOT_FOUND" | "INVALID_TRANSITION" | "VALIDATION_ERROR" | "CONFLICT";
  message: string;
}

export type MemoryActionResult = MemoryActionOk | MemoryActionErr;

export async function reviewMemory(input: MemoryActionInput): Promise<MemoryActionResult> {
  if (input.action === "reject") {
    const trimmed = (input.reason ?? "").trim();
    if (trimmed.length < 3) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "Từ chối cần lý do (ít nhất 3 ký tự).",
      };
    }
  }

  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: memoryEntries.id,
        title: memoryEntries.title,
        status: memoryEntries.status,
        profileScope: memoryEntries.profileScope,
        category: memoryEntries.category,
      })
      .from(memoryEntries)
      .where(eq(memoryEntries.id, input.memoryId))
      .for("update")
      .limit(1);

    if (!current) {
      return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy memory entry." };
    }
    if (!REVIEWABLE_FROM.includes(current.status)) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message: `Chỉ duyệt/từ chối được khi PROPOSED. Hiện tại: ${current.status}.`,
      };
    }

    const now = new Date();
    const nextStatus = NEXT_STATUS[input.action];

    // BR: nếu approve → set approved_by + approved_at.
    // Nếu ACTIVE trùng (profileScope, category, title) — auto SUPERSEDE cũ.
    let supersededCount = 0;
    if (input.action === "approve") {
      const superseded = await tx
        .update(memoryEntries)
        .set({ status: "SUPERSEDED", updatedAt: now })
        .where(
          and(
            eq(memoryEntries.profileScope, current.profileScope),
            eq(memoryEntries.category, current.category),
            eq(memoryEntries.title, current.title),
            eq(memoryEntries.status, "ACTIVE"),
          ),
        )
        .returning({ id: memoryEntries.id });
      supersededCount = superseded.length;
    }

    const [updated] = await tx
      .update(memoryEntries)
      .set({
        status: nextStatus,
        approvedBy: input.action === "approve" ? input.actorId : null,
        approvedAt: input.action === "approve" ? now : null,
        updatedAt: now,
      })
      .where(eq(memoryEntries.id, current.id))
      .returning({ id: memoryEntries.id, status: memoryEntries.status, title: memoryEntries.title });

    if (!updated) {
      return { ok: false, code: "CONFLICT", message: "Cập nhật xung đột, thử lại." };
    }

    await tx.insert(auditEvents).values({
      actorType: "user",
      actorId: input.actorId,
      action: ACTION_AUDIT[input.action],
      entityType: "memory_entry",
      entityId: current.id,
      beforeJson: { status: current.status },
      afterJson: {
        status: updated.status,
        reason: input.reason ?? null,
        superseded_count: supersededCount,
      },
      requestId: input.requestId,
    });

    return { ok: true, memory: updated };
  });
}
