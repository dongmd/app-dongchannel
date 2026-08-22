/**
 * P3-R03 — callback security.
 *
 * Callback data is **attacker-controlled input**. G-32 states the rule:
 * *"`approve:act_…`, resolved server-side; never trust callback params."*
 *
 * ## The shape of the defence
 *
 * The button carries an **opaque id and nothing else**. Every fact that matters
 * — which article, which revision, which user, which action — lives in a stored
 * record the server looks up. There is no field in the payload an attacker
 * could edit into a different meaning, because there are no fields.
 *
 * ## Pure
 *
 * Imports nothing. `now` is a parameter, the record is injected, and no branch
 * reads a clock. That is `AC-10`, and it is what makes `AC-11`'s boundary
 * assertions possible without waiting: exactly at the expiry instant, one
 * millisecond before, one after.
 */

// ─── The id ───────────────────────────────────────────────────────

/**
 * `act_` + 32 lowercase hex characters — 128 bits.
 *
 * `AC-03` requires unguessable. A counter is enumerable, a timestamp is
 * predictable, and a hash of the target is a hash **of the thing you are trying
 * not to reveal** — given the target, an attacker recomputes the id. Only
 * randomness has none of those properties.
 */
export const ACTION_ID_PATTERN = /^act_[0-9a-f]{32}$/;

export function isActionId(v: unknown): v is string {
  return typeof v === "string" && ACTION_ID_PATTERN.test(v);
}

/**
 * The generator is injected rather than imported, so this module stays free of
 * `node:crypto` and the tests stay pure. Production passes
 * `randomBytes(16).toString("hex")`.
 */
export function makeActionId(random16Bytes: string): string {
  const hex = random16Bytes.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    // Refusing beats emitting a weak id. An id that is short, uppercase or
    // non-hex is one whose entropy nobody has checked.
    throw new Error("makeActionId requires 16 bytes of randomness as 32 hex characters");
  }
  return `act_${hex}`;
}

// ─── The stored record ────────────────────────────────────────────

export const CALLBACK_ACTIONS = [
  "approve",
  "confirm",
  "cancel",
  "preview",
  "reject",
] as const;
export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

const CALLBACK_ACTION_SET: ReadonlySet<string> = new Set(CALLBACK_ACTIONS);

export function isCallbackAction(v: unknown): v is CallbackAction {
  return typeof v === "string" && CALLBACK_ACTION_SET.has(v);
}

/**
 * What the server stores against an id. Everything the button "means" is here,
 * and none of it travelled through Telegram.
 */
export interface ActionRecord {
  readonly actionId: string;
  /** The numeric Telegram id this button was offered to. */
  readonly issuedTo: number;
  readonly action: CallbackAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /**
   * The outcome of the first successful press, or `null` if it has not been
   * pressed. `AC-07`: a replay returns this rather than acting again.
   */
  readonly consumedResult: string | null;
  readonly consumedAt: Date | null;
}

// ─── Decisions ────────────────────────────────────────────────────

export const CALLBACK_OUTCOMES = [
  "ACT",
  "REPLAY",
  "REFUSE_UNKNOWN",
  "REFUSE_MALFORMED",
  "REFUSE_WRONG_USER",
  "REFUSE_EXPIRED",
  "REFUSE_RATE_LIMITED",
] as const;
export type CallbackOutcome = (typeof CALLBACK_OUTCOMES)[number];

export interface CallbackDecision {
  readonly outcome: CallbackOutcome;
  /** Present only on ACT. Nothing downstream may act without it. */
  readonly action?: CallbackAction;
  readonly targetType?: string;
  readonly targetId?: string;
  /** Present only on REPLAY — the stored result of the first press. */
  readonly storedResult?: string;
  /** Safe to log and audit: names the decision, never the subject. */
  readonly reason: string;
}

/**
 * A refusal that reveals nothing.
 *
 * `AC-04` requires a forged id to be rejected *"without revealing whether the id
 * existed"*. So an unknown id and a **wrong-user** id must be
 * indistinguishable — otherwise an attacker enumerating ids learns which ones
 * are real by watching the reason change. Both return this exact object.
 */
const REFUSE_UNKNOWN: CallbackDecision = {
  outcome: "REFUSE_UNKNOWN",
  reason: "that action is no longer available",
};

export interface CallbackInput {
  /** Raw callback data, straight off the wire. Trusted for nothing. */
  readonly callbackData: unknown;
  /** The sender id, taken from the VERIFIED update — never from the payload. */
  readonly fromId: unknown;
  /** The stored record for this id, or null if the lookup found none. */
  readonly record: ActionRecord | null;
  /** Whether this user is already over their rate limit. */
  readonly rateLimited?: boolean;
}

/**
 * Resolve one callback press.
 *
 * Order matters and is deliberate: **malformed → rate limit → unknown → wrong
 * user → replay → expiry → act**. Rate limiting comes before the lookup so a
 * flood costs no database work, and replay is checked *before* expiry so that
 * pressing an old button twice reports what happened the first time rather than
 * claiming it expired — the first press really did act, and saying otherwise
 * would be a lie about the system's own history.
 */
