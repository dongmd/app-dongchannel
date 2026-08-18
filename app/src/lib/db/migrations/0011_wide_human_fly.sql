CREATE TYPE "public"."affiliate_project_status" AS ENUM('CANDIDATE', 'RESEARCH', 'READY_FOR_APPROVAL', 'APPROVED_FOR_TEST', 'CAMPAIGN_DRAFTED', 'TESTING', 'SCALE', 'HOLD', 'STOPPED');--> statement-breakpoint
CREATE TYPE "public"."affiliate_test_status" AS ENUM('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."affiliate_traffic_route" AS ENUM('PPC', 'SEO', 'CONTENT', 'YOUTUBE', 'OTHER');--> statement-breakpoint
CREATE TABLE "affiliate_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "affiliate_project_status" DEFAULT 'CANDIDATE' NOT NULL,
	"route" "affiliate_traffic_route",
	"route_reason" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_test_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"spend" real,
	"conversions_reported" integer,
	"conversions_validated" integer,
	"commission_reported" real,
	"commission_validated" real,
	"currency" text DEFAULT 'USD' NOT NULL,
	"net_profit_validated" real,
	"source" text,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_test_metrics_period_order" CHECK ("affiliate_test_metrics"."period_end" > "affiliate_test_metrics"."period_start")
);
--> statement-breakpoint
CREATE TABLE "affiliate_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"angle_id" uuid,
	"geo_id" uuid,
	"name" text NOT NULL,
	"status" "affiliate_test_status" DEFAULT 'DRAFT' NOT NULL,
	"route" "affiliate_traffic_route",
	"budget_cap_value" real,
	"budget_cap_currency" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"stop_reason" text,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliate_projects" ADD CONSTRAINT "affiliate_projects_program_id_affiliate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_test_metrics" ADD CONSTRAINT "affiliate_test_metrics_test_id_affiliate_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."affiliate_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_tests" ADD CONSTRAINT "affiliate_tests_project_id_affiliate_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."affiliate_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_tests" ADD CONSTRAINT "affiliate_tests_angle_id_angles_id_fk" FOREIGN KEY ("angle_id") REFERENCES "public"."angles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_tests" ADD CONSTRAINT "affiliate_tests_geo_id_affiliate_program_geos_id_fk" FOREIGN KEY ("geo_id") REFERENCES "public"."affiliate_program_geos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_projects_program_name_uq" ON "affiliate_projects" USING btree ("program_id","name");--> statement-breakpoint
CREATE INDEX "affiliate_projects_status_idx" ON "affiliate_projects" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_test_metrics_test_period_uq" ON "affiliate_test_metrics" USING btree ("test_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "affiliate_test_metrics_test_idx" ON "affiliate_test_metrics" USING btree ("test_id");--> statement-breakpoint
CREATE INDEX "affiliate_tests_project_idx" ON "affiliate_tests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "affiliate_tests_status_idx" ON "affiliate_tests" USING btree ("status");