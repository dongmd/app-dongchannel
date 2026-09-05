--> P4-R08 AC-10 / P4-R09 AC-01 — the two things the publish path had no home for.
-->
--> ## Why this migration exists at all
-->
--> `publish-executor.ts` shipped able to publish and with nothing calling it:
--> no worker consumed `article_publish_intents`, and the WordPress post id a
--> publish produced had nowhere to be written. `P4-R09 AC-01` says in terms
--> that "the resulting WordPress post id is stored", and
--> `idempotency-policy.ts` already declares the exact record shape
--> (`PublishRecord`: idempotency key, wp post id, attempts, state) and the
--> state vocabulary (`PUBLISH_STATES`). Both existed as TYPES with no table
--> behind them. This is that table -- the shape is not invented here, it is
--> lifted from the module that already specified it.
-->
--> Additive only, per the V1 rule: one new column and one new table. Nothing
--> is dropped or renamed.

--> ─── 1. The atomic claim ────────────────────────────────────────
-->
--> A code review of the executor found this hole: `decidePublish` reads
--> `intent.state` from the SNAPSHOT its caller passed in, not under a lock. Two
--> workers that both read the same OPEN intent before either resolved it would
--> both pass gate 1, both sign, and both call WordPress. The route itself is
--> safe (`post_status` has one 'publish' value and creates nothing, D-03), but
--> the audit trail and the failure path would both be wrong.
-->
--> `claimed_at` makes claiming a COMPARE-AND-SWAP instead of a read:
-->
-->   UPDATE article_publish_intents SET claimed_at = now()
-->    WHERE id = $1 AND state = 'OPEN'
-->      AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')
-->
--> One row affected means this worker owns it; zero means somebody else does.
-->
--> The interval is a RECLAIM window, not a timeout: a worker that crashes
--> mid-publish would otherwise hold the intent -- and with it the per-article
--> lock -- forever. Ten minutes is comfortably longer than MAX_ATTEMPTS (6)
--> times the bounded backoff, so a live worker is never robbed of its own
--> intent by the reclaim.
ALTER TABLE "article_publish_intents"
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz;--> statement-breakpoint

--> Only OPEN intents are ever claimed, so the index is partial for the same
--> reason `publish_intents_one_open_per_article` is.
CREATE INDEX IF NOT EXISTS "publish_intents_claimable_idx"
  ON "article_publish_intents" ("claimed_at")
  WHERE "state" = 'OPEN';--> statement-breakpoint

--> ─── 2. The publish record ──────────────────────────────────────
-->
--> States are `idempotency-policy.ts`'s `PUBLISH_STATES`, verbatim. A CHECK
--> rather than an ENUM: `resolveFailure()` in that module is the authority on
--> which state a failure produces, and a database enum that drifted from it
--> would be a second vocabulary for one fact.
CREATE TABLE IF NOT EXISTS "article_publish_records" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  --> `publishIdempotencyKey(articleId, revisionId, destination)` -- built by
  --> that ONE function, never concatenated at a call site. UNIQUE is the whole
  --> point: it is what makes a replayed publish an UPDATE of this row rather
  --> than a second publish. G-51, in one constraint.
  "idempotency_key"  text NOT NULL,

  --> Denormalised from the key so the row is readable without parsing it, and
  --> so a human debugging a duplicate can see the three components that were
  --> supposed to make it unique.
  "article_id"       text NOT NULL,
  "revision_id"      text NOT NULL,
  "destination"      text NOT NULL,

  --> AC-01, the criterion this table exists for. NULL until a publish has
  --> actually succeeded -- never 0, which would read as a real post id.
  "wp_post_id"       integer,

  --> What WordPress reported after the write. Stored so `P4-R08 AC-08`'s
  --> human-edit comparison has a baseline that came from the publish itself.
  "wp_modified_gmt"  text,

  --> The content hash this record last PUBLISHED. `decideReplay()` compares
  --> the incoming hash against it to tell ALREADY_DONE from UPDATE -- a no-op
  --> "update" would bump post_modified and make the publisher look like a
  --> human editor on the next run.
  "published_hash"   text,

  "state"            text NOT NULL DEFAULT 'PENDING',
  "attempts"         integer NOT NULL DEFAULT 0,

  --> The error KIND and CODE only, never WordPress's message: a message can
  --> quote the request, and the request carries the integration credential.
  "last_error_kind"  text,
  "last_error_code"  text,

  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "publish_record_state_valid" CHECK (
    "state" IN ('PENDING','IN_FLIGHT','SUCCEEDED','FAILED_RETRYING','FAILED_REQUIRES_ATTENTION')
  ),

  CONSTRAINT "publish_record_attempts_nonneg" CHECK ("attempts" >= 0),

  --> A SUCCEEDED publish must name the post it produced. Without this, "it
  --> published" and "we know what it published" could disagree, and AC-01
  --> would be satisfiable by a row that stored nothing.
  CONSTRAINT "publish_record_success_has_post" CHECK (
    "state" <> 'SUCCEEDED' OR ("wp_post_id" IS NOT NULL AND "published_hash" IS NOT NULL)
  )
);--> statement-breakpoint

--> THE idempotency guarantee. One key, one row, forever.
CREATE UNIQUE INDEX IF NOT EXISTS "publish_records_key_uq"
  ON "article_publish_records" ("idempotency_key");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "publish_records_article_idx"
  ON "article_publish_records" ("article_id", "created_at");--> statement-breakpoint

--> One WordPress post is published by at most one record.
-->
--> Partial, because NULL means "no publish has succeeded yet" and several
--> records may legitimately sit in that state. Two SUCCEEDED records naming
--> one post would mean the same post was published under two different
--> idempotency keys -- which is the duplicate `P4-R09 AC-02` targets, in the
--> only place this database can actually see it.
CREATE UNIQUE INDEX IF NOT EXISTS "publish_records_wp_post_uq"
  ON "article_publish_records" ("wp_post_id")
  WHERE "wp_post_id" IS NOT NULL;
