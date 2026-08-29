import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * P4-R01 — `agent_runs` and `model_policies`.
 *
 * The constraints live in `0034_p4r01_agent_framework.sql`. These declarations
 * exist so the ORM and the type system know the tables; a rule written only
 * here would be a rule the database does not enforce, and `P3` established
 * that persistence invariants belong in the migration.
 */

export const agentRunState = pgEnum("agent_run_state", [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REFUSED",
]);

export const agentTaskClass = pgEnum("agent_task_class", [
  "RESEARCH",
  "STRATEGY",
  "EVIDENCE",
  "WRITING",
  "QA",
  "PUBLISHING",
]);

/**
 * AC-05/AC-06. One row per attempt to run an agent, including the attempts the
 * framework refused before anything started.
 *
 * The token and cost columns are **nullable on purpose**. A provider that does
 * not report cost yields `NULL`, never `0` — summing a column where the second
 * has been written as the first gives a total that is wrong and looks right.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    agentName: text("agent_name").notNull(),
    profile: text("profile").notNull(),
    taskClass: agentTaskClass("task_class").notNull(),

    /** What the run was about. Free-form by design: P4-R02..R08 name their own. */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),

    /** NULL when the run was refused before a model was chosen. */
    provider: text("provider"),
    model: text("model"),

    state: agentRunState("state").notNull(),

    /** NULL for PENDING and REFUSED: those never started. AC-06. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    promptTokens: numeric("prompt_tokens"),
    completionTokens: numeric("completion_tokens"),
    /** USD. NULL = the provider did not report it. Never 0 to mean unknown. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),

    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_runs_entity_idx").on(t.entityType, t.entityId),
    index("agent_runs_state_idx").on(t.state, t.createdAt),
    index("agent_runs_agent_idx").on(t.agentName, t.createdAt),

    // AC-06 as a database rule, not a convention. Mirrors `buildRunRecord`;
    // both exist because the policy module cannot stop a hand-written INSERT.
    check(
      "agent_runs_never_started_has_no_times",
      sql`(${t.state} NOT IN ('PENDING','REFUSED')) OR (${t.startedAt} IS NULL AND ${t.finishedAt} IS NULL)`,
    ),
    check(
      "agent_runs_running_has_start_only",
      sql`(${t.state} <> 'RUNNING') OR (${t.startedAt} IS NOT NULL AND ${t.finishedAt} IS NULL)`,
    ),
    check(
      "agent_runs_terminal_has_both_times",
      sql`(${t.state} NOT IN ('SUCCEEDED','FAILED')) OR (${t.startedAt} IS NOT NULL AND ${t.finishedAt} IS NOT NULL)`,
    ),
    check(
      "agent_runs_failed_has_error_code",
      sql`(${t.state} NOT IN ('FAILED','REFUSED')) OR (${t.errorCode} IS NOT NULL)`,
    ),
    check(
      "agent_runs_succeeded_has_no_error",
      sql`(${t.state} <> 'SUCCEEDED') OR (${t.errorCode} IS NULL AND ${t.errorMessage} IS NULL)`,
    ),
    check(
      "agent_runs_finish_after_start",
      sql`${t.finishedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.finishedAt} >= ${t.startedAt}`,
    ),
    check(
      "agent_runs_usage_non_negative",
      sql`(${t.promptTokens} IS NULL OR ${t.promptTokens} >= 0)
          AND (${t.completionTokens} IS NULL OR ${t.completionTokens} >= 0)
          AND (${t.costUsd} IS NULL OR ${t.costUsd} >= 0)`,
    ),
  ],
);

/**
 * AC-08. Model routing as data.
 *
 * The partial unique index is the load-bearing part: **at most one active
 * policy per task class**. Without it, routing would depend on row order, and
 * the same task would quietly change model when an unrelated row was edited.
 * `routeModel` refuses ambiguity in the application; this makes ambiguity
 * unrepresentable.
 */
export const modelPolicies = pgTable(
  "model_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskClass: agentTaskClass("task_class").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    active: text("active").notNull().default("true"),

    /** Why this routing was chosen. Read by a human, not by code. */
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("model_policies_one_active_per_class")
      .on(t.taskClass)
      .where(sql`${t.active} = 'true'`),
    check("model_policies_active_boolean", sql`${t.active} IN ('true','false')`),
  ],
);
