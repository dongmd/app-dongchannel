import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, type NotificationRow } from "@/lib/db/schema/notifications";

export interface ListInput {
  userId: string;
  unreadOnly?: boolean;
  limit?: number;
}

export async function listNotifications(input: ListInput): Promise<NotificationRow[]> {
  const limit = Math.min(input.limit ?? 20, 100);
  const whereClauses = [eq(notifications.userId, input.userId)];
  if (input.unreadOnly) whereClauses.push(isNull(notifications.readAt));
  return db
    .select()
    .from(notifications)
    .where(and(...whereClauses))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function countUnread(userId: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows.length;
}
