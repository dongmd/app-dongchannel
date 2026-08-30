--> P4-R12 -- task recovery. Formalizes DC-015.
-->
--> AC-03: a retry is a NEW ATTEMPT, not a rewritten history.
-->
--> The obvious implementation is a `retry_count` column on `tasks`, bumped in
--> place. That loses exactly what a person retrying needs: WHO asked, WHEN,
--> from WHICH failure state, and under which policy version. By the third
--> retry the first two failures are unrecoverable.
-->
--> So each attempt is a row. `tasks.retry_count` is derived from them rather
--> than stored, which also removes the class of bug where a counter and its
--> history disagree.

CREATE TABLE IF NOT EXISTS "task_retry_attempts" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "task_id"        uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,

  --> 1 for the first retry. The ORIGINAL run is not an attempt of this table:
  --> it was not a retry, and numbering it 0 would invite an off-by-one every
  --> time someone compares against the policy bound.
  "attempt"        integer NOT NULL,

  --> Which failure this retry was launched from. A task can fail, be retried,
  --> and fail differently; without this the sequence is unreadable.
  "from_status"    text NOT NULL,

  "requested_by"   text NOT NULL,
  "requested_at"   timestamptz NOT NULL DEFAULT now(),

  --> AC-04. The bound in force when this was allowed, travelling WITH the row
  --> -- the discipline P2-R03 applies to a score and P4-R07 to a policy.
  "policy_version" integer NOT NULL,

  --> Filled when the re-execution finishes. NULL = still running, which is a
  --> real state and not a missing value.
  "outcome"        text,
  "finished_at"    timestamptz,

  CONSTRAINT "task_retry_attempts_attempt_positive" CHECK (attempt >= 1),

  --> A retry launched from a state that is not a failure is not a retry.
  CONSTRAINT "task_retry_attempts_from_failure"
    CHECK (from_status IN ('FAILED','SYNC_DELAYED')),

  --> An outcome with no finish time, or a finish time with no outcome, is a
  --> row that answers half a question.
  CONSTRAINT "task_retry_attempts_outcome_paired"
    CHECK ((outcome IS NULL) = (finished_at IS NULL))
);

--> Two retries numbered the same for one task would make the sequence
--> ambiguous and the budget uncountable. This also makes a concurrent
--> double-submit impossible to commit twice rather than merely unlikely --
--> the second INSERT loses on the index, not on a race the application won.
CREATE UNIQUE INDEX IF NOT EXISTS "task_retry_attempts_task_attempt_uq"
  ON "task_retry_attempts" ("task_id","attempt");

CREATE INDEX IF NOT EXISTS "task_retry_attempts_task_idx"
  ON "task_retry_attempts" ("task_id","requested_at" DESC);
