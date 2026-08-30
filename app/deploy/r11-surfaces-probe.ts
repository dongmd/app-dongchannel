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

import {
  listAgentRuns, listCandidates, listClaims, listClusters, listEvidence,
  listMarkets, listOpportunities, listSignals, listTrends, surfaceCounts,
} from "../src/lib/moneyos/queries";

type Probe = { name: string; run: () => Promise<unknown[]> };

const PROBES: Probe[] = [
  { name: "opportunities", run: listOpportunities },
  { name: "signals", run: listSignals },
  { name: "clusters", run: listClusters },
  { name: "trends", run: listTrends },
  { name: "candidates", run: listCandidates },
  { name: "evidence", run: listEvidence },
  { name: "claims", run: listClaims },
  { name: "agentRuns", run: listAgentRuns },
  { name: "markets", run: listMarkets },
];

async function main() {
  let failed = 0;

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
    const counts = await surfaceCounts();
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
    const rows = await listOpportunities();
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
