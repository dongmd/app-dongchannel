import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { topicClusterProjections, topicClusters } from "../db/schema/topic-cluster";
import {
  FORBIDDEN_REWRITE_SLUGS,
  WP_REWRITE_SLUG,
  WP_TAXONOMY,
  checkSlugCollision,
  clusterIdentity,
  clusterKey,
  planRedirects,
  projectCluster,
  projectionsEqual,
  shouldFlushRewrites,
  CLUSTER_STATES,
  internalLinkValueFor,
  checkKeyRename,
  reconcileProjection,
} from "./topic-cluster-policy";

// P2-R04 — the eight verification points the owner set, each checked against
// the real policy or the real schema.
//
// The boundary under test: TopicCluster is a canonical domain entity, and
// dc_category is a projection of it. A test that only proved "a term gets
// created" would miss the whole point.

function columns(table: object): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null && "columnType" in v) {
      out[k] = v as Record<string, unknown>;
    }
  }
  return out;
}

// ─── 1. Identity does not depend on a WordPress term id ───────────

test("1: cluster identity is derived from its own name, never from a term", () => {
  const v = clusterIdentity("AI Writing Tools");
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.key, "ai-writing-tools");

  // The function signature is the argument: there is no term id to pass in.
  assert.equal(clusterIdentity.length, 1);
});

test("1: the cluster table carries no WordPress term id at all", () => {
  const cols = Object.keys(columns(topicClusters)).map((n) => n.toLowerCase());
  for (const wp of ["wptermid", "termid", "wptaxonomy", "wptermslug"]) {
    assert.equal(
      cols.includes(wp),
      false,
      `topic_clusters must not carry '${wp}' -- identity would then depend on WordPress`,
    );
  }
  // It carries its own identity instead.
  assert.ok(columns(topicClusters).key, "the cluster's own stable key must exist");
  assert.equal(columns(topicClusters).key?.notNull, true);
});

test("1: the term id lives on the projection and is NULLABLE", () => {
  const cols = columns(topicClusterProjections);
  assert.ok(cols.wpTermId, "the projection records the term id");
  assert.equal(
    cols.wpTermId?.notNull,
    false,
    "a cluster exists before its term does, and survives the term being deleted",
  );
});

test("1: an empty or punctuation-only name cannot become an identity", () => {
  assert.equal(clusterIdentity("").ok, false);
  assert.equal(clusterIdentity("   ").ok, false);
  const punct = clusterIdentity("!!! ---");
  assert.equal(punct.ok, false);
  assert.equal(punct.ok === false && punct.reason, "KEY_EMPTY");
});

// ─── 2. Projection is deterministic and idempotent ────────────────

test("2: the same cluster projects to the same thing, every time", () => {
  const a = projectCluster("ai-writing-tools");
  const b = projectCluster("ai-writing-tools");
  assert.ok(projectionsEqual(a, b));
  assert.equal(a.taxonomy, WP_TAXONOMY);
  assert.equal(a.termSlug, "ai-writing-tools");
});

test("2: key derivation is idempotent — deriving from a key returns the key", () => {
  // Without this, a projection worker that re-derives from a stored key drifts,
  // and drift means a second term.
  for (const name of ["AI Writing Tools", "SEO & Content", "Email  Marketing"]) {
    const once = clusterKey(name);
    assert.equal(clusterKey(once), once, `re-deriving '${once}' changed it`);
  }
});

test("2: diacritics normalise rather than producing a second cluster", () => {
  // "Tối ưu" and "Toi uu" are the same cluster to a reader, and must be the
  // same key -- otherwise the same topic gets two archives.
  assert.equal(clusterKey("Tối ưu"), clusterKey("Toi uu"));
  assert.equal(clusterKey("Đầu tư"), "dau-tu");
});

test("2: the term slug IS the cluster key, not a second derivation", () => {
  // Two separate derivations are two chances to disagree.
  const key = clusterKey("Marketing Automation");
  assert.equal(projectCluster(key).termSlug, key);
});

// ─── 3. /guides/ does not collide with /topics/ ───────────────────

test("3: the rewrite slug is `topics`, and `guides` is refused", () => {
  assert.equal(WP_REWRITE_SLUG, "topics");
  assert.ok(FORBIDDEN_REWRITE_SLUGS.has("guides"), "`guides` is an existing page");
  assert.ok(FORBIDDEN_REWRITE_SLUGS.has("category"), "`category` is core's rewrite base — G-03");
});

