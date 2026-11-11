-- Đợt 6 (IMP-06, phần làm được trong ứng dụng): cài đặt (ADM-06), hộp thư ý tưởng (CNV-03), mẫu công việc (SKL-01..04), routine (RTN-01..05, EXE-02),
-- soát kiến thức định kỳ (KNW-08). Chỉ THÊM bảng/chuỗi mới; không đổi bảng cũ (bản trước vẫn chạy trên schema này).
CREATE SEQUENCE IF NOT EXISTS "lumi_idea_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_tpl_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_rtn_seq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_setting_values" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" text NOT NULL CHECK (length("key") BETWEEN 2 AND 60),
  "value" text NOT NULL CHECK (length("value") BETWEEN 1 AND 200),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_setting_values_idx" ON "lumi_setting_values" ("key","set_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_ideas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE DEFAULT ('ID-' || lpad(nextval('lumi_idea_seq')::text, 4, '0')),
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "body" text CHECK ("body" IS NULL OR length("body") <= 4000),
  "link" text CHECK ("link" IS NULL OR "link" ~ '^https?://'),
  "channel" text NOT NULL DEFAULT 'WEB',
  "status" text NOT NULL DEFAULT 'NEW' CHECK ("status" IN ('NEW','CLASSIFIED','ACCEPTED','DISCARDED')),
  "class" text CHECK ("class" IS NULL OR "class" IN ('NOTE','SOURCE','TASK')),
  "project_id" uuid REFERENCES "lumi_projects"("id"),
  "assignee_id" uuid REFERENCES "lumi_assistants"("id"),
  "result_ref" text,
  "decision_note" text,
  "created_by" text NOT NULL,
  "classified_by" text,
  "decided_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "classified_at" timestamptz,
  "decided_at" timestamptz
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_ideas_status_idx" ON "lumi_ideas" ("status","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_task_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE DEFAULT ('TP-' || lpad(nextval('lumi_tpl_seq')::text, 4, '0')),
  "name" text NOT NULL CHECK (length("name") BETWEEN 3 AND 120),
  "state" text NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','ARCHIVED')),
  "current_version" integer NOT NULL DEFAULT 1,
  "approved_version" integer,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_task_template_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id" uuid NOT NULL REFERENCES "lumi_task_templates"("id"),
  "version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'PROPOSED' CHECK ("state" IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED','EXPIRED')),
  "description" text NOT NULL CHECK (length("description") BETWEEN 3 AND 2000),
  "when_to_use" text NOT NULL CHECK (length("when_to_use") BETWEEN 3 AND 1000),
  "steps" text NOT NULL CHECK (length("steps") BETWEEN 3 AND 4000),
  "inputs" text NOT NULL CHECK (length("inputs") BETWEEN 1 AND 1000),
  "outputs" text NOT NULL CHECK (length("outputs") BETWEEN 1 AND 1000),
  "default_title" text NOT NULL CHECK (length("default_title") BETWEEN 3 AND 200),
  "default_assignee_id" uuid REFERENCES "lumi_assistants"("id"),
  "allowed_assistant_ids" uuid[] NOT NULL DEFAULT '{}',
  "proposed_by" text NOT NULL,
  "decided_by" text,
  "decision_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "lumi_tpl_ver_uq" UNIQUE ("template_id","version")
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_tpl_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'phiên bản mẫu là bản ghi bất biến (không xóa)'; END IF;
  IF NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.when_to_use IS DISTINCT FROM OLD.when_to_use OR NEW.steps IS DISTINCT FROM OLD.steps OR NEW.inputs IS DISTINCT FROM OLD.inputs
     OR NEW.outputs IS DISTINCT FROM OLD.outputs OR NEW.default_title IS DISTINCT FROM OLD.default_title OR NEW.default_assignee_id IS DISTINCT FROM OLD.default_assignee_id
     OR NEW.allowed_assistant_ids IS DISTINCT FROM OLD.allowed_assistant_ids OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by THEN
    RAISE EXCEPTION 'nội dung phiên bản mẫu bất biến (sửa = phiên bản mới)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_tpl_version_immutable_trg ON "lumi_task_template_versions";--> statement-breakpoint
