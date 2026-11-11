-- IMP-04 (PRD 11.5; TDD 14.11.B.17): kho kiến thức có phạm vi/phiên bản/nguồn/truy vết, cuộc họp bất đồng bộ có biên bản và kết luận phân loại,
-- và đo chi phí AI thật theo lượt (thăm dò mức sử dụng khóa riêng). CHỈ THÊM: dãy, bảng, chỉ mục, trigger chỉ-thêm. Mã cũ bỏ qua tất cả.
CREATE SEQUENCE IF NOT EXISTS "lumi_ksrc_code_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_kn_code_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "lumi_meeting_code_seq";--> statement-breakpoint

-- ───────────── kiến thức (KNW-01..07, 09, 11..14; CMP-01)
CREATE TABLE IF NOT EXISTS "lumi_knowledge_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "kind" text NOT NULL CHECK ("kind" IN ('URL','DOCUMENT','NOTE','MANUAL','BOT_CITED')),
  "ref" text CHECK ("ref" IS NULL OR length("ref") <= 1000),
  "content" text CHECK ("content" IS NULL OR length("content") <= 20000),
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_knowledge_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "kind" text NOT NULL CHECK ("kind" IN ('NOTE','DECISION','RULE')),
  "scope" text NOT NULL CHECK ("scope" IN ('COMPANY','AREA','PROJECT','PERSONAL')),
  "scope_ref" text,
  "status" text NOT NULL DEFAULT 'PROPOSED' CHECK ("status" IN ('PROPOSED','ACTIVE','REJECTED','SUPERSEDED','ARCHIVED')),
  "current_version" integer NOT NULL DEFAULT 1,
  "approved_version" integer,
  "supersedes_item_id" uuid REFERENCES "lumi_knowledge_items"("id"),
  "shared_with" jsonb NOT NULL DEFAULT '[]',
  "proposed_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_by" text,
  "archived_at" timestamptz,
  CONSTRAINT "lumi_kn_scope_ref_chk" CHECK (("scope"='COMPANY' AND "scope_ref" IS NULL) OR ("scope"<>'COMPANY' AND "scope_ref" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_kn_scope_idx" ON "lumi_knowledge_items" ("status","scope","scope_ref");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_knowledge_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id" uuid NOT NULL REFERENCES "lumi_knowledge_items"("id"),
  "version" integer NOT NULL,
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "content" text NOT NULL CHECK (length("content") BETWEEN 3 AND 8000),
  "reason" text CHECK ("reason" IS NULL OR length("reason") <= 2000),
  "confidence" text CHECK ("confidence" IS NULL OR "confidence" IN ('LOW','MEDIUM','HIGH')),
  "manual_entry" boolean NOT NULL DEFAULT false,
  "unsupported" jsonb NOT NULL DEFAULT '[]',
  "state" text NOT NULL DEFAULT 'PROPOSED' CHECK ("state" IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED','WITHDRAWN')),
  "search_text" text NOT NULL DEFAULT '',
  "effective_until" timestamptz,
  "created_by" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'WEB',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_by" text,
  "decided_at" timestamptz,
  "decision_reason" text,
  UNIQUE ("item_id","version")
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_knowledge_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'lumi_knowledge_sources' THEN RAISE EXCEPTION 'lumi_knowledge_sources là nguồn bất biến'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lumi_knowledge_versions không xóa'; END IF;
  IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'nội dung một phiên bản kiến thức là bất biến (sửa = tạo phiên bản mới)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_ksrc_immutable_trg ON "lumi_knowledge_sources";--> statement-breakpoint
CREATE TRIGGER lumi_ksrc_immutable_trg BEFORE UPDATE OR DELETE ON "lumi_knowledge_sources" FOR EACH ROW EXECUTE FUNCTION lumi_knowledge_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_kver_immutable_trg ON "lumi_knowledge_versions";--> statement-breakpoint
CREATE TRIGGER lumi_kver_immutable_trg BEFORE UPDATE OR DELETE ON "lumi_knowledge_versions" FOR EACH ROW EXECUTE FUNCTION lumi_knowledge_immutable();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_knowledge_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id" uuid NOT NULL REFERENCES "lumi_knowledge_items"("id"),
  "version" integer NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "lumi_knowledge_sources"("id"),
  "supports" text CHECK ("supports" IS NULL OR length("supports") <= 500),
  UNIQUE ("item_id","version","source_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_run_knowledge" (
  "run_id" uuid NOT NULL REFERENCES "lumi_task_runs"("id"),
  "item_id" uuid NOT NULL REFERENCES "lumi_knowledge_items"("id"),
  "version" integer NOT NULL,
  "scope" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("run_id","item_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_run_knowledge_item_idx" ON "lumi_run_knowledge" ("item_id","version");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_knowledge_reads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "item_id" uuid NOT NULL REFERENCES "lumi_knowledge_items"("id"),
  "version" integer NOT NULL,
  "run_id" uuid,
  "via" text NOT NULL CHECK ("via" IN ('DISPATCH','SEARCH','TOOL')),
  "at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- ───────────── họp bất đồng bộ (MTG-01..03, 05..09)
CREATE TABLE IF NOT EXISTS "lumi_meetings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "idempotency_key" text NOT NULL UNIQUE,
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "question" text NOT NULL CHECK (length("question") BETWEEN 3 AND 4000),
  "reason" text NOT NULL CHECK ("reason" IN ('CROSS_ROLE','JOINT_PLAN','MILESTONE','OWNER')),
  "plan_id" uuid REFERENCES "lumi_plans"("id"),
  "project_id" uuid REFERENCES "lumi_projects"("id"),
  "chair_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "backup_chair_assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "state" text NOT NULL DEFAULT 'OPEN' CHECK ("state" IN ('OPEN','CLOSED','CANCELLED')),
  "outcome" text NOT NULL DEFAULT 'PENDING' CHECK ("outcome" IN ('PENDING','DECIDED','PARTIAL','ESCALATED','NO_DECISION','NOT_CONCLUDED')),
  "opens_at" timestamptz NOT NULL DEFAULT now(),
  "closes_at" timestamptz NOT NULL,
  "max_rounds" integer NOT NULL CHECK ("max_rounds" BETWEEN 1 AND 5),
  "max_runs" integer NOT NULL CHECK ("max_runs" BETWEEN 1 AND 50),
  "max_cost" numeric CHECK ("max_cost" IS NULL OR "max_cost" >= 0),
  "currency" text,
  "end_conditions" text NOT NULL CHECK (length("end_conditions") >= 3),
  "inputs" jsonb NOT NULL DEFAULT '[]',
  "inputs_changed" boolean NOT NULL DEFAULT false,
  "runs_used" integer NOT NULL DEFAULT 0,
  "cost_spent" numeric,
  "cost_unknown_runs" integer NOT NULL DEFAULT 0,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  "closed_by" text,
  "close_reason" text,
  "synth_task_id" uuid REFERENCES "tasks"("id"),
  "chair_switched" boolean NOT NULL DEFAULT false,
  CONSTRAINT "lumi_meeting_window_chk" CHECK ("closes_at" > "opens_at")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_meeting_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "meeting_id" uuid NOT NULL REFERENCES "lumi_meetings"("id"),
  "assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "actor_ref" text,
  "role" text NOT NULL CHECK ("role" IN ('CHAIR','REQUIRED_EXPERT','CONTRIBUTOR','OBSERVER','OWNER_OPTIONAL')),
  "expertise" text CHECK ("expertise" IS NULL OR length("expertise") BETWEEN 2 AND 80),
  "state" text NOT NULL DEFAULT 'INVITED' CHECK ("state" IN ('INVITED','CONTRIBUTED','ABSENT')),
  "task_id" uuid REFERENCES "tasks"("id"),
  CONSTRAINT "lumi_mp_who_chk" CHECK (("assistant_id" IS NOT NULL) <> ("actor_ref" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_mp_uq" ON "lumi_meeting_participants" ("meeting_id", coalesce("assistant_id"::text,"actor_ref"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_meeting_contributions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "meeting_id" uuid NOT NULL REFERENCES "lumi_meetings"("id"),
  "participant_id" uuid NOT NULL REFERENCES "lumi_meeting_participants"("id"),
  "round" integer NOT NULL CHECK ("round" >= 1),
  "stance" text NOT NULL CHECK (length("stance") BETWEEN 3 AND 4000),
  "evidence" text CHECK ("evidence" IS NULL OR length("evidence") <= 4000),
  "risks" text CHECK ("risks" IS NULL OR length("risks") <= 2000),
  "estimate" text CHECK ("estimate" IS NULL OR length("estimate") <= 1000),
  "objection" text CHECK ("objection" IS NULL OR length("objection") <= 2000),
  "proposal" text CHECK ("proposal" IS NULL OR length("proposal") <= 2000),
  "late" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("meeting_id","participant_id","round")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_meeting_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "meeting_id" uuid NOT NULL REFERENCES "lumi_meetings"("id"),
  "version" integer NOT NULL,
  "summary" text NOT NULL CHECK (length("summary") BETWEEN 3 AND 6000),
  "lines" jsonb NOT NULL DEFAULT '[]',
  "self_checked" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("meeting_id","version")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_meeting_conclusions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "meeting_id" uuid NOT NULL REFERENCES "lumi_meetings"("id"),
  "note_version" integer NOT NULL,
  "idx" integer NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('RECORD','INTERNAL','PROPOSAL')),
  "type" text NOT NULL,
  "text" text NOT NULL CHECK (length("text") BETWEEN 3 AND 2000),
  "depends_on_expertise" text,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "reason" text NOT NULL,
  "state" text NOT NULL DEFAULT 'RECORDED' CHECK ("state" IN ('RECORDED','APPLIED','PENDING_OWNER','APPROVED','REJECTED','BLOCKED')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_by" text,
  "decided_at" timestamptz,
  UNIQUE ("meeting_id","note_version","idx")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_meeting_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "meeting_id" uuid NOT NULL REFERENCES "lumi_meetings"("id"),
  "item_key" text NOT NULL CHECK ("item_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "conclusion_id" uuid REFERENCES "lumi_meeting_conclusions"("id"),
  "title" text NOT NULL,
  "pic_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "due_at" timestamptz NOT NULL,
  "expected_output" text NOT NULL,
  "acceptance" text NOT NULL,
  "depends_on" text,
  "budget_ref" text,
  "task_id" uuid REFERENCES "tasks"("id"),
  "state" text NOT NULL DEFAULT 'PENDING_ACCEPT' CHECK ("state" IN ('PENDING_ACCEPT','ACCEPTED','DECLINED','AWAITING_OWNER')),
  "decline_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("meeting_id","item_key")
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_meeting_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% là bản ghi chỉ-thêm (đóng góp và biên bản là nguồn bất biến)', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_mcontrib_append_only_trg ON "lumi_meeting_contributions";--> statement-breakpoint
CREATE TRIGGER lumi_mcontrib_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_meeting_contributions" FOR EACH ROW EXECUTE FUNCTION lumi_meeting_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_mnotes_append_only_trg ON "lumi_meeting_notes";--> statement-breakpoint
CREATE TRIGGER lumi_mnotes_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_meeting_notes" FOR EACH ROW EXECUTE FUNCTION lumi_meeting_append_only();--> statement-breakpoint

-- ───────────── đo chi phí AI thật theo lượt (ECO-03: lượt lỗi, vòng sửa, điều phối đều vào sổ với số đo thật khi đo được)
CREATE TABLE IF NOT EXISTS "lumi_run_cost_probes" (
  "run_id" uuid PRIMARY KEY REFERENCES "lumi_task_runs"("id"),
  "assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','MEASURED','UNAVAILABLE','OVERLAP')),
  "before_usage" numeric,
  "before_at" timestamptz,
  "after_usage" numeric,
  "after_at" timestamptz,
  "currency" text NOT NULL DEFAULT 'USD',
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_run_cost_probes_state_idx" ON "lumi_run_cost_probes" ("state");
