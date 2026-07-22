import { integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tasks } from "./tasks";

// Lifecycle theo PRD FR-05:
//   PROPOSED → APPROVED → ACTIVE → SUPERSEDED / REJECTED / ARCHIVED
// V1 gộp APPROVED + ACTIVE (approve xong = active luôn). SUPERSEDED được set
// khi có entry mới thay thế (memory.supersede action).
export const memoryStatusEnum = pgEnum("memory_status", [
  "PROPOSED",
  "ACTIVE",
  "SUPERSEDED",
  "REJECTED",
  "ARCHIVED",
]);

// Category maps PRD FR-05 tabs (không hard-coded để tương lai mở rộng dễ).
//   user_profile — thông tin cá nhân người dùng (VD "prefers Vietnamese responses")
//   decision     — quyết định đã duyệt (VD "reject offer XYZ vì cookie 1 ngày quá ngắn")
//   playbook     — nguyên tắc chung cho AFF/YT bot (VD "always verify commission via network dashboard")
//   fact         — sự thật khách quan (VD "network X payout NET-30")
export const memoryCategoryEnum = pgEnum("memory_category", [
  "user_profile",
  "decision",
  "playbook",
  "fact",
]);

// profile_scope = 'shared' nghĩa là cả 2 bot đọc được (VD user_profile).
// 'aff' hoặc 'yt' = giới hạn 1 profile.
export const memoryScopeEnum = pgEnum("memory_scope", ["shared", "aff", "yt"]);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    profileScope: memoryScopeEnum("profile_scope").notNull(),
    category: memoryCategoryEnum("category").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: memoryStatusEnum("status").notNull().default("PROPOSED"),
    confidence: real("confidence"), // 0..1 optional
    // Source: task nguồn (nếu bot đề xuất) hoặc null (manual entry)
    sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
    manualEntry: integer("manual_entry").notNull().default(0), // BR02: 0/1
    reasonText: text("reason_text"), // Lý do proposal (bot generate hoặc human input)
    approvedBy: text("approved_by"), // email
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"), // Self-FK, add ref sau khi bảng tồn tại
    version: integer("version").notNull().default(1),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Trong V1 không unique title-per-scope vì có thể proposal + active parallel.
    // Chỉ index bằng created_at cho query nhanh.
    activeByCategory: uniqueIndex("memory_active_by_category_uq")
      .on(t.profileScope, t.category, t.title)
      .where(sql`status = 'ACTIVE'`),
  }),
);

export type MemoryRow = typeof memoryEntries.$inferSelect;
export type NewMemoryRow = typeof memoryEntries.$inferInsert;
export type MemoryStatus = (typeof memoryStatusEnum.enumValues)[number];
export type MemoryCategory = (typeof memoryCategoryEnum.enumValues)[number];
export type MemoryScope = (typeof memoryScopeEnum.enumValues)[number];

// Ghi chú: hồ sơ profile của TDD không tách "shared" entities riêng cho V1 memory —
// một memory là shared khi profile_scope='shared'. Đủ cho FR-05.
