CREATE TYPE "public"."affiliate_permission" AS ENUM('YES', 'NO', 'CONDITIONAL', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "affiliate_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"market_id" uuid,
	"network_id" uuid,
	"network_external_ref" text,
	"name" text NOT NULL,
	"program_url" text,
	"application_url" text,
	"payout_type" "offer_commission_type" DEFAULT 'UNKNOWN' NOT NULL,
	"payout_value" real,
	"payout_currency" text,
	"payout_unit" text,
	"recurring" boolean,
	"cookie_duration_days" integer,
	"payout_threshold" real,
	"ppc_allowed" "affiliate_permission" DEFAULT 'UNKNOWN' NOT NULL,
	"brand_bidding_allowed" "affiliate_permission" DEFAULT 'UNKNOWN' NOT NULL,
	"direct_linking_allowed" "affiliate_permission" DEFAULT 'UNKNOWN' NOT NULL,
	"application_required" "affiliate_permission" DEFAULT 'UNKNOWN' NOT NULL,
	"owner_account_status" text,
	"status" "offer_status" DEFAULT 'NEW' NOT NULL,
	"confidence" "offer_confidence" DEFAULT 'UNVERIFIED' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_network_id_affiliate_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."affiliate_networks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_programs_merchant_name_uq" ON "affiliate_programs" USING btree ("merchant_id","name");--> statement-breakpoint
CREATE INDEX "affiliate_programs_merchant_idx" ON "affiliate_programs" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "affiliate_programs_network_idx" ON "affiliate_programs" USING btree ("network_id");--> statement-breakpoint
CREATE INDEX "affiliate_programs_market_idx" ON "affiliate_programs" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "affiliate_programs_status_idx" ON "affiliate_programs" USING btree ("status");