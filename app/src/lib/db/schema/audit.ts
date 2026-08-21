import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Immutable event log (nguyên tắc BR06 và BR07 trong PRD mục 11).
// V1 chỉ có login events; mở rộng ở DC-009 (task review), DC-010 (memory approval).
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  actorType: text("actor_type").notNull(),      // 'user' | 'system' | 'agent'
  actorId: text("actor_id"),                     // email hoặc user_id — nullable cho action anonymous
  action: text("action").notNull(),              // 'login.success' | 'login.denied' | 'login.error' | ...
  entityType: text("entity_type"),               // 'user' | 'task' | 'memory_entry' | ...
  entityId: text("entity_id"),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  requestId: text("request_id"),

  // P3-R06 AC-04 — the two fields the owner's spec §10 asks for and the table
  // did not have.
  //
  // `result` is the outcome, not merely that the action was attempted: a line
  // saying "publish requested" without saying what happened cannot answer the
  // question the log exists for.
  result: text("result"),

  // Spec §10's "Telegram message/callback reference where safe". AC-05 makes
  // "where safe" mechanical: IDS ONLY, enforced by a CHECK in migration 0028,
  // because a convention in a comment is what P3-R06 exists to stop trusting.
  // A bot token is `<digits>:<35+ chars>` and the CHECK's length bound refuses
  // it, along with message text, @handles and email addresses.
  telegramRef: text("telegram_ref"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// APPEND-ONLY IS ENFORCED BY THE DATABASE, not by this comment.
//
// The previous comment on this table called it an "Immutable event log" while
// migrations 0000..0027 contained zero CREATE TRIGGER, CREATE RULE and REVOKE
// statements. Migration 0028 adds BEFORE UPDATE / DELETE / TRUNCATE triggers
// that RAISE for every role -- including the table owner, which is how this
// application connects, and which a REVOKE would not have bound.

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
