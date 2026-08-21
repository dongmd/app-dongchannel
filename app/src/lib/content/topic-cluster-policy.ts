/**
 * P2-R04 — `TopicCluster`, and its projection onto a WordPress taxonomy.
 *
 * Imports nothing. Same rule as every other policy module here.
 *
 * ## The boundary this file refuses to cross
 *
 * `TopicCluster` is a **canonical domain entity of the AI Money OS** (Repo B).
 * `dc_category` is a **WordPress publication taxonomy** (Repo A) — a *projection*
 * of clusters onto something readers can browse.
 *
 * They are not one model, and WordPress is **not** the source of truth for a
 * cluster:
 *
 *   * a cluster's identity is its own `uuid` and its own stable `key`. It
 *     exists before any term does, and it survives the term being deleted;
 *   * `wp_term_id` is a *result* of projection, never an input to identity.
 *     `clusterIdentity()` cannot even see it;
 *   * nothing here opens a connection to WordPress. The projection is decided
 *     in Postgres and carried out over the authenticated `dc/v1` contract
 *     (P1-R07). **There is no cross-database coupling in either direction.**
 *
 * Owner decision **Q28**: the taxonomy key stays `dc_category`, the public
 * rewrite slug becomes `/topics/`, `/guides/` is not reused, and the key is not
 * renamed for cosmetic reasons.
 */

// ─── Identity ─────────────────────────────────────────────────────

/**
 * A cluster's stable key. Derived from the cluster's own name — never from a
 * WordPress term, a term id, or a URL.
 *
 * Deterministic and idempotent: `clusterKey(clusterKey(x)) === clusterKey(x)`,
 * so re-deriving a key from an already-derived one cannot drift. That property
 * is what lets the projection run repeatedly without producing a second term.
 */
export function clusterKey(name: string): string {
  return name
    .normalize("NFKD")
    // Strip diacritics rather than transliterating: "Tối ưu" and "Toi uu" must
    // land on the same key, or the same cluster gets two terms.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, (m) => (m === "đ" ? "d" : "D"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export type IdentityVerdict =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: "NAME_REQUIRED" | "KEY_EMPTY" };

/**
 * The identity function, and note what it does **not** take: no term id, no
 * taxonomy, no URL. A cluster that could only be identified once WordPress had
 * given it a number would be a WordPress entity wearing a domain name.
 */
export function clusterIdentity(name: string): IdentityVerdict {
  if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "NAME_REQUIRED" };
  const key = clusterKey(name);
  // A name made entirely of punctuation produces nothing usable, and an empty
  // key would collide with every other empty key.
  if (!key) return { ok: false, reason: "KEY_EMPTY" };
  return { ok: true, key };
}

// ─── Projection onto the WordPress taxonomy ───────────────────────

/** The one taxonomy clusters project onto. Owner Q28: the key does not change. */
export const WP_TAXONOMY = "dc_category" as const;

/** The public rewrite slug. Owner Q28: `/topics/`, and `/guides/` is not reused. */
export const WP_REWRITE_SLUG = "topics" as const;

/**
 * Slugs the taxonomy may never take.
 *
 * `category` is WordPress core's own rewrite base and is what made six archives
 * 404 (G-03). `guides` is an existing page — the posts page — and reusing it
 * would put a taxonomy archive on top of a real page.
 */
export const FORBIDDEN_REWRITE_SLUGS: ReadonlySet<string> = new Set([
  "category",
  "guides",
  "tag",
  "author",
  "page",
  "feed",
]);

export interface ClusterProjection {
  readonly clusterKey: string;
  readonly taxonomy: typeof WP_TAXONOMY;
  readonly termSlug: string;
}

/**
 * Deterministic and idempotent (owner verification point 2).
 *
 * The term slug **is** the cluster key. Not derived separately, not
 * lower-cased again somewhere else — the same string, so projecting twice
 * cannot produce two terms and a later reader can tell at a glance which term
 * belongs to which cluster.
 */
export function projectCluster(key: string): ClusterProjection {
  return { clusterKey: key, taxonomy: WP_TAXONOMY, termSlug: key };
}

export function projectionsEqual(a: ClusterProjection, b: ClusterProjection): boolean {
  return a.clusterKey === b.clusterKey && a.taxonomy === b.taxonomy && a.termSlug === b.termSlug;
}

// ─── Collisions ───────────────────────────────────────────────────

export type CollisionVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "SLUG_TAKEN_BY_OTHER_CLUSTER" | "RESERVED_SLUG" | "EMPTY_SLUG";
    };

