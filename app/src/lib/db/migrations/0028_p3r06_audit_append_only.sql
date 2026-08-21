--> P3-R06 — audit_events becomes canonically append-only, and gains the two
--> fields the owner's spec §10 asks for.
-->
--> The table already existed, from the superseded V1 design, describing itself
--> in a code comment as an "Immutable event log". Nothing enforced that:
--> migrations 0000..0027 contain zero CREATE TRIGGER, CREATE RULE and REVOKE
--> statements. It was an ordinary table the code was trusted not to update.

--> ── AC-04: the two spec §10 fields that were missing ──────────────
-->
--> `result` — the outcome of the action, not merely that it was attempted. An
--> audit line saying "publish requested" without saying what happened cannot
--> answer the question it exists for.
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "result" text;--> statement-breakpoint

--> `telegram_ref` — spec §10's "Telegram message/callback reference where
--> safe". AC-05 makes "where safe" mechanical: IDS ONLY. The CHECK below is
--> what enforces it, because a convention in a comment is exactly what this
--> migration exists to stop trusting.
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "telegram_ref" text;--> statement-breakpoint

--> Digits, and optionally a colon-separated pair (chat:message). Anything else
--> -- message text, a token, an @handle, an email -- is refused by the database.
--> A bot token is `<digits>:<35+ chars>`, so the length bound refuses that too.
ALTER TABLE "audit_events" DROP CONSTRAINT IF EXISTS "audit_events_telegram_ref_ids_only";--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_telegram_ref_ids_only"
  CHECK ("telegram_ref" IS NULL OR "telegram_ref" ~ '^[0-9]{1,20}(:[0-9]{1,20})?$');--> statement-breakpoint

--> ── AC-02 / AC-03: append-only, enforced by the database ──────────
-->
--> A TRIGGER rather than REVOKE, deliberately.
-->
--> REVOKE UPDATE, DELETE binds the roles it names. It does not bind the table
--> OWNER, and it does not bind a superuser -- and on this deployment the
--> application connects as the database owner. A privilege grant that the one
--> account actually used can ignore is a rule written down rather than enforced,
--> which is the exact failure this requirement was raised to end.
-->
--> A BEFORE trigger raises for every role including the owner. Removing it
--> requires DROP TRIGGER, which is a visible schema change in a migration
--> rather than a quiet privilege the next deploy might restore.
CREATE OR REPLACE FUNCTION dc_audit_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only: % is refused (P3-R06 AC-02)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_audit_events_no_update" ON "audit_events";--> statement-breakpoint
CREATE TRIGGER "dc_audit_events_no_update"
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION dc_audit_events_append_only();--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_audit_events_no_delete" ON "audit_events";--> statement-breakpoint
CREATE TRIGGER "dc_audit_events_no_delete"
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION dc_audit_events_append_only();--> statement-breakpoint

--> Defence in depth: the grant layer says the same thing, so an account that is
--> NOT the owner is refused before the trigger is even reached.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM PUBLIC;--> statement-breakpoint

--> TRUNCATE bypasses row triggers entirely -- FOR EACH ROW never fires when
--> there are no rows to iterate. Without this it would empty the log while both
--> triggers above sat there looking like protection.
DROP TRIGGER IF EXISTS "dc_audit_events_no_truncate" ON "audit_events";--> statement-breakpoint
CREATE TRIGGER "dc_audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION dc_audit_events_append_only();--> statement-breakpoint

--> ── AC-10: readable, or it is a write-only file ───────────────────
CREATE INDEX IF NOT EXISTS "audit_events_action_created_idx"
  ON "audit_events" ("action", "created_at" DESC);
