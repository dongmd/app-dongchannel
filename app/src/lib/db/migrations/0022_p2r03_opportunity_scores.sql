CREATE TABLE "content_opportunity_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_opportunity_id" uuid NOT NULL,
	"scoring_config_version" text NOT NULL,
	"inputs_fingerprint" text NOT NULL,
	"raw_score" real NOT NULL,
	"normalised_score" real NOT NULL,
	"breakdown" jsonb NOT NULL,
	"known_dimensions" real NOT NULL,
	"total_dimensions" real NOT NULL,
	"evidence_signal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_opportunity_scores_normalised_range" CHECK ("content_opportunity_scores"."normalised_score" >= 0 AND "content_opportunity_scores"."normalised_score" <= 100),
	CONSTRAINT "content_opportunity_scores_raw_range" CHECK ("content_opportunity_scores"."raw_score" >= -20 AND "content_opportunity_scores"."raw_score" <= 100),
	CONSTRAINT "content_opportunity_scores_dimensions_sane" CHECK ("content_opportunity_scores"."known_dimensions" >= 0
          AND "content_opportunity_scores"."total_dimensions" > 0
          AND "content_opportunity_scores"."known_dimensions" <= "content_opportunity_scores"."total_dimensions"),
	CONSTRAINT "content_opportunity_scores_computed_by_required" CHECK (length(btrim("content_opportunity_scores"."computed_by")) > 0)
);
--> statement-breakpoint
ALTER TABLE "content_opportunity_scores" ADD CONSTRAINT "content_opportunity_scores_content_opportunity_id_content_opportunities_id_fk" FOREIGN KEY ("content_opportunity_id") REFERENCES "public"."content_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_opportunity_scores_idempotency_uq" ON "content_opportunity_scores" USING btree ("content_opportunity_id","scoring_config_version","inputs_fingerprint");--> statement-breakpoint
CREATE INDEX "content_opportunity_scores_opportunity_idx" ON "content_opportunity_scores" USING btree ("content_opportunity_id");--> statement-breakpoint
CREATE INDEX "content_opportunity_scores_rank_idx" ON "content_opportunity_scores" USING btree ("normalised_score");--> statement-breakpoint
CREATE INDEX "content_opportunity_scores_version_idx" ON "content_opportunity_scores" USING btree ("scoring_config_version");