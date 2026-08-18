ALTER TABLE "affiliate_results" DROP CONSTRAINT "affiliate_results_offer_id_offers_id_fk";
--> statement-breakpoint
ALTER TABLE "angles" DROP CONSTRAINT "angles_offer_id_offers_id_fk";
--> statement-breakpoint
ALTER TABLE "videos" DROP CONSTRAINT "videos_offer_id_offers_id_fk";
--> statement-breakpoint
ALTER TABLE "affiliate_results" ADD CONSTRAINT "affiliate_results_offer_id_affiliate_programs_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "angles" ADD CONSTRAINT "angles_offer_id_affiliate_programs_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_offer_id_affiliate_programs_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE set null ON UPDATE no action;