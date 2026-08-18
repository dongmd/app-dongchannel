CREATE TYPE "public"."affiliate_network_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."merchant_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "affiliate_networks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"website_url" text,
	"status" "affiliate_network_status" DEFAULT 'ACTIVE' NOT NULL,
	"owner_account_status" text,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website_url" text,
	"canonical_domain" text,
	"status" "merchant_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_networks_key_uq" ON "affiliate_networks" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_name_uq" ON "merchants" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_canonical_domain_uq" ON "merchants" USING btree ("canonical_domain");