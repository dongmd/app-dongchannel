CREATE TYPE "public"."wp_article_sync_state" AS ENUM('BASELINE_SET', 'CONFLICT');--> statement-breakpoint
CREATE TABLE "wordpress_article_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wp_post_id" integer NOT NULL,
	"state" "wp_article_sync_state" DEFAULT 'BASELINE_SET' NOT NULL,
	"wp_content_hash" text,
	"wp_post_modified_gmt" text,
	"wp_post_status" text,
	"hash_contract_version" text,
	"wp_last_synced_at" timestamp with time zone,
	"conflict_detected_at" timestamp with time zone,
	"conflict_reason" text,
	"conflict_baseline_hash" text,
	"conflict_observed_hash" text,
	"conflict_baseline_modified_gmt" text,
	"conflict_observed_modified_gmt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wp_article_sync_post_uq" ON "wordpress_article_sync" USING btree ("wp_post_id");--> statement-breakpoint
CREATE INDEX "wp_article_sync_state_idx" ON "wordpress_article_sync" USING btree ("state");