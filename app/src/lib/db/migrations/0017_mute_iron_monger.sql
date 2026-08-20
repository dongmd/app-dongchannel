CREATE TYPE "public"."content_mode" AS ENUM('COMMERCIAL', 'EVERGREEN', 'NEWS', 'TREND', 'UPDATE');--> statement-breakpoint
CREATE TYPE "public"."content_refresh_state" AS ENUM('FRESH', 'REFRESH_REQUIRED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."evidence_level" AS ENUM('E0', 'E1', 'E2', 'E3', 'E4');--> statement-breakpoint
CREATE TYPE "public"."qa_depth" AS ENUM('FULL', 'STANDARD', 'EXPEDITED');--> statement-breakpoint
CREATE TABLE "article_content_modes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wp_post_id" integer NOT NULL,
	"content_mode" "content_mode" NOT NULL,
	"mode_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode_set_by" text NOT NULL,
	"mode_reason" text,
	"freshness_anchor_at" timestamp with time zone,
	"refresh_state" "content_refresh_state" DEFAULT 'UNKNOWN' NOT NULL,
	"refresh_state_derived_at" timestamp with time zone,
	"policy_version_at_derivation" text,
	"commissioned_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_mode_policies" (
	"mode" "content_mode" PRIMARY KEY NOT NULL,
	"ttl_days" integer,
	"qa_depth" "qa_depth",
	"min_evidence_level" "evidence_level",
	"sla_hours" integer,
	"updated_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_mode_policies_ttl_positive" CHECK ("content_mode_policies"."ttl_days" IS NULL OR "content_mode_policies"."ttl_days" > 0),
	CONSTRAINT "content_mode_policies_sla_positive" CHECK ("content_mode_policies"."sla_hours" IS NULL OR "content_mode_policies"."sla_hours" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "article_content_modes_wp_post_uq" ON "article_content_modes" USING btree ("wp_post_id");--> statement-breakpoint
CREATE INDEX "article_content_modes_mode_idx" ON "article_content_modes" USING btree ("content_mode");--> statement-breakpoint
CREATE INDEX "article_content_modes_refresh_idx" ON "article_content_modes" USING btree ("refresh_state");--> statement-breakpoint
CREATE INDEX "article_content_modes_anchor_idx" ON "article_content_modes" USING btree ("freshness_anchor_at");