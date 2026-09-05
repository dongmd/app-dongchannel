import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { articleApprovals } from "./approval";

/**
 * P3-R05 — the pending action record.
 *
 * The **only** thing step 1 of Approve → Confirm writes. Everything else — the
 * approval, the revision lock, the queue entry — happens after the confirm
 * press, so cancelling costs nothing and leaves nothing to clean up.
 *
 * It holds the revision id and the payload hash rather than pointing at "the
 * article", because consent given against a moving target is exactly what
 * `AC-06` catches: a row naming only the article could not tell that the
 * article had been edited between the two presses.
 *
 * The constraints and triggers live in `0031_p3r05_two_step.sql`. This
 * declaration exists so the ORM and the type system know the table, not as the
 * source of its rules — a `CHECK` written only here would be a rule the database
 * does not enforce.
 */
export const telegramPendingActions = pgTable(
  "telegram_pending_actions",
  {
    /** `P3-R03`'s opaque action id. Step 2 presents this, never an article id. */
    id: text("id").primaryKey(),

    /** The numeric Telegram id the buttons were offered to. */
    issuedTo: bigint("issued_to", { mode: "number" }).notNull(),

    articleId: text("article_id").notNull(),

    /** One revision. Never "the latest" — see `AC-06`. */
    revisionId: text("revision_id").notNull(),

    /** Shown in the summary, so consent is given against where it will go. */
    destination: text("destination").notNull(),

    /** The hash of exactly what the summary showed. */
    payloadHash: text("payload_hash").notNull(),

    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * Set by the confirm press. Both outcomes are nullable timestamps rather
     * than one status column, so "when" is recorded as a side effect of "what"
     * — and a trigger makes whichever lands first final.
     */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => ({
    articleIdx: index("pending_actions_article_idx").on(t.articleId),

    idShape: check("pending_action_id_shape", sql`${t.id} ~ '^act_[0-9a-f]{32}$'`),

    singleOutcome: check(
      "pending_action_single_outcome",
      sql`${t.confirmedAt} IS NULL OR ${t.cancelledAt} IS NULL`,
    ),

    outcomeAfterIssue: check(
      "pending_action_outcome_after_issue",
      sql`(${t.confirmedAt} IS NULL OR ${t.confirmedAt} >= ${t.issuedAt})
      AND (${t.cancelledAt} IS NULL OR ${t.cancelledAt} >= ${t.issuedAt})`,
    ),

    expiryAfterIssue: check(
      "pending_action_expiry_after_issue",
      sql`${t.expiresAt} > ${t.issuedAt}`,
    ),
  }),
);

/**
 * P3-R05 AC-03 — the durable publish intent.
 *
 * The hand-off artefact between P3 and P4. `AC-08` says "P3 stops at the queue",
 * and the TDD heading says "P3 stops at enqueue" — both place the enqueue inside
 * P3 and the consumption in P4, so the dependency runs P4 → P3: the consumer
 * depends on the producer's artefact, not the reverse.
 *
 * The publisher treats a row here as **input**, never as authority. It re-checks
 * all three gates itself and does not trust P3's word.
 *
 * The rules live in `0032_p3r05_publish_intent.sql` — including the partial
 * unique index that is the "lock the revision" step, and the trigger that stops
 * a Telegram action marking an intent `CONSUMED`, because consumption is the
 * publisher's act.
 */
export const publishIntentStateEnum = pgEnum("publish_intent_state", [
  "OPEN",
  "CONSUMED",
  "CANCELLED",
]);

export const articlePublishIntents = pgTable(
  "article_publish_intents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    /** The consent this intent was created from. No intent without one. */
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => articleApprovals.id, { onDelete: "restrict" }),

    /**
     * Denormalised from the approval deliberately: the publisher must be able
     * to answer "which revision, which bytes" without trusting a join to still
     * say the same thing later. A trigger proves they match at insert.
     */
    articleId: text("article_id").notNull(),
    revisionId: text("revision_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    destination: text("destination").notNull(),

    state: publishIntentStateEnum("state").notNull().default("OPEN"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    /**
     * `P4-R08 AC-10` — the worker's compare-and-swap claim (migration `0038`).
     *
     * `decidePublish` reads the intent state from the SNAPSHOT its caller
     * passed in, not under a lock, so two workers reading the same OPEN intent
     * would both pass gate 1 and both call WordPress. Claiming is therefore a
     * conditional UPDATE, not a read — and this column is what it swaps on.
     *
     * A stale claim is reclaimable after ten minutes: a worker that crashed
     * mid-publish would otherwise hold the per-article lock forever.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => ({
    /** One approval, at most one intent: a replayed confirm cannot double-queue. */
    approvalUq: uniqueIndex("publish_intents_approval_uq").on(t.approvalId),

    /**
     * THE LOCK. At most one OPEN intent per article, so no other revision can
     * queue behind a pending publish. Partial, so resolving an intent releases
     * it — which is what makes it a lock rather than a permanent bar.
     */
    oneOpenPerArticle: uniqueIndex("publish_intents_one_open_per_article")
      .on(t.articleId)
      .where(sql`${t.state} = 'OPEN'`),

    resolutionConsistent: check(
      "publish_intent_resolution_consistent",
      sql`(${t.state} = 'OPEN' AND ${t.resolvedAt} IS NULL)
       OR (${t.state} <> 'OPEN' AND ${t.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * P3-R07 — preview links.
 *
 * A signed token alone cannot be revoked, and that is the whole difference
 * between a capability and a bearer credential. `AC-05` requires revocation
 * before expiry, individually and in bulk for an article, so there has to be
 * something to revoke.
 *
 * The row is **not** the authority. The signature is verified first, before this
 * table is consulted at all, so an unsigned guess cannot be used to probe which
 * ids exist. The rules — an immutable scope, one-way revocation, the TTL ceiling,
 * and the triggers that stop a preview render writing anything — live in
 * `0033_p3r07_preview_links.sql`.
 */
export const articlePreviewLinks = pgTable(
  "article_preview_links",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    /** `AC-02`. One article, one revision — signed into the token as well. */
    articleId: text("article_id").notNull(),
    revisionId: text("revision_id").notNull(),

    /** `AC-10`/`AC-11`. The hash of exactly what the link will show. */
    contentHash: text("content_hash").notNull(),

    /** `AC-13`. Which key signed it, so rotation is a stated consequence. */
    keyVersion: text("key_version").notNull(),

    issuedTo: bigint("issued_to", { mode: "number" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** `AC-05`. A timestamp, not a deletion: the log keeps its shape. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    articleIdx: index("preview_links_article_idx").on(t.articleId),
    scopeUq: uniqueIndex("preview_links_scope_uq").on(
      t.articleId,
      t.revisionId,
      t.contentHash,
      t.expiresAt,
    ),
    expiryAfterIssue: check("preview_link_expiry_after_issue", sql`${t.expiresAt} > ${t.issuedAt}`),
    ttlCapped: check(
      "preview_link_ttl_capped",
      sql`${t.expiresAt} <= ${t.issuedAt} + interval '1 hour'`,
    ),
    revocationAfterIssue: check(
      "preview_link_revocation_after_issue",
      sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.issuedAt}`,
    ),
    hashShape: check("preview_link_hash_shape", sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`),
  }),
);
