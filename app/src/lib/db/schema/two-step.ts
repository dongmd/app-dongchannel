import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
