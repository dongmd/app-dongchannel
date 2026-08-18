import {
  boolean,
  check,
  index,
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

// P1-R03 / M5 — the Opportunity Inbox (FINAL sections 4, 7, 8).
//
// Every discovery mode lands here first, normalised, before anything decides
// it is worth doing. The ordering matters: a signal is a *thing that was
// noticed*, not a thing that is good. Nothing in this file defaults to
// optimism -- no score, no confidence, no route.

// ─── Sources ──────────────────────────────────────────────────────
// The registry of places signals come from. It has to describe the owner
// typing into Telegram, an affiliate network API, a search or trend feed, a
// competitor site, DongChannel's own analytics, YouTube, and connectors that
// do not exist yet -- without a schema change for each one.
export const sourceTypeEnum = pgEnum("source_type", [
  "OWNER_TELEGRAM",
  "OWNER_APP",
  "AFFILIATE_NETWORK",
  "MERCHANT_OFFICIAL",
  "SEARCH",
  "TREND",
  "COMPETITOR_SITE",
  "YOUTUBE",
  "DONGCHANNEL_FIRST_PARTY",
  "PERFORMANCE",
  "OTHER",
]);

// How much a claim from this source is worth on its own. UNKNOWN is the
// default because an unclassified source has not earned a tier.
export const trustTierEnum = pgEnum("trust_tier", [
  "OFFICIAL_PRIMARY",
  "FIRST_PARTY",
  "RELIABLE_SECONDARY",
  "DISCOVERY_ONLY",
  "UNKNOWN",
]);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Stable machine key, e.g. "impact", "gsc", "owner-telegram". Connectors
    // reference this rather than the display name.
    key: text("key").notNull(),
    name: text("name").notNull(),
    sourceType: sourceTypeEnum("source_type").notNull(),
    // Free-text provider for connector sources, e.g. "impact". Deliberately
    // not an enum: FINAL 10.2 requires new networks without a model change.
    provider: text("provider"),
    baseUrl: text("base_url"),

    trustTier: trustTierEnum("trust_tier").notNull().default("UNKNOWN"),

    // Both default false. A source that was just registered should not begin
    // ingesting, and should not be assumed schedulable, until someone says so.
    isEnabled: boolean("is_enabled").notNull().default(false),
    supportsScheduledDiscovery: boolean("supports_scheduled_discovery").notNull().default(false),
    requiresAuth: boolean("requires_auth").notNull().default(false),

    // A POINTER to credentials -- an env var name or secret-store key. Never a
    // credential. FINAL 10.2: connectors must never expose secrets to UI or
    // logs, and a secret in a row is a secret in every backup and screenshot.
    configRef: text("config_ref"),

    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastError: text("last_error"),

    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex("sources_key_uq").on(t.key),
    typeIdx: index("sources_type_idx").on(t.sourceType),
    enabledIdx: index("sources_enabled_idx").on(t.isEnabled),
  }),
);

// ─── Source items ─────────────────────────────────────────────────
// Raw intake, kept so an opportunity can always be traced back to the thing
// that produced it. This is the provenance layer: if a payout figure is
// challenged months later, the answer is a row here, not a memory.
//
// Dedup is explicit rather than best-effort, because an ingest loop that
// re-reads the same feed hourly will otherwise create the same signal forever:
//
//   (source_id, external_id)   the provider's own identifier, when it has one
//   (source_id, content_hash)  for sources with no stable ID
//
// Both are partial-safe: Postgres treats NULLs as distinct, so an item with no
// external ID does not collide with every other such item.
export const sourceItemStatusEnum = pgEnum("source_item_status", [
  "NEW",
  "PROCESSED",
  "DUPLICATE",
  "IGNORED",
  "ERROR",
]);

export const sourceItems = pgTable(
  "source_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),

    // The provider's identifier for this item, where one exists.
    externalId: text("external_id"),
    url: text("url"),
    // Normalised URL used for dedup: lower-cased host, tracking params
    // stripped. Stored rather than computed so the normalisation rule can
    // change without silently re-deduping history.
    canonicalUrl: text("canonical_url"),
    // Hash of the meaningful content. The fallback dedup key.
    contentHash: text("content_hash"),

    title: text("title"),
    summary: text("summary"),
    // The raw payload exactly as received. Provenance, not working data --
    // nothing should read business facts out of here.
    rawPayload: jsonb("raw_payload"),

    status: sourceItemStatusEnum("status").notNull().default("NEW"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalUq: uniqueIndex("source_items_source_external_uq").on(t.sourceId, t.externalId),
    hashUq: uniqueIndex("source_items_source_hash_uq").on(t.sourceId, t.contentHash),
    statusIdx: index("source_items_status_idx").on(t.status),
    fetchedIdx: index("source_items_fetched_idx").on(t.fetchedAt),
  }),
);

// ─── Opportunity signals ──────────────────────────────────────────
// The product heart. One normalised row per thing worth a second look.
//
// The defaults here are the design. `status` starts NEW, `confidence` starts
// UNKNOWN, and `overall_score` starts NULL -- not 0, not 50. An unscored
// signal must be distinguishable from one scored zero, or a ranked inbox will
// quietly bury everything that has not been looked at yet.
export const signalKindEnum = pgEnum("signal_kind", [
  "AFFILIATE_PROGRAM",
  "PRODUCT",
  "KEYWORD",
  "TREND",
  "CONTENT_GAP",
  "YOUTUBE_NICHE",
  "YOUTUBE_VIDEO",
  "COMPETITOR_SIGNAL",
  "PERFORMANCE_EXPANSION",
  "OWNER_IDEA",
  "OTHER",
]);

