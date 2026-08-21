CREATE TABLE "trend_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"rationale" text,
	"added_by" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trend_allowlist_term_shape" CHECK ("trend_allowlist"."term" = lower(btrim("trend_allowlist"."term")) AND length("trend_allowlist"."term") > 0),
	CONSTRAINT "trend_allowlist_added_by_required" CHECK (length(btrim("trend_allowlist"."added_by")) > 0)
);
--> statement-breakpoint
ALTER TABLE "topic_cluster_projections" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "trend_allowlist_term_uq" ON "trend_allowlist" USING btree ("term");--> statement-breakpoint
CREATE INDEX "trend_allowlist_enabled_idx" ON "trend_allowlist" USING btree ("enabled");