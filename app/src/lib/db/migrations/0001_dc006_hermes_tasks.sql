CREATE TYPE "public"."task_review_status" AS ENUM('NONE', 'PENDING', 'APPROVED', 'REVISION_REQUESTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('CAPTURED', 'QUEUED', 'RUNNING', 'WAITING_REVIEW', 'APPROVED', 'REVISION_REQUESTED', 'REJECTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'SYNC_DELAYED', 'IMPORTED');--> statement-breakpoint
CREATE TABLE "profiles" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'bot' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hermes_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"external_message_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"tool_name" text,
	"tool_call_id" text,
	"token_count" integer,
	"finish_reason" text,
	"occurred_at" timestamp with time zone,
	"raw_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hermes_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_slug" text NOT NULL,
	"hermes_session_id" text NOT NULL,
	"source" text,
	"chat_id" text,
	"user_id" text,
	"chat_type" text,
	"display_name" text,
	"title" text,
	"model" text,
	"started_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_usd" real,
	"archived" integer DEFAULT 0 NOT NULL,
	"raw_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"external_event_id" text,
	"event_type" text NOT NULL,
	"step_name" text,
	"status" text,
	"payload_redacted" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"profile_slug" text NOT NULL,
	"source_hermes_session_id" uuid,
	"source_hermes_message_id" uuid,
	"title" text NOT NULL,
	"type" text,
	"status" "task_status" DEFAULT 'IMPORTED' NOT NULL,
	"review_status" "task_review_status" DEFAULT 'NONE' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hermes_messages" ADD CONSTRAINT "hermes_messages_session_id_hermes_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."hermes_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_sessions" ADD CONSTRAINT "hermes_sessions_profile_slug_profiles_slug_fk" FOREIGN KEY ("profile_slug") REFERENCES "public"."profiles"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_profile_slug_profiles_slug_fk" FOREIGN KEY ("profile_slug") REFERENCES "public"."profiles"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_hermes_session_id_hermes_sessions_id_fk" FOREIGN KEY ("source_hermes_session_id") REFERENCES "public"."hermes_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_hermes_message_id_hermes_messages_id_fk" FOREIGN KEY ("source_hermes_message_id") REFERENCES "public"."hermes_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_messages_session_msg_uq" ON "hermes_messages" USING btree ("session_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_sessions_profile_session_uq" ON "hermes_sessions" USING btree ("profile_slug","hermes_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_activities_external_event_uq" ON "task_activities" USING btree ("external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_code_uq" ON "tasks" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_session_uq" ON "tasks" USING btree ("source_hermes_session_id");