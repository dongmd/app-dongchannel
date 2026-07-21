import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// RBAC per TDD mục 23. V1 chỉ dùng OWNER, còn lại reserved để không phải migrate schema sau.
export const roleEnum = pgEnum("app_role", ["OWNER", "ADMIN", "VIEWER", "AGENT"]);

// Single source of truth cho role type — mọi file khác import từ đây thay vì define lại.
export type AppRole = (typeof roleEnum.enumValues)[number];

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  googleSub: text("google_sub").unique(),
  role: roleEnum("role").notNull().default("VIEWER"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const emailAllowlist = pgTable("email_allowlist", {
  email: text("email").primaryKey(),
  role: roleEnum("role").notNull().default("VIEWER"),
  addedBy: text("added_by"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type AllowlistRow = typeof emailAllowlist.$inferSelect;
