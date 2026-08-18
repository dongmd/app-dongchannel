import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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

// ─── Affiliate programs ───────────────────────────────────────────
// P1-R03 / M2. The FINAL-shaped replacement for `offers`.
//
// `offers` is intentionally left in place: the app still reads it, and the
// rule is that no legacy table is dropped until application compatibility has
// been proven. Moving the app across and dropping `offers` is a separate,
// tracked step.
//
// Permissions are the reason this table exists in this shape. `offer_restrictions`
// stored them as integer 0/1 defaulting to 1, with no way to express "nobody has
// checked". That default asserts "PPC is allowed" about every programme ever
// inserted. FINAL section 9 requires unknown to stay UNKNOWN, and a wrong claim
// here is the kind that gets an affiliate account closed -- so the default is
// UNKNOWN and no legacy 0/1 value is inferred into it.
export const affiliatePermissionEnum = pgEnum("affiliate_permission", [
  "YES",
  "NO",
  "CONDITIONAL",
  "UNKNOWN",
]);

export const affiliatePrograms = pgTable(
  "affiliate_programs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // Who owns the programme.
    merchantId: uuid("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
    // Which vertical it sits in. Retained from `offers` -- a market is a
    // category, not a company, so both references are real and neither
    // replaces the other.
    marketId: uuid("market_id").references(() => markets.id, { onDelete: "set null" }),
    // Which network it is run through, normalised out of the old free-text
    // `offers.network`.
    networkId: uuid("network_id").references(() => affiliateNetworks.id, { onDelete: "set null" }),
    // The provider's own identifier, kept so a connector can sync incrementally.
    networkExternalRef: text("network_external_ref"),

    name: text("name").notNull(),
    programUrl: text("program_url"),
    applicationUrl: text("application_url"),

    // Economics. Enums reused from the offer model rather than duplicated --
    // same meanings, and a second near-identical pg enum helps nobody.
    payoutType: offerCommissionTypeEnum("payout_type").notNull().default("UNKNOWN"),
    payoutValue: real("payout_value"),
    payoutCurrency: text("payout_currency"),
    payoutUnit: text("payout_unit"), // 'percent' | 'usd' | 'usd_recurring'
    recurring: boolean("recurring"),
    cookieDurationDays: integer("cookie_duration_days"),
    payoutThreshold: real("payout_threshold"),

    // Traffic permissions. All default UNKNOWN, deliberately.
    ppcAllowed: affiliatePermissionEnum("ppc_allowed").notNull().default("UNKNOWN"),
    brandBiddingAllowed: affiliatePermissionEnum("brand_bidding_allowed")
      .notNull()
      .default("UNKNOWN"),
    directLinkingAllowed: affiliatePermissionEnum("direct_linking_allowed")
      .notNull()
      .default("UNKNOWN"),

    applicationRequired: affiliatePermissionEnum("application_required")
      .notNull()
      .default("UNKNOWN"),
    ownerAccountStatus: text("owner_account_status"),

    status: offerStatusEnum("status").notNull().default("NEW"),
    confidence: offerConfidenceEnum("confidence").notNull().default("UNVERIFIED"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),

    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Same merchant may not have two programmes of the same name. Postgres
    // treats NULLs as distinct, so this does not over-constrain rows whose
    // merchant is not yet identified.
    merchantNameUq: uniqueIndex("affiliate_programs_merchant_name_uq").on(t.merchantId, t.name),
    merchantIdx: index("affiliate_programs_merchant_idx").on(t.merchantId),
    networkIdx: index("affiliate_programs_network_idx").on(t.networkId),
    marketIdx: index("affiliate_programs_market_idx").on(t.marketId),
    statusIdx: index("affiliate_programs_status_idx").on(t.status),
  }),
);

