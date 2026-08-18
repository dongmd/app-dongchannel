CREATE TABLE "affiliate_program_geos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"geo" text NOT NULL,
	"payout_type" "offer_commission_type",
	"payout_value" real,
	"payout_currency" text,
	"payout_unit" text,
	"cookie_duration_days" integer,
	"ppc_allowed" "affiliate_permission",
	"brand_bidding_allowed" "affiliate_permission",
	"direct_linking_allowed" "affiliate_permission",
	"confidence" "offer_confidence" DEFAULT 'UNVERIFIED' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_program_geos_geo_format" CHECK ("affiliate_program_geos"."geo" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "affiliate_program_geos" ADD CONSTRAINT "affiliate_program_geos_program_id_affiliate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_program_geos_program_geo_uq" ON "affiliate_program_geos" USING btree ("program_id","geo");--> statement-breakpoint
CREATE INDEX "affiliate_program_geos_geo_idx" ON "affiliate_program_geos" USING btree ("geo");