test("3: a cluster can never take a reserved slug", () => {
  for (const reserved of FORBIDDEN_REWRITE_SLUGS) {
    const v = checkSlugCollision(reserved, new Map(), "some-cluster");
    assert.equal(v.ok, false, `${reserved} must be refused`);
    assert.equal(v.ok === false && v.reason, "RESERVED_SLUG");
  }
});

test("3: the database refuses a reserved slug too, not just the policy", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/db/schema/topic-cluster.ts"),
    "utf8",
  );
  assert.ok(
    /slug_not_reserved[\s\S]{0,200}NOT IN \('category','guides'/.test(src),
    "a CHECK must refuse reserved slugs — the policy alone is bypassable by any direct write",
  );
});

// ─── 4. Rewrites flush on version change, not per request ─────────

test("4: a flush happens only when the version actually changes", () => {
  assert.equal(shouldFlushRewrites(5, 4), true, "a bump must flush");
  assert.equal(shouldFlushRewrites(5, 5), false, "an unchanged version must NOT flush");
  assert.equal(shouldFlushRewrites(5, null), true, "a site that has never flushed must");
  // Nonsense must not trigger work.
  assert.equal(shouldFlushRewrites(0, 4), false);
  assert.equal(shouldFlushRewrites(Number.NaN, 4), false);
});

// ─── 5. Slug uniqueness and collision ─────────────────────────────

test("5: two clusters cannot claim the same slug", () => {
  const taken = new Map([["ai-tools", "cluster-a"]]);
  const v = checkSlugCollision("ai-tools", taken, "cluster-b");
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "SLUG_TAKEN_BY_OTHER_CLUSTER");
});

test("5: re-projecting the SAME cluster onto its own slug is not a collision", () => {
  // The idempotent case. Reporting it as a collision would make every repeat
  // run look like a conflict.
  const taken = new Map([["ai-tools", "cluster-a"]]);
  assert.equal(checkSlugCollision("ai-tools", taken, "cluster-a").ok, true);
});

test("5: names that normalise to one key are refused, not silently suffixed", () => {
  // "AI Tools" and "AI tools." both key to `ai-tools`. A `ai-tools-2` archive
  // nobody chose is a public URL nobody can explain, so the answer is refusal.
  assert.equal(clusterKey("AI Tools"), clusterKey("AI tools."));
  const taken = new Map([[clusterKey("AI Tools"), "cluster-a"]]);
  assert.equal(checkSlugCollision(clusterKey("AI tools."), taken, "cluster-b").ok, false);
});

test("5: the database enforces uniqueness per taxonomy, not globally by accident", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/db/schema/topic-cluster.ts"),
    "utf8",
  );
  assert.ok(
    /uniqueIndex\("topic_cluster_projections_taxonomy_slug_uq"\)\.on\([\s\S]{0,80}wpTaxonomy[\s\S]{0,60}wpTermSlug/.test(src),
    "slug uniqueness must be scoped to the taxonomy",
  );
  assert.ok(
    /uniqueIndex\("topic_cluster_projections_cluster_taxonomy_uq"\)/.test(src),
    "one projection per cluster per taxonomy",
  );
});

// ─── 7 + 8. Redirects only if there is something to redirect ──────

test("7/8: no indexed or resolving old URLs means NO redirect is built", () => {
  // Evidence gathered 2026-08-20: /category/ returns 404 (the G-03 collision),
  // and blog_public has been 0 throughout, so nothing was ever indexed.
  const plan = planRedirects({
    oldSlug: "category",
    newSlug: "topics",
    wereIndexed: false,
    oldUrlsResolve: false,
  });
  assert.equal(plan.needed, false);
  assert.equal(plan.needed === false && plan.reason, "NO_PUBLIC_OR_INDEXED_OLD_URLS");
});

test("7: if the old URLs HAD been indexed, a redirect plan is required", () => {
  const plan = planRedirects({
    oldSlug: "category",
    newSlug: "topics",
    wereIndexed: true,
    oldUrlsResolve: false,
  });
  assert.equal(plan.needed, true);
  assert.deepEqual(plan.needed === true && plan.from, ["/category/"]);
  assert.equal(plan.needed === true && plan.to, "/topics/");
});

