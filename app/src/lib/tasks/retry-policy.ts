/**
 * P4-R12 — task recovery: when may a FAILED task be re-run, and by whom.
 *
 * This formalizes `DC-015`, a promise made to a user in production copy that
 * named a story id existing in no register: *"Retry (khi task FAILED) sẽ có ở
 * DC-015 cùng SSE"*.
 *
 * ## Deliberately minimal
 *
 * It owns the path from a **`FAILED` task** to an **authorized re-execution**
 * and its **observable status**, and nothing wider. Not a workflow engine, not
 * a scheduler, not a generic job runner. Hermes remains the agent runtime and
 * the task projection remains `P3-R08`/`DC-006`'s; this governs *re-entry* into
 * a substrate that already exists.
 *
 * ## `AC-03`: a retry is a new attempt, not a rewritten history
 *
 * The original failure stays readable with its own error. Overwriting it would
 * destroy the evidence of *why* it failed — which is the thing a person
 * retrying most needs, and the thing they lose exactly when they need it.
 *
 * ## Pure
 */

// ─── AC-01: eligibility is decided in one place ────────────────────

/**
 * The only states a retry may start from.
 *
 * `FAILED` is the obvious one. `SYNC_DELAYED` is here because it is a
 * transport failure rather than a task failure — the work may well have
 * succeeded upstream and the projection simply did not arrive.
 *
 * `CANCELLED` is deliberately NOT here: somebody stopped that task on purpose,
 * and re-running it would quietly undo a decision. Restarting cancelled work is
 * a new task, not a retry.
 */
export const RETRYABLE_STATES = ["FAILED", "SYNC_DELAYED"] as const;
export type RetryableState = (typeof RETRYABLE_STATES)[number];

export const RETRY_INELIGIBLE = [
  "TASK_NOT_FOUND",
  "TASK_STILL_RUNNING",
  "TASK_ALREADY_SUCCEEDED",
  "TASK_WAS_CANCELLED",
  "TASK_AWAITING_REVIEW",
  "TASK_NOT_IN_A_FAILURE_STATE",
  "RETRY_BUDGET_EXHAUSTED",
] as const;

export type RetryIneligible = (typeof RETRY_INELIGIBLE)[number];

export type RetryEligibility =
  | { readonly ok: true; readonly from: RetryableState; readonly attempt: number }
  | { readonly ok: false; readonly reason: RetryIneligible; readonly detail: string | null };

/**
 * `AC-04`. Versioned configuration, not a literal at a call site.
 *
 * Same shape as `P4-R01`'s `REPAIR_POLICY` and `P3-R07`'s `PREVIEW_TTL_CONFIG`,
 * for the same reason: changing the bound should be a visible change to
 * configuration rather than an edited number nobody reviews.
 */
export const RETRY_POLICY = {
  version: 1,
  /** Retries BEYOND the original run. */
  maxAttempts: 3,
} as const;

export interface TaskForRetry {
  readonly id: string;
  readonly status: string;
  /** How many retries have already been made. */
  readonly retryCount: number;
}

/**
 * `AC-01`. May this task be retried?
 *
 * One function, so the UI, the API and any future caller cannot each hold their
 * own version — the failure `P3-R02 AC-03` and `P4-R11 AC-02` both guard
 * against, in a third place.
 *
 * The refusal NAMES which state blocked it. "Not eligible" would be true and
 * would leave the person guessing whether to wait, to look for a cancellation,
 * or to raise a new task.
 */
export function retryEligibility(
  task: TaskForRetry | null,
  policy: typeof RETRY_POLICY = RETRY_POLICY,
): RetryEligibility {
  if (!task) return { ok: false, reason: "TASK_NOT_FOUND", detail: null };

  switch (task.status) {
    case "RUNNING":
    case "QUEUED":
      return { ok: false, reason: "TASK_STILL_RUNNING", detail: task.status };
    case "COMPLETED":
    case "APPROVED":
      return { ok: false, reason: "TASK_ALREADY_SUCCEEDED", detail: task.status };
    case "CANCELLED":
      // Somebody stopped this on purpose. Re-running it would undo a decision
      // without anyone deciding to.
      return { ok: false, reason: "TASK_WAS_CANCELLED", detail: task.status };
    case "WAITING_REVIEW":
    case "REVISION_REQUESTED":
      // It is waiting for a person, not stuck. Retrying would discard the
      // review that is in progress.
      return { ok: false, reason: "TASK_AWAITING_REVIEW", detail: task.status };
  }

  if (!(RETRYABLE_STATES as readonly string[]).includes(task.status)) {
    return { ok: false, reason: "TASK_NOT_IN_A_FAILURE_STATE", detail: task.status };
  }

  if (task.retryCount >= policy.maxAttempts) {
    // AC-04. A distinct reason, so exhaustion does not read like a permission
    // failure -- they need completely different responses.
    return { ok: false, reason: "RETRY_BUDGET_EXHAUSTED", detail: String(task.retryCount) };
  }

  return { ok: true, from: task.status as RetryableState, attempt: task.retryCount + 1 };
}

