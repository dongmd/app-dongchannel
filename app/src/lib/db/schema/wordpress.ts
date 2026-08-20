import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// P1-R05 — one-way product fact sync, APP → WordPress.
//
// SOURCE_OF_TRUTH §1 makes this app canonical for *researched* product facts --
// price, features, identity -- because WordPress has nowhere to record where a
// price came from or when it was checked. WordPress keeps the current display
// values as a projection. Prose stays WordPress-owned and is never touched from
// here.
//
// Direction is one-way and that is load-bearing. C-05: without enforcement a
// hand edit in wp-admin diverges silently and the next sync destroys it.

// ─── Products ─────────────────────────────────────────────────────
//
// IMPLEMENTATION_PLAN §P1.2 lists `products` among the P1-R03 core tables, but
// P1-R03 shipped merchants, claims, evidence and the affiliate domain without
// it. R05 cannot sync product facts from a table that does not exist, so the
// gap is closed here rather than left as a silent hole in a VERIFIED
// requirement. Recorded in the traceability register as debt from R03, paid in
// R05.
//
// Columns mirror the fields the dc/v1 allowlist accepts, because a field this
// table cannot express is a field the sync cannot carry. Provenance does not
// live here -- a price with a source and a checked-at date is a `claim`, and
// this row holds the *resolved* value that claim produced.
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // The WordPress post_name this product maps to. Stable, human-readable, and
    // the thing an operator recognises in both systems.
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    vendor: text("vendor"),
    officialUrl: text("official_url"),

    pricingModel: text("pricing_model"),
    priceAmount: numeric("price_amount", { precision: 12, scale: 2 }),
    priceCurrency: text("price_currency"),
    pricePeriod: text("price_period"), // month | year | one-time
    priceDisplay: text("price_display"),

    freePlan: boolean("free_plan"),
    freeTrial: boolean("free_trial"),
    trialLength: text("trial_length"),
    moneyback: text("moneyback"),
    hasCoupon: boolean("has_coupon"),

    lastVerified: date("last_verified"),
    lastPriceCheck: date("last_price_check"),
    active: boolean("active").notNull().default(true),

    // Monotonic, incremented on every material fact change.
    //
    // This is the stale-update guard and it is deliberately *not* the
    // idempotency key. R07's idempotency records expire after seven days
    // (D-12); once one is pruned, an old job replayed from a dead queue would
    // execute again and roll newer facts backwards. A version the receiver can
    // compare does not expire.
    sourceVersion: integer("source_version").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUq: uniqueIndex("products_slug_uq").on(t.slug),
    activeIdx: index("products_active_idx").on(t.active),
  }),
);

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;

// ─── Sync state ───────────────────────────────────────────────────
export const wpSyncStatusEnum = pgEnum("wp_sync_status", [
  "PENDING",   // mapped, never synced
  "SYNCED",    // last attempt succeeded
  "CONFLICT",  // WordPress changed under us -- needs a human, never a retry
  "FAILED",    // last attempt failed for a reason that is not a conflict
]);

// One row per product that has a WordPress counterpart.
//
// `wpContentHash` and `wpPostModifiedGmt` are stored exactly as dc/v1 returned
// them and are never recomputed here. The hash is opaque by contract; the
// timestamp is **nullable by contract** -- null means "WordPress cannot date
// this post", which is not the same as "unchanged" and must never be treated as
// agreement.
export const wordpressProductSync = pgTable(
  "wordpress_product_sync",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),

    // WordPress mints post IDs; we record what it minted. Unique in both
    // directions -- two products pointing at one post would let each overwrite
    // the other's facts.
    wpPostId: integer("wp_post_id").notNull(),

    status: wpSyncStatusEnum("status").notNull().default("PENDING"),

    // The product version last *successfully* applied to WordPress. An incoming
    // job carrying a lower version is stale and is refused.
    syncedSourceVersion: integer("synced_source_version"),

    wpContentHash: text("wp_content_hash"),
    wpPostModifiedGmt: text("wp_post_modified_gmt"),

    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productUq: uniqueIndex("wp_sync_product_uq").on(t.productId),
    postUq: uniqueIndex("wp_sync_post_uq").on(t.wpPostId),
    statusIdx: index("wp_sync_status_idx").on(t.status),
  }),
);

export type WordpressProductSyncRow = typeof wordpressProductSync.$inferSelect;
export type NewWordpressProductSyncRow = typeof wordpressProductSync.$inferInsert;

