--> P3-R05 AC-03 — the durable publish intent, and the lock that goes with it.
-->
--> ## What the canonical documents actually say
-->
--> AC-08, in the same requirement: "Enqueuing a publish is not publishing. P3
--> STOPS AT THE QUEUE; the P4 publisher enforces the three gates independently
--> and does not trust P3's word." TDD-P3-R04/R05 is headed "consent is scoped,
--> and P3 STOPS AT ENQUEUE".
-->
--> Both place the enqueue INSIDE P3 and the consumption in P4. So AC-03 asks for
--> a durable publish INTENT, not publish execution -- and the dependency runs
--> P4 -> P3, which is the right direction: the consumer depends on the
--> producer's artefact, not the other way round.
-->
--> P4-R08 and P4-R09 are title-only stubs with no acceptance criteria, so P4 has
--> claimed nothing about this table. Nothing here pre-empts it: the publisher
--> re-checks all three gates and treats this row as INPUT, never as authority.
-->
--> ## Why a new table rather than an existing one
-->
--> Neither existing candidate is a queue for articles. `wordpress_sync_jobs`
--> carries PRODUCTS (P1-R05). `wordpress_article_sync` is the overwrite guard's
--> baseline and conflict state -- it answers "did WordPress diverge", not "what
--> should be published next". Reusing either would give one table two meanings.
-->
--> ## What "lock the revision" means here
-->
--> The phrase appears nowhere in the canonical documents except AC-03 itself and
--> the TDD line restating it, so its content has to come from the surrounding
--> model. Articles live in WordPress; this database cannot prevent an edit
--> there. What it CAN do -- and what makes "lock" a step distinct from "create
--> the approval" -- is guarantee that while a publish is pending for an article,
--> no OTHER revision of that article can be queued behind it.
-->
--> That is the partial unique index below. Without it, "lock" would name nothing
--> the approval does not already do, since P3-R04's own index permits two live
--> approvals for two different revisions of one article.
-->
--> Recorded as a DERIVED reading, not asserted as the only one.

CREATE TYPE "publish_intent_state" AS ENUM ('OPEN', 'CONSUMED', 'CANCELLED');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "article_publish_intents" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  --> The approval this intent was created from. NOT NULL and referenced: an
  --> intent with no consent behind it is the thing the whole two-step gate
  --> exists to prevent, and a nullable column would make it representable.
  "approval_id"  uuid NOT NULL REFERENCES "article_approvals"("id") ON DELETE RESTRICT,

  --> Denormalised from the approval on purpose. The publisher must be able to
  --> answer "which revision, which bytes" without trusting a join to still say
  --> the same thing later, and the trigger below proves they match at insert.
  "article_id"   text NOT NULL,
  "revision_id"  text NOT NULL,
  "payload_hash" text NOT NULL,
  "destination"  text NOT NULL,

  "state"        publish_intent_state NOT NULL DEFAULT 'OPEN',
  "enqueued_at"  timestamptz NOT NULL DEFAULT now(),
  "resolved_at"  timestamptz,

  --> A resolved intent has a time; an open one does not. Both directions, so
  --> neither half can drift from the other.
  CONSTRAINT "publish_intent_resolution_consistent"
    CHECK (("state" = 'OPEN' AND "resolved_at" IS NULL)
        OR ("state" <> 'OPEN' AND "resolved_at" IS NOT NULL))
);--> statement-breakpoint

--> Idempotent enqueue. One approval yields at most one intent, so a replayed
--> confirm -- which P3-R03 already answers from its stored result -- cannot
--> produce a second queue entry even if it reached this far.
CREATE UNIQUE INDEX IF NOT EXISTS "publish_intents_approval_uq"
  ON "article_publish_intents" ("approval_id");--> statement-breakpoint

--> THE LOCK. At most one OPEN intent per article.
-->
--> Partial, so a consumed or cancelled intent does not block the next publish:
--> the lock is held for the duration of the pending publish and released by its
--> resolution, which is what a lock is.
CREATE UNIQUE INDEX IF NOT EXISTS "publish_intents_one_open_per_article"
  ON "article_publish_intents" ("article_id")
  WHERE "state" = 'OPEN';--> statement-breakpoint

--> AC-03 — an intent must match the approval it names.
-->
--> Denormalised columns that disagree with their source are worse than no
--> columns: the publisher would read a revision the owner never consented to
--> while an approval sat next to it saying otherwise. Checked at insert rather
--> than trusted, because the two are written by the same statement and a typo
--> is enough.
CREATE OR REPLACE FUNCTION dc_publish_intent_matches_approval()
RETURNS TRIGGER AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT article_id, revision_id, payload_hash, withdraws_id
    INTO a FROM article_approvals WHERE id = NEW.approval_id;

  --> A missing approval and a mismatched one are different mistakes and earn
  --> different answers. Without this branch the comparison below raises the
  --> MISMATCH message for a row that has no approval at all -- every column
  --> differs from NULL -- which is true but tells the reader the wrong thing.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'a publish intent needs an existing approval (P3-R05 AC-03)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF a.withdraws_id IS NOT NULL THEN
    RAISE EXCEPTION
      'a withdrawal cannot authorise a publish intent (P3-R05 AC-03)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.article_id   IS DISTINCT FROM a.article_id
  OR NEW.revision_id  IS DISTINCT FROM a.revision_id
  OR NEW.payload_hash IS DISTINCT FROM a.payload_hash THEN
    RAISE EXCEPTION
      'a publish intent must name the same article, revision and hash as its approval (P3-R05 AC-03)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_publish_intent_matches_approval" ON "article_publish_intents";--> statement-breakpoint
CREATE TRIGGER "dc_publish_intent_matches_approval"
  BEFORE INSERT ON "article_publish_intents"
  FOR EACH ROW EXECUTE FUNCTION dc_publish_intent_matches_approval();--> statement-breakpoint

--> AC-08 — enqueuing is not publishing, as an invariant rather than a sentence.
-->
--> A Telegram action may CREATE an intent and may CANCEL one it created. It may
--> not mark one CONSUMED: consumption is the publisher's act, and P4 re-checks
--> every gate before performing it. Without this, "P3 stops at the queue" would
--> be a convention that the next Telegram code path has no way of knowing about.
CREATE OR REPLACE FUNCTION dc_publish_intent_not_consumed_by_telegram()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('dc.in_telegram_action', true) = 'on'
     AND NEW.state = 'CONSUMED' THEN
    RAISE EXCEPTION
      'a Telegram action may not consume a publish intent (P3-R05 AC-08). Enqueuing is not publishing.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_publish_intent_no_telegram_consume_ins" ON "article_publish_intents";--> statement-breakpoint
CREATE TRIGGER "dc_publish_intent_no_telegram_consume_ins"
  BEFORE INSERT ON "article_publish_intents"
  FOR EACH ROW EXECUTE FUNCTION dc_publish_intent_not_consumed_by_telegram();--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_publish_intent_no_telegram_consume_upd" ON "article_publish_intents";--> statement-breakpoint
CREATE TRIGGER "dc_publish_intent_no_telegram_consume_upd"
  BEFORE UPDATE ON "article_publish_intents"
  FOR EACH ROW EXECUTE FUNCTION dc_publish_intent_not_consumed_by_telegram();
