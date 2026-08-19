CREATE TYPE "public"."wp_sync_job_state" AS ENUM('QUEUED', 'RUNNING', 'DONE', 'FAILED_RETRYABLE', 'FAILED_PERMANENT');--> statement-breakpoint
CREATE TYPE "public"."wp_sync_status" AS ENUM('PENDING', 'SYNCED', 'CONFLICT', 'FAILED');--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"official_url" text,
	"pricing_model" text,
	"price_amount" numeric(12, 2),
	"price_currency" text,
	"price_period" text,
	"price_display" text,
	"free_plan" boolean,
	"free_trial" boolean,
	"trial_length" text,
	"moneyback" text,
	"has_coupon" boolean,
	"last_verified" date,
	"last_price_check" date,
	"active" boolean DEFAULT true NOT NULL,
	"source_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wordpress_product_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"wp_post_id" integer NOT NULL,
	"status" "wp_sync_status" DEFAULT 'PENDING' NOT NULL,
	"synced_source_version" integer,
	"wp_content_hash" text,
	"wp_post_modified_gmt" text,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wordpress_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "wp_sync_job_state" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wordpress_product_sync" ADD CONSTRAINT "wordpress_product_sync_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordpress_sync_jobs" ADD CONSTRAINT "wordpress_sync_jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_uq" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_active_idx" ON "products" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "wp_sync_product_uq" ON "wordpress_product_sync" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wp_sync_post_uq" ON "wordpress_product_sync" USING btree ("wp_post_id");--> statement-breakpoint
CREATE INDEX "wp_sync_status_idx" ON "wordpress_product_sync" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "wp_sync_jobs_key_uq" ON "wordpress_sync_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "wp_sync_jobs_due_idx" ON "wordpress_sync_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "wp_sync_jobs_product_idx" ON "wordpress_sync_jobs" USING btree ("product_id");