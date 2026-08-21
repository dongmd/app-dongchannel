import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { contentModeEnum } from "./content";
import { opportunitySignals } from "./opportunity";
import { profiles } from "./profiles";

// P2-R01 — ContentOpportunity, the central editorial entity.
//
// ## Why this is a new table rather than a change to opportunity_signals
//
// `opportunity_signals` (P1-R03/M5) treats a signal AS the opportunity: it
// carries `overall_score`, a nine-state editorial lifecycle, and
// `opportunity_routes.opportunity_id` points at it. One signal was one decision
// unit, by construction, and "one signal produces three opportunities" was
// unrepresentable.
//
// P2 separates the layers because that separation is what stops discovery
// collapsing into a content generator (PROPOSED §2):
//
//   OpportunitySignal    an atomic, evidence-bearing observation, with
//                        provenance and no judgement
//   ContentOpportunity   a DERIVED candidate, synthesised from one or more
//                        signals, with its own lifecycle and its own score
//
// The four existing tables held **zero rows in production** when this was
// written, so nothing migrates and nothing is at risk. The migration is still
// additive-only: no column is dropped or renamed, per the standing V1 rule.
//
// The judgement columns on `opportunity_signals` (`overall_score`,
// `scoring_version`, `score_breakdown`) are now vestigial. They are left in
// place and **narrowed by P2-R02**, which owns the signal layer; this file does
// not touch them.

export const opportunityOriginTypeEnum = pgEnum("opportunity_origin_type", [
  "AFFILIATE_OFFER",
  "KEYWORD",
  "TREND",
  "PRODUCT_TOOL",
  "COMPETITOR_MOVE",
  "CONTENT_GAP",
  "PERFORMANCE_EXPANSION",
  "OWNER_SEED",
]);

// AC-04. REJECTED and DROPPED are outcomes, not absences. A discovery run that
// considered something and declined must leave a row, or the system cannot tell
// "we looked and said no" from "we never looked" -- and will rediscover it
// forever.
export const contentOpportunityStatusEnum = pgEnum("content_opportunity_status", [
  "PROPOSED",
  "RESEARCHING",
  "READY",
  "IN_PRODUCTION",
  "PUBLISHED",
  "REJECTED",
  "DROPPED",
]);

export const contentOpportunities = pgTable(
  "content_opportunities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // ---- Origin. AC-01, AC-02, AC-03.
    //
    // `origin_type` is NOT NULL and `origin_id` is nullable. That pairing is the
    // AC-03 asymmetry made unrepresentable rather than merely refused: an id
    // whose type nobody recorded cannot be stored, because nothing could then
    // interpret it. A null id is a normal, queryable state -- an owner idea
    // typed into Telegram points at no source object.
    originType: opportunityOriginTypeEnum("origin_type").notNull(),
    originId: text("origin_id"),

    // ---- AC-05. Required, and no default: an insert that forgets the mode
    // fails loudly rather than quietly becoming COMMERCIAL.
    contentMode: contentModeEnum("content_mode").notNull(),

    // P2-R07 identity. Two opportunities are the same opportunity when they
    // share an origin AND an angle -- so a rerun is idempotent, while one
    // affiliate programme can still support a review, a comparison and a
    // migration guide as three separate records.
    //
    // Nullable because an OWNER_SEED typed into Telegram has no derived key
    // yet; the unique index treats NULLs as distinct, which is correct here --
    // two owner ideas are two ideas.
    opportunityKey: text("opportunity_key"),

    title: text("title").notNull(),
    // Why this is worth doing. Prose about the DECISION, not the article.
    rationale: text("rationale"),

    // ---- AC-12. Questions, never answers.
    //
    // A list of claims that WOULD need checking if this is produced. There is
    // deliberately nowhere here to record what the answer turned out to be:
    // checked claims live in `claims` (P1-R04) with a verification status and a
    // source. P0-R01 happened because "costs $29/month" was written down as
    // though checking had occurred.
    claimsToCheck: jsonb("claims_to_check").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    status: contentOpportunityStatusEnum("status").notNull().default("PROPOSED"),

    // ---- AC-04. Closing without content requires a reason, enforced by the
    // check constraint below rather than by whoever remembered.
    closedReason: text("closed_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    // ---- AC-10 / BR01. `profiles` is keyed on a human-readable slug, not a
    // uuid, so this follows `tasks.profile_slug` rather than inventing a second
    // convention. Nullable: an opportunity may predate its assignment to an
    // engine, and forcing a guess would be worse than recording none.
    profileSlug: text("profile_slug").references(() => profiles.slug),

    // No FK: agent runs are a later requirement, and a FK to a table that does
    // not exist is a guess, not a constraint. Same choice as opportunity.ts.
    createdByAgentRunId: uuid("created_by_agent_run_id"),

    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotency as a constraint. Without it, re-running Direction B inserts a
    // second row for work already queued.
    keyUq: uniqueIndex("content_opportunities_key_uq").on(t.opportunityKey),
    statusIdx: index("content_opportunities_status_idx").on(t.status),
    modeIdx: index("content_opportunities_mode_idx").on(t.contentMode),
    originIdx: index("content_opportunities_origin_idx").on(t.originType),
    profileIdx: index("content_opportunities_profile_idx").on(t.profileSlug),

    // AC-04, at the boundary that cannot be bypassed. A rejected or dropped
    // opportunity without a reason is the same as no record at all.
    closedNeedsReason: check(
      "content_opportunities_closed_needs_reason",
      sql`${t.status} NOT IN ('REJECTED','DROPPED')
          OR (${t.closedReason} IS NOT NULL AND length(btrim(${t.closedReason})) > 0)`,
    ),
    // A terminal status and a null closed_at describe an event with no time.
    closedNeedsTime: check(
      "content_opportunities_closed_needs_time",
      sql`${t.status} NOT IN ('PUBLISHED','REJECTED','DROPPED') OR ${t.closedAt} IS NOT NULL`,
    ),
  }),
);

// ─── Derivation: opportunity ← signals ────────────────────────────
//
// A table, not a column, because the cardinality runs both ways. Several
// signals about the same tool collapse into one opportunity; one broad trend
// signal spawns several. A `signal_id` column on the opportunity would permit
// only the first, and a `content_opportunity_id` on the signal only the second.
//
// Zero rows is also legal, and is the OWNER_SEED case: a person had an idea.
// Every other origin claims something was observed, and the application refuses
// an observation with no signal behind it (`checkDerivation`).
export const contentOpportunitySignals = pgTable(
  "content_opportunity_signals",
  {
    contentOpportunityId: uuid("content_opportunity_id")
      .notNull()
      .references(() => contentOpportunities.id, { onDelete: "cascade" }),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => opportunitySignals.id, { onDelete: "cascade" }),

    // Why this signal supports this opportunity. Kept because six months later
    // "these three rows are linked" is not an explanation.
    contribution: text("contribution"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.contentOpportunityId, t.signalId] }),
    signalIdx: index("content_opportunity_signals_signal_idx").on(t.signalId),
  }),
);

export type ContentOpportunityRow = typeof contentOpportunities.$inferSelect;
export type ContentOpportunitySignalRow = typeof contentOpportunitySignals.$inferSelect;
