import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// P2-R06 — the topic allowlist, as CONFIGURATION.
//
// AC-01: changing the allowlist must need no deploy. That is why it is a table
// and not the constant in `trend-radar-policy.ts` — the constant is the SEED a
// fresh database starts from, and this is where the list actually lives.
//
// An empty table is not "allow everything". The policy fails closed
// (AC-04): a wiped table or a failed config load turns into an obvious pile of
// rejections rather than into a radar that publishes about anything.

export const trendAllowlist = pgTable(
  "trend_allowlist",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // Matched case-insensitively against a normalised subject. Stored
    // lower-cased so two entries cannot differ only by capitalisation.
    term: text("term").notNull(),

    // Retiring a topic must not lose the record that it was once in scope, so
    // entries are disabled rather than deleted. A disabled entry never matches.
    enabled: boolean("enabled").notNull().default(true),

    // Why this topic is in scope. Six months later, "seo" on its own does not
    // explain whether it means technical SEO or the SEO-tools market.
    rationale: text("rationale"),

    addedBy: text("added_by").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    termUq: uniqueIndex("trend_allowlist_term_uq").on(t.term),
    enabledIdx: index("trend_allowlist_enabled_idx").on(t.enabled),

    // Lower-case, non-blank. Enforced here because the policy normalises on
    // read, and a stored `SEO ` that only matches after normalisation is a
    // second representation of the same term.
    termShape: check(
      "trend_allowlist_term_shape",
      sql`${t.term} = lower(btrim(${t.term})) AND length(${t.term}) > 0`,
    ),
    // An entry nobody claims is an entry nobody can question.
    addedByRequired: check(
      "trend_allowlist_added_by_required",
      sql`length(btrim(${t.addedBy})) > 0`,
    ),
  }),
);

export type TrendAllowlistRow = typeof trendAllowlist.$inferSelect;