// ─── AC-02: authorization, decided before anything runs ────────────

export interface RetryRequester {
  /** Null when unauthenticated. */
  readonly userId: string | null;
  readonly role: string | null;
  /**
   * The profiles this requester may act within.
   *
   * `null` means **no per-user profile restriction exists**, which is the
   * situation in this codebase today and is stated rather than assumed.
   *
   * `BR01` here is QUERY SCOPING, not authorization: `getProfileFilter` reads a
   * URL parameter or a cookie to decide which rows to SHOW. There is no
   * per-user profile allowlist anywhere — `session.user` carries a role and
   * nothing else.
   *
   * So a check against `session.user.profiles` would read an empty array,
   * refuse every task that has a profile, and break retry entirely while
   * looking like security. An authorization boundary the system does not have
   * is worse invented than omitted.
   *
   * The field stays because the check is written and correct FOR THE DAY a
   * per-user profile model exists. Until then callers pass `null` and the role
   * gate is the authorization — which is exactly what every other
   * `/api/v1/*` route applies.
   */
  readonly profiles: readonly string[] | null;
}

export const RETRY_AUTH_REFUSALS = [
  "NOT_AUTHENTICATED",
  "ROLE_NOT_PERMITTED",
  "PROFILE_NOT_PERMITTED",
] as const;

export type RetryAuthRefusal = (typeof RETRY_AUTH_REFUSALS)[number];

/** Only these roles may re-run work. Same set the review actions require. */
export const RETRY_ROLES = ["OWNER", "ADMIN"] as const;

export type RetryAuth =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RetryAuthRefusal };

/**
 * `AC-02`. Checked BEFORE any re-execution is requested.
 *
 * Separate from eligibility on purpose. "You may not do this" and "this cannot
 * be done" are different answers, and collapsing them would tell an
 * unauthorized caller which tasks exist and what state they are in.
 */
export function authorizeRetry(
  requester: RetryRequester,
  taskProfile: string | null,
): RetryAuth {
  if (!requester.userId) return { ok: false, reason: "NOT_AUTHENTICATED" };
  if (!requester.role || !(RETRY_ROLES as readonly string[]).includes(requester.role)) {
    return { ok: false, reason: "ROLE_NOT_PERMITTED" };
  }
  // `null` = no per-user profile model exists; the role gate is the
  // authorization. When a list IS supplied, it is enforced: a task with a
  // profile the requester does not hold is refused, and a task with NO profile
  // is refused too rather than treated as "any" -- fail closed.
  if (requester.profiles !== null) {
    if (taskProfile === null || !requester.profiles.includes(taskProfile)) {
      return { ok: false, reason: "PROFILE_NOT_PERMITTED" };
    }
  }
  return { ok: true };
}

// ─── AC-03: what a retry records ───────────────────────────────────

export interface RetryAttemptRecord {
  readonly taskId: string;
  readonly attempt: number;
  readonly fromStatus: RetryableState;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly policyVersion: number;
}

/**
 * Build the record of one retry.
 *
 * A NEW row every time. Nothing here updates the previous attempt, and the
 * type has no field naming one — so "the original failed attempt remains
 * readable with its own error" is a property of the shape rather than a rule
 * about the SQL somebody writes later.
 */
export function buildRetryAttempt(
  taskId: string,
  eligibility: Extract<RetryEligibility, { ok: true }>,
  requestedBy: string,
  now: Date,
  policy: typeof RETRY_POLICY = RETRY_POLICY,
): RetryAttemptRecord {
  return {
    taskId,
    attempt: eligibility.attempt,
    fromStatus: eligibility.from,
    requestedBy,
    requestedAt: now,
    policyVersion: policy.version,
  };
}

// ─── AC-06: what the status surface may claim ──────────────────────

/**
 * How the status surface is being fed.
 *
 * `AC-06` permits either a real stream or honest polling, and forbids the third
 * thing: a UI that looks live and is not. So the mode is a value the surface
 * must carry, rather than an assumption it may make.
 */
export const STATUS_TRANSPORTS = ["STREAM", "POLL", "NONE"] as const;
export type StatusTransport = (typeof STATUS_TRANSPORTS)[number];

export interface StatusFreshness {
  readonly transport: StatusTransport;
  /** When this snapshot was taken. Never null -- unknown freshness is not fresh. */
  readonly asOf: Date;
  /** For POLL: how often. Null for STREAM. */
  readonly pollIntervalMs: number | null;
}

/**
 * What the surface should tell the reader about how current this is.
 *
 * `NONE` says so plainly rather than showing a stale value as though it were
 * current — the `UNKNOWN`-is-not-false invariant applied to freshness.
 */
export function describeFreshness(f: StatusFreshness): string {
  switch (f.transport) {
    case "STREAM":
      return "trực tiếp";
    case "POLL":
      return `cập nhật mỗi ${Math.round((f.pollIntervalMs ?? 0) / 1000)}s`;
    case "NONE":
      return "không tự cập nhật — tải lại trang để xem trạng thái mới";
  }
}
