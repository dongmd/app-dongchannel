CREATE TYPE "public"."claim_source_access" AS ENUM('PUBLIC_WEB', 'AUTHENTICATED', 'FIRST_PARTY');--> statement-breakpoint
CREATE TYPE "public"."claim_visibility" AS ENUM('PUBLIC', 'INTERNAL', 'CONFIDENTIAL');--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "source_access" "claim_source_access" DEFAULT 'FIRST_PARTY' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "visibility" "claim_visibility" DEFAULT 'CONFIDENTIAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "visibility_override_by" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "visibility_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "visibility_override_reason" text;--> statement-breakpoint
CREATE INDEX "claims_visibility_idx" ON "claims" USING btree ("visibility");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_public_requires_open_source_or_override" CHECK ("claims"."visibility" <> 'PUBLIC'
          OR "claims"."source_access" = 'PUBLIC_WEB'
          OR "claims"."visibility_override_by" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_override_needs_date" CHECK ("claims"."visibility_override_by" IS NULL OR "claims"."visibility_override_at" IS NOT NULL);