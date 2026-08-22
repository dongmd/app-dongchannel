/**
 * P3-R02 — the reads behind the commands.
 *
 * Separated from `command-policy.ts` because that module is pure and must stay
 * so: its ranking criterion is proven by feeding it rows in a deliberately wrong
 * order, which is only possible while it does not fetch its own.
 *
 * ## The database is asked, not the code's memory
 *
 * `AC-03` requires the displayed order to be the stored `P2-R03` score order,
 * `AC-03b` requires real job state, and `AC-07` requires every number in
 * `/status` to be one that was read back. Each function here issues the query
 * and returns what came out. Where a query cannot answer, the result is `null`
 * — never `0`, which would render as a healthy-looking fact nobody measured.
 *
 * ## Why `db` is a parameter
 *
 * The connection is injected rather than imported, so these run against a
 * throwaway database in a harness without a module-load-time `DATABASE_URL` and
 * without the app's connection pool. Importing the singleton would make every
 * one of these untestable except in production, which is the opposite of what
 * the criteria ask for.
 */

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { affiliateProjects } from "../db/schema/aff";
import { articleApprovals } from "../db/schema/approval";
import { contentOpportunities } from "../db/schema/opportunity-content";
import { contentOpportunityScores } from "../db/schema/opportunity-scoring";
import { tasks } from "../db/schema/tasks";
import { ACTIVE_JOB_STATES, type OpportunityRow } from "./command-policy";

/**
 * The shape used here, rather than the full drizzle type.
 *
 * Naming the concrete `PostgresJsDatabase<typeof schema>` would drag the schema
 * barrel — and with it every table in the project — into a module that touches
 * five of them.
 */
export type Db = {
  select: (...args: never[]) => never;
} & Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = any;

/**
 * `/contentplan` — AC-03.
 *
 * **The `ORDER BY` is here and nowhere else.** `projectContentPlan` preserves
 * whatever order it receives, so this clause is the entire ranking, and it names
 * the stored `P2-R03` score rather than recomputing anything.
 *
 * `NULLS LAST` is a decision, not a default: an opportunity nobody has scored is
 * not a low-scoring opportunity, and sorting it as though its score were zero
 * would be the `UNKNOWN`-is-not-false error expressed as an ordering.
 *
 * The score is the latest row per opportunity. Scores accumulate — a new config
 * version produces a new row rather than overwriting — so taking the maximum
 * `created_at` per opportunity is what "the current score" means.
 */
export async function fetchContentPlan(db: AnyDb, limit = 20): Promise<OpportunityRow[]> {
  const latest = db
    .select({
      opportunityId: contentOpportunityScores.contentOpportunityId,
      normalisedScore: contentOpportunityScores.normalisedScore,
      rn: sql<number>`row_number() over (
        partition by ${contentOpportunityScores.contentOpportunityId}
        order by ${contentOpportunityScores.createdAt} desc
      )`.as("rn"),
    })
    .from(contentOpportunityScores)
    .as("latest");

  const rows = await db
    .select({
      id: contentOpportunities.id,
      title: contentOpportunities.title,
      normalisedScore: latest.normalisedScore,
    })
    .from(contentOpportunities)
    .leftJoin(latest, and(eq(latest.opportunityId, contentOpportunities.id), eq(latest.rn, 1)))
    .orderBy(sql`${latest.normalisedScore} desc nulls last`)
    .limit(limit);

  return rows as OpportunityRow[];
}

/** `/queue` — AC-03b. Real job state, read back. */
export async function fetchActiveJobs(db: AnyDb, limit = 20) {
  return (await db
    .select({
      id: tasks.id,
      code: tasks.code,
      title: tasks.title,
      status: tasks.status,
    })
    .from(tasks)
    .where(inArray(tasks.status, ACTIVE_JOB_STATES as unknown as (typeof tasks.$inferSelect)["status"][]))
    .orderBy(desc(tasks.createdAt))
    .limit(limit)) as { id: string; code: string; title: string; status: string }[];
}

/** `/projects`. */
export async function fetchProjects(db: AnyDb, limit = 20) {
  return (await db
    .select({ id: affiliateProjects.id, name: affiliateProjects.name, status: affiliateProjects.status })
    .from(affiliateProjects)
    .orderBy(desc(affiliateProjects.createdAt))
    .limit(limit)) as { id: string; name: string; status: string }[];
}

/** `/project <id>`. `null` means no such row — the `NOT_FOUND` refusal. */
export async function fetchProject(db: AnyDb, id: string) {
  const rows = (await db
    .select({ id: affiliateProjects.id, name: affiliateProjects.name, status: affiliateProjects.status })
    .from(affiliateProjects)
    .where(eq(affiliateProjects.id, id))
    .limit(1)) as { id: string; name: string; status: string }[];
  return rows[0] ?? null;
}

/**
 * `/status` — AC-07.
 *
 * Each field is a separate query, and each failure is caught **separately**.
 * One `try` around all three would let a single broken query turn the other two
 * into `null` as well, reporting three unknowns where two were known — which is
 * a different lie from the one this criterion forbids, but a lie.
 */
export async function fetchStatusCounts(db: AnyDb): Promise<{
  failedJobs: number | null;
  pendingApprovals: number | null;
  databaseReachable: boolean | null;
}> {
  let databaseReachable: boolean | null = null;
  try {
    await db.execute(sql`select 1`);
    databaseReachable = true;
  } catch {
    // False, not null: the probe ran and answered. `null` is reserved for a
    // question that was never put to the database at all.
    databaseReachable = false;
  }

  let failedJobs: number | null = null;
  try {
    const r = (await db
      .select({ n: count() })
      .from(tasks)
      .where(eq(tasks.status, "FAILED"))) as { n: number }[];
    failedJobs = Number(r[0]?.n ?? 0);
  } catch {
    failedJobs = null;
  }

  let pendingApprovals: number | null = null;
  try {
    // Pending: a LIVE approval.
    //
    // `P3-R04` does not mark an approval withdrawn -- there is no
    // `withdrawn_at`, because the table is immutable. A withdrawal is a
    // SEPARATE ROW whose `withdraws_id` points at the approval it retracts. So
    // "live" is two conditions: this row is not itself a withdrawal, and no
    // other row withdraws it. Reading a `withdrawn_at` column that does not
    // exist would have counted every withdrawal as pending, and counted every
    // retracted approval as still standing -- the worst possible direction for
    // a consent record to be wrong in.
    const r = (await db
      .select({ n: count() })
      .from(articleApprovals)
      .where(
        and(
          isNull(articleApprovals.withdrawsId),
          sql`not exists (
            select 1 from ${articleApprovals} w
            where w.withdraws_id = ${articleApprovals.id}
          )`,
        ),
      )) as { n: number }[];
    pendingApprovals = Number(r[0]?.n ?? 0);
  } catch {
    pendingApprovals = null;
  }

  return { failedJobs, pendingApprovals, databaseReachable };
}
