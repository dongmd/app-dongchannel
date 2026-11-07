-- IMP-02 (CMP-03): chính sách vận hành do Chủ đặt, CÓ PHIÊN BẢN, không có giá trị mặc định (SR-16). CHỈ THÊM: một bảng và trigger chỉ-thêm.
-- Mã M1/IMP-01 cũ bỏ qua bảng này. Một dòng = một phiên bản của (key, scope); phiên bản hiện hành = số lớn nhất; "bỏ đặt" là một phiên bản mới có value = null.
CREATE TABLE IF NOT EXISTS "lumi_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" text NOT NULL CHECK ("key" IN ('prepare_fund','max_loss','report_cadence_days','proposal_ttl_days','meeting_cap','currency','owner_hourly_rate')),
  "scope" text NOT NULL DEFAULT 'COMPANY' CHECK (length("scope") BETWEEN 1 AND 80),
  "version" integer NOT NULL CHECK ("version" >= 1),
  "value" jsonb,
  "note" text CHECK ("note" IS NULL OR length("note") <= 500),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("key","scope","version")
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION lumi_policies_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'lumi_policies là bản ghi chỉ-thêm (đổi chính sách = phiên bản mới)';
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_policies_append_only_trg ON "lumi_policies";--> statement-breakpoint
CREATE TRIGGER lumi_policies_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_policies" FOR EACH ROW EXECUTE FUNCTION lumi_policies_append_only();
