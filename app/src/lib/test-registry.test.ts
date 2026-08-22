/**
 * The test script in `package.json` is a hand-maintained list of files, so a new
 * test file runs only if someone remembers to add it. This guard exists because
 * a suite of sixty new cases was written, reported green, and had not been
 * executed at all — the total stayed at 490 and nothing said otherwise.
 *
 * That is the `M-06` shape: a hand-maintained list drifting from the thing it
 * lists. The fix is the one used everywhere else here — let the machine notice.
 *
 * ## This file's own first version did not run either
 *
 * It was written to `src/lib/` while `package.json` was given `src/`. It
 * therefore sat on disk, listed, and silent: a guard against untested files that
 * was itself untested. The `CONTROL` case below — *the scan can see this very
 * file* — is what makes that state impossible to repeat, and it is the first
 * assertion for exactly that reason.
 *
 * A glob in the script would delete the whole problem. It is not done here
 * because discovery must behave identically on Node 24 locally and Node 20 on
 * the VPS, and shell glob expansion differs on Windows. Changing how every test
 * in the project is discovered does not belong inside a requirement about
 * Telegram commands.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // src/lib/
const SRC = resolve(HERE, "..");
const APP_ROOT = resolve(SRC, "..");

function findTests(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("every test file is actually run", () => {
  const pkgPath = join(APP_ROOT, "package.json");
  const found = findTests(SRC).map((f) => relative(APP_ROOT, f).split(sep).join("/"));

  it("CONTROL: the scan can see THIS file", () => {
    // Placed first because everything below is meaningless without it. The
    // first version of this guard failed exactly here and never ran to say so.
    assert.ok(
      found.some((f) => f.endsWith("src/lib/test-registry.test.ts")),
      `the scanner is looking in the wrong place. scanned ${SRC}, found ${found.length} files`,
    );
  });

  it("CONTROL: package.json was found where this file expects it", () => {
    assert.ok(existsSync(pkgPath), `no package.json at ${pkgPath}`);
  });

  it("CONTROL: the scan found a realistic number of test files", () => {
    assert.ok(found.length > 10, `only found ${found.length} test files`);
  });

  it("no test file exists that the script never runs", () => {
    const script = (
      JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts: { test: string } }
    ).scripts.test;
    const missing = found.filter((f) => !script.includes(f));
    assert.deepEqual(
      missing,
      [],
      `these test files exist but are never run:\n  ${missing.join("\n  ")}`,
    );
  });

  it("the script does not list a file that no longer exists", () => {
    // The other direction. A renamed file leaves a dead entry, and the runner
    // reports "Could not find" on a line most readers scroll past.
    const script = (
      JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts: { test: string } }
    ).scripts.test;
    const listed = script.match(/src\/[^\s"]+\.test\.ts/g) ?? [];
    assert.ok(listed.length > 0, "no test paths parsed out of the script");
    const gone = listed.filter((f) => !found.includes(f));
    assert.deepEqual(gone, [], `listed but absent: ${gone.join(", ")}`);
  });
});
