import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * `P4-R09 AC-01` — where a publish's outcome is recorded.
 *
 * The shape is **not designed here.** `publish/idempotency-policy.ts` already
 * declared it as a type — `PublishRecord` (idempotency key, wp post id,
 * attempts, state) plus the `PUBLISH_STATES` vocabulary — and shipped with no
 * table behind it, which is why `P4-R09 AC-01`'s "the resulting WordPress post
 * id is stored" had nowhere to store anything. This table is that declaration
 * given a home; the rules live in `0038_p4r08_publish_wiring.sql`.
 *
 * `state` is a CHECK rather than a `pgEnum` deliberately: `resolveFailure()` in
 * `idempotency-policy.ts` is the authority on which state a failure produces,
 * and a database enum drifting from it would be a second vocabulary for one
 * fact — the "two classifiers that can disagree" defect `P4-R07 AC-06` names,
 * in schema form.
 */
export const articlePublishRecords = pgTable(
  "article_publish_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    /**
     * Built by `publishIdempotencyKey()` and by nothing else. Two call sites
     * concatenating the three components slightly differently is how
     * idempotency quietly stops working.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    articleId: text("article_id").notNull(),
    revisionId: text("revision_id").notNull(),
    destination: text("destination").notNull(),

    /** `AC-01`. NULL until a publish has actually succeeded — never `0`. */
    wpPostId: integer("wp_post_id"),

    /** What WordPress reported after the write, for `P4-R08 AC-08`'s baseline. */
    wpModifiedGmt: text("wp_modified_gmt"),

    /** The hash last PUBLISHED — `decideReplay()` compares against this. */
    publishedHash: text("published_hash"),

    state: text("state").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),

    /** Kind and code only. A WordPress message can quote the request, and the request carries the credential. */
    lastErrorKind: text("last_error_kind"),
    lastErrorCode: text("last_error_code"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** The idempotency guarantee itself. One key, one row. `G-51`. */
    keyUq: uniqueIndex("publish_records_key_uq").on(t.idempotencyKey),

    articleIdx: index("publish_records_article_idx").on(t.articleId, t.createdAt),

    /**
     * `P4-R09 AC-02` — target: zero duplicate publishes, in the only form this
     * database can enforce. Two SUCCEEDED records naming one post would mean
     * one post published under two idempotency keys.
     */
    wpPostUq: uniqueIndex("publish_records_wp_post_uq")
      .on(t.wpPostId)
      .where(sql`${t.wpPostId} IS NOT NULL`),

    stateValid: check(
      "publish_record_state_valid",
      sql`${t.state} IN ('PENDING','IN_FLIGHT','SUCCEEDED','FAILED_RETRYING','FAILED_REQUIRES_ATTENTION')`,
    ),

    attemptsNonNeg: check("publish_record_attempts_nonneg", sql`${t.attempts} >= 0`),

    /** A SUCCEEDED publish must name what it published, or `AC-01` is satisfiable by an empty row. */
    successHasPost: check(
      "publish_record_success_has_post",
      sql`${t.state} <> 'SUCCEEDED' OR (${t.wpPostId} IS NOT NULL AND ${t.publishedHash} IS NOT NULL)`,
    ),
  }),
);

export type ArticlePublishRecordRow = typeof articlePublishRecords.$inferSelect;
export type NewArticlePublishRecordRow = typeof articlePublishRecords.$inferInsert;
