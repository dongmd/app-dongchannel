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

import { opportunitySignals } from "./opportunity";

// P2-R07 — the AffiliateProject **candidate**.
//
// A candidate is a proposal awaiting owner triage. It is NOT an
// `AffiliateProject`, and this is a different table on purpose: sharing one
// would make "is this real yet?" a column value that some query somewhere
// forgets to filter on.
//
// Nothing in this file or its policy module can create a live project, apply to
// a network, touch Google Ads, or publish anything. There is no foreign key to
// `affiliate_projects` either -- promotion is an owner action, and a link that
// existed before the decision would invite code to follow it.

export const candidateStatusEnum = pgEnum("affiliate_candidate_status", [
  "PROPOSED", //  discovered, untriaged
  "TRIAGED", //   a human has looked
  "ACCEPTED", //  the owner wants it. Still not a project -- that is a separate act
  "REJECTED", //  declined, with a reason
]);

// UNKNOWN is not NO. "We have not checked whether PPC is allowed" and "PPC is
// forbidden" lead to different decisions, and collapsing them means inventing
// either a prohibition or a permission.
export const tristateEnum = pgEnum("verified_tristate", ["YES", "NO", "UNKNOWN"]);

export const affiliateProjectCandidates = pgTable(
  "affiliate_project_candidates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // Idempotency: keyed on the VENDOR, not on the run that found it. Re-running
    // research must not produce a second candidate.
    candidateKey: text("candidate_key").notNull(),
    vendorName: text("vendor_name").notNull(),

    // The central claim. A candidate whose existence claim is UNKNOWN is a
    // hunch, not a discovery, and the policy refuses it.
    programmeExists: tristateEnum("programme_exists").notNull().default("UNKNOWN"),
    programmeObservedUrl: text("programme_observed_url"),
    programmeObservedAt: timestamp("programme_observed_at", { withTimezone: true }),

    // ---- Commercial facts. Every one defaults to UNKNOWN, and every one keeps
    // its own source. This is the surface where invented affiliate terms would
    // enter the system, so nothing here may be inferred.
    //
    // Shape per fact: { value, state, observedUrl, observedAt }. Stored as jsonb
    // rather than forty columns because the set will grow, and because a fact
    // and its provenance must move together -- separate columns drift apart.
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),

    status: candidateStatusEnum("status").notNull().default("PROPOSED"),
    // A rejection nobody can read is not a decision.
    statusReason: text("status_reason"),
    triagedBy: text("triaged_by"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // UNIQUE, not merely indexed. Idempotency is the whole point of keying on
    // the vendor: an index that permits duplicates would let a second research
    // run create a second candidate for the same vendor, which is exactly what
    // the key exists to prevent. (The same slip was caught by a mutation check
    // on P2-R03's score table; it is easy to type and invisible afterwards.)
    keyUq: uniqueIndex("affiliate_project_candidates_key_uq").on(t.candidateKey),
    statusIdx: index("affiliate_project_candidates_status_idx").on(t.status),

    // A claimed programme must say where it was seen. This is the fabrication
    // guard at the storage boundary, not only in the policy.
    existenceNeedsSource: check(
      "affiliate_project_candidates_existence_needs_source",
      sql`${t.programmeExists} = 'UNKNOWN'
          OR (${t.programmeObservedUrl} IS NOT NULL
              AND length(btrim(${t.programmeObservedUrl})) > 0
              AND ${t.programmeObservedAt} IS NOT NULL)`,
    ),
    // Triage is a human act, and a triaged row with nobody's name on it cannot
    // be questioned.
    triageNeedsActor: check(
      "affiliate_project_candidates_triage_needs_actor",
      sql`${t.status} IN ('PROPOSED')
          OR (${t.triagedBy} IS NOT NULL AND length(btrim(${t.triagedBy})) > 0
              AND ${t.triagedAt} IS NOT NULL)`,
    ),
    rejectionNeedsReason: check(
      "affiliate_project_candidates_rejection_needs_reason",
      sql`${t.status} <> 'REJECTED'
          OR (${t.statusReason} IS NOT NULL AND length(btrim(${t.statusReason})) > 0)`,
    ),
  }),
);

// ─── Evidence: many signals may support one candidate ─────────────
//
// A table, not a column. Three separate observations of the same vendor -- a
// footer link, a network listing, a pricing page -- all support one candidate,
// and a `signal_id` column would keep the first and lose the other two along
// with the reason each mattered.
export const candidateEvidence = pgTable(
  "affiliate_candidate_evidence",
  {
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => affiliateProjectCandidates.id, { onDelete: "cascade" }),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => opportunitySignals.id, { onDelete: "cascade" }),

    // What this particular signal contributed. Six months later, "these rows
    // are linked" is not an explanation.
    contribution: text("contribution"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.candidateId, t.signalId] }),
    signalIdx: index("affiliate_candidate_evidence_signal_idx").on(t.signalId),
  }),
);

export type AffiliateProjectCandidateRow = typeof affiliateProjectCandidates.$inferSelect;
export type CandidateEvidenceRow = typeof candidateEvidence.$inferSelect;
