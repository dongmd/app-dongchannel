--> P3-R05 — the two-step gate, made a property of the data.
-->
--> Owner spec 6: `Approve & Publish` shows a summary, then `Confirm Publish` /
--> `Cancel`. The policy module refuses to act on step 1. This makes the refusal
--> survive a call site that forgets, which is the only kind of call site that
--> matters six months from now.

--> AC-01 — the pending action record.
-->
--> The ONLY thing step 1 writes. It deliberately holds the revision id and the
--> payload hash rather than pointing at "the article": consent given against a
--> moving target is the failure AC-06 exists to catch, and a row that named only
--> the article could not detect it.
CREATE TABLE IF NOT EXISTS "telegram_pending_actions" (
  "id"            text PRIMARY KEY,
  "issued_to"     bigint NOT NULL,
  "article_id"    text NOT NULL,
  "revision_id"   text NOT NULL,
  "destination"   text NOT NULL,
  "payload_hash"  text NOT NULL,
  "issued_at"     timestamptz NOT NULL DEFAULT now(),
  "expires_at"    timestamptz NOT NULL,
  "confirmed_at"  timestamptz,
  "cancelled_at"  timestamptz,

  --> The id is P3-R03's format. One generator, one shape, one place that
  --> decides what an action id looks like -- a second format would be a second
  --> thing to keep in step.
  CONSTRAINT "pending_action_id_shape"
    CHECK ("id" ~ '^act_[0-9a-f]{32}$'),

  --> AC-04/AC-03. Confirmed and cancelled are mutually exclusive outcomes.
  --> Without this, a row could record both and nothing would say which one the
  --> system acted on.
  CONSTRAINT "pending_action_single_outcome"
    CHECK ("confirmed_at" IS NULL OR "cancelled_at" IS NULL),

  --> An outcome cannot predate the offer.
  CONSTRAINT "pending_action_outcome_after_issue"
    CHECK (("confirmed_at" IS NULL OR "confirmed_at" >= "issued_at")
       AND ("cancelled_at" IS NULL OR "cancelled_at" >= "issued_at")),

  --> A confirm window that has already closed is not a window.
  CONSTRAINT "pending_action_expiry_after_issue"
    CHECK ("expires_at" > "issued_at")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pending_actions_article_idx"
  ON "telegram_pending_actions" ("article_id");--> statement-breakpoint

--> AC-03/AC-04 — an outcome is final.
-->
--> Once confirmed or cancelled, a pending action may not change again. The
--> attack this closes is not exotic: re-opening a cancelled action would turn a
--> withdrawal into an approval without anyone pressing anything, and re-opening
--> a confirmed one would let a single consent authorise twice.
CREATE OR REPLACE FUNCTION dc_pending_action_outcome_is_final()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.confirmed_at IS NOT NULL AND
     (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'a confirmed pending action is final (P3-R05 AC-03)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.cancelled_at IS NOT NULL AND
     (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'a cancelled pending action is final (P3-R05 AC-04)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  --> What consent was given TO cannot be edited afterwards. Otherwise the
  --> revision check in AC-06 compares against a value the confirming party
  --> could have moved.
  IF NEW.article_id   IS DISTINCT FROM OLD.article_id
  OR NEW.revision_id  IS DISTINCT FROM OLD.revision_id
  OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
  OR NEW.destination  IS DISTINCT FROM OLD.destination
  OR NEW.issued_to    IS DISTINCT FROM OLD.issued_to
  OR NEW.expires_at   IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION
      'the subject of a pending action is immutable (P3-R05 AC-06)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_pending_action_final" ON "telegram_pending_actions";--> statement-breakpoint
CREATE TRIGGER "dc_pending_action_final"
  BEFORE UPDATE ON "telegram_pending_actions"
  FOR EACH ROW EXECUTE FUNCTION dc_pending_action_outcome_is_final();--> statement-breakpoint

--> AC-01/AC-03/AC-09 — a Telegram approval requires a CONFIRMED pending action.
-->
--> This is the two-step gate itself. Step 1 cannot create an approval because
--> at step 1 no pending action is confirmed yet; only the confirm press makes
--> the insert legal, and only for the exact article and revision the summary
--> named.
-->
--> Scoped to `dc.in_telegram_action`, the same transaction-scoped flag P3-R04
--> and P3-R02 use. The Ops Hub and any other authorised path are untouched:
--> they carry their own authorisation and are not what a two-step Telegram
--> button is protecting against.
-->
--> Matching on article_id AND revision_id is what makes AC-06 structural. An
--> approval for a revision nobody confirmed has no matching row, so an edit
--> between the presses leaves the confirm with nothing to authorise.
CREATE OR REPLACE FUNCTION dc_approval_requires_confirmation()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('dc.in_telegram_action', true) = 'on' THEN
    --> A withdrawal is a retraction, not an authorisation, and needs no
    --> two-step gate: it removes permission rather than granting it.
    IF NEW.withdraws_id IS NOT NULL THEN
      RETURN NEW;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM telegram_pending_actions p
      WHERE p.article_id   = NEW.article_id
        AND p.revision_id  = NEW.revision_id
        AND p.confirmed_at IS NOT NULL
        AND p.cancelled_at IS NULL
    ) THEN
      RAISE EXCEPTION
        'a Telegram approval needs a confirmed two-step action for this article and revision (P3-R05 AC-03). Step 1 does not act.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_approval_needs_confirmation" ON "article_approvals";--> statement-breakpoint
CREATE TRIGGER "dc_approval_needs_confirmation"
  BEFORE INSERT ON "article_approvals"
  FOR EACH ROW EXECUTE FUNCTION dc_approval_requires_confirmation();
