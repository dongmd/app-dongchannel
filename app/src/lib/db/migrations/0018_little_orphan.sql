CREATE TYPE "public"."content_opportunity_status" AS ENUM('PROPOSED', 'RESEARCHING', 'READY', 'IN_PRODUCTION', 'PUBLISHED', 'REJECTED', 'DROPPED');--> statement-breakpoint
CREATE TYPE "public"."opportunity_origin_type" AS ENUM('AFFILIATE_OFFER', 'KEYWORD', 'TREND', 'PRODUCT_TOOL', 'COMPETITOR_MOVE', 'CONTENT_GAP', 'PERFORMANCE_EXPANSION', 'OWNER_SEED');--> statement-breakpoint
CREATE TABLE "content_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origin_type" "opportunity_origin_type" NOT NULL,
	"origin_id" text,
	"content_mode" "content_mode" NOT NULL,
	"title" text NOT NULL,
	"rationale" text,
	"claims_to_check" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "content_opportunity_status" DEFAULT 'PROPOSED' NOT NULL,
	"closed_reason" text,
	"closed_at" timestamp with time zone,
	"profile_slug" text,
	"created_by_agent_run_id" uuid,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_opportunities_closed_needs_reason" CHECK ("content_opportunities"."status" NOT IN ('REJECTED','DROPPED')
          OR ("content_opportunities"."closed_reason" IS NOT NULL AND length(btrim("content_opportunities"."closed_reason")) > 0)),
	CONSTRAINT "content_opportunities_closed_needs_time" CHECK ("content_opportunities"."status" NOT IN ('PUBLISHED','REJECTED','DROPPED') OR "content_opportunities"."closed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "content_opportunity_signals" (
	"content_opportunity_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"contribution" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_opportunity_signals_content_opportunity_id_signal_id_pk" PRIMARY KEY("content_opportunity_id","signal_id")
);
--> statement-breakpoint
ALTER TABLE "content_opportunities" ADD CONSTRAINT "content_opportunities_profile_slug_profiles_slug_fk" FOREIGN KEY ("profile_slug") REFERENCES "public"."profiles"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_opportunity_signals" ADD CONSTRAINT "content_opportunity_signals_content_opportunity_id_content_opportunities_id_fk" FOREIGN KEY ("content_opportunity_id") REFERENCES "public"."content_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_opportunity_signals" ADD CONSTRAINT "content_opportunity_signals_signal_id_opportunity_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."opportunity_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_opportunities_status_idx" ON "content_opportunities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "content_opportunities_mode_idx" ON "content_opportunities" USING btree ("content_mode");--> statement-breakpoint
CREATE INDEX "content_opportunities_origin_idx" ON "content_opportunities" USING btree ("origin_type");--> statement-breakpoint
CREATE INDEX "content_opportunities_profile_idx" ON "content_opportunities" USING btree ("profile_slug");--> statement-breakpoint
CREATE INDEX "content_opportunity_signals_signal_idx" ON "content_opportunity_signals" USING btree ("signal_id");