/**
 * Owner verification point 5 — slug uniqueness and collision, handled rather
 * than hoped for.
 *
 * Two clusters whose names normalise to the same key is a **real** case:
 * "AI Tools" and "AI tools." both key to `ai-tools`. The answer is to refuse,
 * not to silently suffix a number — a `ai-tools-2` archive nobody chose is a
 * public URL nobody can explain.
 */
export function checkSlugCollision(
  slug: string,
  existing: ReadonlyMap<string, string>,
  clusterKeyForSlug: string,
): CollisionVerdict {
  if (!slug) return { ok: false, reason: "EMPTY_SLUG" };
  if (FORBIDDEN_REWRITE_SLUGS.has(slug)) return { ok: false, reason: "RESERVED_SLUG" };

  const owner = existing.get(slug);
  // Re-projecting the SAME cluster onto the SAME slug is the idempotent case,
  // and must not be reported as a collision.
  if (owner !== undefined && owner !== clusterKeyForSlug) {
    return { ok: false, reason: "SLUG_TAKEN_BY_OTHER_CLUSTER" };
  }
  return { ok: true };
}

// ─── Rewrite-rule flushing ────────────────────────────────────────

/**
 * Owner verification point 4 — rewrite rules must not flush on every request.
 *
 * `flush_rewrite_rules()` rebuilds every rule and writes an option. On a shared
 * LiteSpeed host that is a per-request cost for a thing that changes about once
 * a year. dc-core already gates it on `DC_CORE_REWRITE_VERSION` versus the
 * stored `dc_rewrite_version`; this states the same rule on the app side so a
 * projection worker can never ask for a flush it has not earned.
 */
export function shouldFlushRewrites(
  codeVersion: number,
  storedVersion: number | null,
): boolean {
  if (!Number.isInteger(codeVersion) || codeVersion < 1) return false;
  return storedVersion !== codeVersion;
}

// ─── Redirects ────────────────────────────────────────────────────

export type RedirectPlan =
  | { readonly needed: false; readonly reason: string }
  | { readonly needed: true; readonly from: readonly string[]; readonly to: string };

/**
 * Owner verification points 7 and 8, as one decision.
 *
 * If old taxonomy URLs were ever public and indexed, changing the slug needs an
 * explicit redirect plan. If they were not, building one is legacy
 * compatibility for a legacy that does not exist.
 *
 * The evidence has to be supplied, not assumed — which is why `wereIndexed` is
 * a parameter rather than a default.
 */
export function planRedirects(input: {
  readonly oldSlug: string;
  readonly newSlug: string;
  readonly wereIndexed: boolean;
  readonly oldUrlsResolve: boolean;
}): RedirectPlan {
  if (input.oldSlug === input.newSlug) {
    return { needed: false, reason: "SLUG_UNCHANGED" };
  }
  if (!input.wereIndexed && !input.oldUrlsResolve) {
    // Nothing to preserve: the URLs never resolved and were never indexed.
    return { needed: false, reason: "NO_PUBLIC_OR_INDEXED_OLD_URLS" };
  }
  return {
    needed: true,
    from: [`/${input.oldSlug}/`],
    to: `/${input.newSlug}/`,
  };
}

// ─── Feeding P2-R03 ───────────────────────────────────────────────

export const CLUSTER_STATES = ["THIN", "DEVELOPING", "SATURATED", "RETIRED"] as const;
export type ClusterState = (typeof CLUSTER_STATES)[number];

/**
 * AC-03 — cluster state feeds `internal_link_value` into P2-R03 scoring.
 *
 * The value is 0-1, the shape every scoring dimension takes. The ordering is
 * the point and it is not intuitive at first glance: a **THIN** cluster scores
 * HIGHEST, because a new piece there has the most to connect to and the most
 * to establish. A **SATURATED** cluster scores lowest — another piece links
 * into a web that already exists, so it adds little.
 *
 * `RETIRED` returns `UNKNOWN` rather than 0. Zero would be a judgement ("this
 * is worth nothing"); unknown is the truth ("we are not pursuing this, so the
 * question does not apply"), and P2-R03 keeps unknown out of the numerator
 * while leaving its weight in the denominator.
 */
export function internalLinkValueFor(state: ClusterState): number | "UNKNOWN" {
  switch (state) {
    case "THIN":
      return 1;
    case "DEVELOPING":
      return 0.6;
    case "SATURATED":
      return 0.2;
    case "RETIRED":
      return "UNKNOWN";
  }
}