CREATE TRIGGER lumi_tpl_version_immutable_trg BEFORE UPDATE OR DELETE ON "lumi_task_template_versions" FOR EACH ROW EXECUTE FUNCTION lumi_tpl_version_immutable();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_task_template_uses" (
  "task_id" uuid PRIMARY KEY,
  "template_id" uuid NOT NULL REFERENCES "lumi_task_templates"("id"),
  "version" integer NOT NULL,
  "used_by" text NOT NULL,
  "used_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_routines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE DEFAULT ('RT-' || lpad(nextval('lumi_rtn_seq')::text, 4, '0')),
  "name" text NOT NULL CHECK (length("name") BETWEEN 3 AND 120),
  "kind" text NOT NULL CHECK ("kind" IN ('NOTIFY','CREATE_TASK')),
  "schedule_kind" text NOT NULL CHECK ("schedule_kind" IN ('DAILY','WEEKDAYS','WEEKLY')),
  "time_of_day" text NOT NULL CHECK ("time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "weekday" integer CHECK ("weekday" IS NULL OR "weekday" BETWEEN 1 AND 7),
  "timezone" text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  "project_id" uuid REFERENCES "lumi_projects"("id"),
  "assignee_id" uuid REFERENCES "lumi_assistants"("id"),
  "template_id" uuid REFERENCES "lumi_task_templates"("id"),
  "title" text CHECK ("title" IS NULL OR length("title") BETWEEN 3 AND 200),
  "description" text CHECK ("description" IS NULL OR length("description") <= 2000),
  "message" text CHECK ("message" IS NULL OR length("message") BETWEEN 3 AND 1000),
  "max_runs_per_day" integer CHECK ("max_runs_per_day" IS NULL OR "max_runs_per_day" BETWEEN 1 AND 100),
  "deadline_minutes" integer CHECK ("deadline_minutes" IS NULL OR "deadline_minutes" BETWEEN 1 AND 10080),
  "enabled" boolean NOT NULL DEFAULT false,
  "next_run_at" timestamptz,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "alerted" boolean NOT NULL DEFAULT false,
  "last_error" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_rtn_weekly_chk" CHECK (("schedule_kind"='WEEKLY') = ("weekday" IS NOT NULL))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_routine_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "routine_id" uuid NOT NULL REFERENCES "lumi_routines"("id"),
  "scheduled_for" timestamptz NOT NULL,
  "trigger" text NOT NULL CHECK ("trigger" IN ('SCHEDULE','CATCHUP','MANUAL')),
  "result" text NOT NULL CHECK ("result" IN ('DONE','FAILED','STOPPED','CAP','SKIPPED')),
  "task_id" uuid,
  "error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_routine_run_slot_uq" UNIQUE ("routine_id","scheduled_for")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_knowledge_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id" uuid NOT NULL REFERENCES "lumi_knowledge_items"("id"),
  "version" integer NOT NULL,
  "reviewed_by" text NOT NULL,
  "note" text CHECK ("note" IS NULL OR length("note") <= 1000),
  "reviewed_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_kn_reviews_idx" ON "lumi_knowledge_reviews" ("item_id","reviewed_at" DESC);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_ops_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% là bản ghi chỉ-thêm', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_setting_append_only_trg ON "lumi_setting_values";--> statement-breakpoint
CREATE TRIGGER lumi_setting_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_setting_values" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_routine_runs_append_only_trg ON "lumi_routine_runs";--> statement-breakpoint
CREATE TRIGGER lumi_routine_runs_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_routine_runs" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_kn_reviews_append_only_trg ON "lumi_knowledge_reviews";--> statement-breakpoint
CREATE TRIGGER lumi_kn_reviews_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_knowledge_reviews" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();
