import { bigint, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { profiles } from "./profiles";

// Projection cache của Hermes SQLite state.db (Nguyên tắc bất di #3 & #5).
// Xoá được để rebuild qua ingestion — không phải source of truth.
// Fields khớp JSONL export từ `hermes sessions export --format jsonl -` (Discovery mục 8).

export const hermesSessions = pgTable(
  "hermes_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    profileSlug: text("profile_slug")
      .notNull()
      .references(() => profiles.slug),
    hermesSessionId: text("hermes_session_id").notNull(), // "20260720_162847_b6ae65df"
    source: text("source"), // 'telegram', 'discord', 'cli'
    chatId: text("chat_id"),
    userId: text("user_id"),
    chatType: text("chat_type"), // 'dm', 'group'
    displayName: text("display_name"),
    title: text("title"),
    model: text("model"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
    messageCount: integer("message_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    estimatedCostUsd: real("estimated_cost_usd"),
    archived: integer("archived").notNull().default(0), // 0/1
    rawMetadata: jsonb("raw_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotency: (profile, hermes_session_id) là natural key.
    profileSessionUq: uniqueIndex("hermes_sessions_profile_session_uq").on(
      t.profileSlug,
      t.hermesSessionId,
    ),
  }),
);

export const hermesMessages = pgTable(
  "hermes_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hermesSessions.id, { onDelete: "cascade" }),
    externalMessageId: integer("external_message_id").notNull(), // int từ Hermes
    role: text("role").notNull(), // 'user' | 'assistant' | 'session_meta' | 'tool'
    content: text("content"), // nullable — session_meta có content=null
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    tokenCount: integer("token_count"),
    finishReason: text("finish_reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    rawJson: jsonb("raw_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionMessageUq: uniqueIndex("hermes_messages_session_msg_uq").on(
      t.sessionId,
      t.externalMessageId,
    ),
  }),
);

export type HermesSessionRow = typeof hermesSessions.$inferSelect;
export type NewHermesSessionRow = typeof hermesSessions.$inferInsert;
export type HermesMessageRow = typeof hermesMessages.$inferSelect;
export type NewHermesMessageRow = typeof hermesMessages.$inferInsert;
