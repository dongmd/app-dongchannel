CREATE TYPE "public"."claim_support_type" AS ENUM('SUPPORTS', 'CONTRADICTS', 'CONTEXT');--> statement-breakpoint
CREATE TYPE "public"."claim_verification_status" AS ENUM('UNVERIFIED', 'VERIFIED', 'CONTRADICTED', 'SUPERSEDED', 'EXPIRED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."evidence_confidence" AS ENUM('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."evidence_status" AS ENUM('ACTIVE', 'SUPERSEDED', 'RETRACTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"support_type" "claim_support_type" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"claim_key" text NOT NULL,
	"claim_text" text NOT NULL,
	"normalized_value" jsonb,
	"verification_status" "claim_verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"expires_at" timestamp with time zone,
	"agent_run_id" uuid,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_verified_needs_date" CHECK ("claims"."verification_status" <> 'VERIFIED' OR "claims"."verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_id" uuid,
	"source_url" text,
	"source_ref" text,
	"publisher" text,
	"title" text,
	"excerpt" text,
	"content_hash" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fresh_until" timestamp with time zone,
	"confidence" "evidence_confidence" DEFAULT 'UNKNOWN' NOT NULL,
	"status" "evidence_status" DEFAULT 'ACTIVE' NOT NULL,
	"agent_run_id" uuid,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_fresh_after_capture" CHECK ("evidence"."fresh_until" IS NULL OR "evidence"."fresh_until" > "evidence"."captured_at")
);
--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claim_evidence_pair_uq" ON "claim_evidence" USING btree ("claim_id","evidence_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_claim_idx" ON "claim_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_evidence_idx" ON "claim_evidence" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "claims_entity_key_idx" ON "claims" USING btree ("entity_type","entity_id","claim_key");--> statement-breakpoint
CREATE INDEX "claims_verification_status_idx" ON "claims" USING btree ("verification_status");--> statement-breakpoint
CREATE INDEX "claims_expires_idx" ON "claims" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "evidence_entity_idx" ON "evidence" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "evidence_status_idx" ON "evidence" USING btree ("status");--> statement-breakpoint
CREATE INDEX "evidence_fresh_until_idx" ON "evidence" USING btree ("fresh_until");--> statement-breakpoint
CREATE INDEX "evidence_source_idx" ON "evidence" USING btree ("source_id");