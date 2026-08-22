--> P3-R04 — approval records, and the verification state they must never touch.
-->
--> This is the project's central non-negotiable expressed as schema:
--> OWNER APPROVAL is a record of CONSENT; FACT VERIFICATION is a DERIVED state
--> describing what is known about the claims. P0-R01 is the record of what
--> happens when the two blur.

--> ── AC-11: two TABLES, not two column groups ──────────────────────
-->
--> A shared row is one UPDATE away from being written together. Separate tables
--> make "approving also marked it verified" a statement somebody has to write
--> deliberately, in a second query, against a table the approval path has no
--> business touching.

CREATE TABLE IF NOT EXISTS "article_approvals" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  --> AC-01: exactly the PROPOSED 7.1 fields. AC-07: ONE article and ONE
  --> revision -- there is no "latest" here to resolve at publish time.
  "article_id"      text NOT NULL,
  "revision_id"     text NOT NULL,

  --> AC-10: the Telegram numeric id that passed P3-R01, taken from the verified
  --> update. Never from the callback payload, which is attacker-controlled.
  "approved_by"     bigint NOT NULL,
  "approved_at"     timestamptz NOT NULL DEFAULT now(),

  --> AC-05/AC-06: computed over the approved revision's content, covering
  --> everything the owner was shown -- including what the P3-R07 preview
  --> rendered. Editing after approval changes the hash and invalidates it.
  "payload_hash"    text NOT NULL,

  --> P3-R03's opaque action id. Stored to key idempotency, never rendered.
  "callback_nonce"  text NOT NULL,
  "expires_at"      timestamptz NOT NULL,

  --> AC-08: a WITHDRAWAL is a new row, not an edit. This points at the approval
  --> being withdrawn; the original stays exactly as written.
  "withdraws_id"    uuid REFERENCES "article_approvals"("id"),

  CONSTRAINT "article_approvals_expiry_after_approval"
    CHECK ("expires_at" > "approved_at"),
  CONSTRAINT "article_approvals_hash_shape"
    CHECK (char_length("payload_hash") = 64 AND "payload_hash" ~ '^[0-9a-f]{64}$'),
  --> A withdrawal must not withdraw itself.
  CONSTRAINT "article_approvals_no_self_withdraw"
    CHECK ("withdraws_id" IS NULL OR "withdraws_id" <> "id")
);--> statement-breakpoint

--> AC-07: one live approval per (article, revision). A second one would make
--> "which consent authorised this publish" ambiguous, and ambiguity at the
--> approval boundary is the whole problem.
CREATE UNIQUE INDEX IF NOT EXISTS "article_approvals_article_revision_uq"
  ON "article_approvals" ("article_id", "revision_id")
  WHERE "withdraws_id" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "article_approvals_article_idx"
  ON "article_approvals" ("article_id", "approved_at" DESC);--> statement-breakpoint

--> ── AC-08: immutable once written ─────────────────────────────────
-->
--> Same mechanism as 0028 and for the same reason: a comment claiming
--> immutability that nothing enforces is worse than no claim. UPDATE is refused
--> outright. DELETE is refused too -- withdrawing consent is a new record, and
--> erasing the original would erase the evidence that consent was ever given.
CREATE OR REPLACE FUNCTION dc_article_approvals_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'article_approvals is immutable: % is refused. Withdraw with a new row (P3-R04 AC-08)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_article_approvals_no_update" ON "article_approvals";--> statement-breakpoint
CREATE TRIGGER "dc_article_approvals_no_update"
  BEFORE UPDATE ON "article_approvals"
  FOR EACH ROW EXECUTE FUNCTION dc_article_approvals_immutable();--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_article_approvals_no_delete" ON "article_approvals";--> statement-breakpoint
CREATE TRIGGER "dc_article_approvals_no_delete"
  BEFORE DELETE ON "article_approvals"
  FOR EACH ROW EXECUTE FUNCTION dc_article_approvals_immutable();--> statement-breakpoint

--> TRUNCATE bypasses FOR EACH ROW entirely, as 0028 had to learn.
DROP TRIGGER IF EXISTS "dc_article_approvals_no_truncate" ON "article_approvals";--> statement-breakpoint
CREATE TRIGGER "dc_article_approvals_no_truncate"
  BEFORE TRUNCATE ON "article_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION dc_article_approvals_immutable();--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE ON "article_approvals" FROM PUBLIC;--> statement-breakpoint

--> ── AC-02: the verification state, a SEPARATE table ───────────────
-->
--> Derived from evidence and QA. No human button sets it, and the owner's
--> approval does not imply it (PROPOSED 7.1).
-->
--> This table IS mutable: verification is a derived state that legitimately
--> changes as evidence arrives. That difference from article_approvals is the
--> point -- consent is a historical fact, knowledge is not.

CREATE TABLE IF NOT EXISTS "article_verification" (
  "article_id"          text PRIMARY KEY,
  "evidence_level"      text NOT NULL DEFAULT 'E0',
  "qa_result"           text,
  "claims_checked"      integer NOT NULL DEFAULT 0,
  "unsupported_claims"  integer NOT NULL DEFAULT 0,
  "conflicting_claims"  integer NOT NULL DEFAULT 0,
  "last_verified_at"    timestamptz,
  "updated_at"          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "article_verification_evidence_level"
    CHECK ("evidence_level" IN ('E0','E1','E2','E3','E4')),
  CONSTRAINT "article_verification_counts_nonneg"
    CHECK ("claims_checked" >= 0 AND "unsupported_claims" >= 0 AND "conflicting_claims" >= 0)
);--> statement-breakpoint

--> ── AC-03: the choke point ────────────────────────────────────────
-->
--> "No Telegram action may write the verification state", enforced by a guard
--> every write passes through rather than by reviewing call sites -- the manner
--> of dc_core_guard_affiliate_meta_write.
-->
--> The mechanism is a session flag. The approval path sets
--> dc.in_telegram_action = 'on' for its transaction; this trigger refuses any
--> write to article_verification while that flag is set. A future call site
--> that forgets to route through the approval module cannot accidentally gain
--> permission, because the flag is set by the module the Telegram path must use.
CREATE OR REPLACE FUNCTION dc_verification_not_from_telegram()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('dc.in_telegram_action', true) = 'on' THEN
    RAISE EXCEPTION
      'a Telegram action may not write article_verification (P3-R04 AC-03). Owner approval is not fact verification.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_verification_guard_insert" ON "article_verification";--> statement-breakpoint
CREATE TRIGGER "dc_verification_guard_insert"
  BEFORE INSERT ON "article_verification"
  FOR EACH ROW EXECUTE FUNCTION dc_verification_not_from_telegram();--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_verification_guard_update" ON "article_verification";--> statement-breakpoint
CREATE TRIGGER "dc_verification_guard_update"
  BEFORE UPDATE ON "article_verification"
  FOR EACH ROW EXECUTE FUNCTION dc_verification_not_from_telegram();
