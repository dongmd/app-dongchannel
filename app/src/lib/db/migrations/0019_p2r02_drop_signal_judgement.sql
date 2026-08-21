ALTER TABLE "opportunity_signals" DROP CONSTRAINT "opportunity_signals_score_range";--> statement-breakpoint
ALTER TABLE "opportunity_routes" DROP CONSTRAINT "opportunity_routes_opportunity_id_opportunity_signals_id_fk";
--> statement-breakpoint
DROP INDEX "opportunity_routes_opportunity_route_uq";--> statement-breakpoint
ALTER TABLE "opportunity_routes" DROP COLUMN "opportunity_id";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "overall_score";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "scoring_version";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "score_breakdown";--> statement-breakpoint
ALTER TABLE "opportunity_signals" DROP COLUMN "last_researched_at";--> statement-breakpoint
--> HAND-CORRECTED 2026-08-20. drizzle-kit generated this enum narrowing without
--> dropping the column DEFAULT first, and the migration could not run:
-->
-->   DROP TYPE "public"."signal_status";
-->   ERROR:  cannot drop type signal_status because other objects depend on it
-->   DETAIL: default value for column status of table opportunity_signals
-->           depends on type signal_status
-->
--> Casting the column to text does NOT remove `DEFAULT 'NEW'::signal_status`, so
--> the old type still had a dependent object. Found by the MIGRATION-CHAIN gate
--> on a scratch database; it would have failed on production.
ALTER TABLE "public"."opportunity_signals" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."opportunity_signals" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."signal_status";--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('NEW', 'ROUTED', 'DUPLICATE', 'DISCARDED');--> statement-breakpoint
ALTER TABLE "public"."opportunity_signals" ALTER COLUMN "status" SET DATA TYPE "public"."signal_status" USING "status"::"public"."signal_status";--> statement-breakpoint
--> Restore the default the schema declares. Leaving it off would make `status`
--> silently nullable-by-omission on every insert that does not name it.
ALTER TABLE "public"."opportunity_signals" ALTER COLUMN "status" SET DEFAULT 'NEW';