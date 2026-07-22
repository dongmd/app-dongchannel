import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Profile slug khớp Hermes VPS (Discovery Gate mục 4): `aff`, `yt`, `default`.
// Không dùng uuid vì slug đã unique + human-readable; JOIN chuỗi ngắn nhanh.
export const profiles = pgTable("profiles", {
  slug: text("slug").primaryKey(), // 'aff' | 'yt' | 'default'
  name: text("name").notNull(),
  type: text("type").notNull().default("bot"), // 'bot' | 'system'
  status: text("status").notNull().default("active"), // 'active' | 'archived'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProfileRow = typeof profiles.$inferSelect;

export const PROFILE_SLUGS = ["default", "aff", "yt"] as const;
export type ProfileSlug = (typeof PROFILE_SLUGS)[number];
