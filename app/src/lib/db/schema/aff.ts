import { integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Pipeline theo PRD FR-03:
//   NEW → RESEARCHING → WATCHLIST → APPROVED_FOR_TEST → TESTING → ITERATE / SCALE / STOP
export const offerStatusEnum = pgEnum("offer_status", [
  "NEW",
  "RESEARCHING",
  "WATCHLIST",
  "APPROVED_FOR_TEST",
  "TESTING",
  "ITERATE",
  "SCALE",
  "STOP",
]);

export const marketStatusEnum = pgEnum("market_status", ["ACTIVE", "PAUSED", "ARCHIVED"]);
export const angleStatusEnum = pgEnum("angle_status", [
  "DRAFT",
  "READY",
  "TESTING",
  "WINNER",
  "LOSER",
  "ARCHIVED",
]);

export const offerConfidenceEnum = pgEnum("offer_confidence", [
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "UNVERIFIED",
]);

export const offerCommissionTypeEnum = pgEnum("offer_commission_type", [
  "CPA",
  "REVSHARE",
  "RECURRING",
  "HYBRID",
  "UNKNOWN",
]);

// ─── Merchants ────────────────────────────────────────────────────
// P1-R03 / M1. The company that owns an affiliate programme.
//
// Deliberately NOT the same thing as `markets`. A market is a vertical
// ("SEO tools"); a merchant is a company ("Semrush"). Confirmed against the
// code before this was added: `markets` is only ever used as a classification
// label on an offer, and carries demand/competition/policy-risk scores, which
// are properties of a vertical and meaningless for a company.
export const merchantStatusEnum = pgEnum("merchant_status", ["ACTIVE", "INACTIVE", "ARCHIVED"]);

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    websiteUrl: text("website_url"),
    // Normalised host, e.g. "semrush.com". The dedup key FINAL section 8.2 asks
    // for: merchant names vary by source, registrable domains do not.
    canonicalDomain: text("canonical_domain"),
    status: merchantStatusEnum("status").notNull().default("ACTIVE"),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUq: uniqueIndex("merchants_name_uq").on(t.name),
    domainUq: uniqueIndex("merchants_canonical_domain_uq").on(t.canonicalDomain),
  }),
);

// ─── Affiliate networks ───────────────────────────────────────────
// P1-R03 / M1. Impact is the first connector (FINAL section 10.2), but nothing
// here is Impact-shaped: FINAL is explicit that provider concepts must not be
// hard-coded into the canonical model.
export const affiliateNetworkStatusEnum = pgEnum("affiliate_network_status", [
  "ACTIVE",
  "INACTIVE",
  "ARCHIVED",
]);

export const affiliateNetworks = pgTable(
  "affiliate_networks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Stable machine key, e.g. "impact". Connectors reference this, not the
    // display name, so renaming a network cannot break an integration.
    key: text("key").notNull(),
    name: text("name").notNull(),
    websiteUrl: text("website_url"),
    status: affiliateNetworkStatusEnum("status").notNull().default("ACTIVE"),
    // Whether the owner holds an account. Drives what a connector may fetch.
    ownerAccountStatus: text("owner_account_status"),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex("affiliate_networks_key_uq").on(t.key),
  }),
);

// ─── Markets ──────────────────────────────────────────────────────
export const markets = pgTable(
  "markets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    summary: text("summary"),
    demandScore: integer("demand_score"),
    longevityScore: integer("longevity_score"),
    competitionScore: integer("competition_score"),
    policyRiskScore: integer("policy_risk_score"),
    status: marketStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameUq: uniqueIndex("markets_name_uq").on(t.name),
  }),
);

// ─── Offers ───────────────────────────────────────────────────────
export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    marketId: uuid("market_id").references(() => markets.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    websiteUrl: text("website_url"),
    network: text("network"),
    commissionType: offerCommissionTypeEnum("commission_type").notNull().default("UNKNOWN"),
    commissionValue: real("commission_value"), // % hoặc $ tuỳ type
    commissionUnit: text("commission_unit"), // 'percent' | 'usd' | 'usd_recurring'
    cookieDays: integer("cookie_days"),
    payoutThreshold: real("payout_threshold"),
    countries: text("countries").array(), // Postgres text[]
    status: offerStatusEnum("status").notNull().default("NEW"),
    confidence: offerConfidenceEnum("confidence").notNull().default("UNVERIFIED"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Cùng market không cho trùng tên. Cross-market OK.
    marketNameUq: uniqueIndex("offers_market_name_uq").on(t.marketId, t.name),
  }),
);

// ─── Offer restrictions (traffic source + brand bidding) ─────────
export const offerRestrictions = pgTable("offer_restrictions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  offerId: uuid("offer_id")
    .notNull()
    .references(() => offers.id, { onDelete: "cascade" }),
  trafficSource: text("traffic_source").notNull(), // 'facebook', 'google-ads', 'seo', 'email'
  allowed: integer("allowed").notNull().default(1), // 0/1
  brandBidding: integer("brand_bidding"), // nullable
  notes: text("notes"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});

// ─── Angles ──────────────────────────────────────────────────────
export const angles = pgTable("angles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  offerId: uuid("offer_id")
    .notNull()
    .references(() => offers.id, { onDelete: "cascade" }),
  audienceLabel: text("audience_label"),
  painPoint: text("pain_point"),
  desire: text("desire"),
  bigIdea: text("big_idea"),
  promise: text("promise"),
  mechanism: text("mechanism"),
  proofRequired: text("proof_required"),
  status: angleStatusEnum("status").notNull().default("DRAFT"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Affiliate test results ──────────────────────────────────────
export const affiliateResults = pgTable("affiliate_results", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  offerId: uuid("offer_id")
    .notNull()
    .references(() => offers.id, { onDelete: "cascade" }),
  angleId: uuid("angle_id").references(() => angles.id, { onDelete: "set null" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  impressions: integer("impressions"),
  clicks: integer("clicks"),
  leads: integer("leads"),
  sales: integer("sales"),
  commission: real("commission"),
  cost: real("cost"),
  refunds: real("refunds"),
  profit: real("profit"),
  currency: text("currency").notNull().default("USD"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Scorecards (chung cho market/offer/angle) ───────────────────
export const scorecards = pgTable(
  "scorecards",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    entityType: text("entity_type").notNull(), // 'market' | 'offer' | 'angle'
    entityId: uuid("entity_id").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    totalScore: real("total_score").notNull(),
    breakdownJson: jsonb("breakdown_json"),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityUq: uniqueIndex("scorecards_entity_uq").on(t.entityType, t.entityId, t.schemaVersion),
  }),
);

export type MarketRow = typeof markets.$inferSelect;
export type OfferRow = typeof offers.$inferSelect;
export type NewOfferRow = typeof offers.$inferInsert;
export type AngleRow = typeof angles.$inferSelect;
export type AffiliateResultRow = typeof affiliateResults.$inferSelect;
export type OfferStatus = (typeof offerStatusEnum.enumValues)[number];
export type OfferConfidence = (typeof offerConfidenceEnum.enumValues)[number];
export type OfferCommissionType = (typeof offerCommissionTypeEnum.enumValues)[number];

export type MerchantRow = typeof merchants.$inferSelect;
export type NewMerchantRow = typeof merchants.$inferInsert;
export type AffiliateNetworkRow = typeof affiliateNetworks.$inferSelect;
export type NewAffiliateNetworkRow = typeof affiliateNetworks.$inferInsert;
