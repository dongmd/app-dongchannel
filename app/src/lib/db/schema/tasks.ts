import { integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { profiles } from "./profiles";
import { hermesMessages, hermesSessions } from "./hermes";

// PRD FR-02 lifecycle:
//   CAPTURED → QUEUED → RUNNING → WAITING_REVIEW → APPROVED/REVISION_REQUESTED/REJECTED → COMPLETED
// Trạng thái phụ:
//   FAILED, CANCELLED, SYNC_DELAYED
// Ngoài ra dùng IMPORTED cho backfill session cũ chưa có review lifecycle (TDD mục 25 M2).
export const taskStatusEnum = pgEnum("task_status", [
  "CAPTURED",
  "QUEUED",
  "RUNNING",
  "WAITING_REVIEW",
  "APPROVED",
  "REVISION_REQUESTED",
  "REJECTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SYNC_DELAYED",
  "IMPORTED",
]);

export const taskReviewStatusEnum = pgEnum("task_review_status", [
  "NONE",
  "PENDING",
  "APPROVED",
  "REVISION_REQUESTED",
  "REJECTED",
]);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    code: text("code").notNull(), // 'AFF-0001', 'YT-0001'
    profileSlug: text("profile_slug")
      .notNull()
      .references(() => profiles.slug),
    sourceHermesSessionId: uuid("source_hermes_session_id").references(() => hermesSessions.id, {
      onDelete: "set null",
    }),
    sourceHermesMessageId: uuid("source_hermes_message_id").references(() => hermesMessages.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    type: text("type"), // 'research', 'video_brief', 'general'
    status: taskStatusEnum("status").notNull().default("IMPORTED"),
    reviewStatus: taskReviewStatusEnum("review_status").notNull().default("NONE"),
    priority: integer("priority").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUq: uniqueIndex("tasks_code_uq").on(t.code),
    sessionUq: uniqueIndex("tasks_session_uq").on(t.sourceHermesSessionId),
  }),
);

// Activity events (empty V1 — populated khi SSE ingestion ở DC-015).
// Structure sẵn để DC-015 chỉ cần INSERT.
export const taskActivities = pgTable(
  "task_activities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    externalEventId: text("external_event_id"),
    eventType: text("event_type").notNull(), // 'session.started', 'agent.step', 'tool.completed', ...
    stepName: text("step_name"),
    status: text("status"), // 'ok', 'error'
    payloadRedacted: jsonb("payload_redacted"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalEventUq: uniqueIndex("task_activities_external_event_uq").on(t.externalEventId),
  }),
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
export type TaskReviewStatus = (typeof taskReviewStatusEnum.enumValues)[number];
