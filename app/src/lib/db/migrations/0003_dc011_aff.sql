CREATE TYPE "public"."angle_status" AS ENUM('DRAFT', 'READY', 'TESTING', 'WINNER', 'LOSER', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('ACTIVE', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."offer_commission_type" AS ENUM('CPA', 'REVSHARE', 'RECURRING', 'HYBRID', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."offer_confidence" AS ENUM('VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('NEW', 'RESEARCHING', 'WATCHLIST', 'APPROVED_FOR_TEST', 'TESTING', 'ITERATE', 'SCALE', 'STOP');--> statement-breakpoint
CREATE TABLE "affiliate_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"angle_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"leads" integer,
	"sales" integer,
	"commission" real,
	"cost" real,
	"refunds" real,
	"profit" real,
	"currency" text DEFAULT 'USD' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "angles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"audience_label" text,
	"pain_point" text,
	"desire" text,
	"big_idea" text,
	"promise" text,
	"mechanism" text,
	"proof_required" text,
	"status" "angle_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"demand_score" integer,
	"longevity_score" integer,
	"competition_score" integer,
	"policy_risk_score" integer,
	"status" "market_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"traffic_source" text NOT NULL,
	"allowed" integer DEFAULT 1 NOT NULL,
	"brand_bidding" integer,
	"notes" text,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid,
	"name" text NOT NULL,
	"website_url" text,
	"network" text,
	"commission_type" "offer_commission_type" DEFAULT 'UNKNOWN' NOT NULL,
	"commission_value" real,
	"commission_unit" text,
	"cookie_days" integer,
	"payout_threshold" real,
	"countries" text[],
	"status" "offer_status" DEFAULT 'NEW' NOT NULL,
	"confidence" "offer_confidence" DEFAULT 'UNVERIFIED' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scorecards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"total_score" real NOT NULL,
	"breakdown_json" jsonb,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliate_results" ADD CONSTRAINT "affiliate_results_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_results" ADD CONSTRAINT "affiliate_results_angle_id_angles_id_fk" FOREIGN KEY ("angle_id") REFERENCES "public"."angles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "angles" ADD CONSTRAINT "angles_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_restrictions" ADD CONSTRAINT "offer_restrictions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "markets_name_uq" ON "markets" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_market_name_uq" ON "offers" USING btree ("market_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "scorecards_entity_uq" ON "scorecards" USING btree ("entity_type","entity_id","schema_version");