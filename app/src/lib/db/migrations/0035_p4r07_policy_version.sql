--> P4-R07 AC-02 -- a policy row must carry the version it was written under.
-->
--> `content_mode_policies` shipped with P2-R05 (migration 0017) and holds the
--> per-mode overrides. It has no version column, so a policy row written under
--> one set of rules is indistinguishable from one written under another, and a
--> decision made in March could be compared against April's bar with nothing
--> reporting the mismatch.
-->
--> This is the discipline P2-R03 already applies to scoring:
--> `content_opportunity_scores.scoring_config_version` travels WITH the number.
--> A version held only in application code answers "what are the rules now",
--> never "what were the rules when this row was written".
-->
--> NOT NULL with a default, because a row with no version is exactly the
--> ambiguity the column exists to remove. Existing rows -- there are none in
--> production today -- take the P2-R05 baseline, which is the version they were
--> in fact written under.

ALTER TABLE "content_mode_policies"
  ADD COLUMN IF NOT EXISTS "policy_version" text NOT NULL DEFAULT 'v0-2026-08-20';

--> AC-02 again, from the other side: a version that could be blank is not a
--> version. The DEFAULT stops an INSERT omitting it; this stops an UPDATE
--> emptying it.
DO $$ BEGIN
  ALTER TABLE "content_mode_policies"
    ADD CONSTRAINT "content_mode_policies_version_not_blank"
    CHECK (length(btrim("policy_version")) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
