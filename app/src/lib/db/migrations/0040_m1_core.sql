-- M1 core (TDD 6.5). Additive only. New columns on `tasks` are nullable or defaulted so the previous release can still read and write `tasks`
-- (compatibility must still be proven by TDD 14.7 before release).
CREATE TABLE IF NOT EXISTS "lumi_actors" (
  "actor_ref" text PRIMARY KEY,
  "role" text NOT NULL CHECK ("role" IN ('OWNER','ADMIN','VIEWER')),
  "channel" text NOT NULL DEFAULT 'ANY',
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "area" text NOT NULL CHECK ("area" IN ('AFFILIATE','YOUTUBE','WEBSITE','OTHER')),
  "goal" text,
  "pm_actor_ref" text,
  "pm_assistant_id" uuid,
  "affiliate_project_id" uuid UNIQUE REFERENCES "affiliate_projects"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','ARCHIVED')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_projects_one_pm" CHECK (NOT ("pm_actor_ref" IS NOT NULL AND "pm_assistant_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_projects_name_uq" ON "lumi_projects" (lower("name"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_assistants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "avatar" text,
  "role_label" text NOT NULL DEFAULT '',
  "description" text,
  "capabilities" jsonb NOT NULL DEFAULT '[]',
  "kind" text NOT NULL DEFAULT 'SPECIALIST' CHECK ("kind" IN ('SPECIALIST','PM')),
  "hermes_profile" text UNIQUE REFERENCES "profiles"("slug"),
  "connection_state" text NOT NULL DEFAULT 'NONE' CHECK ("connection_state" IN ('NONE','VERIFIED','FAILED')),
  "connection_checked_at" timestamptz,
  "connection_error" text,
  "execution_level" smallint NOT NULL DEFAULT 0,
  "tool_allowlist" jsonb NOT NULL DEFAULT '[]',
  "dispatch_paused" boolean NOT NULL DEFAULT false,
  "dispatch_enabled" boolean NOT NULL DEFAULT false,
  "max_runs_per_day" integer,
  "run_deadline_seconds" integer,
  "ack_deadline_seconds" integer,
  "max_run_failures" smallint,
  "max_transport_attempts" smallint,
  "max_revision_rounds" smallint,
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','ARCHIVED')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_project_members" (
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id") ON DELETE CASCADE,
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'MEMBER',
  PRIMARY KEY ("project_id","assistant_id")
);--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_task_code_seq";--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "lumi_projects"("id"),
  ADD COLUMN IF NOT EXISTS "owner_kind" text CHECK ("owner_kind" IN ('BOT','HUMAN')),
  ADD COLUMN IF NOT EXISTS "owner_assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  ADD COLUMN IF NOT EXISTS "owner_actor_ref" text,
  ADD COLUMN IF NOT EXISTS "source_key" text,
  ADD COLUMN IF NOT EXISTS "error_code" text,
  ADD COLUMN IF NOT EXISTS "error_message" text,
  ADD COLUMN IF NOT EXISTS "hold_reason" text,
  ADD COLUMN IF NOT EXISTS "due_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "expected_output" text,
  ADD COLUMN IF NOT EXISTS "current_output_id" uuid,
  ADD COLUMN IF NOT EXISTS "revision_round" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "needs_decision" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_source_key_uq" ON "tasks" ("source_key") WHERE "source_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_kind_chk" CHECK (
  "owner_kind" IS NULL OR ("owner_kind"='BOT' AND "owner_assistant_id" IS NOT NULL) OR ("owner_kind"='HUMAN' AND "owner_actor_ref" IS NOT NULL));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_intake_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_key" text NOT NULL UNIQUE,
  "channel" text NOT NULL CHECK ("channel" IN ('TELEGRAM','WEB')),
  "actor_ref" text NOT NULL,
  "assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "raw_text" text NOT NULL CHECK (length("raw_text") <= 4000),
  "parsed" jsonb NOT NULL DEFAULT '{}',
  "missing" text[] NOT NULL DEFAULT '{}',
  "state" text NOT NULL DEFAULT 'OPEN' CHECK ("state" IN ('OPEN','CONFIRMED','EXPIRED','CANCELLED')),
  "version" integer NOT NULL DEFAULT 1,
  "expires_at" timestamptz NOT NULL,
  "task_id" uuid REFERENCES "tasks"("id"),
  "confirmed_by" text,
  "confirmed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_intake_confirmed_has_task" CHECK ("state" <> 'CONFIRMED' OR "task_id" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_intake_state_idx" ON "lumi_intake_drafts" ("state","expires_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_task_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "attempt_no" integer NOT NULL,
  "assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "run_kind" text NOT NULL CHECK ("run_kind" IN ('INITIAL','RETRY','REVISION','REASSIGN')),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','DISPATCHED','DISPATCH_UNCERTAIN','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','STOPPED_CAP','ABANDONED','CANCELLED')),
  "dispatch_key" text NOT NULL UNIQUE,
  "hermes_session_ref" text,
  "ack_deadline_at" timestamptz,
  "acked_at" timestamptz,
  "deadline_at" timestamptz,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "remote_stop_state" text NOT NULL DEFAULT 'NONE' CHECK ("remote_stop_state" IN ('NONE','REQUESTED','CONFIRMED','UNKNOWN')),
  "error_code" text,
  "error_message" text,
  "instruction_snapshot" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_runs_task_attempt_uq" UNIQUE ("task_id","attempt_no"),
  CONSTRAINT "lumi_runs_finish_after_start" CHECK ("finished_at" IS NULL OR "started_at" IS NULL OR "finished_at" >= "started_at"),
  CONSTRAINT "lumi_runs_failed_has_code" CHECK ("state" NOT IN ('FAILED','TIMED_OUT') OR "error_code" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_runs_one_open_per_task" ON "lumi_task_runs" ("task_id") WHERE "state" IN ('PENDING','DISPATCHED','DISPATCH_UNCERTAIN','RUNNING');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_runs_state_deadline_idx" ON "lumi_task_runs" ("state","deadline_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_task_outputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "run_id" uuid REFERENCES "lumi_task_runs"("id"),
  "version" integer NOT NULL,
  "content" text NOT NULL,
  "format" text NOT NULL DEFAULT 'markdown',
  "sources" jsonb NOT NULL DEFAULT '[]',
  "submitted_by" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "late" boolean NOT NULL DEFAULT false,
  "adopted_at" timestamptz,
  "adopted_by" text,
  "state" text NOT NULL DEFAULT 'SUBMITTED' CHECK ("state" IN ('SUBMITTED','LATE_SAVED','APPROVED','REVISION_REQUESTED','REJECTED','SUPERSEDED','DISCARDED')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_outputs_task_version_uq" UNIQUE ("task_id","version"),
  CONSTRAINT "lumi_outputs_task_idem_uq" UNIQUE ("task_id","idempotency_key")
);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_output_fk" FOREIGN KEY ("current_output_id") REFERENCES "lumi_task_outputs"("id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL CHECK ("kind" IN ('OUTPUT','KNOWLEDGE','ACTION')),
  "object_id" uuid NOT NULL,
  "object_version" integer NOT NULL,
  "scope_ref" text,
  "decision" text NOT NULL CHECK ("decision" IN ('APPROVE','REVISE','REJECT')),
  "reason" text,
  "decided_by" text NOT NULL,
  "channel" text NOT NULL CHECK ("channel" IN ('WEB','TELEGRAM_APP','TELEGRAM_HERMES')),
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_approvals_final_uq" UNIQUE ("kind","object_id","object_version"),
  CONSTRAINT "lumi_approvals_reason_chk" CHECK ("decision" = 'APPROVE' OR length(coalesce("reason",'')) >= 3)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "aggregate_type" text,
  "aggregate_id" uuid,
  "dedupe_key" text NOT NULL UNIQUE,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','LEASED','DONE','DEAD')),
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "lease_owner" text,
  "lease_epoch" integer NOT NULL DEFAULT 0,
  "lease_expires_at" timestamptz,
  "last_error" text,
  "done_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_outbox_due_idx" ON "lumi_outbox" ("next_attempt_at") WHERE "state" IN ('PENDING','LEASED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_system_flags" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "set_by" text,
  "set_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
INSERT INTO "profiles" ("slug","name","type","status") VALUES ('owner','Chủ (người thật)','system','active'),('unassigned','Chưa gán','system','active') ON CONFLICT ("slug") DO NOTHING;
