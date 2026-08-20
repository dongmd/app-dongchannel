import {
  check,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { contentOpportunities } from "./opportunity-content";

// P2-R03 — the opportunity score, and only the opportunity score.
//
// ## Why this is a table and not two columns
//
// The score has to be **versioned and reproducible** (owner Q29.1). A column on
// `content_opportunities` holds one number and forgets how it was reached; when
// the weights change, the old ranking becomes unexplainable and there is no way
// to answer "why was this third last month". A row per computation keeps the
// config version, the inputs fingerprint and the full breakdown together.
//
// ## The three scores in this project, kept apart
//
//   opportunity_signals.confidence   how reliable is the OBSERVATION
//   opportunity_routes.fit_score     how well does a signal fit ONE DESTINATION
//   this table                       BUSINESS PRIORITISATION of an opportunity
//
// Only the third is "the opportunity score". A test asserts the other two
// tables carry no column that could be read as an alias for it.
//
// ## And what it is not
//
// **An internal score is not a public product rating.** P0-R08 suppressed
// reader-facing ratings and they do not return without a published rubric.
// Nothing here may reach a reader, a `dc_rating` field or schema markup.

export const contentOpportunityScores = pgTable(
  "content_opportunity_scores",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    contentOpportunityId: uuid("content_opportunity_id")
      .notNull()
      .references(() => contentOpportunities.id, { onDelete: "cascade" }),

    // Q29.1. The version that produced this number travels with it, so a score
    // computed under old weights is never silently compared with a new one.
    scoringConfigVersion: text("scoring_config_version").notNull(),

    // AC-03 / AC-09. A deterministic fingerprint of the inputs. Combined with
    // the unique index below, recomputing an unchanged opportunity under an
    // unchanged config is idempotent **in the database** rather than in a
    // caller's memory -- the second write simply has nowhere to go.
    inputsFingerprint: text("inputs_fingerprint").notNull(),

    // Raw runs [-20, 100]: the positive budget of 100 minus the two penalties.
    // Normalised is the linear mapping of that range onto 0-100.
    rawScore: real("raw_score").notNull(),
    normalisedScore: real("normalised_score").notNull(),

    // AC-13. The components, not just the number. FINAL §10 requires a score to
    // be explainable, and a total with no breakdown is an assertion.
    //
    // Each entry carries its dimension, weight, input, contribution, whether the
    // input was KNOWN, and -- for a penalty that bit -- the reason it did.
    breakdown: jsonb("breakdown").notNull(),

    // AC-16 read from the other side: how much of the opportunity was actually
    // assessed. A high score over three known dimensions is a different fact
    // from the same score over eleven, and the queue should be able to say so.
    knownDimensions: real("known_dimensions").notNull(),
    totalDimensions: real("total_dimensions").notNull(),

    // Provenance: the signals this assessment rested on, so a score traces back
    // through `content_opportunity_signals` to a source.
    evidenceSignalIds: jsonb("evidence_signal_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    computedBy: text("computed_by").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // AC-09. Idempotency as a constraint rather than a convention.
    idempotencyUq: uniqueIndex("content_opportunity_scores_idempotency_uq").on(
      t.contentOpportunityId,
      t.scoringConfigVersion,
      t.inputsFingerprint,
    ),
    opportunityIdx: index("content_opportunity_scores_opportunity_idx").on(t.contentOpportunityId),
    // The ranking read path.
    rankIdx: index("content_opportunity_scores_rank_idx").on(t.normalisedScore),
    versionIdx: index("content_opportunity_scores_version_idx").on(t.scoringConfigVersion),

    // AC-13. Bounds are explicit, not implied by whatever the code happened to
    // produce. A score outside them means the arithmetic changed without the
    // schema being told.
    normalisedRange: check(
      "content_opportunity_scores_normalised_range",
      sql`${t.normalisedScore} >= 0 AND ${t.normalisedScore} <= 100`,
    ),
    rawRange: check(
      "content_opportunity_scores_raw_range",
      sql`${t.rawScore} >= -20 AND ${t.rawScore} <= 100`,
    ),
    // AC-16. You cannot have assessed more dimensions than exist, and a score
    // over zero known dimensions is not a score.
    dimensionsSane: check(
      "content_opportunity_scores_dimensions_sane",
      sql`${t.knownDimensions} >= 0
          AND ${t.totalDimensions} > 0
          AND ${t.knownDimensions} <= ${t.totalDimensions}`,
    ),
    // A score with no author cannot be questioned.
    computedByRequired: check(
      "content_opportunity_scores_computed_by_required",
      sql`length(btrim(${t.computedBy})) > 0`,
    ),
  }),
);

export type ContentOpportunityScoreRow = typeof contentOpportunityScores.$inferSelect;
