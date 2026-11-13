-- Đợt 8 (nhóm 3): pipeline nội dung trong ứng dụng (AGT-06/08/10/11, WRD khung): bài viết có phiên bản, mệnh đề kèm mức bằng chứng E0–E4, QA độc lập, duyệt của Chủ gắn phiên bản, xuất bản ba cổng.
-- Đích xuất bản duy nhất hiện có là bản GIẢ có nhãn (`lumi_fake_wp`); WordPress thật chưa nối. Chỉ THÊM bảng mới.
CREATE SEQUENCE IF NOT EXISTS "lumi_art_seq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_articles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE DEFAULT ('AR-' || lpad(nextval('lumi_art_seq')::text, 4, '0')),
  "project_id" uuid NOT NULL REFERENCES "lumi_projects"("id"),
  "state" text NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT','QA_PENDING','QA_FAILED','QA_PASSED','OWNER_APPROVED','PUBLISHED','REJECTED')),
  "current_version" integer NOT NULL DEFAULT 1,
  "has_affiliate_links" boolean NOT NULL DEFAULT false,
  "ai_assisted" boolean NOT NULL DEFAULT true,
  "ai_disclosure" text,
  "affiliate_disclosure" text,
  "qa_version" integer, "qa_by" text, "qa_at" timestamptz, "qa_notes" text,
  "approved_version" integer, "approved_by" text, "approved_at" timestamptz,
  "published_version" integer, "published_at" timestamptz, "publish_target" text, "publish_ref" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_article_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "article_id" uuid NOT NULL REFERENCES "lumi_articles"("id"),
  "version" integer NOT NULL,
  "title" text NOT NULL CHECK (length("title") BETWEEN 3 AND 200),
  "body" text NOT NULL CHECK (length("body") BETWEEN 3 AND 60000),
  "content_hash" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_article_versions_uq" UNIQUE ("article_id","version")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_article_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "article_id" uuid NOT NULL REFERENCES "lumi_articles"("id"),
  "version" integer NOT NULL,
  "text" text NOT NULL CHECK (length("text") BETWEEN 3 AND 1000),
  "evidence_level" text NOT NULL CHECK ("evidence_level" IN ('E0','E1','E2','E3','E4')),
  "source_ref" text CHECK ("source_ref" IS NULL OR length("source_ref") <= 500),
  "is_opinion" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lumi_article_claims_idx" ON "lumi_article_claims" ("article_id","version");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lumi_fake_wp" (
  "post_ref" text PRIMARY KEY,
  "article_id" uuid NOT NULL REFERENCES "lumi_articles"("id"),
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "label" text NOT NULL DEFAULT 'ADAPTER GIẢ — không phải website thật',
  "published_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lumi_fake_wp_uq" UNIQUE ("article_id","version")
);--> statement-breakpoint
DROP TRIGGER IF EXISTS lumi_article_versions_append_only_trg ON "lumi_article_versions";--> statement-breakpoint
CREATE TRIGGER lumi_article_versions_append_only_trg BEFORE UPDATE OR DELETE ON "lumi_article_versions" FOR EACH ROW EXECUTE FUNCTION lumi_ops_append_only();
