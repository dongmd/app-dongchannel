CREATE TYPE "public"."topic_cluster_state" AS ENUM('THIN', 'DEVELOPING', 'SATURATED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."cluster_projection_state" AS ENUM('PENDING', 'PROJECTED', 'DIVERGED', 'WITHDRAWN');--> statement-breakpoint
CREATE TABLE "topic_cluster_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_cluster_id" uuid NOT NULL,
	"wp_taxonomy" text DEFAULT 'dc_category' NOT NULL,
	"wp_term_slug" text NOT NULL,
	"wp_term_id" integer,
	"state" "cluster_projection_state" DEFAULT 'PENDING' NOT NULL,
	"projection_fingerprint" text NOT NULL,
	"last_projected_at" timestamp with time zone,
	"divergence_reason" text,
	"divergence_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_cluster_projections_projected_needs_term" CHECK ("topic_cluster_projections"."state" <> 'PROJECTED'
          OR ("topic_cluster_projections"."wp_term_id" IS NOT NULL AND "topic_cluster_projections"."last_projected_at" IS NOT NULL)),
	CONSTRAINT "topic_cluster_projections_diverged_needs_reason" CHECK ("topic_cluster_projections"."state" <> 'DIVERGED'
          OR ("topic_cluster_projections"."divergence_reason" IS NOT NULL
              AND length(btrim("topic_cluster_projections"."divergence_reason")) > 0)),
	CONSTRAINT "topic_cluster_projections_slug_shape" CHECK ("topic_cluster_projections"."wp_term_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "topic_cluster_projections_slug_not_reserved" CHECK ("topic_cluster_projections"."wp_term_slug" NOT IN ('category','guides','tag','author','page','feed'))
);
--> statement-breakpoint
CREATE TABLE "topic_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"state" "topic_cluster_state" DEFAULT 'THIN' NOT NULL,
	"profile_slug" text,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_clusters_key_shape" CHECK ("topic_clusters"."key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "topic_cluster_projections" ADD CONSTRAINT "topic_cluster_projections_topic_cluster_id_topic_clusters_id_fk" FOREIGN KEY ("topic_cluster_id") REFERENCES "public"."topic_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_clusters" ADD CONSTRAINT "topic_clusters_profile_slug_profiles_slug_fk" FOREIGN KEY ("profile_slug") REFERENCES "public"."profiles"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_cluster_projections_cluster_taxonomy_uq" ON "topic_cluster_projections" USING btree ("topic_cluster_id","wp_taxonomy");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_cluster_projections_taxonomy_slug_uq" ON "topic_cluster_projections" USING btree ("wp_taxonomy","wp_term_slug");--> statement-breakpoint
CREATE INDEX "topic_cluster_projections_state_idx" ON "topic_cluster_projections" USING btree ("state");--> statement-breakpoint
CREATE INDEX "topic_cluster_projections_term_idx" ON "topic_cluster_projections" USING btree ("wp_term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_clusters_key_uq" ON "topic_clusters" USING btree ("key");--> statement-breakpoint
CREATE INDEX "topic_clusters_state_idx" ON "topic_clusters" USING btree ("state");