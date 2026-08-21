CREATE TYPE "public"."affiliate_candidate_status" AS ENUM('PROPOSED', 'TRIAGED', 'ACCEPTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."verified_tristate" AS ENUM('YES', 'NO', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "affiliate_project_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_key" text NOT NULL,
	"vendor_name" text NOT NULL,
	"programme_exists" "verified_tristate" DEFAULT 'UNKNOWN' NOT NULL,
	"programme_observed_url" text,
	"programme_observed_at" timestamp with time zone,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "affiliate_candidate_status" DEFAULT 'PROPOSED' NOT NULL,
	"status_reason" text,
	"triaged_by" text,
	"triaged_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_project_candidates_existence_needs_source" CHECK ("affiliate_project_candidates"."programme_exists" = 'UNKNOWN'
          OR ("affiliate_project_candidates"."programme_observed_url" IS NOT NULL
              AND length(btrim("affiliate_project_candidates"."programme_observed_url")) > 0
              AND "affiliate_project_candidates"."programme_observed_at" IS NOT NULL)),
	CONSTRAINT "affiliate_project_candidates_triage_needs_actor" CHECK ("affiliate_project_candidates"."status" IN ('PROPOSED')
          OR ("affiliate_project_candidates"."triaged_by" IS NOT NULL AND length(btrim("affiliate_project_candidates"."triaged_by")) > 0
              AND "affiliate_project_candidates"."triaged_at" IS NOT NULL)),
	CONSTRAINT "affiliate_project_candidates_rejection_needs_reason" CHECK ("affiliate_project_candidates"."status" <> 'REJECTED'
          OR ("affiliate_project_candidates"."status_reason" IS NOT NULL AND length(btrim("affiliate_project_candidates"."status_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "affiliate_candidate_evidence" (
	"candidate_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"contribution" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_candidate_evidence_candidate_id_signal_id_pk" PRIMARY KEY("candidate_id","signal_id")
);
--> statement-breakpoint
ALTER TABLE "affiliate_candidate_evidence" ADD CONSTRAINT "affiliate_candidate_evidence_candidate_id_affiliate_project_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."affiliate_project_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_candidate_evidence" ADD CONSTRAINT "affiliate_candidate_evidence_signal_id_opportunity_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."opportunity_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_project_candidates_key_uq" ON "affiliate_project_candidates" USING btree ("candidate_key");--> statement-breakpoint
CREATE INDEX "affiliate_project_candidates_status_idx" ON "affiliate_project_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "affiliate_candidate_evidence_signal_idx" ON "affiliate_candidate_evidence" USING btree ("signal_id");