/**
 * P3-R02 — run the REAL query functions against a real database.
 *
 *   DATABASE_URL=<scratch> npx tsx deploy/r02-queries-probe.ts
 *
 * `AC-03`, `AC-03b` and `AC-07` are claims about what comes back from the
 * database. A unit test with hand-built rows cannot make them: it would prove
 * the projection functions work on data the test invented, which is the part
 * that was never in doubt.
 *
 * So this imports `command-queries.ts` itself — the same module the commands
 * use — seeds deliberately awkward data, and prints what the queries returned.
 * The shell harness asserts on that output. Nothing is re-implemented here; a
 * probe that re-wrote the SQL would be comparing a query with a copy of itself.
 *
 * Every case runs inside a transaction that is rolled back.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import {
  fetchActiveJobs,
  fetchContentPlan,
  fetchProject,
  fetchStatusCounts,
} from "../src/lib/telegram/command-queries";
import { projectContentPlan, projectStatus } from "../src/lib/telegram/command-policy";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (url.includes("dongchannel_ops")) {
  throw new Error("that is the production database -- use a scratch database");
}
if (!/scratch|test|tmp|_ci/.test(url)) {
  throw new Error("the scratch URL must be clearly named scratch/test/tmp");
}

const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client);

const out: Record<string, unknown> = {};

async function main() {
  await db.transaction(async (tx) => {
    // ── Seed ──────────────────────────────────────────────────────
    //
    // The scores are inserted in an order that does NOT match their values, and
    // the highest-scoring opportunity is inserted LAST. A query missing its
    // ORDER BY would return insertion order and look plausible; this makes that
    // failure visible.
    await tx.execute(sql`
      INSERT INTO content_opportunities (id, origin_type, content_mode, opportunity_key, title, status)
      VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001','OWNER_SEED','EVERGREEN','k1','low',   'PROPOSED'),
        ('aaaaaaaa-0000-4000-8000-000000000002','OWNER_SEED','EVERGREEN','k2','unscored','PROPOSED'),
        ('aaaaaaaa-0000-4000-8000-000000000003','OWNER_SEED','EVERGREEN','k3','high',  'PROPOSED')
    `);
    await tx.execute(sql`
      INSERT INTO content_opportunity_scores
        (content_opportunity_id, scoring_config_version, inputs_fingerprint,
         raw_score, normalised_score, breakdown, known_dimensions, total_dimensions, computed_by)
      VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001','v1','f1', 10, 10, '{}'::jsonb, 1, 1, 'probe'),
        ('aaaaaaaa-0000-4000-8000-000000000003','v1','f3', 90, 90, '{}'::jsonb, 1, 1, 'probe')
    `);
    // A superseded score for the high opportunity, inserted FIRST in value order
    // but EARLIER in time, so "latest per opportunity" is doing real work: if the
    // query took any row rather than the newest, `high` would score 5 and sort last.
    await tx.execute(sql`
      INSERT INTO content_opportunity_scores
        (content_opportunity_id, scoring_config_version, inputs_fingerprint,
         raw_score, normalised_score, breakdown, known_dimensions, total_dimensions, computed_by, created_at)
      VALUES
        ('aaaaaaaa-0000-4000-8000-000000000003','v0','f3-old', 5, 5, '{}'::jsonb, 1, 1, 'probe', now() - interval '1 day')
    `);

    await tx.execute(sql`
      INSERT INTO profiles (slug, name) VALUES ('aff','AFF') ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO tasks (id, code, profile_slug, title, status)
      VALUES
        ('bbbbbbbb-0000-4000-8000-000000000001','T-1','aff','running',   'RUNNING'),
        ('bbbbbbbb-0000-4000-8000-000000000002','T-2','aff','done',      'COMPLETED'),
        ('bbbbbbbb-0000-4000-8000-000000000003','T-3','aff','failed one','FAILED'),
        ('bbbbbbbb-0000-4000-8000-000000000004','T-4','aff','cancelled', 'CANCELLED')
    `);

    // ── AC-03 ─────────────────────────────────────────────────────
    const plan = await fetchContentPlan(tx as never);
    out.planTitles = plan.map((r) => r.title);
    out.planScores = plan.map((r) => r.normalisedScore);
    out.planRendered = projectContentPlan(plan).map((l) => `${l.title}:${l.score}`);

    // ── AC-03b ────────────────────────────────────────────────────
    const jobs = await fetchActiveJobs(tx as never);
    out.activeTitles = jobs.map((j) => j.title).sort();
    out.activeStatuses = [...new Set(jobs.map((j) => j.status))].sort();

    // ── AC-07 ─────────────────────────────────────────────────────
    const counts = await fetchStatusCounts(tx as never);
    out.statusCounts = counts;
    out.statusRendered = projectStatus(counts).map((l) => `${l.label}=${l.value}`);

    // ── AC-02 NOT_FOUND is a real absence, read back ──────────────
    out.missingProject = await fetchProject(tx as never, "cccccccc-0000-4000-8000-00000000dead");

    throw new Rollback();
  }).catch((e: unknown) => {
    if (!(e instanceof Rollback)) throw e;
  });

  console.log(JSON.stringify(out));
  await client.end({ timeout: 5 });
}

class Rollback extends Error {}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
