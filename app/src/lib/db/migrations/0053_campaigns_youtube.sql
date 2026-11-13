-- Đợt 8 (nhóm 2): chiến dịch affiliate và số liệu theo kỳ nhập tay có nguồn (AFF-02/03/05/06), hiệu suất video theo cửa sổ (YTB-02), chiến lược YouTube có phiên bản (YTB-04).
-- Chỉ THÊM bảng mới; không đổi bảng hệ cũ. Không có cột «lợi nhuận».
CREATE SEQUENCE IF NOT EXISTS "lumi_cmp_seq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE DEFAULT ('CP-' || lpad(nextval('lumi_cmp_seq')::text, 4, '0')),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "name" text NOT NULL CHECK (length("name") BETWEEN 3 AND 160),
  "network" text CHECK ("network" IS NULL OR length("network") <= 80),
  "offer_id" uuid,
  "state" text NOT NULL DEFAULT 'PLANNED' CHECK ("state" IN ('PLANNED','ACTIVE','PAUSED','ENDED')),
  "cap_amount" numeric CHECK ("cap_amount" IS NULL OR "cap_amount" > 0),
  "currency" text NOT NULL DEFAULT 'USD' CHECK ("currency" ~ '^[A-Z]{3,5}$'),
  "pause_reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_campaign_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL REFERENCES "lumi_campaigns"("id"),
  "event" text NOT NULL,
  "detail" text,
  "by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_campaign_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL REFERENCES "lumi_campaigns"("id"),
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "spend" numeric CHECK ("spend" IS NULL OR "spend" >= 0),
  "clicks" integer CHECK ("clicks" IS NULL OR "clicks" >= 0),
  "conversions" integer CHECK ("conversions" IS NULL OR "conversions" >= 0),
  "revenue" numeric CHECK ("revenue" IS NULL OR "revenue" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3,5}$'),
  "source" text NOT NULL CHECK (length("source") BETWEEN 2 AND 200),
  "idempotency_key" text NOT NULL UNIQUE,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_cmp_metrics_period_chk" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "lumi_cmp_metrics_any_chk" CHECK ("spend" IS NOT NULL OR "clicks" IS NOT NULL OR "conversions" IS NOT NULL OR "revenue" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_cmp_metrics_idx" ON "lumi_campaign_metrics" ("campaign_id","period_start");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_video_perf" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "video_id" uuid NOT NULL REFERENCES "videos"("id"),
  "window_days" integer NOT NULL CHECK ("window_days" IN (1,7,28,90)),
  "captured_at" timestamptz NOT NULL,
  "impressions" bigint CHECK ("impressions" IS NULL OR "impressions" >= 0),
  "views" bigint CHECK ("views" IS NULL OR "views" >= 0),
  "ctr" numeric CHECK ("ctr" IS NULL OR ("ctr" >= 0 AND "ctr" <= 1)),
  "retention_30s" numeric CHECK ("retention_30s" IS NULL OR ("retention_30s" >= 0 AND "retention_30s" <= 1)),
  "avg_pct_viewed" numeric CHECK ("avg_pct_viewed" IS NULL OR ("avg_pct_viewed" >= 0 AND "avg_pct_viewed" <= 1)),
  "subscribers" integer,
  "affiliate_clicks" integer CHECK ("affiliate_clicks" IS NULL OR "affiliate_clicks" >= 0),
  "revenue" numeric CHECK ("revenue" IS NULL OR "revenue" >= 0),
  "currency" text NOT NULL DEFAULT 'USD',
  "source" text NOT NULL CHECK (length("source") BETWEEN 2 AND 200),
  "idempotency_key" text NOT NULL UNIQUE,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_video_perf_idx" ON "lumi_video_perf" ("video_id","window_days","captured_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_yt_strategy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "version" integer NOT NULL,
  "channel_goal" text NOT NULL CHECK (length("channel_goal") BETWEEN 3 AND 1000),
  "uniqueness_rules" text NOT NULL CHECK (length("uniqueness_rules") BETWEEN 3 AND 2000),
  "pattern_breaks" text NOT NULL CHECK (length("pattern_breaks") BETWEEN 3 AND 2000),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_yt_strategy_uq" UNIQUE ("project_id","version")
);--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_cmp_events_append_only_trg ON "lumi_campaign_events";--> statement-breakpoint
CREATE TRIGGER lumi_cmp_events_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_campaign_events" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_cmp_metrics_append_only_trg ON "lumi_campaign_metrics";--> statement-breakpoint
CREATE TRIGGER lumi_cmp_metrics_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_campaign_metrics" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_video_perf_append_only_trg ON "lumi_video_perf";--> statement-breakpoint
CREATE TRIGGER lumi_video_perf_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_video_perf" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_yt_strategy_append_only_trg ON "lumi_yt_strategy";--> statement-breakpoint
CREATE TRIGGER lumi_yt_strategy_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_yt_strategy" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();
