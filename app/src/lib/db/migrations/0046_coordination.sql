-- IMP-03 (PRD 11.5; TDD 14.11.B.16): vai trò và bổ nhiệm kiêm nhiệm, phụ thuộc giữa việc, bàn giao giữa bot qua ứng dụng, đề xuất thay đổi của PM bot,
-- năng lực đã kiểm chứng, business case thêm bot. CHỈ THÊM: bảng, dãy, cột nullable, chỉ mục, trigger chỉ-thêm và mở rộng CHECK của chính sách.
-- Mã M1/IMP-01/IMP-02 cũ bỏ qua tất cả. Không có giá trị mặc định cho giới hạn bàn giao: nằm ở lumi_policies (không đặt = bị chặn).
CREATE SEQUENCE IF NOT EXISTS "lumi_role_code_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_handoff_code_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_case_code_seq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "name" text NOT NULL CHECK (length("name") BETWEEN 2 AND 80),
  "department" text CHECK ("department" IS NULL OR "department" ~ '^DEP-[0-9]{2}$'),
  "description" text CHECK ("description" IS NULL OR length("description") <= 1000),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','ARCHIVED')),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_roles_name_uq" ON "lumi_roles" (lower("name")) WHERE "status"='ACTIVE';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_appointments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role_id" uuid NOT NULL REFERENCES "lumi_roles"("id"),
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "scope" text NOT NULL DEFAULT 'COMPANY' CHECK ("scope" IN ('COMPANY','PROJECT','PLAN')),
  "scope_ref" uuid,
  "effective_from" timestamptz NOT NULL DEFAULT now(),
  "effective_to" timestamptz,
  "substitute_assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "handover_note" text CHECK ("handover_note" IS NULL OR length("handover_note") <= 1000),
  "state" text NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','ENDED')),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "ended_by" text,
  "ended_at" timestamptz,
  "end_reason" text,
  CONSTRAINT "lumi_appt_scope_chk" CHECK (("scope"='COMPANY' AND "scope_ref" IS NULL) OR ("scope"<>'COMPANY' AND "scope_ref" IS NOT NULL)),
  CONSTRAINT "lumi_appt_window_chk" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "lumi_appt_substitute_chk" CHECK ("substitute_assistant_id" IS NULL OR "substitute_assistant_id" <> "assistant_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_appt_active_uq" ON "lumi_appointments" ("role_id","assistant_id","scope",coalesce("scope_ref",'00000000-0000-0000-0000-000000000000'::uuid)) WHERE "state"='ACTIVE';--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "role_id" uuid REFERENCES "lumi_roles"("id"),
  ADD COLUMN IF NOT EXISTS "required_skill" text CHECK ("required_skill" IS NULL OR length("required_skill") BETWEEN 2 AND 80);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "skill" text NOT NULL CHECK (length("skill") BETWEEN 2 AND 80),
  "state" text NOT NULL DEFAULT 'UNVERIFIED' CHECK ("state" IN ('UNVERIFIED','VERIFIED','MONITORED')),
  "evidence" text CHECK ("evidence" IS NULL OR length("evidence") <= 1000),
  "environment" text CHECK ("environment" IS NULL OR length("environment") <= 300),
  "limits" text CHECK ("limits" IS NULL OR length("limits") <= 500),
  "assessed_at" timestamptz,
  "assessed_by" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_skills_verified_evidence_chk" CHECK ("state"='UNVERIFIED' OR ("evidence" IS NOT NULL AND length(trim("evidence")) >= 10 AND "environment" IS NOT NULL AND "assessed_at" IS NOT NULL AND "assessed_by" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_skills_uq" ON "lumi_skills" ("assistant_id", lower("skill"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_task_deps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "depends_on_task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "consumed_version" integer,
  "consumed_output_id" uuid,
  "stale" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_deps_not_self" CHECK ("task_id" <> "depends_on_task_id"),
  UNIQUE ("task_id","depends_on_task_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_deps_up_idx" ON "lumi_task_deps" ("depends_on_task_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "idempotency_key" text NOT NULL UNIQUE,
  "source_task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "from_assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "to_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "new_task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "state" text NOT NULL DEFAULT 'PROPOSED' CHECK ("state" IN ('PROPOSED','ACCEPTED','REJECTED','NEEDS_INFO','ESCALATED','CANCELLED')),
  "depth" integer NOT NULL CHECK ("depth" >= 1),
  "round" integer NOT NULL DEFAULT 0 CHECK ("round" >= 0),
  "ticket" jsonb NOT NULL DEFAULT '{}',
  "reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_handoffs_new_task_uq" ON "lumi_handoffs" ("new_task_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_handoff_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "handoff_id" uuid NOT NULL REFERENCES "lumi_handoffs"("id"),
  "event_type" text NOT NULL,
  "actor_ref" text NOT NULL,
  "text" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_handoff_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'lumi_handoff_events là bản ghi chỉ-thêm';
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_handoff_events_append_only_trg ON "lumi_handoff_events";--> statement-breakpoint
CREATE TRIGGER lumi_handoff_events_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_handoff_events" FOR EACH ROW EXECUTE FUNCTION lumi_handoff_events_append_only();--> statement-breakpoint
ALTER TABLE "lumi_projects" ADD COLUMN IF NOT EXISTS "pm_auto_reassign" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_change_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL UNIQUE,
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "kind" text NOT NULL DEFAULT 'REASSIGN' CHECK ("kind" IN ('REASSIGN')),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "to_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "reason" text NOT NULL CHECK (length("reason") BETWEEN 3 AND 500),
  "proposed_by_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','APPROVED','REJECTED','APPLIED','FAILED')),
  "decided_by" text,
  "decided_at" timestamptz,
  "result" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_bot_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "work_needed" text NOT NULL,
  "volume" text NOT NULL,
  "extra_cost" text NOT NULL,
  "owner_time_saved" text NOT NULL,
  "trial_criteria" text NOT NULL,
  "stop_condition" text NOT NULL,
  "alternatives" text,
  "state" text NOT NULL DEFAULT 'PROPOSED' CHECK ("state" IN ('PROPOSED','APPROVED','REJECTED')),
  "proposed_by" text NOT NULL,
  "decided_by" text,
  "decided_at" timestamptz,
  "decision_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "lumi_policies" DROP CONSTRAINT IF EXISTS "lumi_policies_key_check";--> statement-breakpoint
ALTER TABLE "lumi_policies" ADD CONSTRAINT "lumi_policies_key_check" CHECK ("key" IN ('prepare_fund','max_loss','report_cadence_days','proposal_ttl_days','meeting_cap','currency','owner_hourly_rate','handoff_max_depth','handoff_max_rounds'));
