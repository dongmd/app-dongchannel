import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * P3-R04 — approval records, and the verification state they must never touch.
 *
 * **Two tables, not two column groups on one row** (`AC-11`). A shared row is
 * one `UPDATE` away from being written together, and "approving also marked it
 * verified" is exactly the blur `P0-R01` recorded the consequences of.
 *
 * The asymmetry between them is deliberate and load-bearing:
 *
 *   article_approvals     CONSENT — a historical fact. IMMUTABLE (migration
 *                         0029 refuses UPDATE, DELETE and TRUNCATE). A
 *                         withdrawal is a NEW ROW.
 *
 *   article_verification  KNOWLEDGE — a derived state. MUTABLE, because what is
 *                         known about an article's claims legitimately changes
 *                         as evidence arrives.
 */

export const articleApprovals = pgTable(
  "article_approvals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // AC-01 / AC-07 — exactly PROPOSED §7.1's fields, and ONE revision. There
    // is no "latest" to resolve at publish time.
    articleId: text("article_id").notNull(),
    revisionId: text("revision_id").notNull(),

    // AC-10 — the Telegram numeric id that passed P3-R01, from the verified
    // update. `bigint` because Telegram ids outgrew 32 bits years ago.
    approvedBy: bigint("approved_by", { mode: "number" }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),

    // AC-05 / AC-06 — over the approved revision's content, covering everything
    // the owner was shown, including what the P3-R07 preview rendered.
    payloadHash: text("payload_hash").notNull(),

    // P3-R03's opaque action id. Keys idempotency; never rendered.
    callbackNonce: text("callback_nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    // AC-08 — a withdrawal points at what it withdraws. The original is never
    // edited, because erasing it would erase the evidence consent was given.
    withdrawsId: uuid("withdraws_id"),
  },
  (t) => ({
    // Partial unique: one LIVE approval per (article, revision). Withdrawals
    // are excluded, so a withdraw-then-reapprove cycle is possible without
    // ever editing a row.
    articleRevisionUq: uniqueIndex("article_approvals_article_revision_uq")
      .on(t.articleId, t.revisionId)
      .where(sql`${t.withdrawsId} IS NULL`),
    articleIdx: index("article_approvals_article_idx").on(t.articleId, t.approvedAt),
    expiryAfterApproval: check(
      "article_approvals_expiry_after_approval",
      sql`${t.expiresAt} > ${t.approvedAt}`,
    ),
    hashShape: check(
      "article_approvals_hash_shape",
      sql`char_length(${t.payloadHash}) = 64 AND ${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    noSelfWithdraw: check(
      "article_approvals_no_self_withdraw",
      sql`${t.withdrawsId} IS NULL OR ${t.withdrawsId} <> ${t.id}`,
    ),
  }),
);

export const articleVerification = pgTable(
  "article_verification",
  {
    articleId: text("article_id").primaryKey(),

    // AC-02 — derived from evidence and QA. No human button sets any of this,
    // and a guard in migration 0029 refuses any write made inside a Telegram
    // action (AC-03).
    evidenceLevel: text("evidence_level").notNull().default("E0"),
    qaResult: text("qa_result"),
    claimsChecked: integer("claims_checked").notNull().default(0),
    unsupportedClaims: integer("unsupported_claims").notNull().default(0),
    conflictingClaims: integer("conflicting_claims").notNull().default(0),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    evidenceLevelValid: check(
      "article_verification_evidence_level",
      sql`${t.evidenceLevel} IN ('E0','E1','E2','E3','E4')`,
    ),
    countsNonNeg: check(
      "article_verification_counts_nonneg",
      sql`${t.claimsChecked} >= 0 AND ${t.unsupportedClaims} >= 0 AND ${t.conflictingClaims} >= 0`,
    ),
  }),
);

export type ArticleApprovalRow = typeof articleApprovals.$inferSelect;
export type NewArticleApprovalRow = typeof articleApprovals.$inferInsert;
export type ArticleVerificationRow = typeof articleVerification.$inferSelect;