// ─── Affiliate program GEOs ───────────────────────────────────────
// P1-R03 / M3. Replaces `offers.countries text[]` with one row per country, so
// that terms which genuinely differ by country can be expressed:
//
//   US → CPA $80, PPC YES
//   UK → CPA $60, PPC CONDITIONAL
//   CA → CPA $50, PPC NO
//
// A text[] of country codes cannot carry any of that.
//
// Every override column is NULLABLE WITH NO DEFAULT, and that is the whole
// design. Three states have to stay distinguishable:
//
//   NULL       → no GEO-specific finding; inherit the programme-level value
//   'UNKNOWN'  → someone looked at this country specifically and could not tell
//   YES/NO/... → a verified GEO-specific term
//
// Giving these columns a default of UNKNOWN would collapse the first two, and
// every GEO row ever created would silently assert "checked, unknown" about a
// country nobody examined. The programme-level columns are NOT NULL DEFAULT
// UNKNOWN because there the absence of a finding *is* "unknown"; here it is
// "inherit", which is a different fact.
//
// Nothing in this table is ever auto-populated. A row exists only where a GEO
// was actually researched.
export const affiliateProgramGeos = pgTable(
  "affiliate_program_geos",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    programId: uuid("program_id")
      .notNull()
      .references(() => affiliatePrograms.id, { onDelete: "cascade" }),

    // ISO 3166-1 alpha-2, uppercase. Constrained rather than trusted: "usa",
    // "gb " and "United Kingdom" all silently break GEO matching later.
    geo: text("geo").notNull(),

    // Payout overrides. NULL = inherit from the programme.
    payoutType: offerCommissionTypeEnum("payout_type"),
    payoutValue: real("payout_value"),
    payoutCurrency: text("payout_currency"),
    payoutUnit: text("payout_unit"),
    cookieDurationDays: integer("cookie_duration_days"),

    // Permission overrides. NULL = inherit from the programme.
    ppcAllowed: affiliatePermissionEnum("ppc_allowed"),
    brandBiddingAllowed: affiliatePermissionEnum("brand_bidding_allowed"),
    directLinkingAllowed: affiliatePermissionEnum("direct_linking_allowed"),

    // Evidence tracking is per GEO: US terms can be verified while UK terms
    // are still stale.
    confidence: offerConfidenceEnum("confidence").notNull().default("UNVERIFIED"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),

    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    programGeoUq: uniqueIndex("affiliate_program_geos_program_geo_uq").on(t.programId, t.geo),
    // "which programmes run in the US" is a primary query for route decisions.
    geoIdx: index("affiliate_program_geos_geo_idx").on(t.geo),
    geoFormat: check("affiliate_program_geos_geo_format", sql`${t.geo} ~ '^[A-Z]{2}$'`),
  }),
);

// ─── Offer restrictions (traffic source + brand bidding) ─────────
// DEPRECATED by M2. Superseded by the permission columns on
// `affiliate_programs`. Retained until the app no longer reads `offers`.
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
  // M2b: repointed from `offers` to `affiliate_programs`. Column name kept as
  // offer_id for now -- renaming it is churn across the angles UI for no
  // behavioural gain, and M4 reshapes this area anyway.
  offerId: uuid("offer_id")
    .notNull()
    .references(() => affiliatePrograms.id, { onDelete: "cascade" }),
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
  // M2b: repointed to `affiliate_programs`. This table is reshaped in M4.
  offerId: uuid("offer_id")
    .notNull()
    .references(() => affiliatePrograms.id, { onDelete: "cascade" }),
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

// ─── Affiliate projects / tests / metrics ─────────────────────────
// P1-R03 / M4. Splits what `affiliate_results` conflated.
//
// `affiliate_results` carried the identity of a test and its measurements in
// one row: offer, angle, period, impressions, clicks, commission, cost, profit.
// That makes a re-measured period either a duplicate row or a destructive
// update, and it leaves nowhere to record *why* a test was approved.
//
//   affiliate_projects      a decision to pursue a programme
//   affiliate_tests         one experiment inside that project
//   affiliate_test_metrics  one measurement window of that experiment
//
// Deliberately absent: `affiliate_conversions` and `affiliate_payout_events`.
// They only mean something once a network connector exists, and FINAL section
// 7.1 defines profit as *validated* commission -- net of reversals and
// rejections that only the network can report. Creating those tables now would
// invite writing unvalidated numbers into them.
export const affiliateProjectStatusEnum = pgEnum("affiliate_project_status", [
  "CANDIDATE",
  "RESEARCH",
  "READY_FOR_APPROVAL",
  "APPROVED_FOR_TEST",
  "CAMPAIGN_DRAFTED",
  "TESTING",
  "SCALE",
  "HOLD",
  "STOPPED",
]);