// ─── Job queue (G-55) ─────────────────────────────────────────────
export const wpSyncJobStateEnum = pgEnum("wp_sync_job_state", [
  "QUEUED",
  "RUNNING",
  "DONE",
  "FAILED_RETRYABLE",
  "FAILED_PERMANENT", // needs a human; retrying a 400 only fails faster
]);

// G-55: WP-Cron fires on visitor requests and is unreliable on a zero-traffic
// site, so the queue lives here.
//
// `idempotencyKey` is derived deterministically from product + version +
// destination, not generated per attempt. A key regenerated on process restart
// is a duplicate write waiting to happen -- which is the entire failure mode
// R07's idempotency table exists to prevent, defeated from the client side.
export const wordpressSyncJobs = pgTable(
  "wordpress_sync_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),

    // The version this job carries. Compared against the sync state on
    // execution, so a job that sat in the queue while newer ones ran is
    // discarded rather than applied.
    sourceVersion: integer("source_version").notNull(),

    idempotencyKey: text("idempotency_key").notNull(),
    state: wpSyncJobStateEnum("state").notNull().default("QUEUED"),

    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),

    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    correlationId: text("correlation_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex("wp_sync_jobs_key_uq").on(t.idempotencyKey),
    dueIdx: index("wp_sync_jobs_due_idx").on(t.state, t.nextAttemptAt),
    productIdx: index("wp_sync_jobs_product_idx").on(t.productId),
  }),
);

export type WordpressSyncJobRow = typeof wordpressSyncJobs.$inferSelect;
export type NewWordpressSyncJobRow = typeof wordpressSyncJobs.$inferInsert;

// ─── P1-R06 · article sync state (G-58, PROPOSED §7A) ─────────────
//
// WordPress wins for article prose after publication, because that is where the
// owner edits it. This table holds the baseline the guard compares against, and
// it exists so that "has a human touched this?" has an answer other than a
// guess.
//
// There is no `articles` table to reference: the app does not own article prose
// and will not until a much later phase. The key is therefore the WordPress
// post id, which is the only identity both sides agree on today.
export const wpArticleSyncStateEnum = pgEnum("wp_article_sync_state", [
  "BASELINE_SET", //  a clean baseline; the guard may compare against it
  "CONFLICT", //      WordPress diverged; refused until explicitly resolved
]);

export const wordpressArticleSync = pgTable(
  "wordpress_article_sync",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    wpPostId: integer("wp_post_id").notNull(),

    state: wpArticleSyncStateEnum("state").notNull().default("BASELINE_SET"),

    // ---- The baseline. All three are captured from one read, never assembled
    // from separate ones: a hash from one moment and a timestamp from another
    // describe a post that never existed.
    //
    // Both are nullable in the *column* sense only because a row is written
    // before it is validated. The guard refuses on null -- AC-09. Null means
    // "WordPress could not tell us", which is not "unchanged".
    wpContentHash: text("wp_content_hash"),
    wpPostModifiedGmt: text("wp_post_modified_gmt"),
    wpPostStatus: text("wp_post_status"),

    // The hash format the baseline was taken under. Stored so a later contract
    // change is a refusal (AC-10) rather than a silent comparison of two
    // incomparable strings.
    hashContractVersion: text("hash_contract_version"),

    wpLastSyncedAt: timestamp("wp_last_synced_at", { withTimezone: true }),

    // ---- Conflict context (§7A step 5). Enough to reconstruct the divergence
    // without going back to WordPress, because by then it may have moved again.
    conflictDetectedAt: timestamp("conflict_detected_at", { withTimezone: true }),
    conflictReason: text("conflict_reason"),
    conflictBaselineHash: text("conflict_baseline_hash"),
    conflictObservedHash: text("conflict_observed_hash"),
    conflictBaselineModifiedGmt: text("conflict_baseline_modified_gmt"),
    conflictObservedModifiedGmt: text("conflict_observed_modified_gmt"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    postUq: uniqueIndex("wp_article_sync_post_uq").on(t.wpPostId),
    stateIdx: index("wp_article_sync_state_idx").on(t.state),
  }),
);

export type WordpressArticleSyncRow = typeof wordpressArticleSync.$inferSelect;
export type NewWordpressArticleSyncRow = typeof wordpressArticleSync.$inferInsert;
