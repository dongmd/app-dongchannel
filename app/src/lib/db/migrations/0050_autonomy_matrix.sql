-- Đợt 7 (APR-07): ma trận tự chủ cấu hình được. Chỉ THÊM bảng mới. Mỗi lần đổi là một dòng mới (lịch sử), hiện hành = dòng mới nhất của từng loại hành động.
CREATE TABLE IF NOT EXISTS "lumi_autonomy_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "action_type" text NOT NULL CHECK (length("action_type") BETWEEN 2 AND 60),
  "mode" text NOT NULL CHECK ("mode" IN ('AUTO','GRANT','OFF')),
  "set_by" text NOT NULL,
  "note" text CHECK ("note" IS NULL OR length("note") <= 500),
  "set_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_autonomy_rules_idx" ON "lumi_autonomy_rules" ("action_type","set_at" DESC);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_autonomy_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% là bản ghi chỉ-thêm (đổi quy tắc = dòng mới)', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_autonomy_append_only_trg ON "lumi_autonomy_rules";--> statement-breakpoint
CREATE TRIGGER lumi_autonomy_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_autonomy_rules" FOR EACH ROW EXECUTE FUNCTION lumi_autonomy_append_only();
