import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { profiles } from "./profiles";

// P2-R04 — TopicCluster, a canonical domain entity of the AI Money OS.
//
// ## The boundary
//
//   TopicCluster (here, Repo B)   canonical. Cluster strategy: which clusters
//                                 are thin, which are saturated, what a new
//                                 piece would add.
//
//   dc_category  (Repo A)         a WordPress publication taxonomy. A
//                                 PROJECTION of clusters onto something readers
//                                 can browse.
//
// They are not one model. WordPress is **not** the source of truth for a
// cluster, and the schema enforces that rather than asking politely:
//
//   * identity is `id` (uuid) plus `key` (stable, derived from the cluster's
//     own name). Both exist before any term does;
//   * `wp_term_id` lives on the PROJECTION table, never on the cluster, and it
//     is nullable -- a cluster with no term is a perfectly good cluster;
//   * nothing here reaches WordPress. The projection is decided in Postgres and
//     carried out over the authenticated `dc/v1` contract (P1-R07). There is no
//     cross-database coupling in either direction.

export const clusterStateEnum = pgEnum("topic_cluster_state", [
  "THIN", //        too little content to be authoritative
  "DEVELOPING", //  growing, not yet complete
  "SATURATED", //   further pieces would add little
  "RETIRED", //     no longer pursued
]);

export const topicClusters = pgTable(
  "topic_clusters",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    // Stable identity, derived from the cluster's own name. NOT from a term, a
    // term id or a URL. `clusterIdentity()` in the policy module cannot even
    // see a WordPress value.
    key: text("key").notNull(),

    title: text("title").notNull(),
    description: text("description"),

    state: clusterStateEnum("state").notNull().default("THIN"),

    profileSlug: text("profile_slug").references(() => profiles.slug),

    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex("topic_clusters_key_uq").on(t.key),
    stateIdx: index("topic_clusters_state_idx").on(t.state),
    // The key is the term slug too, so the shape a slug must have is enforced
    // once, here, rather than at whichever caller happens to write next.
    keyShape: check(
      "topic_clusters_key_shape",
      sql`${t.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  }),
);

// ─── Projection onto the WordPress taxonomy ───────────────────────
//
// A separate table because it records something about a RELATIONSHIP between
// two systems, not something about the cluster. Putting `wp_term_id` on
// `topic_clusters` would make a cluster's row incomplete until WordPress had
// spoken, which is precisely the coupling this requirement exists to prevent.

export const projectionStateEnum = pgEnum("cluster_projection_state", [
  "PENDING", //     decided here, not yet carried out in WordPress
  "PROJECTED", //   the term exists and matches
  "DIVERGED", //    the term exists and does NOT match; refuse and raise
  "WITHDRAWN", //   deliberately not projected
]);

export const topicClusterProjections = pgTable(
  "topic_cluster_projections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    topicClusterId: uuid("topic_cluster_id")
      .notNull()
      .references(() => topicClusters.id, { onDelete: "cascade" }),

    // Which taxonomy, spelled out rather than assumed: a second projection
    // target is plausible later, and a column that means "the one we use" ages
    // badly.
    wpTaxonomy: text("wp_taxonomy").notNull().default("dc_category"),
    wpTermSlug: text("wp_term_slug").notNull(),

    // NULLABLE, and that is the point. A cluster exists before its term does,
    // and survives the term being deleted. This is a RESULT of projection,
    // never an input to identity.
    wpTermId: integer("wp_term_id"),

    state: projectionStateEnum("state").notNull().default("PENDING"),

    // Idempotency: the fingerprint of what was projected. Re-running a
    // projection whose fingerprint has not changed is a no-op rather than a
    // second write.
    projectionFingerprint: text("projection_fingerprint").notNull(),
    lastProjectedAt: timestamp("last_projected_at", { withTimezone: true }),

    // When the term in WordPress does not match what we projected, we record
    // what we saw rather than overwriting -- the same refusal discipline as
    // P1-R06's article guard.
    divergenceReason: text("divergence_reason"),
    divergenceObservedAt: timestamp("divergence_observed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One projection per cluster per taxonomy. Two would be two answers.
    clusterTaxonomyUq: uniqueIndex("topic_cluster_projections_cluster_taxonomy_uq").on(
      t.topicClusterId,
      t.wpTaxonomy,
    ),
    // And one cluster per slug within a taxonomy: the collision rule, enforced
    // by the database rather than only by the policy module.
    slugUq: uniqueIndex("topic_cluster_projections_taxonomy_slug_uq").on(
      t.wpTaxonomy,
      t.wpTermSlug,
    ),
    stateIdx: index("topic_cluster_projections_state_idx").on(t.state),
    termIdx: index("topic_cluster_projections_term_idx").on(t.wpTermId),

    // A projection claiming to be done must name the term it produced.
    projectedNeedsTerm: check(
      "topic_cluster_projections_projected_needs_term",
      sql`${t.state} <> 'PROJECTED'
          OR (${t.wpTermId} IS NOT NULL AND ${t.lastProjectedAt} IS NOT NULL)`,
    ),
    // And a divergence must say what diverged, or it is just a stuck row.
    divergedNeedsReason: check(
      "topic_cluster_projections_diverged_needs_reason",
      sql`${t.state} <> 'DIVERGED'
          OR (${t.divergenceReason} IS NOT NULL
              AND length(btrim(${t.divergenceReason})) > 0)`,
    ),
    // The slug shape is the cluster key shape. Stated in both places because
    // both are write boundaries.
    slugShape: check(
      "topic_cluster_projections_slug_shape",
      sql`${t.wpTermSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    // Owner Q28: never these. `category` is core's own rewrite base and caused
    // G-03; `guides` is an existing page.
    slugNotReserved: check(
      "topic_cluster_projections_slug_not_reserved",
      sql`${t.wpTermSlug} NOT IN ('category','guides','tag','author','page','feed')`,
    ),
  }),
);

export type TopicClusterRow = typeof topicClusters.$inferSelect;
export type TopicClusterProjectionRow = typeof topicClusterProjections.$inferSelect;
