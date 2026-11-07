-- IMP-01 (TDD 14.11.B): mục tiêu → kế hoạch có phiên bản → ngân sách/sổ → báo cáo. CHỈ THÊM: bảng, dãy, cột nullable, chỉ mục, trigger,
-- và mở rộng CHECK của lumi_approvals.kind (thả-và-thêm-lại như 0043). Không đụng dữ liệu cũ; mã M1 cũ bỏ qua các cột mới.
CREATE SEQUENCE IF NOT EXISTS "lumi_goal_code_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_plan_code_seq";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "outcome" text NOT NULL CHECK (length("outcome") >= 3),
  "metrics" jsonb NOT NULL DEFAULT '{}',
  "period_start" timestamptz,
  "period_end" timestamptz,
  "constraints" jsonb NOT NULL DEFAULT '{}',
  "max_loss" numeric CHECK ("max_loss" IS NULL OR "max_loss" >= 0),
  "currency" text,
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','CLOSED','ARCHIVED')),
  "result" text CHECK ("result" IN ('ACHIEVED','NOT_ACHIEVED','INSUFFICIENT_DATA','ABANDONED')),
  "close_note" text,
  "source_key" text NOT NULL UNIQUE,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "closed_by" text,
  "closed_at" timestamptz,
  CONSTRAINT "lumi_goals_money_pair" CHECK (("max_loss" IS NULL) = ("currency" IS NULL)),
  CONSTRAINT "lumi_goals_closed_has_result" CHECK (("status" = 'CLOSED') = ("result" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "goal_id" uuid NOT NULL REFERENCES "lumi_goals"("id"),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "lead_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "status" text NOT NULL DEFAULT 'DRAFTING' CHECK ("status" IN ('DRAFTING','PENDING_APPROVAL','NEEDS_REVISION','DEFERRED','REJECTED','EXECUTING','PAUSED_ADJUSTMENT','PARTIAL_DONE','DONE','CANCELLED')),
  "current_version" integer NOT NULL DEFAULT 0,
  "approved_version" integer,
  "planning_task_id" uuid REFERENCES "tasks"("id"),
  "cancel_reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_plans_one_live_per_goal" ON "lumi_plans" ("goal_id") WHERE "status" NOT IN ('REJECTED','CANCELLED','DONE','PARTIAL_DONE');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_plan_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id" uuid NOT NULL REFERENCES "lumi_plans"("id"),
  "version" integer NOT NULL CHECK ("version" >= 1),
  "state" text NOT NULL DEFAULT 'SUBMITTED' CHECK ("state" IN ('SUBMITTED','APPROVED','REJECTED','SUPERSEDED','EXPIRED')),
  "body" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "ceiling_amount" numeric NOT NULL CHECK ("ceiling_amount" >= 0),
  "currency" text NOT NULL,
  "est_low" numeric,
  "est_base" numeric,
  "est_high" numeric,
  "submitted_by" text NOT NULL,
  "submitted_run_id" uuid REFERENCES "lumi_task_runs"("id"),
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  CONSTRAINT "lumi_plan_versions_uq" UNIQUE ("plan_id","version"),
  CONSTRAINT "lumi_plan_versions_run_uq" UNIQUE ("plan_id","submitted_run_id")
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_plan_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.ceiling_amount IS DISTINCT FROM OLD.ceiling_amount
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_run_id IS DISTINCT FROM OLD.submitted_run_id THEN
    RAISE EXCEPTION 'lumi_plan_versions content is immutable (only state may change)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_plan_versions_immutable_trg ON "lumi_plan_versions";--> statement-breakpoint
CREATE TRIGGER lumi_plan_versions_immutable_trg BEFORE UPDATE ON "lumi_plan_versions" FOR EACH ROW EXECUTE FUNCTION lumi_plan_versions_immutable();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id" uuid NOT NULL REFERENCES "lumi_plans"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('PREPARE','EXECUTE')),
  "currency" text,
  "ceiling" numeric CHECK ("ceiling" IS NULL OR "ceiling" >= 0),
  "actual" numeric NOT NULL DEFAULT 0 CHECK ("actual" >= 0),
  "committed" numeric NOT NULL DEFAULT 0 CHECK ("committed" >= 0),
  "reserve" numeric NOT NULL DEFAULT 0 CHECK ("reserve" >= 0),
  "unknown_count" integer NOT NULL DEFAULT 0 CHECK ("unknown_count" >= 0),
  "state" text NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','CLOSED')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_budgets_plan_kind_uq" UNIQUE ("plan_id","kind"),
  CONSTRAINT "lumi_budgets_execute_has_ceiling" CHECK ("kind" = 'PREPARE' OR ("ceiling" IS NOT NULL AND "currency" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_ledger_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "budget_id" uuid NOT NULL REFERENCES "lumi_budgets"("id"),
  "plan_id" uuid NOT NULL REFERENCES "lumi_plans"("id"),
  "task_id" uuid REFERENCES "tasks"("id"),
  "run_id" uuid REFERENCES "lumi_task_runs"("id"),
  "entry_type" text NOT NULL CHECK ("entry_type" IN ('CEILING','COMMIT','RELEASE','ACTUAL','ADJUST')),
  "category" text NOT NULL CHECK ("category" IN ('AI','TOOL','ADS','PRODUCTION','ASSET','OUTSOURCE','FEE','COORD','SHARED','OTHER')),
  "amount" numeric,
  "currency" text,
  "source" text NOT NULL CHECK ("source" IN ('ESTIMATED','MEASURED','BOT_DECLARED','PROVIDER_STATEMENT','MANUAL','UNKNOWN')),
  "reconciliation" text NOT NULL DEFAULT 'UNRECONCILED' CHECK ("reconciliation" IN ('UNRECONCILED','RECONCILED')),
  "reconciliation_key" text,
  "reconciled_by" text,
  "reconciled_at" timestamptz,
  "ref_entry_id" uuid REFERENCES "lumi_ledger_entries"("id"),
  "idempotency_key" text NOT NULL UNIQUE,
  "note" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "recorded_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_ledger_unknown_iff_null" CHECK (("amount" IS NULL) = ("source" = 'UNKNOWN')),
  CONSTRAINT "lumi_ledger_null_only_actual" CHECK ("amount" IS NOT NULL OR "entry_type" = 'ACTUAL'),
  CONSTRAINT "lumi_ledger_nonneg" CHECK ("amount" IS NULL OR "amount" >= 0 OR "entry_type" = 'ADJUST')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_ledger_plan_idx" ON "lumi_ledger_entries" ("plan_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lumi_ledger_entries is append-only'; END IF;
  IF NEW.budget_id IS DISTINCT FROM OLD.budget_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.entry_type IS DISTINCT FROM OLD.entry_type OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.ref_entry_id IS DISTINCT FROM OLD.ref_entry_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'lumi_ledger_entries is append-only (only reconciliation columns may change)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_ledger_append_only_trg ON "lumi_ledger_entries";--> statement-breakpoint
CREATE TRIGGER lumi_ledger_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_ledger_entries" FOR EACH ROW EXECUTE FUNCTION lumi_ledger_append_only();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id" uuid NOT NULL REFERENCES "lumi_plans"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('PHASE','FINAL')),
  "milestone_key" text,
  "supersedes_report_id" uuid REFERENCES "lumi_reports"("id"),
  "body" jsonb NOT NULL,
  "data_basis" jsonb NOT NULL DEFAULT '{}',
  "content_hash" text NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_reports_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'lumi_reports is immutable (a correction is a new row that supersedes)';
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_reports_immutable_trg ON "lumi_reports";--> statement-breakpoint
CREATE TRIGGER lumi_reports_immutable_trg BEFORE UPDATE OR DELETE ON "lumi_reports" FOR EACH ROW EXECUTE FUNCTION lumi_reports_immutable();--> statement-breakpoint

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "plan_id" uuid REFERENCES "lumi_plans"("id"),
  ADD COLUMN IF NOT EXISTS "plan_version" integer,
  ADD COLUMN IF NOT EXISTS "plan_task_key" text,
  ADD COLUMN IF NOT EXISTS "acceptance" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_plan_task_key_uq" ON "tasks" ("plan_id","plan_task_key") WHERE "plan_task_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_plan_idx" ON "tasks" ("plan_id") WHERE "plan_id" IS NOT NULL;--> statement-breakpoint

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid='lumi_approvals'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%KNOWLEDGE%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE lumi_approvals DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE lumi_approvals ADD CONSTRAINT lumi_approvals_kind_chk CHECK (kind IN ('OUTPUT','KNOWLEDGE','ACTION','PLAN'));
END $$;
