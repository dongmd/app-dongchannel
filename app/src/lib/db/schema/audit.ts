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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
