CREATE TYPE "public"."route_status" AS ENUM('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."route_type" AS ENUM('AFFILIATE_PROJECT', 'CONTENT_OPPORTUNITY', 'YOUTUBE_NICHE', 'WATCHLIST', 'NO_ACTION');--> statement-breakpoint
CREATE TYPE "public"."signal_confidence" AS ENUM('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."signal_kind" AS ENUM('AFFILIATE_PROGRAM', 'PRODUCT', 'KEYWORD', 'TREND', 'CONTENT_GAP', 'YOUTUBE_NICHE', 'YOUTUBE_VIDEO', 'COMPETITOR_SIGNAL', 'PERFORMANCE_EXPANSION', 'OWNER_IDEA', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."signal_origin_mode" AS ENUM('OWNER_TELEGRAM', 'OWNER_APP', 'SCHEDULED_DISCOVERY', 'CONNECTOR', 'DONGCHANNEL_SIGNAL', 'CROSS_ENGINE', 'PERFORMANCE', 'REVERIFY');--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('NEW', 'RESEARCHING', 'NEEDS_EVIDENCE', 'READY_FOR_DECISION', 'WATCHLIST', 'APPROVED', 'REJECTED', 'ROUTED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."source_item_status" AS ENUM('NEW', 'PROCESSED', 'DUPLICATE', 'IGNORED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('OWNER_TELEGRAM', 'OWNER_APP', 'AFFILIATE_NETWORK', 'MERCHANT_OFFICIAL', 'SEARCH', 'TREND', 'COMPETITOR_SITE', 'YOUTUBE', 'DONGCHANNEL_FIRST_PARTY', 'PERFORMANCE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."trust_tier" AS ENUM('OFFICIAL_PRIMARY', 'FIRST_PARTY', 'RELIABLE_SECONDARY', 'DISCOVERY_ONLY', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "opportunity_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"route_type" "route_type" NOT NULL,
	"fit_score" real,
	"reason" text,
	"status" "route_status" DEFAULT 'PROPOSED' NOT NULL,
	"created_by_run_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_routes_fit_score_range" CHECK ("opportunity_routes"."fit_score" IS NULL OR ("opportunity_routes"."fit_score" >= 0 AND "opportunity_routes"."fit_score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "opportunity_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text,
	"kind" "signal_kind" NOT NULL,
	"origin_mode" "signal_origin_mode" NOT NULL,
	"source_id" uuid,
	"source_item_id" uuid,
	"owner_seed_text" text,
	"title" text NOT NULL,
	"summary" text,
	"language" text,
	"target_geos" text[],
	"status" "signal_status" DEFAULT 'NEW' NOT NULL,
	"overall_score" real,
	"scoring_version" text,
	"score_breakdown" jsonb,
	"confidence" "signal_confidence" DEFAULT 'UNKNOWN' NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_researched_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_by_agent_run_id" uuid,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_signals_score_range" CHECK ("opportunity_signals"."overall_score" IS NULL OR ("opportunity_signals"."overall_score" >= 0 AND "opportunity_signals"."overall_score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text,
	"url" text,
	"canonical_url" text,
	"content_hash" text,
	"title" text,
	"summary" text,
	"raw_payload" jsonb,
	"status" "source_item_status" DEFAULT 'NEW' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"source_type" "source_type" NOT NULL,
	"provider" text,
	"base_url" text,
	"trust_tier" "trust_tier" DEFAULT 'UNKNOWN' NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"supports_scheduled_discovery" boolean DEFAULT false NOT NULL,
	"requires_auth" boolean DEFAULT false NOT NULL,
	"config_ref" text,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_routes" ADD CONSTRAINT "opportunity_routes_opportunity_id_opportunity_signals_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_routes_opportunity_route_uq" ON "opportunity_routes" USING btree ("opportunity_id","route_type");--> statement-breakpoint
CREATE INDEX "opportunity_routes_status_idx" ON "opportunity_routes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "opportunity_routes_type_idx" ON "opportunity_routes" USING btree ("route_type");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_signals_canonical_key_uq" ON "opportunity_signals" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "opportunity_signals_status_idx" ON "opportunity_signals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "opportunity_signals_kind_idx" ON "opportunity_signals" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "opportunity_signals_discovered_idx" ON "opportunity_signals" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "opportunity_signals_source_idx" ON "opportunity_signals" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_items_source_external_uq" ON "source_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_items_source_hash_uq" ON "source_items" USING btree ("source_id","content_hash");--> statement-breakpoint
CREATE INDEX "source_items_status_idx" ON "source_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_items_fetched_idx" ON "source_items" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_key_uq" ON "sources" USING btree ("key");--> statement-breakpoint
CREATE INDEX "sources_type_idx" ON "sources" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("is_enabled");