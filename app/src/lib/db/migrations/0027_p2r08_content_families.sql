CREATE TYPE "public"."content_family" AS ENUM('dc_review', 'dc_bestpicks', 'dc_comparison', 'dc_workflow', 'dc_deal');--> statement-breakpoint
CREATE TABLE "content_family_policies" (
	"family" "content_family" PRIMARY KEY NOT NULL,
	"content_mode" "content_mode" NOT NULL,
	"min_evidence_level" "evidence_level",
	"updated_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_family_policies_updated_by_required" CHECK (length(btrim("content_family_policies"."updated_by")) > 0)
);
--> statement-breakpoint
CREATE INDEX "content_family_policies_mode_idx" ON "content_family_policies" USING btree ("content_mode");