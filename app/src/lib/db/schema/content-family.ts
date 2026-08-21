import { check, index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { contentModeEnum, evidenceLevelEnum } from "./content";

// P2-R08 — content families as CONFIGURATION.
//
// AC-02: changing which mode a family maps to must need no deploy. Same pattern
// as `content_mode_policies`: an EMPTY TABLE means "use the defaults", so a
// fresh database and a configured one behave identically and there is no seed
// step to forget.
//
// Note what is NOT here: no `ttl_days`, no `sla_hours`, no `qa_depth`. A family
// maps to a MODE, and P2-R05's mode policy answers all three. Two sources of
// truth for "how long until this is stale" is the drift this project has spent
// requirements removing.

export const contentFamilyEnum = pgEnum("content_family", [
  "dc_review",
  "dc_bestpicks",
  "dc_comparison",
  "dc_workflow",
  "dc_deal",
]);

export const contentFamilyPolicies = pgTable(
  "content_family_policies",
  {
    family: contentFamilyEnum("family").primaryKey(),

    // The mapping AC-01 requires to be explicit: NOT NULL, no default.
    //
    // The first draft made this nullable, reasoning that an override row might
    // want to change only the evidence level. **P2-R05's schema-wide rule
    // caught it** -- any table carrying the content-mode enum must require it --
    // and the rule is right. A row here exists to STATE the mapping; wanting to
    // change one field is not a reason to leave the mapping ambiguous, and a
    // carve-out would be a hole the next table could hide in.
    contentMode: contentModeEnum("content_mode").notNull(),
    // May be RAISED above the mode's floor. Lowering below EVIDENCE_FLOOR is
    // clamped in the policy module -- the one setting configuration must not
    // reach.
    minEvidenceLevel: evidenceLevelEnum("min_evidence_level"),

    updatedBy: text("updated_by").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modeIdx: index("content_family_policies_mode_idx").on(t.contentMode),
    updatedByRequired: check(
      "content_family_policies_updated_by_required",
      sql`length(btrim(${t.updatedBy})) > 0`,
    ),
  }),
);

export type ContentFamilyPolicyRow = typeof contentFamilyPolicies.$inferSelect;