export function resolveCallback(input: CallbackInput, now: Date): CallbackDecision {
  if (!isActionId(input.callbackData)) {
    return { outcome: "REFUSE_MALFORMED", reason: "that action is no longer available" };
  }

  if (input.rateLimited === true) {
    // AC-09: refuse, never queue. A queued press acts later, at a moment
    // nobody chose, against a record that may have expired in between.
    return { outcome: "REFUSE_RATE_LIMITED", reason: "too many actions, try again shortly" };
  }

  const rec = input.record;
  if (rec === null || !isActionId(rec.actionId) || rec.actionId !== input.callbackData) {
    return REFUSE_UNKNOWN;
  }

  if (typeof input.fromId !== "number" || !Number.isSafeInteger(input.fromId)) {
    return REFUSE_UNKNOWN;
  }

  if (rec.issuedTo !== input.fromId) {
    // AC-05. Being on the allowlist is not the same as being the person the
    // button was offered to. Byte-identical to REFUSE_UNKNOWN on purpose.
    return { ...REFUSE_UNKNOWN, outcome: "REFUSE_WRONG_USER" };
  }

  if (rec.consumedResult !== null) {
    // AC-07. Return what happened; do not act again, and do not error as if
    // nothing had happened.
    return {
      outcome: "REPLAY",
      storedResult: rec.consumedResult,
      reason: "already done",
    };
  }

  if (!(rec.expiresAt instanceof Date) || Number.isNaN(rec.expiresAt.getTime())) {
    return REFUSE_UNKNOWN;
  }

  // AC-06 / AC-11. `>=` and not `>`: the expiry instant is the first moment the
  // id is invalid, not the last moment it is valid. Off-by-one at a security
  // boundary is a security defect.
  if (now.getTime() >= rec.expiresAt.getTime()) {
    return { outcome: "REFUSE_EXPIRED", reason: "that action has expired" };
  }

  if (!isCallbackAction(rec.action)) {
    return REFUSE_UNKNOWN;
  }

  return {
    outcome: "ACT",
    action: rec.action,
    targetType: rec.targetType,
    targetId: rec.targetId,
    reason: "authorised",
  };
}

// ─── Rate limiting (AC-09) ────────────────────────────────────────

export interface RateLimitConfig {
  readonly maxPresses: number;
  readonly windowMs: number;
}

export const DEFAULT_CALLBACK_RATE_LIMIT: RateLimitConfig = {
  maxPresses: 20,
  windowMs: 60_000,
};

/**
 * Whether this press is over the limit, given the timestamps of previous
 * presses by the same user.
 *
 * Pure, and `now` is a parameter. Bounded by construction: the caller passes a
 * window, and presses outside it are not counted rather than accumulated
 * forever.
 */
export function isRateLimited(
  previousPresses: readonly Date[],
  now: Date,
  config: RateLimitConfig = DEFAULT_CALLBACK_RATE_LIMIT,
): boolean {
  if (config.maxPresses <= 0) return true; // fail closed on a nonsense config
  const cutoff = now.getTime() - config.windowMs;
  let inWindow = 0;
  for (const p of previousPresses) {
    if (!(p instanceof Date) || Number.isNaN(p.getTime())) continue;
    if (p.getTime() > cutoff) inWindow++;
  }
  return inWindow >= config.maxPresses;
}

// ─── What may be audited (P3-R06 AC-05) ───────────────────────────

/**
 * The audit input for one callback decision, shaped as `P3-R06`'s
 * `AuditInput` — the same seam `P3-R01` uses, for the same reason: two shapes
 * agreeing by inspection is how they stop agreeing.
 *
 * **The action id is never recorded.** It is a bearer token for the window it
 * is live, and an audit row is permanent — writing it would leave a working
 * credential in a table nobody can edit afterwards.
 */
export interface CallbackAuditRecord {
  readonly actorType: "user";
  readonly action: "telegram.callback.resolve" | "telegram.callback.replay" | "telegram.ratelimit.refuse";
  readonly actorId: number | null;
  readonly result: "OK" | "REFUSED" | "REPLAYED";
  readonly entityType: string;
  readonly entityId: string;
  readonly at: string;
}

export function callbackAuditRecordFor(
  decision: CallbackDecision,
  fromId: unknown,
  now: Date,
): CallbackAuditRecord {
  const actorId = typeof fromId === "number" && Number.isSafeInteger(fromId) ? fromId : null;

  if (decision.outcome === "REFUSE_RATE_LIMITED") {
    return {
      actorType: "user",
      action: "telegram.ratelimit.refuse",
      actorId,
      result: "REFUSED",
      entityType: "telegram_callback",
      entityId: decision.outcome,
      at: now.toISOString(),
    };
  }

  const replayed = decision.outcome === "REPLAY";
  return {
    actorType: "user",
    action: replayed ? "telegram.callback.replay" : "telegram.callback.resolve",
    // A refused caller is not a verified actor.
    actorId: decision.outcome === "ACT" || replayed ? actorId : null,
    result: decision.outcome === "ACT" ? "OK" : replayed ? "REPLAYED" : "REFUSED",
    entityType: "telegram_callback",
    // The OUTCOME, never the action id.
    entityId: decision.outcome,
    at: now.toISOString(),
  };
}
