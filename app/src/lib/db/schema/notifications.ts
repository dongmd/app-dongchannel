import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";

// Notifications inbox theo PRD FR-07.
// Broadcast qua Postgres LISTEN/NOTIFY channel 'notifications:{userId}'.
// V1: mỗi user 1 kênh; toàn bộ notification target user_id cụ thể.
// V1.1 sẽ có 'notifications:all' cho system events.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'task.waiting_review' | 'memory.proposed' | 'offer.transition' | 'video.transition' | 'ingest.error'
    entityType: text("entity_type"), // 'task' | 'memory_entry' | 'offer' | 'video'
    entityId: uuid("entity_id"),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"), // deep link
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userUnreadIdx: index("notifications_user_unread_idx").on(t.userId, t.readAt),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
