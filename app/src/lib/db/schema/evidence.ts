import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sources } from "./opportunity";

// P1-R03 / M6 — evidence and claims (FINAL section 9).
//
// The separation is the point. A *claim* is an assertion about the world -- "this
// programme pays $80 CPA in the US". *Evidence* is a thing that was observed --
// a merchant terms page captured on a date. They are different objects with
// different lifetimes: evidence goes stale, claims get contradicted, and the
// same piece of evidence can support one claim while contradicting another.
//
// Storing a payout as a column on a programme cannot express "the merchant page
// says $80, the network dashboard says $60, and nobody has resolved it yet".
// This can, and FINAL section 9 requires it for exactly the fields that get an
// affiliate account closed: payout, PPC, brand bidding, direct linking, GEO and
// cookie duration.

// ─── Evidence ─────────────────────────────────────────────────────
export const evidenceStatusEnum = pgEnum("evidence_status", [
  "ACTIVE",
  "SUPERSEDED",
  "RETRACTED",
  "EXPIRED",
]);

export const evidenceConfidenceEnum = pgEnum("evidence_confidence", [
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
]);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // Polymorphic by design: evidence attaches to programmes, GEOs, signals,
    // projects and things not built yet. A real FK would need one nullable
    // column per target and a new migration for each, which is a worse trade
    // than an unenforced pair -- so the pair is indexed and always written
    // together.
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),

    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    sourceUrl: text("source_url"),
    // A pointer within the source: an API field path, a page anchor.
    sourceRef: text("source_ref"),
    publisher: text("publisher"),
    title: text("title"),
    // The words actually observed. Without this, "verified" means trusting
    // whoever ran the agent.
    excerpt: text("excerpt"),
    contentHash: text("content_hash"),

    // When it was observed, and when it should stop being trusted. NULL
    // fresh_until means "no expiry known", never "fresh forever".
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    freshUntil: timestamp("fresh_until", { withTimezone: true }),

    confidence: evidenceConfidenceEnum("confidence").notNull().default("UNKNOWN"),
    status: evidenceStatusEnum("status").notNull().default("ACTIVE"),

    agentRunId: uuid("agent_run_id"),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index("evidence_entity_idx").on(t.entityType, t.entityId),
    statusIdx: index("evidence_status_idx").on(t.status),
    freshIdx: index("evidence_fresh_until_idx").on(t.freshUntil),
    sourceIdx: index("evidence_source_idx").on(t.sourceId),
    freshAfterCapture: check(
      "evidence_fresh_after_capture",
      sql`${t.freshUntil} IS NULL OR ${t.freshUntil} > ${t.capturedAt}`,
    ),
  }),
);

// ─── Claims ───────────────────────────────────────────────────────
// Deliberately NOT unique on (entity, claim_key).
//
// FINAL section 6 requires conflicting candidates to coexist with a status
// rather than one overwriting the other. If this were unique, the second
// source to report a payout would silently replace the first, and the fact
// that two sources disagree -- which is the single most useful signal that a
// number should not be trusted -- would be destroyed on write.
// ─── Visibility classification (P1-R04 / G-59) ────────────────────
// Two axes, because one is not enough. An earlier draft treated all affiliate
// data as uniformly private, which is wrong in both directions: it forbids
// citing a merchant's own published commission rate, while giving no explicit
// protection to a negotiated one.
//
//   source_access  where the fact came from  → how sensitive it inherently is
//   visibility     where it may be shown     → the decision made about it
export const claimVisibilityEnum = pgEnum("claim_visibility", [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
]);

export const claimSourceAccessEnum = pgEnum("claim_source_access", [
  "PUBLIC_WEB",
  "AUTHENTICATED",
  "FIRST_PARTY",
]);

