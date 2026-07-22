CREATE TYPE "public"."memory_category" AS ENUM('user_profile', 'decision', 'playbook', 'fact');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('shared', 'aff', 'yt');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_scope" "memory_scope" NOT NULL,
	"category" "memory_category" NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" "memory_status" DEFAULT 'PROPOSED' NOT NULL,
	"confidence" real,
	"source_task_id" uuid,
	"manual_entry" integer DEFAULT 0 NOT NULL,
	"reason_text" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"supersedes_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_active_by_category_uq" ON "memory_entries" USING btree ("profile_scope","category","title") WHERE status = 'ACTIVE';