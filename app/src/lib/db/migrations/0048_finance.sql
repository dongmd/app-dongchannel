-- IMP-05 (phần làm được trong ứng dụng; PRD 11.5; TDD 14.11.B.18): giới hạn chi phí AI, ba sổ tiền tách riêng (chi phí quảng cáo, hoa hồng, tài trợ),
-- thử nghiệm có tiêu chí dừng/scale chốt TRƯỚC khi chạy. CHỈ THÊM: dãy, bảng, chỉ mục, trigger chỉ-thêm. Mã cũ bỏ qua tất cả.
CREATE SEQUENCE IF NOT EXISTS "lumi_ex_code_seq";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_cost_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope" text NOT NULL CHECK ("scope" IN ('DAY_GLOBAL','DAY_ASSISTANT','PROJECT_TOTAL','RUN')),
  "scope_ref" text,
  "amount" numeric NOT NULL CHECK ("amount" > 0),
  "currency" text NOT NULL DEFAULT 'USD',
  "warn_ratio" numeric NOT NULL DEFAULT 0.8 CHECK ("warn_ratio" > 0 AND "warn_ratio" <= 1),
  "active" boolean NOT NULL DEFAULT true,
  "note" text,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  "ended_by" text,
  "ended_at" timestamptz,
  CONSTRAINT "lumi_cost_limits_ref_chk" CHECK (("scope"='DAY_GLOBAL' AND "scope_ref" IS NULL) OR ("scope"='RUN' AND "scope_ref" IS NULL) OR ("scope" IN ('DAY_ASSISTANT','PROJECT_TOTAL') AND "scope_ref" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lumi_cost_limits_active_uq" ON "lumi_cost_limits" ("scope", coalesce("scope_ref",'')) WHERE "active";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_cost_alerts" (
  "limit_id" uuid NOT NULL REFERENCES "lumi_cost_limits"("id"),
  "day" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('WARN','STOP')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("limit_id","day","kind")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_money_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "ledger" text NOT NULL CHECK ("ledger" IN ('ADS_COST','COMMISSION','SPONSOR')),
  "state" text NOT NULL CHECK ("state" IN ('RECORDED','CONFIRMED','PAID','REVERSED','PIPELINE')),
  "amount" numeric NOT NULL CHECK ("amount" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3,5}$'),
  "period_start" date,
  "period_end" date,
  "source" text NOT NULL CHECK (length("source") BETWEEN 2 AND 200),
  "note" text CHECK ("note" IS NULL OR length("note") <= 1000),
  "parent_id" uuid REFERENCES "lumi_money_entries"("id"),
  "idempotency_key" text NOT NULL UNIQUE,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_money_period_chk" CHECK ("period_end" IS NULL OR "period_start" IS NULL OR "period_end" >= "period_start")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_money_project_idx" ON "lumi_money_entries" ("project_id","ledger","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_finance_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% là bản ghi chỉ-thêm (điều chỉnh = bản ghi mới; số cũ không bị xóa hay sửa)', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_money_append_only_trg ON "lumi_money_entries";--> statement-breakpoint
CREATE TRIGGER lumi_money_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_money_entries" FOR EACH ROW EXECUTE FUNCTION lumi_finance_append_only();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lumi_experiments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "hypothesis" text NOT NULL CHECK (length("hypothesis") >= 3),
  "baseline" text NOT NULL CHECK (length("baseline") >= 1),
  "metric_unit" text NOT NULL CHECK (length("metric_unit") >= 1),
  "metric_source" text NOT NULL CHECK (length("metric_source") >= 2),
  "observation_days" integer NOT NULL CHECK ("observation_days" BETWEEN 1 AND 365),
  "min_sample" integer NOT NULL CHECK ("min_sample" >= 1),
  "cap_amount" numeric NOT NULL CHECK ("cap_amount" >= 0),
  "max_loss" numeric NOT NULL CHECK ("max_loss" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3,5}$'),
  "stop_condition" text NOT NULL CHECK (length("stop_condition") >= 3),
  "scale_condition" text NOT NULL CHECK (length("scale_condition") >= 3),
  "target_metric_min" numeric,
  "stop_spend_no_conversion" numeric,
  "evaluator" text NOT NULL CHECK (length("evaluator") >= 2),
  "state" text NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT','LOCKED','STOPPED','SCALE_PROPOSED','INSUFFICIENT','COMPLETED')),
  "decision_note" text,
  "locked_by" text,
  "locked_at" timestamptz,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_experiment_criteria_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'DRAFT' AND (NEW.hypothesis IS DISTINCT FROM OLD.hypothesis OR NEW.baseline IS DISTINCT FROM OLD.baseline OR NEW.metric_unit IS DISTINCT FROM OLD.metric_unit
     OR NEW.metric_source IS DISTINCT FROM OLD.metric_source OR NEW.observation_days IS DISTINCT FROM OLD.observation_days OR NEW.min_sample IS DISTINCT FROM OLD.min_sample
     OR NEW.cap_amount IS DISTINCT FROM OLD.cap_amount OR NEW.max_loss IS DISTINCT FROM OLD.max_loss OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.stop_condition IS DISTINCT FROM OLD.stop_condition OR NEW.scale_condition IS DISTINCT FROM OLD.scale_condition
     OR NEW.target_metric_min IS DISTINCT FROM OLD.target_metric_min OR NEW.stop_spend_no_conversion IS DISTINCT FROM OLD.stop_spend_no_conversion OR NEW.evaluator IS DISTINCT FROM OLD.evaluator) THEN
    RAISE EXCEPTION 'tiêu chí thử nghiệm đã chốt trước khi chạy: không sửa được';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_experiment_criteria_locked_trg ON "lumi_experiments";--> statement-breakpoint
CREATE TRIGGER lumi_experiment_criteria_locked_trg BEFORE UPDATE ON "lumi_experiments" FOR EACH ROW EXECUTE FUNCTION lumi_experiment_criteria_locked();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_experiment_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "experiment_id" uuid NOT NULL REFERENCES "lumi_experiments"("id"),
  "observed_on" date NOT NULL,
  "spend" numeric NOT NULL CHECK ("spend" >= 0),
  "conversions" integer NOT NULL CHECK ("conversions" >= 0),
  "metric_value" numeric,
  "note" text CHECK ("note" IS NULL OR length("note") <= 1000),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_experiment_results_append_only_trg ON "lumi_experiment_results";--> statement-breakpoint
CREATE TRIGGER lumi_experiment_results_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_experiment_results" FOR EACH ROW EXECUTE FUNCTION lumi_finance_append_only();
