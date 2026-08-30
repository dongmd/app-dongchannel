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

/**
 * P4-R09 AC-05 — the outbound alert ledger.
 *
 * A **delivery ledger, not a Source of Truth.** The business fact — that a
 * publish failed and why — lives in the publish state and in `audit_events`.
 * This records only whether that fact has reached the owner over Telegram yet.
 *
 * Separate from `notifications` on purpose: that table is the in-app inbox,
 * keyed to a `users` row and read by the bell in the header. This one is a
 * queue for a collector that is not a browser and has no user session.
 *
 * Constraints live in `0037_p4r09_outbound_alerts.sql`.
 */
export const ownerOutboundAlerts = pgTable(
  "owner_outbound_alerts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Hermes' profile slug. Decides WHICH assistant carries the message. */
    profile: text("profile").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** Composed at failure time, stored, never rebuilt at delivery time. */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL = still waiting. */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchedBy: text("dispatched_by"),
  },
  (t) => [
    index("owner_outbound_alerts_pending_idx").on(t.profile, t.createdAt),
  ],
);

export type OwnerOutboundAlertRow = typeof ownerOutboundAlerts.$inferSelect;
