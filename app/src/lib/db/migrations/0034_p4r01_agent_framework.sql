--> P4-R01 — the agent framework's two tables.
-->
--> `agent_runs` records every attempt to run an agent, including the attempts
--> the framework refused before anything started. `model_policies` makes model
--> routing a row rather than a literal at a call site.
-->
--> ## Why the CHECK constraints, when agent-policy.ts already refuses
-->
--> `buildRunRecord` refuses a SUCCEEDED run with no finish time, a FAILED run
--> with no error code, and the rest. That protects the one path that goes
--> through it. It does nothing about a hand-written INSERT during an incident,
--> a repair script, or a future requirement that reaches for the table
--> directly -- and those are exactly the moments when the audit trail matters
--> most.
-->
--> AC-06 asks that a FAILED run be distinguishable from one that NEVER
--> STARTED and from one still in flight. A nullable start time with no
--> constraint makes all three representable as the same row, and no query
--> could then tell them apart. So the distinction is a database rule.
-->
--> ## Nullable cost is a decision, not an omission
-->
--> A provider that does not report cost yields NULL. Writing 0 there would
--> make an unreported cost and a free run the same fact, and a SUM over the
--> column would be wrong while looking entirely correct. This is the P2
--> UNKNOWN-is-not-zero invariant arriving in the agent layer.

DO $$ BEGIN
  CREATE TYPE "agent_run_state" AS ENUM ('PENDING','RUNNING','SUCCEEDED','FAILED','REFUSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "agent_task_class" AS ENUM ('RESEARCH','STRATEGY','EVIDENCE','WRITING','QA','PUBLISHING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "agent_name"        text NOT NULL,
  "profile"           text NOT NULL,
  "task_class"        "agent_task_class" NOT NULL,

  --> What the run was about. Free-form: P4-R02..R08 name their own entities,
  --> and constraining it here would mean editing this migration for each.
  "entity_type"       text NOT NULL,
  "entity_id"         text NOT NULL,

  --> NULL when the run was refused before a model was chosen.
  "provider"          text,
  "model"             text,

  "state"             "agent_run_state" NOT NULL,

  "started_at"        timestamptz,
  "finished_at"       timestamptz,

  "prompt_tokens"     numeric,
  "completion_tokens" numeric,
  "cost_usd"          numeric(12,6),

  "error_code"        text,
  "error_message"     text,

  "created_at"        timestamptz NOT NULL DEFAULT now(),

  --> AC-06. The three states are kept distinguishable by construction.
  CONSTRAINT "agent_runs_never_started_has_no_times"
    CHECK (state NOT IN ('PENDING','REFUSED')
           OR (started_at IS NULL AND finished_at IS NULL)),

  CONSTRAINT "agent_runs_running_has_start_only"
    CHECK (state <> 'RUNNING'
           OR (started_at IS NOT NULL AND finished_at IS NULL)),

  CONSTRAINT "agent_runs_terminal_has_both_times"
    CHECK (state NOT IN ('SUCCEEDED','FAILED')
           OR (started_at IS NOT NULL AND finished_at IS NOT NULL)),

  --> A failed run that cannot say why is a row that satisfies a schema and
  --> answers no question.
  CONSTRAINT "agent_runs_failed_has_error_code"
    CHECK (state NOT IN ('FAILED','REFUSED') OR error_code IS NOT NULL),

  --> And a successful run carrying an error code would make the state column
  --> untrustworthy in the other direction.
  CONSTRAINT "agent_runs_succeeded_has_no_error"
    CHECK (state <> 'SUCCEEDED' OR (error_code IS NULL AND error_message IS NULL)),

  CONSTRAINT "agent_runs_finish_after_start"
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),

  --> AC-05. NULL is permitted -- it means "not reported". A NEGATIVE token
  --> count or cost is not a fact about anything.
  CONSTRAINT "agent_runs_usage_non_negative"
    CHECK ((prompt_tokens     IS NULL OR prompt_tokens     >= 0)
       AND (completion_tokens IS NULL OR completion_tokens >= 0)
       AND (cost_usd          IS NULL OR cost_usd          >= 0))
);

CREATE INDEX IF NOT EXISTS "agent_runs_entity_idx" ON "agent_runs" ("entity_type","entity_id");
CREATE INDEX IF NOT EXISTS "agent_runs_state_idx"  ON "agent_runs" ("state","created_at");
CREATE INDEX IF NOT EXISTS "agent_runs_agent_idx"  ON "agent_runs" ("agent_name","created_at");


--> AC-08. Model routing as data.
CREATE TABLE IF NOT EXISTS "model_policies" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_class"  "agent_task_class" NOT NULL,
  "provider"    text NOT NULL,
  "model"       text NOT NULL,

  --> Text rather than boolean so the partial unique index below reads the same
  --> way in every tool that inspects it.
  "active"      text NOT NULL DEFAULT 'true',

  --> Why this routing was chosen. Read by a human, never by code.
  "note"        text,

  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "model_policies_active_boolean" CHECK (active IN ('true','false'))
);

--> The load-bearing constraint of AC-08. At most ONE active policy per task
--> class, so routing cannot depend on row order. `routeModel` refuses ambiguity
--> in the application; this makes ambiguity unrepresentable, which is the
--> difference between a rule and a habit.
CREATE UNIQUE INDEX IF NOT EXISTS "model_policies_one_active_per_class"
  ON "model_policies" ("task_class") WHERE active = 'true';


--> AC-07 is NOT enforced here, and the reason is worth recording.
-->
--> "No agent writes to a Source of Truth another phase owns" is a property of
--> the CALLER, and the database cannot see which application module opened the
--> connection. A trigger on `article_approvals` refusing writes "from an agent"
--> would need a flag the agent itself set, which an agent could equally not
--> set.
-->
--> It is enforced structurally instead, in `runner.ts`: model output is data
--> and never a command. Nothing a model returns is dispatched or used to select
--> a code path, and a tool is chosen by the CALLER from the agent's declared
--> list -- never by a string the model produced. An agent therefore has no
--> mechanism by which to name `article_approvals` as a destination. The
--> `FORBIDDEN_AGENT_WRITES` list and `agent-boundary.test.ts` assert the
--> property on the import graph, which is where it is actually decidable.
