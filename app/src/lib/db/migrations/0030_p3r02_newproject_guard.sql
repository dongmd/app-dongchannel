--> P3-R02 AC-04b — creation is not authorisation, enforced by the database.
-->
--> Owner decision Q33 allows `/newproject` to create a real `AffiliateProject`,
--> and forbids it from moving that project into an execution state. The command
--> module already refuses to; this makes the refusal a property of the data
--> rather than of one call site.
-->
--> ── Why a trigger rather than a check in the handler ──────────────
-->
--> A handler guard binds the handler. The next Telegram code path — a callback,
--> a retry, a bulk action, a helper somebody adds in six months — starts with no
--> such guard and no reason to suspect it needed one. The prohibition belongs to
--> the ACTION, not to the function that happens to perform it today.
-->
--> Keyed on `dc.in_telegram_action`, the same transaction-scoped flag P3-R04
--> uses for `article_verification`. One mechanism, one thing to understand, and
--> a future call site that forgets to set the flag cannot accidentally gain
--> permission — because the flag is set by the module the Telegram path must go
--> through, and a path that skips it is not a Telegram action.
-->
--> ── Why UPDATE is guarded too, and not only INSERT ────────────────
-->
--> Q33's prohibition is on `/newproject` *reaching* an execution state, not on
--> the single statement that creates the row. INSERT-only enforcement would be
--> satisfied by inserting `CANDIDATE` and updating to `APPROVED_FOR_TEST` in the
--> same transaction — two legal statements composing into the exact outcome the
--> decision forbids.
-->
--> ── What this deliberately does NOT do ────────────────────────────
-->
--> It does not stop the OPS HUB or a human from approving a project. Approval is
--> a legitimate act by an authorised actor through a path that carries an
--> approval record. The flag is set only inside a Telegram action, so this
--> constrains that one actor, which is what Q33 is about.

CREATE OR REPLACE FUNCTION dc_project_not_execution_from_telegram()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('dc.in_telegram_action', true) = 'on'
     AND NEW.status IN ('READY_FOR_APPROVAL', 'APPROVED_FOR_TEST',
                        'CAMPAIGN_DRAFTED', 'TESTING', 'SCALE') THEN
    RAISE EXCEPTION
      'a Telegram action may not put an affiliate project into %  (P3-R02 AC-04b). Creation is not authorisation.', NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_project_guard_insert" ON "affiliate_projects";--> statement-breakpoint
CREATE TRIGGER "dc_project_guard_insert"
  BEFORE INSERT ON "affiliate_projects"
  FOR EACH ROW EXECUTE FUNCTION dc_project_not_execution_from_telegram();--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_project_guard_update" ON "affiliate_projects";--> statement-breakpoint
CREATE TRIGGER "dc_project_guard_update"
  BEFORE UPDATE ON "affiliate_projects"
  FOR EACH ROW EXECUTE FUNCTION dc_project_not_execution_from_telegram();--> statement-breakpoint

--> AC-05 — an owner idea uses the EXISTING P2 vocabulary.
-->
--> `OWNER_SEED` and `OWNER_TELEGRAM` are already values of
--> `opportunity_origin_type` and `signal_origin_mode`. Nothing is added here;
--> this comment records that the requirement was met by using what P2 defined,
--> and the test asserts against the enums themselves rather than against string
--> literals that merely look the same.
