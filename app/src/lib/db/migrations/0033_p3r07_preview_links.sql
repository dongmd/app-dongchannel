--> P3-R07 — the preview link, as a record that can be taken back.
-->
--> Owner decision Q32, Option A. A preview link is a CAPABILITY, not an
--> identity: it opens one revision of one article, for a short while, and can be
--> revoked.
-->
--> ## Why a row at all, when the token is signed
-->
--> A signed token alone cannot be revoked -- that is the whole difference
--> between a capability and a bearer credential. AC-05 requires revocation
--> before expiry, individually AND in bulk for an article, so there has to be
--> something to revoke.
-->
--> The row is not the authority: the signature is checked FIRST, before this
--> table is consulted at all, so an unsigned guess cannot be used to probe which
--> ids exist.

CREATE TABLE IF NOT EXISTS "article_preview_links" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  --> AC-02. One article, one revision. The token signs these too, and the
  --> verifier compares both -- so neither the row nor the token can be moved
  --> without the other noticing.
  "article_id"   text NOT NULL,
  "revision_id"  text NOT NULL,

  --> AC-10/AC-11. The hash of exactly what the link will show. A material edit
  --> changes this and the preview refuses, which is what stops an approval
  --> being taken against content nobody saw.
  "content_hash" text NOT NULL,

  --> AC-13. Which key signed it. Rotation then invalidates outstanding links
  --> as a stated consequence rather than as a mystery: a link whose key is gone
  --> refuses distinctly from one whose signature is wrong.
  "key_version"  text NOT NULL,

  "issued_to"    bigint,
  "issued_at"    timestamptz NOT NULL DEFAULT now(),
  "expires_at"   timestamptz NOT NULL,
  "revoked_at"   timestamptz,

  --> AC-03. A link that has already expired when issued is not a short-lived
  --> capability, it is a mistake.
  CONSTRAINT "preview_link_expiry_after_issue"
    CHECK ("expires_at" > "issued_at"),

  --> AC-03. The stated maximum, enforced by the database rather than only by
  --> the caller that happens to be writing today. One hour.
  CONSTRAINT "preview_link_ttl_capped"
    CHECK ("expires_at" <= "issued_at" + interval '1 hour'),

  --> A revocation cannot predate the issue it revokes.
  CONSTRAINT "preview_link_revocation_after_issue"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "issued_at"),

  --> AC-01/AC-11. A 64-character hex hash, or nothing. A truncated or
  --> differently-encoded hash compared against a full one would silently never
  --> match, and every preview would refuse for a reason nobody could see.
  CONSTRAINT "preview_link_hash_shape"
    CHECK ("content_hash" ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint

--> AC-05. Bulk revocation for an article is one statement against this index.
CREATE INDEX IF NOT EXISTS "preview_links_article_idx"
  ON "article_preview_links" ("article_id");--> statement-breakpoint

--> The verifier looks a link up by its exact scope, after checking the
--> signature. Unique so two rows cannot describe the same capability, which
--> would make revoking one of them look like revoking the capability.
CREATE UNIQUE INDEX IF NOT EXISTS "preview_links_scope_uq"
  ON "article_preview_links" ("article_id", "revision_id", "content_hash", "expires_at");--> statement-breakpoint

--> AC-02/AC-05 — the scope is immutable and revocation is final.
-->
--> Everything the token signs is fixed at issue. If any of it could be edited
--> afterwards, the signature would still verify while the capability quietly
--> pointed somewhere else -- the row would have been moved out from under a
--> token that still looked valid.
-->
--> Revocation is one-way for the same reason a withdrawal is in P3-R04:
--> un-revoking would turn a decision to take something back into a decision to
--> hand it over again, with nobody pressing anything.
CREATE OR REPLACE FUNCTION dc_preview_link_scope_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.article_id   IS DISTINCT FROM OLD.article_id
  OR NEW.revision_id  IS DISTINCT FROM OLD.revision_id
  OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
  OR NEW.key_version  IS DISTINCT FROM OLD.key_version
  OR NEW.expires_at   IS DISTINCT FROM OLD.expires_at
  OR NEW.issued_at    IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION
      'a preview link''s scope is immutable (P3-R07 AC-02)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION
      'a revoked preview link cannot be un-revoked (P3-R07 AC-05)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_preview_link_immutable" ON "article_preview_links";--> statement-breakpoint
CREATE TRIGGER "dc_preview_link_immutable"
  BEFORE UPDATE ON "article_preview_links"
  FOR EACH ROW EXECUTE FUNCTION dc_preview_link_scope_is_immutable();--> statement-breakpoint

--> AC-06/AC-07 — a preview grants a read and nothing else, at the data layer.
-->
--> A preview link must never become a route to approval. The two-step gate
--> already requires a confirmed pending action, and this makes the narrower
--> statement: nothing in the preview path can create one. Expressed as a
--> transaction-scoped flag, matching P3-R04/R05/R02, so a future call site that
--> renders a preview inside a wider transaction cannot quietly gain the ability.
CREATE OR REPLACE FUNCTION dc_preview_grants_read_only()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('dc.in_preview_render', true) = 'on' THEN
    RAISE EXCEPTION
      'a preview render may not write %  (P3-R07 AC-06). A preview authorises one read.', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_preview_no_approval" ON "article_approvals";--> statement-breakpoint
CREATE TRIGGER "dc_preview_no_approval"
  BEFORE INSERT ON "article_approvals"
  FOR EACH ROW EXECUTE FUNCTION dc_preview_grants_read_only();--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_preview_no_intent" ON "article_publish_intents";--> statement-breakpoint
CREATE TRIGGER "dc_preview_no_intent"
  BEFORE INSERT ON "article_publish_intents"
  FOR EACH ROW EXECUTE FUNCTION dc_preview_grants_read_only();--> statement-breakpoint

DROP TRIGGER IF EXISTS "dc_preview_no_pending" ON "telegram_pending_actions";--> statement-breakpoint
CREATE TRIGGER "dc_preview_no_pending"
  BEFORE INSERT ON "telegram_pending_actions"
  FOR EACH ROW EXECUTE FUNCTION dc_preview_grants_read_only();
