-- Đợt 8 (nhóm 1): công suất/chuyển giao nhân viên AI (ORG-06), quỹ chuẩn bị (PLN-04), lịch sử đổi trưởng kế hoạch (PLN-01).
-- Chỉ THÊM cột có thể null / bảng mới (bản trước vẫn chạy trên schema này).
ALTER TABLE "lumi_assistants" ADD COLUMN IF NOT EXISTS "capacity" integer CHECK ("capacity" IS NULL OR ("capacity" BETWEEN 1 AND 50));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id"),
  "from_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "to_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "reason" text NOT NULL CHECK (length("reason") BETWEEN 3 AND 500),
  "by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_transfers_task_idx" ON "lumi_transfers" ("task_id","at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_prep_funds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope" text NOT NULL CHECK ("scope" IN ('COMPANY','ASSISTANT')),
  "assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "amount" numeric NOT NULL CHECK ("amount" > 0),
  "currency" text NOT NULL DEFAULT 'USD' CHECK ("currency" = 'USD'),
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "set_by" text NOT NULL,
  "note" text CHECK ("note" IS NULL OR length("note") <= 500),
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_prep_funds_period_chk" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "lumi_prep_funds_scope_chk" CHECK (("scope"='ASSISTANT') = ("assistant_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_prep_funds_one_active" ON "lumi_prep_funds" ("scope", coalesce("assistant_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "active";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_plan_lead_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id" uuid NOT NULL REFERENCES "lumi_plans"("id"),
  "from_assistant_id" uuid REFERENCES "lumi_assistants"("id"),
  "to_assistant_id" uuid NOT NULL REFERENCES "lumi_assistants"("id"),
  "reason" text NOT NULL CHECK (length("reason") BETWEEN 3 AND 500),
  "by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_transfers_append_only_trg ON "lumi_transfers";--> statement-breakpoint
CREATE TRIGGER lumi_transfers_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_transfers" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_lead_history_append_only_trg ON "lumi_plan_lead_history";--> statement-breakpoint
CREATE TRIGGER lumi_lead_history_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_plan_lead_history" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_link_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id" uuid NOT NULL REFERENCES "lumi_knowledge_sources"("id"),
  "url" text NOT NULL,
  "ok" boolean NOT NULL,
  "status" integer,
  "reason" text NOT NULL,
  "checked_by" text NOT NULL,
  "checked_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_link_checks_idx" ON "lumi_link_checks" ("source_id","checked_at" DESC);--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_link_checks_append_only_trg ON "lumi_link_checks";--> statement-breakpoint
CREATE TRIGGER lumi_link_checks_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_link_checks" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();
--> statement-breakpoint
ALTER TABLE "lumi_routines" ADD COLUMN IF NOT EXISTS "purpose" text CHECK ("purpose" IS NULL OR "purpose" IN ('OPPORTUNITY_SCAN'));