test("7: resolving old URLs alone are enough to require a plan", () => {
  // Indexed and reachable are different questions, and either one is a reason.
  const plan = planRedirects({
    oldSlug: "old",
    newSlug: "topics",
    wereIndexed: false,
    oldUrlsResolve: true,
  });
  assert.equal(plan.needed, true);
});

test("8: an unchanged slug never manufactures a redirect", () => {
  const plan = planRedirects({
    oldSlug: "topics",
    newSlug: "topics",
    wereIndexed: true,
    oldUrlsResolve: true,
  });
  assert.equal(plan.needed, false);
  assert.equal(plan.needed === false && plan.reason, "SLUG_UNCHANGED");
});

// ─── 6 (part) / AC-03 — cluster state feeds the scoring dimension ─

test("AC-03: a THIN cluster is worth MORE to link into than a saturated one", () => {
  // Not intuitive at a glance, and that is why it is asserted: a new piece in a
  // thin cluster has the most to establish. A saturated cluster already has the
  // web, so another piece adds little.
  assert.equal(internalLinkValueFor("THIN"), 1);
  assert.ok(
    (internalLinkValueFor("DEVELOPING") as number) > (internalLinkValueFor("SATURATED") as number),
  );
});

test("AC-03: a RETIRED cluster is UNKNOWN, not zero", () => {
  // Zero is a judgement -- "worth nothing". Unknown is the truth -- "we are not
  // pursuing this, so the question does not apply" -- and P2-R03 keeps unknown
  // out of the numerator while leaving its weight in the denominator.
  assert.equal(internalLinkValueFor("RETIRED"), "UNKNOWN");
  assert.notEqual(internalLinkValueFor("RETIRED"), 0);
});

test("AC-03: every cluster state produces a scoring input", () => {
  for (const s of CLUSTER_STATES) {
    const v = internalLinkValueFor(s);
    assert.ok(
      v === "UNKNOWN" || (typeof v === "number" && v >= 0 && v <= 1),
      `${s} produced ${String(v)}, which is not a scoring input`,
    );
  }
});

// ─── Owner invariants added 2026-08-20 ───────────────────────────

test("INV-1: the cluster's uuid is its identity, and it is generated, not supplied", () => {
  const cols = columns(topicClusters);
  assert.equal(cols.id?.columnType, "PgUUID");
  assert.equal(cols.id?.hasDefault, true, "a uuid nobody has to supply cannot be forgotten");
  assert.equal(cols.id?.primary, true);
});

test("INV-2: an ACTIVATED key cannot be renamed silently", () => {
  // Before activation the key is an internal identifier. After it, /topics/{key}/
  // is a public URL, and renaming it breaks every link to it.
  const before = checkKeyRename({ oldKey: "ai-tools", newKey: "ai-tooling", activated: false });
  assert.equal(before.ok, true);
  assert.equal(before.ok === true && before.requiresRedirect, false);

  const after = checkKeyRename({ oldKey: "ai-tools", newKey: "ai-tooling", activated: true });
  assert.equal(after.ok, false);
  assert.equal(after.ok === false && after.reason, "ACTIVATED_KEY_IS_PUBLIC");
});

test("INV-2: an approved SEO migration may rename, and OWES a redirect", () => {
  const v = checkKeyRename({
    oldKey: "ai-tools", newKey: "ai-tooling", activated: true, seoMigrationApproved: true,
  });
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.requiresRedirect, true, "renaming a live URL owes a redirect");
});

test("INV-2: a malformed new key is refused whether activated or not", () => {
  for (const activated of [true, false]) {
    const v = checkKeyRename({ oldKey: "a", newKey: "Not A Key", activated, seoMigrationApproved: true });
    assert.equal(v.ok === false && v.reason, "INVALID_NEW_KEY");
  }
});

test("INV-2: the schema records WHEN a projection went live", () => {
  const cols = columns(topicClusterProjections);
  assert.ok(cols.activatedAt, "activated_at makes 'is this key still free?' a fact, not a memory");
  assert.equal(cols.activatedAt?.notNull, false, "most projections are not live yet");
});

test("INV-3: a term deleted in WordPress is a RE-PROJECTION, not a data loss", () => {
  // The cluster's identity never depended on the term, so losing the term loses
  // nothing about the cluster.
  const v = reconcileProjection({ storedTermId: 42, storedSlug: "ai-tools", observed: null });
  assert.equal(v.outcome, "TERM_MISSING");
  assert.equal(v.outcome === "TERM_MISSING" && v.action, "REPROJECT");
});

