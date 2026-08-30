--> P4-R09 AC-05 -- the outbound alert ledger.
-->
--> The owner must be TOLD when a publish reaches FAILED_REQUIRES_ATTENTION.
--> Telegram is owned by Hermes, which polls its bots; the Ops Hub holds no bot
--> token and sends nothing itself. So the Ops Hub QUEUES an alert and a Hermes
--> cron job collects it and delivers it through the assistant's existing
--> Telegram sender.
-->
--> ## This is a delivery ledger, NOT a second Source of Truth
-->
--> The business fact -- that a publish failed and why -- lives in the publish
--> state and in `audit_events`, and it stays there. This table records only
--> whether that fact has been carried to the owner over Telegram yet. Deleting
--> every row here would lose no business information; it would only make the
--> owner receive some alerts twice.
-->
--> ## `profile` is how the right assistant answers
-->
--> Hermes runs one gateway per profile and one bot per gateway. An alert about
--> affiliate work must reach the AFF assistant, not the YouTube one, or the
--> owner is answered by the wrong bot about work it knows nothing of.

CREATE TABLE IF NOT EXISTS "owner_outbound_alerts" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  --> Which assistant carries it. Hermes' own profile slugs, not ours.
  "profile"       text NOT NULL,

  --> What it is about. Free-form because P4-R09 is the first producer and
  --> others will follow; the pair is indexed rather than constrained.
  "entity_type"   text NOT NULL,
  "entity_id"     text NOT NULL,

  --> The message, already composed by buildOwnerAlert. Stored rather than
  --> rebuilt at delivery time so what the owner receives is what was decided
  --> when the failure happened, not what the code would say today.
  "body"          text NOT NULL,

  "created_at"    timestamptz NOT NULL DEFAULT now(),

  --> NULL = still waiting. Set when a collector has taken it.
  "dispatched_at" timestamptz,
  --> Which collector took it. A bare timestamp cannot answer "who has it".
  "dispatched_by" text,

  CONSTRAINT "owner_outbound_alerts_profile_known"
    CHECK (profile IN ('aff','yt')),

  --> A body nobody can act on is not an alert. P4-R09's buildOwnerAlert always
  --> names the article, the revision, the state and the reason, so anything
  --> this short did not come from it.
  CONSTRAINT "owner_outbound_alerts_body_substantive"
    CHECK (length(btrim(body)) >= 40),

  --> Dispatch is a pair: a timestamp with no collector, or a collector with no
  --> timestamp, is a row that answers half the question.
  CONSTRAINT "owner_outbound_alerts_dispatch_paired"
    CHECK ((dispatched_at IS NULL) = (dispatched_by IS NULL))
);

--> The collector's query: oldest undelivered first, per profile.
CREATE INDEX IF NOT EXISTS "owner_outbound_alerts_pending_idx"
  ON "owner_outbound_alerts" ("profile","created_at")
  WHERE dispatched_at IS NULL;

--> One alert per failure, not one per retry of the collector.
--> A publish that fails once must not queue an alert every time something
--> re-reads its state.
CREATE UNIQUE INDEX IF NOT EXISTS "owner_outbound_alerts_dedup_idx"
  ON "owner_outbound_alerts" ("entity_type","entity_id","body");
