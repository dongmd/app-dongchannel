import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// P2-R05 — content modes as a first-class field, not a tag.
//
// The decisions live in `lib/content/content-mode-policy.ts`, which imports
// nothing and knows no database. This file is only the storage: the closed
// enums, the configuration rows that override the defaults, and the per-article
// assignment. Keeping the two apart is what lets the policy be tested without
// a database at all (AC-09).

// ─── The closed enums ─────────────────────────────────────────────
// AC-01. These mirror `CONTENT_MODES`, `QA_DEPTHS` and `EVIDENCE_LEVELS` in the
// policy module exactly. The duplication is deliberate and it is checked: a
// unit test asserts the two lists agree, because a sixth mode added on one side
// only would otherwise be rejected by Postgres at 3am rather than by CI.
export const contentModeEnum = pgEnum("content_mode", [
  "COMMERCIAL",
  "EVERGREEN",
  "NEWS",
  "TREND",
  "UPDATE",
]);

export const qaDepthEnum = pgEnum("qa_depth", ["FULL", "STANDARD", "EXPEDITED"]);

export const evidenceLevelEnum = pgEnum("evidence_level", ["E0", "E1", "E2", "E3", "E4"]);

// UNKNOWN is a real state, not a null. "Nobody has ever verified this" and
// "this was verified and has since expired" call for different work, and a
// nullable boolean would collapse them.
export const contentRefreshStateEnum = pgEnum("content_refresh_state", [
  "FRESH",
  "REFRESH_REQUIRED",
  "UNKNOWN",
]);

// ─── Configuration (AC-05) ────────────────────────────────────────
// One optional row per mode. **An empty table means "use the defaults"** —
// there is no seed step, and a fresh database behaves exactly like a configured
// one. A row overrides only the columns it fills in.
//
// The evidence floor is deliberately NOT configurable here. `min_evidence_level`
// may be raised by a row; the policy module clamps any attempt to lower it past
// EVIDENCE_FLOOR, so this table cannot be used to reintroduce unchecked claims
// (AC-10). That is enforced in code rather than by a CHECK because the floor is
// a product rule that may rise, and a constraint would have to be migrated to
// follow it.
export const contentModePolicies = pgTable(
  "content_mode_policies",
  {
    mode: contentModeEnum("mode").primaryKey(),

    ttlDays: integer("ttl_days"),
    qaDepth: qaDepthEnum("qa_depth"),
    minEvidenceLevel: evidenceLevelEnum("min_evidence_level"),
    slaHours: integer("sla_hours"),

    // Who changed it and why. A TTL that quietly tripled is otherwise
    // indistinguishable from content that stopped going stale.
    updatedBy: text("updated_by").notNull(),
    reason: text("reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // A zero or negative TTL marks everything permanently overdue; the policy
    // module already falls back on one, but there is no reason to let it be
    // written in the first place.
    ttlPositive: check(
      "content_mode_policies_ttl_positive",
      sql`${t.ttlDays} IS NULL OR ${t.ttlDays} > 0`,
    ),
    slaPositive: check(
      "content_mode_policies_sla_positive",
      sql`${t.slaHours} IS NULL OR ${t.slaHours} > 0`,
    ),
  }),
);

// ─── Per-article assignment ───────────────────────────────────────
// AC-02: mode is required, and there is no default.
//
// `content_mode` is NOT NULL with **no `.default()`**. That is the whole point:
// an insert that forgets the mode fails loudly instead of quietly becoming
// COMMERCIAL. `mode_set_by` is NOT NULL for the same reason — a mode nobody
// chose is a mode nobody owns.
//
// Keyed on the WordPress post id rather than an `articles` FK because the app
// still does not own article prose (see `wordpress.ts`). This table is the
// app's editorial classification of a post; it is emphatically not an article
// state machine and not a second copy of the sync state.
export const articleContentModes = pgTable(
  "article_content_modes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    wpPostId: integer("wp_post_id").notNull(),

    // No default. See above.
    contentMode: contentModeEnum("content_mode").notNull(),
    modeSetAt: timestamp("mode_set_at", { withTimezone: true }).notNull().defaultNow(),
    modeSetBy: text("mode_set_by").notNull(),
    modeReason: text("mode_reason"),

    // ---- The inputs to freshness. Only inputs are stored.
    //
    // TTL and the due date are NOT columns. They are derived by
    // `deriveModeState()` from (mode, anchor), which is a stronger guarantee
    // than re-deriving on change: there is no stored TTL that could be left
    // behind when the mode changes (AC-07).
    //
    // NULL anchor means "never verified" and derives UNKNOWN — never FRESH.
    freshnessAnchorAt: timestamp("freshness_anchor_at", { withTimezone: true }),

    // ---- A projection, not an authority.
    //
    // The refresh worker writes these so the queue is queryable in SQL. The
    // authority is always the policy module. `policy_version_at_derivation`
    // exists so a stale projection is detectable rather than trusted: when it
    // no longer matches MODE_POLICY_VERSION the row must be re-derived, and
    // until it is, the projection is treated as UNKNOWN.
    //
    // This is the same discipline as `hash_contract_version` in P1-R06 — a
    // comparison between two values produced under different rules is not a
    // comparison, it is a coincidence.
    refreshState: contentRefreshStateEnum("refresh_state").notNull().default("UNKNOWN"),
    refreshStateDerivedAt: timestamp("refresh_state_derived_at", { withTimezone: true }),
    policyVersionAtDerivation: text("policy_version_at_derivation"),

    // ---- SLA inputs (AC-06). Both nullable: not every post was commissioned
    // through the pipeline, and an unpublished one has no publication time.
    commissionedAt: timestamp("commissioned_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One editorial mode per post. Two rows would mean two answers, and the
    // refresh worker would act on whichever it read first.
    wpPostUq: uniqueIndex("article_content_modes_wp_post_uq").on(t.wpPostId),
    modeIdx: index("article_content_modes_mode_idx").on(t.contentMode),
    // The refresh queue is read by this index.
    refreshIdx: index("article_content_modes_refresh_idx").on(t.refreshState),
    anchorIdx: index("article_content_modes_anchor_idx").on(t.freshnessAnchorAt),
  }),
);

export type ContentModePolicyRow = typeof contentModePolicies.$inferSelect;
export type ArticleContentModeRow = typeof articleContentModes.$inferSelect;
