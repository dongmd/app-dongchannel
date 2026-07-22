import { bigint, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offers, angles } from "./aff";

// Pipeline theo PRD FR-04:
//   IDEA → VALIDATING → APPROVED → SCRIPTING → PRODUCING → SCHEDULED → PUBLISHED → REVIEWED
export const videoStatusEnum = pgEnum("video_status", [
  "IDEA",
  "VALIDATING",
  "APPROVED",
  "SCRIPTING",
  "PRODUCING",
  "SCHEDULED",
  "PUBLISHED",
  "REVIEWED",
]);

export const nicheStatusEnum = pgEnum("niche_status", [
  "EXPLORING",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
]);

export const videoVariantTypeEnum = pgEnum("video_variant_type", ["title", "thumbnail", "hook"]);

// ─── Niches ──────────────────────────────────────────────────────
export const niches = pgTable(
  "niches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    audienceLabel: text("audience_label"),
    positioning: text("positioning"),
    demandScore: integer("demand_score"),
    monetizationScore: integer("monetization_score"),
    copyrightRiskScore: integer("copyright_risk_score"),
    status: nicheStatusEnum("status").notNull().default("EXPLORING"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUq: uniqueIndex("niches_name_uq").on(t.name),
  }),
);

// ─── Content pillars ─────────────────────────────────────────────
export const contentPillars = pgTable("content_pillars", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  nicheId: uuid("niche_id")
    .notNull()
    .references(() => niches.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Videos ──────────────────────────────────────────────────────
export const videos = pgTable("videos", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  nicheId: uuid("niche_id").references(() => niches.id, { onDelete: "set null" }),
  pillarId: uuid("pillar_id").references(() => contentPillars.id, { onDelete: "set null" }),
  // Cross-ref DC-011 AFF: video có thể liên kết offer + angle nguồn (PRD 10.2 handoff)
  offerId: uuid("offer_id").references(() => offers.id, { onDelete: "set null" }),
  angleId: uuid("angle_id").references(() => angles.id, { onDelete: "set null" }),
  workingTitle: text("working_title").notNull(),
  title: text("title"), // final title (khi PUBLISHED)
  hook: text("hook"),
  outline: text("outline"),
  script: text("script"),
  copyrightRisk: text("copyright_risk"), // 'low' | 'medium' | 'high'
  publishUrl: text("publish_url"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  status: videoStatusEnum("status").notNull().default("IDEA"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Video variants (A/B title/thumbnail/hook) ──────────────────
export const videoVariants = pgTable("video_variants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  type: videoVariantTypeEnum("type").notNull(),
  content: text("content").notNull(),
  rank: integer("rank"), // ordering
  selected: integer("selected").notNull().default(0), // 0/1
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Video metrics (snapshot theo window) ───────────────────────
export const videoMetrics = pgTable("video_metrics", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  windowLabel: text("window_label"), // '24h' | '7d' | '28d' | 'lifetime'
  impressions: bigint("impressions", { mode: "number" }),
  ctr: real("ctr"),
  views: bigint("views", { mode: "number" }),
  retention30s: real("retention_30s"),
  avgPercentageViewed: real("avg_percentage_viewed"),
  subscribers: integer("subscribers"),
  affiliateClicks: integer("affiliate_clicks"),
  sales: integer("sales"),
  revenue: real("revenue"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NicheRow = typeof niches.$inferSelect;
export type VideoRow = typeof videos.$inferSelect;
export type NewVideoRow = typeof videos.$inferInsert;
export type VideoStatus = (typeof videoStatusEnum.enumValues)[number];
export type NicheStatus = (typeof nicheStatusEnum.enumValues)[number];