test("INV-3: a term renamed by hand in wp-admin is REFUSED, not overwritten", () => {
  // Same discipline as P1-R06's article guard: a human changed a public URL,
  // and silently changing it back is as wrong as silently accepting it.
  const v = reconcileProjection({
    storedTermId: 42, storedSlug: "ai-tools", observed: { termId: 42, slug: "ai-tooling" },
  });
  assert.equal(v.outcome, "SLUG_DIVERGED");
  assert.equal(v.outcome === "SLUG_DIVERGED" && v.action, "REFUSE");
  assert.ok(v.outcome === "SLUG_DIVERGED" && v.reason.includes("ai-tooling"));
});

test("INV-3: reconciliation never looks anything up — the observation is a parameter", () => {
  // That is what keeps the cross-database coupling out: the caller reads
  // WordPress over dc/v1 and passes what it saw.
  assert.equal(reconcileProjection.length, 1);
  const src = readFileSync(join(process.cwd(), "src/lib/content/topic-cluster-policy.ts"), "utf8");
  assert.equal([...src.matchAll(/^\s*import\s/gm)].length, 0, "the policy still imports nothing");
});

test("INV-3: a never-projected cluster is distinguishable from a broken one", () => {
  const v = reconcileProjection({ storedTermId: null, storedSlug: "ai-tools", observed: null });
  assert.equal(v.outcome, "NEVER_PROJECTED");
  // "we have not done it yet" and "it was there and is gone" call for the same
  // action but are different facts, and the outcome keeps them apart.
  assert.notEqual(v.outcome, "TERM_MISSING");
});

test("INV-4: collisions are still refused rather than suffixed", () => {
  const taken = new Map([["ai-tools", "cluster-a"]]);
  const v = checkSlugCollision("ai-tools", taken, "cluster-b");
  assert.equal(v.ok, false);
  // And no CODE anywhere generates a numeric suffix. Comments are stripped
  // first: the policy's own comment explains that it does not suffix, and a
  // guard that cannot tell prose from code would punish saying so clearly --
  // the same mistake the P2-R05 boundary test made on the word "unpublish".
  const code = readFileSync(join(process.cwd(), "src/lib/content/topic-cluster-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(
    /`\$\{[^}]*\}-\d|suffix|counter\s*\+\+/.test(code),
    false,
    "no auto-suffix may creep in",
  );
});

// ─── The architectural boundary ───────────────────────────────────

test("no cross-database coupling: the policy imports nothing", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/topic-cluster-policy.ts"), "utf8");
  assert.equal([...src.matchAll(/^\s*import\s/gm)].length, 0);
});

test("no cross-database coupling: the schema reaches no WordPress client", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/db/schema/topic-cluster.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  assert.ok(specs.length > 0, "parsed no imports -- the guard would be vacuous");
  assert.deepEqual(
    specs.filter((s) => /wordpress|mysql|wp-/i.test(s)),
    [],
    "the projection is decided here and carried out over dc/v1, never by a database link",
  );
});

test("the taxonomy key is dc_category and is not renamed", () => {
  // Owner Q28: only the public URL changes. Renaming the key would rewrite
  // every term relationship for cosmetic gain.
  assert.equal(WP_TAXONOMY, "dc_category");
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: the happy path works, so the refusals mean something", () => {
  const id = clusterIdentity("Email Marketing");
  assert.equal(id.ok, true);
  const proj = projectCluster(id.ok ? id.key : "");
  assert.equal(proj.termSlug, "email-marketing");
  assert.equal(checkSlugCollision(proj.termSlug, new Map(), "c1").ok, true);
});

test("CONTROL: the collision checker distinguishes its three refusals", () => {
  const reasons = new Set(
    [
      checkSlugCollision("", new Map(), "c"),
      checkSlugCollision("guides", new Map(), "c"),
      checkSlugCollision("x", new Map([["x", "other"]]), "c"),
    ].map((v) => (v.ok ? "OK" : v.reason)),
  );
  assert.deepEqual(
    [...reasons].sort(),
    ["EMPTY_SLUG", "RESERVED_SLUG", "SLUG_TAKEN_BY_OTHER_CLUSTER"],
  );
});
