import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { claimTtlDays } from "./content-mode-policy";

// P2-R05 AC-04 — "expiry never unpublishes and never edits", proven
// structurally rather than promised in a comment.
//
// This reads the worker's own source and asserts what it is capable of
// reaching. A behavioural test can only show that the paths it happened to
// exercise did not publish; this shows there is no path, because the modules
// that could publish are not imported and the strings that would name them do
// not appear.
//
// The same technique as P1-R06's permit type: make the dangerous thing
// unsayable rather than merely unsaid. It runs without a database and without
// executing the worker, which matters because executing it would need a
// DATABASE_URL and the point is to test the boundary, not the connection.

const WORKER = join(process.cwd(), "src/lib/content/refresh-worker.ts");
const POLICY = join(process.cwd(), "src/lib/content/content-mode-policy.ts");

/**
 * Strip comments before scanning for capability.
 *
 * The first run of this guard failed on the word "unpublish" — inside the
 * worker's own comment explaining that it never unpublishes. A comment is not a
 * capability, and a guard that cannot tell the difference would push authors
 * toward describing the constraint less clearly in order to satisfy the test.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /^\s*import\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

test("AC-04: the refresh worker imports nothing that can reach WordPress", () => {
  const source = readFileSync(WORKER, "utf8");
  const imports = importsOf(source);

  assert.ok(imports.length > 0, "parsed zero imports — the guard would be vacuous");

  const forbidden = imports.filter((spec) =>
    /wordpress|publish|wp-|\/go\/|rest\/v1/i.test(spec),
  );

  assert.deepEqual(
    forbidden,
    [],
    `the worker must not import anything that can write to WordPress: ${forbidden.join(", ")}`,
  );
});

test("AC-04: the worker's write path touches only the projection columns", () => {
  const source = code(readFileSync(WORKER, "utf8"));

  // The tables it is allowed to write.
  const updates = [...source.matchAll(/\.update\((\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(updates)],
    ["articleContentModes"],
    "the worker updates a table it has no business updating",
  );

  // Nothing that sounds like a publication state change.
  for (const forbidden of [
    "post_status",
    "postStatus",
    "wp_update_post",
    "unpublish",
    "publish_posts",
    "draft",
    "trash",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `the worker mentions ${forbidden}; expiry must only mark`,
    );
  }
});

test("AC-04: the action vocabulary contains no destructive verb", () => {
  const source = readFileSync(POLICY, "utf8");

  const match = source.match(/export const REFRESH_ACTIONS = \[([^\]]*)\]/);
  assert.ok(match?.[1], "REFRESH_ACTIONS not found — the guard would be vacuous");

  const actions = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(actions.length >= 2);

  for (const action of actions) {
    assert.ok(
      action === "NONE" || action?.startsWith("MARK_"),
      `${action} is neither a mark nor a no-op`,
    );
  }
});

test("AC-09: the policy module imports nothing at all", () => {
  const source = readFileSync(POLICY, "utf8");

  assert.deepEqual(
    importsOf(source),
    [],
    "the policy module must stay dependency-free so it is testable without a database",
  );
});

// ─── Freshness semantics: two surfaces, neither a bypass ──────────
//
// Owner clarification requested after P2-R05, and worth pinning because the two
// numbers look interchangeable and are not:
//
//   offers.ts isStale()        30 days — an OFFER's payout figure going stale.
//                              Now reads claimTtlDays("payout_value"), so it is
//                              INSIDE the P2-R05 policy, not beside it.
//
//   dc_product::is_stale()     90 days — a WordPress PRODUCT's dc_last_verified
//                              going stale. A separate surface in Repo A that
//                              deliberately does not call the app, because an
//                              admin list column must not depend on a second
//                              host being reachable. It resolves through
//                              dc_core_ttl_days(), so it is configurable too.
//
// Neither bypasses TTL configuration. The risk being guarded against is a later
// reader assuming they do, and reintroducing a literal.

test("freshness: offers.isStale reads the claim TTL and hard-codes no duration", () => {
  const source = code(readFileSync(join(process.cwd(), "src/lib/aff/offers.ts"), "utf8"));

  const fn = source.slice(source.indexOf("export function isStale"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);

  assert.ok(body.includes("claimTtlDays"), "isStale must resolve its window from the claim TTL");

  // The literal that used to be here: `30 * 24 * 60 * 60 * 1000`. Any bare
  // day-count multiplied into milliseconds is the shape being banned.
  assert.equal(
    /\b\d{2,}\s*\*\s*24\s*\*\s*60/.test(body),
    false,
    "isStale hard-codes a duration again; it must come from claimTtlDays",
  );
});

test("freshness: the two thresholds are different values on purpose", () => {
  // If someone ever "tidies" these into one number, the distinction between an
  // offer's payout figure and a product's verification date is lost silently.
  assert.equal(claimTtlDays("payout_value"), 30);
  assert.notEqual(claimTtlDays("payout_value"), 90);

  // 90 is the WordPress product default and lives in Repo A
  // (includes/freshness.php, dc_core_default_ttl_days). It is asserted there,
  // not here — this test only pins that the app side is not 90, so a future
  // merge of the two surfaces cannot happen quietly.
});

test("CONTROL: stripping comments does not blind the capability scan", () => {
  // The strip must remove prose, not code. A worker that actually called an
  // unpublish helper must still be caught.
  const withComment = '// this never unpublishes anything\nconst x = 1;';
  assert.equal(code(withComment).includes("unpublish"), false);

  const withCall = 'await wpUnpublish(id); // safe, honest\n';
  assert.equal(code(withCall).includes("wpUnpublish"), true);

  // A URL inside code must survive — the `[^:]` guard exists for exactly this.
  assert.equal(code('const u = "https://x.test/a";').includes("https://x.test/a"), true);
});

test("CONTROL: the import parser really finds imports", () => {
  // If `importsOf` returned [] for everything, every guard above would pass
  // vacuously. Point it at a file that certainly has imports.
  const workerImports = importsOf(readFileSync(WORKER, "utf8"));
  assert.ok(workerImports.includes("server-only"));
  assert.ok(workerImports.some((s) => s.includes("db/schema/content")));

  // And prove it would catch the thing it is looking for.
  const fake = 'import { publishPost } from "@/lib/wordpress/client";';
  const found = importsOf(fake).filter((s) => /wordpress/i.test(s));
  assert.deepEqual(found, ["@/lib/wordpress/client"]);
});
