/**
 * The full suite must run every test that exists.
 *
 * The test script in `package.json` is a hand-maintained list of files, so a new
 * test file runs only if someone remembers to add it. This guard exists because
 * a suite of sixty new cases was written, reported green, and had not been
 * executed at all — the total sat at 490 and nothing said otherwise.
 *
 * That is the `M-06` shape: a hand-maintained list drifting from the thing it
 * lists. The fix is the one used everywhere else here — let the machine notice.
 *
 * ## The invariant
 *
 *     a test file exists
 *     AND it belongs in the canonical suite
 *     BUT the suite does not execute it
 *     => FAIL
 *
 * Plus the three ways the list can be wrong in the other direction: a path that
 * no longer exists, the same file listed twice, and a file left out without
 * anyone saying so.
 *
 * ## This file's own first version did not run either
 *
 * It was written to `src/lib/` while `package.json` was given `src/`. It sat on
 * disk, listed, and silent: a guard against unrun tests that was itself never
 * run. The first `CONTROL` below — *the scan can see this very file* — is what
 * makes that state impossible to repeat, and it is first for exactly that reason.
 *
 * ## Why not auto-discovery
 *
 * A glob would delete the problem. It is not used because discovery must behave
 * identically on Node 24 locally and Node 20 on the VPS, and shell glob expansion
 * differs on Windows — the three environments this suite has to agree across.
 * The list stays explicit; the machine checks it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // src/lib/
const SRC = resolve(HERE, "..");
const APP_ROOT = resolve(SRC, "..");
const PKG = join(APP_ROOT, "package.json");

/**
 * Test files deliberately kept out of the full suite.
 *
 * Empty, and the mechanism matters more than the current contents: an exclusion
 * has to be written down *here*, with a reason, so that leaving a file out is a
 * decision somebody made rather than a thing that happened. Without it, the only
 * way to exclude a file is to forget it — which is indistinguishable from the
 * bug this guard exists to catch.
 */
const EXCLUDED: ReadonlyArray<{ path: string; reason: string }> = [];

function findTestFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...findTestFiles(full));
		// `.test.ts` only. Fixtures, helpers and probes do not match, which is
		// why that naming convention is load-bearing rather than cosmetic: a
		// helper named `*.test.ts` would be executed as a suite and would pass
		// by containing nothing.
		else if (entry.name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function readScript(): string {
	return (JSON.parse(readFileSync(PKG, "utf8")) as { scripts: { test: string } }).scripts.test;
}

function listedPaths(script: string): string[] {
	return script.match(/src\/[^\s"]+\.test\.ts/g) ?? [];
}

const found = findTestFiles(SRC).map((f) => relative(APP_ROOT, f).split(sep).join("/"));

describe("full-suite completeness", () => {
	it("CONTROL: the scan can see THIS file", () => {
		// Everything below is meaningless without it. The first version of this
		// guard failed exactly here and never ran to say so.
		assert.ok(
			found.some((f) => f.endsWith("src/lib/test-registry.test.ts")),
			`the scanner is looking in the wrong place. scanned ${SRC}, found ${found.length} files`,
		);
	});

	it("CONTROL: package.json is where this file expects it", () => {
		assert.ok(existsSync(PKG), `no package.json at ${PKG}`);
	});

	it("CONTROL: the scan found a realistic number of test files", () => {
		assert.ok(found.length > 10, `only found ${found.length} test files`);
	});

	it("no test file exists that the suite never runs", () => {
		const script = readScript();
		const excluded = new Set(EXCLUDED.map((e) => e.path));
		const missing = found.filter((f) => !script.includes(f) && !excluded.has(f));
		assert.deepEqual(
			missing,
			[],
			`these test files exist but are never run:\n  ${missing.join("\n  ")}`,
		);
	});

	it("the suite does not list a file that no longer exists", () => {
		// A renamed file leaves a dead entry, and the runner reports
		// "Could not find" on a line most readers scroll past.
		const listed = listedPaths(readScript());
		assert.ok(listed.length > 0, "no test paths parsed out of the script");
		const gone = listed.filter((f) => !found.includes(f));
		assert.deepEqual(gone, [], `listed but absent: ${gone.join(", ")}`);
	});

	it("no file is listed twice -- a double run inflates the count", () => {
		const listed = listedPaths(readScript());
		const seen = new Set<string>();
		const dupes = listed.filter((f) => (seen.has(f) ? true : (seen.add(f), false)));
		assert.deepEqual(dupes, [], `listed more than once: ${dupes.join(", ")}`);
	});

	it("the counts agree, so no total is taken on trust", () => {
		const listed = listedPaths(readScript());
		assert.equal(
			listed.length,
			found.length - EXCLUDED.length,
			`the script lists ${listed.length} files, ${found.length} exist, ${EXCLUDED.length} are excluded`,
		);
	});

	it("every exclusion is a recorded decision with a reason", () => {
		for (const e of EXCLUDED) {
			assert.ok(found.includes(e.path), `excluded file does not exist: ${e.path}`);
			assert.ok(e.reason.trim().length > 10, `exclusion needs a real reason: ${e.path}`);
		}
	});

	// ── The regression fixture ────────────────────────────────────
	//
	// The cases above check today's list. This checks that the CHECK works, by
	// creating a real test file on disk and asserting the completeness
	// computation flags it. A synthetic array would exercise the comparison; a
	// real file exercises the scan, the path normalisation and the comparison
	// together — and the scan is the part that was wrong the first time.
	it("REGRESSION: a new test file that the suite does not list is caught", () => {
		const dir = join(SRC, "lib", "__completeness_fixture__");
		const file = join(dir, "planted.test.ts");
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, "// planted by test-registry.test.ts; removed in finally");

			const rescanned = findTestFiles(SRC).map((f) =>
				relative(APP_ROOT, f).split(sep).join("/"),
			);
			const planted = "src/lib/__completeness_fixture__/planted.test.ts";

			// The mutation landed: the scan sees the new file. Without this the
			// case below would pass whenever the scan was broken.
			assert.ok(rescanned.includes(planted), "the planted file was not discovered");

			// And the rule reports it missing. `includes`, not an exact-array
			// comparison: a genuine omission elsewhere has its own case, and
			// asserting the exact set here would make two different defects
			// arrive under one name.
			const missing = rescanned.filter((f) => !readScript().includes(f));
			assert.ok(
				missing.includes(planted),
				`the completeness check did not flag the planted file; it saw ${missing.length} missing`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("CONTROL: the fixture cleaned up after itself", () => {
		// A leftover fixture would fail the real completeness case on the next
		// run, for a reason that has nothing to do with the codebase.
		assert.equal(existsSync(join(SRC, "lib", "__completeness_fixture__")), false);
	});
});
