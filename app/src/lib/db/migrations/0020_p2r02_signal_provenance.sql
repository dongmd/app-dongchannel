ALTER TABLE "opportunity_signals" ALTER COLUMN "canonical_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_routes" ADD COLUMN "signal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_routes" ADD COLUMN "content_opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD COLUMN "captured_by" text;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD COLUMN "duplicate_of_signal_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunity_routes" ADD CONSTRAINT "opportunity_routes_signal_id_opportunity_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."opportunity_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_duplicate_of_signal_id_opportunity_signals_id_fk" FOREIGN KEY ("duplicate_of_signal_id") REFERENCES "public"."opportunity_signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_routes_signal_route_uq" ON "opportunity_routes" USING btree ("signal_id","route_type");--> statement-breakpoint
CREATE INDEX "opportunity_routes_content_opportunity_idx" ON "opportunity_routes" USING btree ("content_opportunity_id");--> statement-breakpoint
CREATE INDEX "opportunity_signals_duplicate_of_idx" ON "opportunity_signals" USING btree ("duplicate_of_signal_id");--> statement-breakpoint
ALTER TABLE "opportunity_routes" ADD CONSTRAINT "opportunity_routes_decline_needs_reason" CHECK (("opportunity_routes"."route_type" <> 'NO_ACTION' AND "opportunity_routes"."status" <> 'REJECTED')
          OR ("opportunity_routes"."reason" IS NOT NULL AND length(btrim("opportunity_routes"."reason")) > 0));--> statement-breakpoint
ALTER TABLE "opportunity_routes" ADD CONSTRAINT "opportunity_routes_content_opportunity_valid" CHECK ("opportunity_routes"."content_opportunity_id" IS NULL
          OR ("opportunity_routes"."route_type" = 'CONTENT_OPPORTUNITY' AND "opportunity_routes"."status" = 'ACCEPTED'));--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_provenance_required" CHECK ("opportunity_signals"."source_id" IS NOT NULL
          OR ("opportunity_signals"."captured_by" IS NOT NULL AND length(btrim("opportunity_signals"."captured_by")) > 0));--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_duplicate_needs_target" CHECK ("opportunity_signals"."status" <> 'DUPLICATE' OR "opportunity_signals"."duplicate_of_signal_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_duplicate_not_self" CHECK ("opportunity_signals"."duplicate_of_signal_id" IS NULL OR "opportunity_signals"."duplicate_of_signal_id" <> "opportunity_signals"."id");