export const signalOriginModeEnum = pgEnum("signal_origin_mode", [
  "OWNER_TELEGRAM",
  "OWNER_APP",
  "SCHEDULED_DISCOVERY",
  "CONNECTOR",
  "DONGCHANNEL_SIGNAL",
  "CROSS_ENGINE",
  "PERFORMANCE",
  "REVERIFY",
]);

export const signalStatusEnum = pgEnum("signal_status", [
  "NEW",
  "RESEARCHING",
  "NEEDS_EVIDENCE",
  "READY_FOR_DECISION",
  "WATCHLIST",
  "APPROVED",
  "REJECTED",
  "ROUTED",
  "ARCHIVED",
]);

export const signalConfidenceEnum = pgEnum("signal_confidence", [
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
]);

export const opportunitySignals = pgTable(
  "opportunity_signals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Normalised dedup key across sources -- the same programme found via
    // Impact and via search should collapse to one signal.
    canonicalKey: text("canonical_key"),

    kind: signalKindEnum("kind").notNull(),
    originMode: signalOriginModeEnum("origin_mode").notNull(),

    // Provenance. Nullable because an owner seed typed into Telegram has no
    // source item behind it.
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, {
      onDelete: "set null",
    }),
    ownerSeedText: text("owner_seed_text"),

    title: text("title").notNull(),
    summary: text("summary"),
    language: text("language"),
    targetGeos: text("target_geos").array(),

    status: signalStatusEnum("status").notNull().default("NEW"),

    // NULL until something actually scores it. Never defaulted.
    overallScore: real("overall_score"),
    scoringVersion: text("scoring_version"),
    // Explainability: FINAL section 10 requires the components, not a number.
    scoreBreakdown: jsonb("score_breakdown"),

    confidence: signalConfidenceEnum("confidence").notNull().default("UNKNOWN"),

    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    lastResearchedAt: timestamp("last_researched_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),

    // No FK yet: agent runs are a later requirement, and a FK to a table that
    // does not exist is not a constraint, it is a guess.
    createdByAgentRunId: uuid("created_by_agent_run_id"),

    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    canonicalUq: uniqueIndex("opportunity_signals_canonical_key_uq").on(t.canonicalKey),
    statusIdx: index("opportunity_signals_status_idx").on(t.status),
    kindIdx: index("opportunity_signals_kind_idx").on(t.kind),
    discoveredIdx: index("opportunity_signals_discovered_idx").on(t.discoveredAt),
    sourceIdx: index("opportunity_signals_source_idx").on(t.sourceId),
    // A score, when present, is 0-100 (FINAL section 10).
    scoreRange: check(
      "opportunity_signals_score_range",
      sql`${t.overallScore} IS NULL OR (${t.overallScore} >= 0 AND ${t.overallScore} <= 100)`,
    ),
  }),
);

// ─── Opportunity routes ───────────────────────────────────────────
// Where a signal should go. One signal may have SEVERAL live routes at once --
// a good programme is often an affiliate project AND an article AND a video
// (FINAL section 4). That is why this is a table and not a column.
//
// A route is NOT an approval. `ACCEPTED` here means "this is worth pursuing
// down this engine", never "money may be spent" or "this may be published".
// Approvals are their own module with their own audit trail (FINAL section
// 14), and collapsing the two would make a routing decision look like
// authorisation.
export const routeTypeEnum = pgEnum("route_type", [
  "AFFILIATE_PROJECT",
  "CONTENT_OPPORTUNITY",
  "YOUTUBE_NICHE",
  "WATCHLIST",
  "NO_ACTION",
]);

export const routeStatusEnum = pgEnum("route_status", [
  "PROPOSED",
  "ACCEPTED",
  "REJECTED",
  "SUPERSEDED",
]);

export const opportunityRoutes = pgTable(
  "opportunity_routes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunitySignals.id, { onDelete: "cascade" }),

    routeType: routeTypeEnum("route_type").notNull(),
    // NULL until scored. Same reasoning as overall_score.
    fitScore: real("fit_score"),
    // Why this route was chosen. FINAL section 4 requires the reason to
    // survive alongside the decision.
    reason: text("reason"),

    status: routeStatusEnum("status").notNull().default("PROPOSED"),

    createdByRunId: uuid("created_by_run_id"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),

    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per (signal, route type): multiple engines yes, duplicates no.
    opportunityRouteUq: uniqueIndex("opportunity_routes_opportunity_route_uq").on(
      t.opportunityId,
      t.routeType,
    ),
    statusIdx: index("opportunity_routes_status_idx").on(t.status),
    typeIdx: index("opportunity_routes_type_idx").on(t.routeType),
    fitRange: check(
      "opportunity_routes_fit_score_range",
      sql`${t.fitScore} IS NULL OR (${t.fitScore} >= 0 AND ${t.fitScore} <= 100)`,
    ),
  }),
);

export type SourceRow = typeof sources.$inferSelect;
export type SourceItemRow = typeof sourceItems.$inferSelect;
export type OpportunitySignalRow = typeof opportunitySignals.$inferSelect;
export type OpportunityRouteRow = typeof opportunityRoutes.$inferSelect;
export type SignalStatus = (typeof signalStatusEnum.enumValues)[number];
export type RouteType = (typeof routeTypeEnum.enumValues)[number];
