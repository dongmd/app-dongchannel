import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, type NewNotificationRow } from "@/lib/db/schema/notifications";
import { users } from "@/lib/db/schema/identity";

// AC02/AC08 — tạo notification + Postgres NOTIFY broadcast.
// V1: gửi cho user có role trong targetRoles (mặc định OWNER + ADMIN).

export interface CreateNotificationInput {
  type: string;
  entityType?: string;
  entityId?: string;
  title: string;
  body?: string;
  href?: string;
  targetRoles?: ("OWNER" | "ADMIN" | "VIEWER" | "AGENT")[];
}

export async function createNotification(input: CreateNotificationInput): Promise<number> {
  const targetRoles = input.targetRoles ?? ["OWNER", "ADMIN"];

  const targetUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.role, targetRoles));
  if (targetUsers.length === 0) return 0;

  const values: NewNotificationRow[] = targetUsers.map((u) => ({
    userId: u.id,
    type: input.type,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    title: input.title,
    body: input.body ?? null,
    href: input.href ?? null,
  }));

  const inserted = await db.insert(notifications).values(values).returning({
    id: notifications.id,
    userId: notifications.userId,
  });

  // Postgres NOTIFY per user channel — SSE stream LISTEN đúng kênh của user.
  // Payload nhỏ (id + type); client refetch full list qua REST khi nhận notify.
  for (const row of inserted) {
    const channel = `notifications:${row.userId}`;
    const payload = JSON.stringify({ id: row.id, type: input.type });
    try {
      await db.execute(sql`SELECT pg_notify(${channel}, ${payload})`);
    } catch {
      // Swallow — polling fallback vẫn pick up
    }
  }
  return inserted.length;
}
