import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

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
