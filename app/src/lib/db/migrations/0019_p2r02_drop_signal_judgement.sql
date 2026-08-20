ALTER TABLE "opportunity_signals" DROP CONSTRAINT "opportunity_signals_score_range";--> statement-breakpoint
ALTER TABLE "opportunity_routes" DROP CONSTRAINT "opportunity_routes_opportunity_id_opportunity_signals_id_fk";
--> statement-breakpoint
DROP INDEX "opportunity_routes_opportunity_route_uq";--> statement-breakpoint
ALTER TABLE "opportunity_routes" DROP COLUMN "opportunity_id";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "overall_score";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "scoring_version";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "score_breakdown";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "last_researched_at";--> statement-breakpoint
ALTER TABLE "public"."opportunity_signals" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."signal_status";--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('NEW', 'ROUTED', 'DUPLICATE', 'DISCARDED');--> statement-breakpoint
ALTER TABLE "public"."opportunity_signals" ALTER COLUMN "status" SET DATA TYPE "public"."signal_status" USING "status"::"public"."signal_status";