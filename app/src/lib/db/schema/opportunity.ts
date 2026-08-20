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
  type AnyPgColumn,
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

// P2-R02. Four INTAKE states, not nine editorial ones.
//
// The states this replaces -- RESEARCHING, NEEDS_EVIDENCE, READY_FOR_DECISION,
// WATCHLIST, APPROVED, REJECTED, ARCHIVED -- are the lifecycle of a DECISION,
// and decisions now live on `content_opportunities` (P2-R01) and on routes.
// A signal is an observation: it was captured, it was routed, it turned out to
// duplicate another, or it could not be normalised. Nothing else happens to it.
//
// WATCHLIST in particular already exists as a ROUTE type, which is where a
// "keep an eye on this" decision belongs.
export const signalStatusEnum = pgEnum("signal_status", [
  "NEW", //        captured, not yet routed
  "ROUTED", //     routing decisions exist for it, including NO_ACTION
  "DUPLICATE", //  collapsed into another signal; duplicate_of_signal_id says which
  "DISCARDED", //  could not be normalised into the common shape
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
    // AC-07. Deterministic dedup key: the same programme found via Impact and
    // via search collapses to one signal. NOT NULL as of P2-R02 -- Postgres
    // treats NULLs as distinct, so a nullable unique key silently permits
    // unlimited duplicates, which is the opposite of what the index promises.
    canonicalKey: text("canonical_key").notNull(),

    kind: signalKindEnum("kind").notNull(),
    originMode: signalOriginModeEnum("origin_mode").notNull(),

    // ---- Provenance. AC-06: mandatory, but it takes two forms.
    //
    // A connector signal has a source. An owner seed typed into Telegram does
    // not -- it has a person. Requiring `source_id` outright would make owner
    // seeds unrepresentable; requiring nothing would let a signal exist with no
    // account of where it came from. The CHECK below requires ONE of the two,
    // so every signal can answer "who or what observed this".
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, {
      onDelete: "set null",
    }),
    ownerSeedText: text("owner_seed_text"),
    // The actor, when a person is the provenance. Owner directive, 2026-08-20:
    // an OWNER_SEED may skip the signal layer entirely, but never the record of
    // who seeded it and when.
    capturedBy: text("captured_by"),

    title: text("title").notNull(),
    summary: text("summary"),
    language: text("language"),
    targetGeos: text("target_geos").array(),

    status: signalStatusEnum("status").notNull().default("NEW"),

    // AC-07. Which signal this collapsed into. A duplicate is kept rather than
    // discarded, so the second sighting still counts as evidence that something
    // is being noticed repeatedly -- and so re-reading a feed is idempotent
    // rather than silently additive.
    duplicateOfSignalId: uuid("duplicate_of_signal_id").references(
      (): AnyPgColumn => opportunitySignals.id,
      { onDelete: "set null" },
    ),

    // ---- AC-10. THE SCORE IS GONE.
    //
    // `overall_score`, `scoring_version` and `score_breakdown` were removed in
    // P2-R02 (owner decision Q30). They were editorial judgement sitting on the
    // observation layer, which is precisely the collapse P2 exists to undo.
    // Scoring belongs to `content_opportunities`, and is P2-R03's to build.
    //
    // They were dropped rather than left read-only: the tables held zero rows,
    // no migration had reached production, and no code referenced them. Keeping
    // them would have been permanent debt protecting nothing.
    //
    // `confidence` STAYS, and the distinction is deliberate. It answers "how
    // reliable is this observation" -- an evidence property, inherited from the
    // source's trust tier. It does not answer "is this worth writing about",
    // which is the judgement AC-10 forbids on this layer.
    confidence: signalConfidenceEnum("confidence").notNull().default("UNKNOWN"),

    // AC-06's "captured-at". Kept as `discovered_at`: the column already means
    // exactly this -- the moment the observation entered the system -- and it is
    // NOT NULL, which is what the criterion requires. Renaming it would have
    // been cosmetic, and it would have made this migration ambiguous to
    // generate for no gain. The criterion is about the fact being mandatory,
    // not about the column's spelling.
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    // `last_researched_at` went with the scores. Research is something done to
    // an OPPORTUNITY. An observation is not researched, it is re-checked --
    // which is what `last_verified_at` records.
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
    dupIdx: index("opportunity_signals_duplicate_of_idx").on(t.duplicateOfSignalId),

    // AC-06. Provenance is mandatory in one of its two forms. A signal that can
    // name neither a source nor a person is an assertion, not an observation.
    provenanceRequired: check(
      "opportunity_signals_provenance_required",
      sql`${t.sourceId} IS NOT NULL
          OR (${t.capturedBy} IS NOT NULL AND length(btrim(${t.capturedBy})) > 0)`,
    ),
    // AC-07. A duplicate must say what it duplicates, or the dedup record is
    // just a discard with a friendlier name.
    duplicateNeedsTarget: check(
      "opportunity_signals_duplicate_needs_target",
      sql`${t.status} <> 'DUPLICATE' OR ${t.duplicateOfSignalId} IS NOT NULL`,
    ),
    // The other direction, added on owner instruction 2026-08-20. The pair is a
    // BICONDITIONAL: DUPLICATE implies a target, and a target implies DUPLICATE.
    // Only one half was enforced before, which left a real hole -- a signal
    // could point at another while claiming to be NEW, and the dedup sweep
    // would treat it as an independent observation while the pointer said
    // otherwise. Two records of the same fact that can disagree is one record
    // too many.
    duplicateOnlyWhenDuplicate: check(
      "opportunity_signals_duplicate_target_only_when_duplicate",
      sql`${t.duplicateOfSignalId} IS NULL OR ${t.status} = 'DUPLICATE'`,
    ),
    duplicateNotSelf: check(
      "opportunity_signals_duplicate_not_self",
      sql`${t.duplicateOfSignalId} IS NULL OR ${t.duplicateOfSignalId} <> ${t.id}`,
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
    // P2-R02: renamed from `opportunity_id`. The column always referenced
    // `opportunity_signals.id`; the NAME said opportunity, which was true only
    // while a signal was treated as an opportunity. It is not, and a column
    // whose name contradicts its foreign key is a trap for the next reader.
    signalId: uuid("signal_id")
      .notNull()
      .references(() => opportunitySignals.id, { onDelete: "cascade" }),

    // AC-02. When a CONTENT_OPPORTUNITY route is accepted, this names what it
    // actually produced. Nullable, because a route is a decision that something
    // is worth pursuing -- the opportunity may not exist yet, and for
    // NO_ACTION, WATCHLIST or AFFILIATE_PROJECT it never will.
    //
    // NO foreign key, deliberately: `content_opportunities` already imports
    // `opportunitySignals` from this file, so a FK the other way would make the
    // two schema modules circular. The CHECK below still refuses the states
    // that would be wrong, and the alternative -- moving one table into the
    // other's file -- would put the opportunity model somewhere nobody looks
    // for it. Same trade-off as `created_by_agent_run_id` above.
    contentOpportunityId: uuid("content_opportunity_id"),

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
    signalRouteUq: uniqueIndex("opportunity_routes_signal_route_uq").on(
      t.signalId,
      t.routeType,
    ),
    statusIdx: index("opportunity_routes_status_idx").on(t.status),
    typeIdx: index("opportunity_routes_type_idx").on(t.routeType),
    contentOppIdx: index("opportunity_routes_content_opportunity_idx").on(t.contentOpportunityId),

    // AC-03. "Nothing" is a first-class outcome, and a first-class outcome with
    // no reason is indistinguishable from an oversight. A radar that rejects
    // everything and one that rejects nothing must be told apart from the
    // record, and that is only possible if the record says why.
    declineNeedsReason: check(
      "opportunity_routes_decline_needs_reason",
      sql`(${t.routeType} <> 'NO_ACTION' AND ${t.status} <> 'REJECTED')
          OR (${t.reason} IS NOT NULL AND length(btrim(${t.reason})) > 0)`,
    ),
    // A route that claims to have produced an opportunity must be the kind of
    // route that can, and must have been accepted.
    contentOppOnlyWhenAccepted: check(
      "opportunity_routes_content_opportunity_valid",
      sql`${t.contentOpportunityId} IS NULL
          OR (${t.routeType} = 'CONTENT_OPPORTUNITY' AND ${t.status} = 'ACCEPTED')`,
    ),
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