export const affiliateTestStatusEnum = pgEnum("affiliate_test_status", [
  "DRAFT",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "ABANDONED",
]);

export const affiliateTrafficRouteEnum = pgEnum("affiliate_traffic_route", [
  "PPC",
  "SEO",
  "CONTENT",
  "YOUTUBE",
  "OTHER",
]);

export const affiliateProjects = pgTable(
  "affiliate_projects",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    programId: uuid("program_id")
      .notNull()
      .references(() => affiliatePrograms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: affiliateProjectStatusEnum("status").notNull().default("CANDIDATE"),
    // Which route was chosen and why. FINAL section 7.5: "PPC forbidden" routes
    // an opportunity to SEO rather than rejecting it.
    route: affiliateTrafficRouteEnum("route"),
    routeReason: text("route_reason"),
    // Who approved the spend, and when. Approval is a record, never inferred
    // from a status value.
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    programNameUq: uniqueIndex("affiliate_projects_program_name_uq").on(t.programId, t.name),
    statusIdx: index("affiliate_projects_status_idx").on(t.status),
  }),
);

export const affiliateTests = pgTable(
  "affiliate_tests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => affiliateProjects.id, { onDelete: "cascade" }),
    // The creative angle under test, where there is one.
    angleId: uuid("angle_id").references(() => angles.id, { onDelete: "set null" }),
    // GEO is a row here, not free text, so a test cannot claim a country the
    // programme has no terms for.
    geoId: uuid("geo_id").references(() => affiliateProgramGeos.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: affiliateTestStatusEnum("status").notNull().default("DRAFT"),
    route: affiliateTrafficRouteEnum("route"),
    // Budget ceiling for this experiment. FINAL section 1.3 requires a spend
    // ceiling on any autonomous money action.
    budgetCapValue: real("budget_cap_value"),
    budgetCapCurrency: text("budget_cap_currency"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    stopReason: text("stop_reason"),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index("affiliate_tests_project_idx").on(t.projectId),
    statusIdx: index("affiliate_tests_status_idx").on(t.status),
  }),
);

export const affiliateTestMetrics = pgTable(
  "affiliate_test_metrics",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    testId: uuid("test_id")
      .notNull()
      .references(() => affiliateTests.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),

    // Traffic side: what the ad platform reports. Nullable, because a metric
    // that was not collected is not zero.
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    spend: real("spend"),

    // Money side. `commission_reported` is what the network currently shows;
    // `commission_validated` is what survived reversal and rejection.
    //
    // They are separate columns and neither is derived from the other. FINAL
    // section 7.1 measures profit on the validated figure precisely because
    // affiliate conversions get reversed, and collapsing the two would let a
    // pending commission be reported as profit.
    conversionsReported: integer("conversions_reported"),
    conversionsValidated: integer("conversions_validated"),
    commissionReported: real("commission_reported"),
    commissionValidated: real("commission_validated"),
    currency: text("currency").notNull().default("USD"),

    // Profit is NOT a computed column and carries no default. It is written
    // only when validated commission is actually known; deriving it from
    // reported figures would manufacture a profit number.
    netProfitValidated: real("net_profit_validated"),

    source: text("source"), // 'google-ads', 'network-api', 'manual'
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    testPeriodUq: uniqueIndex("affiliate_test_metrics_test_period_uq").on(
      t.testId,
      t.periodStart,
      t.periodEnd,
    ),
    testIdx: index("affiliate_test_metrics_test_idx").on(t.testId),
    periodOrder: check(
      "affiliate_test_metrics_period_order",
      sql`${t.periodEnd} > ${t.periodStart}`,
    ),
  }),
);


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

export type AffiliateProgramRow = typeof affiliatePrograms.$inferSelect;
export type NewAffiliateProgramRow = typeof affiliatePrograms.$inferInsert;
export type AffiliatePermission = (typeof affiliatePermissionEnum.enumValues)[number];

export type AffiliateProgramGeoRow = typeof affiliateProgramGeos.$inferSelect;
export type NewAffiliateProgramGeoRow = typeof affiliateProgramGeos.$inferInsert;

export type AffiliateProjectRow = typeof affiliateProjects.$inferSelect;
export type AffiliateTestRow = typeof affiliateTests.$inferSelect;
export type AffiliateTestMetricRow = typeof affiliateTestMetrics.$inferSelect;
