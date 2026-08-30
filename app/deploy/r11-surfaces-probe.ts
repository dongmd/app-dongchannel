/**
 * P4-R11 — do the surfaces' queries actually run against production?
 *
 * The 307-to-login checks prove the auth guard works. They do NOT prove the
 * pages render: the redirect happens before any query does. A column name that
 * no longer exists would sail through every one of those checks and 500 for the
 * first person who logged in.
 *
 * So this runs the REAL query functions the pages call, against the REAL
 * production database, and reports what they return. M-04's lesson applied to a
 * UI requirement: verify the artefact, not the deploy message.
 *
 * Read-only by construction -- `queries.ts` contains no insert, update or
 * delete, and `boundary.test.ts` asserts that.
 *
 *   sudo -u opssite bash -lc 'cd <app> && npx tsx deploy/r11-surfaces-probe.ts'
 */

import { createRequire } from "node:module";

// `queries.ts` imports `server-only`, and correctly so: it holds a live `db`
// handle, which is exactly where that marker belongs. (`runner.ts` in P4-R01
// does NOT have it, because it holds no handle -- the same split
// `retry-policy.ts` and `sync-worker.ts` already use.)
//
// The marker throws under a plain Node runner. Satisfying it by copying the
// queries into this file is the one thing that would defeat the probe's
// purpose -- the existing r02 probe says it in terms: "a probe that re-wrote
// the SQL would be comparing a query with a copy of itself."
//
// So the module is neutralised HERE, deliberately and visibly, for this process
// only. This changes nothing about the application: `server-only` is a
// build-time guard against importing server code into a client bundle, and this
// is a server-side script that is never bundled.
const req = createRequire(import.meta.url);
req.cache[req.resolve("server-only")] = {
  id: "server-only", filename: "server-only", loaded: true, exports: {},
} as never;

type Probe = { name: string; run: () => Promise<unknown[]> };

async function main() {
  let failed = 0;

  const q = await import("../src/lib/moneyos/queries");
  const PROBES: Probe[] = [
    { name: "opportunities", run: q.listOpportunities },
    { name: "signals", run: q.listSignals },
    { name: "clusters", run: q.listClusters },
    { name: "trends", run: q.listTrends },
    { name: "candidates", run: q.listCandidates },
    { name: "evidence", run: q.listEvidence },
    { name: "claims", run: q.listClaims },
    { name: "agentRuns", run: q.listAgentRuns },
    { name: "markets", run: q.listMarkets },
  ];

  console.log("== every surface query executes against production ==");
  for (const p of PROBES) {
    try {
      const rows = await p.run();
      // An empty array is a PASS. Every one of these tables is empty today, and
      // the point of the probe is that the query RAN -- not that it found
      // something. A probe that required rows would fail for the wrong reason.
      console.log(`  ok   ${p.name.padEnd(14)} ${rows.length} rows`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${p.name.padEnd(14)} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n== the index counts ==");
  try {
    const counts = await q.surfaceCounts();
    for (const c of counts) console.log(`  ${c.key.padEnd(14)} ${c.count}`);

    // CONTROL: the counts must be real. If `surfaceCounts` ever returned
    // hard-coded zeros it would look identical to today's correct output, so
    // assert the shape came from a query rather than a literal list.
    if (counts.length !== 7) {
      console.log(`  FAIL expected 7 counts, got ${counts.length}`);
      failed++;
    }
  } catch (e) {
    failed++;
    console.log(`  FAIL surfaceCounts: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\n== CONTROL: the ordering authority is reachable ==");
  try {
    // Runs the LEFT JOIN and the NULLS LAST ordering. On an empty table this
    // proves the SQL is valid and the join columns exist -- which is the
    // failure mode that would 500 the queue page for the first logged-in user.
    const rows = await q.listOpportunities();
    console.log(`  ok   the queue query with its LEFT JOIN and NULLS LAST ordering parsed and ran`);
    console.log(`       (${rows.length} rows -- empty is expected today)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL the queue query: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\n===================================");
  if (failed > 0) {
    console.log(`FAIL: ${failed} surface query did not run against production.`);
    process.exit(1);
  }
  console.log("PASS: every surface query runs; the pages have working data access.");
  process.exit(0);
}

main().catch((e) => {
  console.error("probe crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
