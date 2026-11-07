-- M1 → trợ lý tự chủ (TDD 8.11). Chỉ THÊM; không ghi đè dữ liệu cũ.
-- 1) Khai báo khả năng công cụ (tách khỏi quyền truy cập tài khoản và quyền thực hiện hành động).
ALTER TABLE "lumi_assistants"
  ADD COLUMN IF NOT EXISTS "capability_mode" text NOT NULL DEFAULT 'RESTRICTED' CHECK ("capability_mode" IN ('RESTRICTED','DECLARED_FULL')),
  ADD COLUMN IF NOT EXISTS "capability_snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "capability_ack_by" text,
  ADD COLUMN IF NOT EXISTS "capability_ack_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "max_continuations" smallint NOT NULL DEFAULT 0 CHECK ("max_continuations" >= 0),
  ADD COLUMN IF NOT EXISTS "max_subtasks" smallint NOT NULL DEFAULT 0 CHECK ("max_subtasks" >= 0);--> statement-breakpoint

-- 2) Quyền cấp trước cho hành động ra bên ngoài: theo bot × dự án × tài khoản × loại hành động, có hạn mức và thời hạn.
CREATE TABLE IF NOT EXISTS "lumi_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "account_ref" text NOT NULL CHECK (length("account_ref") BETWEEN 1 AND 200),
  "action_type" text NOT NULL CHECK (length("action_type") BETWEEN 1 AND 80),
  "currency" text,
  "per_action_max" numeric CHECK ("per_action_max" IS NULL OR "per_action_max" >= 0),
  "budget_total" numeric CHECK ("budget_total" IS NULL OR "budget_total" >= 0),
  "spent" numeric NOT NULL DEFAULT 0 CHECK ("spent" >= 0),
  "count_limit" integer CHECK ("count_limit" IS NULL OR "count_limit" >= 0),
  "count_used" integer NOT NULL DEFAULT 0 CHECK ("count_used" >= 0),
  "valid_from" timestamptz NOT NULL DEFAULT now(),
  "valid_until" timestamptz NOT NULL,
  "ask_if_amount_over" numeric CHECK ("ask_if_amount_over" IS NULL OR "ask_if_amount_over" >= 0),
  "stop_conditions" jsonb NOT NULL DEFAULT '[]',
  "state" text NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','REVOKED')),
  "note" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_by" text,
  "revoked_at" timestamptz,
  CONSTRAINT "lumi_grants_window" CHECK ("valid_until" > "valid_from"),
  CONSTRAINT "lumi_grants_money_has_currency" CHECK (("per_action_max" IS NULL AND "budget_total" IS NULL AND "ask_if_amount_over" IS NULL) OR "currency" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_grants_lookup_idx" ON "lumi_grants" ("assistant_id","project_id","action_type") WHERE "state"='ACTIVE';--> statement-breakpoint

-- 3) Yêu cầu hành động chưa có quyền / vượt phạm vi: chờ Chủ quyết định. Quyết định gắn với tham số chính xác (params_hash).
CREATE TABLE IF NOT EXISTS "lumi_action_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "task_id" uuid REFERENCES "tasks"("id"),
  "run_id" uuid REFERENCES "lumi_task_runs"("id"),
  "action_type" text NOT NULL,
  "account_ref" text NOT NULL,
  "amount" numeric CHECK ("amount" IS NULL OR "amount" >= 0),
  "currency" text,
  "summary" text NOT NULL CHECK (length("summary") BETWEEN 1 AND 2000),
  "params_hash" text NOT NULL,
  "basis" text NOT NULL CHECK ("basis" IN ('NO_GRANT','OVER_LIMIT','ASK_CONDITION','GRANT_EXPIRED','COUNT_LIMIT','BUDGET_LIMIT')),
  "grant_id" uuid REFERENCES "lumi_grants"("id"),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','APPROVED','DENIED','EXPIRED','CONSUMED')),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "decided_by" text,
  "decided_at" timestamptz,
  "decision_note" text,
  "consumed_at" timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_action_requests_one_pending" ON "lumi_action_requests" ("assistant_id","project_id","params_hash") WHERE "state" IN ('PENDING','APPROVED');--> statement-breakpoint

-- 4) Nhật ký quyết định hành động: chỉ thêm (không sửa/xóa), kể cả với chủ sở hữu bảng.
CREATE TABLE IF NOT EXISTS "lumi_action_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "at" timestamptz NOT NULL DEFAULT now(),
  "assistant_id" uuid NOT NULL,
  "project_id" uuid,
  "task_id" uuid,
  "run_id" uuid,
  "action_type" text NOT NULL,
  "account_ref" text NOT NULL,
  "amount" numeric,
  "currency" text,
  "params_hash" text NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('ALLOW','ASK','DENY','USE_APPROVAL')),
  "reason" text NOT NULL,
  "grant_id" uuid,
  "request_id" uuid
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_action_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'lumi_action_log is append-only';
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_action_log_no_update ON "lumi_action_log";--> statement-breakpoint
CREATE TRIGGER lumi_action_log_no_update BEFORE UPDATE OR DELETE ON "lumi_action_log" FOR EACH ROW EXECUTE FUNCTION lumi_action_log_append_only();--> statement-breakpoint

-- 5) Việc con (kế hoạch) và điểm dừng/tiếp tục của lần chạy dài.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "parent_task_id" uuid REFERENCES "tasks"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_parent_idx" ON "tasks" ("parent_task_id") WHERE "parent_task_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "lumi_task_runs" ADD COLUMN IF NOT EXISTS "checkpoint" text;--> statement-breakpoint
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid='lumi_task_runs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%run_kind%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE lumi_task_runs DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE lumi_task_runs ADD CONSTRAINT lumi_task_runs_run_kind_chk CHECK (run_kind IN ('INITIAL','RETRY','REVISION','REASSIGN','CONTINUATION'));
END $$;--> statement-breakpoint
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid='lumi_task_outputs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%LATE_SAVED%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE lumi_task_outputs DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE lumi_task_outputs ADD CONSTRAINT lumi_task_outputs_state_chk CHECK (state IN ('SUBMITTED','LATE_SAVED','APPROVED','REVISION_REQUESTED','REJECTED','SUPERSEDED','DISCARDED','PROGRESS'));
END $$;--> statement-breakpoint

-- 6) Dự án ĐỀ XUẤT (bot tạo) tách khỏi dự án đang chạy (Chủ kích hoạt).
ALTER TABLE "lumi_projects"
  ADD COLUMN IF NOT EXISTS "proposal" jsonb,
  ADD COLUMN IF NOT EXISTS "proposed_by_assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  ADD COLUMN IF NOT EXISTS "decided_by" text,
  ADD COLUMN IF NOT EXISTS "decided_at" timestamptz;--> statement-breakpoint
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid='lumi_projects'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%ARCHIVED%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE lumi_projects DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE lumi_projects ADD CONSTRAINT lumi_projects_status_chk CHECK (status IN ('ACTIVE','ARCHIVED','PROPOSED','REJECTED'));
END $$;