export const claimVerificationStatusEnum = pgEnum("claim_verification_status", [
  "UNVERIFIED",
  "VERIFIED",
  "CONTRADICTED",
  "SUPERSEDED",
  "EXPIRED",
  "UNKNOWN",
]);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),

    // What is being asserted about, e.g. "payout_value", "ppc_allowed".
    claimKey: text("claim_key").notNull(),
    // Human-readable form.
    claimText: text("claim_text").notNull(),
    // Machine-comparable form, so two candidates can be compared without
    // parsing prose.
    normalizedValue: jsonb("normalized_value"),

    // UNVERIFIED is the default, and UNKNOWN is a distinct, deliberate state:
    // "nobody has checked" is not the same as "checked and could not tell",
    // and neither is the same as false. FINAL section 9 is explicit that
    // unknown must survive as unknown.
    verificationStatus: claimVerificationStatusEnum("verification_status")
      .notNull()
      .default("UNVERIFIED"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    // Defaults are the most restrictive value on each axis. Forgetting to
    // classify a claim must fail closed -- an unclassified negotiated rate
    // defaulting to PUBLIC is the failure this whole requirement exists to
    // prevent.
    sourceAccess: claimSourceAccessEnum("source_access").notNull().default("FIRST_PARTY"),
    visibility: claimVisibilityEnum("visibility").notNull().default("CONFIDENTIAL"),

    // An owner may promote a claim above what its source_access implies. No
    // agent may: the override has to name a human and a time, and the check
    // constraint below refuses the promotion without one.
    visibilityOverrideBy: text("visibility_override_by"),
    visibilityOverrideAt: timestamp("visibility_override_at", { withTimezone: true }),
    visibilityOverrideReason: text("visibility_override_reason"),

    agentRunId: uuid("agent_run_id"),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityKeyIdx: index("claims_entity_key_idx").on(t.entityType, t.entityId, t.claimKey),
    visibilityIdx: index("claims_visibility_idx").on(t.visibility),
    statusIdx: index("claims_verification_status_idx").on(t.verificationStatus),
    expiresIdx: index("claims_expires_idx").on(t.expiresAt),
    // A claim marked VERIFIED must say when. Otherwise "verified" is a word
    // with no accountability behind it.
    verifiedNeedsDate: check(
      "claims_verified_needs_date",
      sql`${t.verificationStatus} <> 'VERIFIED' OR ${t.verifiedAt} IS NOT NULL`,
    ),
    // The rule that matters. A fact obtained from a logged-in dashboard or a
    // private negotiation cannot become PUBLIC unless a named owner said so.
    // Enforced by the database, so no code path -- agent, API or console --
    // can skip it.
    publicNeedsOpenSourceOrOverride: check(
      "claims_public_requires_open_source_or_override",
      sql`${t.visibility} <> 'PUBLIC'
          OR ${t.sourceAccess} = 'PUBLIC_WEB'
          OR ${t.visibilityOverrideBy} IS NOT NULL`,
    ),
    overrideNeedsDate: check(
      "claims_override_needs_date",
      sql`${t.visibilityOverrideBy} IS NULL OR ${t.visibilityOverrideAt} IS NOT NULL`,
    ),
  }),
);

// ─── Claim ↔ evidence ─────────────────────────────────────────────
// Many-to-many, and the link carries its own meaning. One captured page can
// support a payout claim and contradict a PPC claim at the same time, so the
// relationship -- not the evidence -- is what says which.
export const claimSupportTypeEnum = pgEnum("claim_support_type", [
  "SUPPORTS",
  "CONTRADICTS",
  "CONTEXT",
]);

export const claimEvidence = pgTable(
  "claim_evidence",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),

    supportType: claimSupportTypeEnum("support_type").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One verdict per (claim, evidence) pair. The same page cannot both
    // support and contradict the same claim.
    pairUq: uniqueIndex("claim_evidence_pair_uq").on(t.claimId, t.evidenceId),
    claimIdx: index("claim_evidence_claim_idx").on(t.claimId),
    evidenceIdx: index("claim_evidence_evidence_idx").on(t.evidenceId),
  }),
);

export type EvidenceRow = typeof evidence.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type ClaimEvidenceRow = typeof claimEvidence.$inferSelect;
export type ClaimVerificationStatus = (typeof claimVerificationStatusEnum.enumValues)[number];
