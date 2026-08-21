/**
 * P3-R01 — the bot gateway's authorisation decision.
 *
 * G-31 states the rule precisely: *"Check on each interaction, not once per
 * conversation."* Every command and every callback is authorised on its own
 * merits; there is no session, no "already greeted", nothing that carries trust
 * from one update to the next.
 *
 * ## Pure on purpose
 *
 * This module imports nothing. `now` is a parameter, the allowlist is injected,
 * and no branch reads a clock, a database or an environment variable. That is
 * what makes every path — including the fail-closed empty allowlist — provable
 * offline, and it is why the bot token is needed to **run** the gateway and
 * never to prove it correct. Owner decision **Q22** is an activation credential
 * dependency, not a coding blocker.
 *
 * ## What the gateway is not allowed to be
 *
 * A translator from arbitrary Telegram text into arbitrary internal action.
 * Every update resolves to one member of a **closed set** of intents, or to a
 * refusal. There is no path from raw input to an action nobody enumerated.
 */

// ─── Identity ─────────────────────────────────────────────────────

/**
 * The allowlist holds **numeric Telegram user ids**.
 *
 * Never usernames: a username is chosen by its owner and can be released and
 * re-registered by somebody else. An id cannot. Using `@handle` as an
 * authorisation identity means the account that answers to a name today may not
 * be the account that answers to it tomorrow.
 */
export type TelegramUserId = number;

export function isTelegramUserId(v: unknown): v is TelegramUserId {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

// ─── The closed intent set ────────────────────────────────────────
//
// Owner spec §2 enumerates ten commands. The gateway resolves an update to one
// of these or refuses; P3-R02 implements what each one does.

export const COMMANDS = [
  "newproject",
  "research",
  "projects",
  "project",
  "contentplan",
  "queue",
  "drafts",
  "article",
  "status",
  "help",
] as const;

export type Command = (typeof COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(COMMANDS);

export function isCommand(v: unknown): v is Command {
  return typeof v === "string" && COMMAND_SET.has(v);
}

// ─── Decisions ────────────────────────────────────────────────────

export const GATEWAY_OUTCOMES = [
  "ALLOW",
  "DENY_ALLOWLIST_EMPTY",
  "DENY_NOT_ALLOWLISTED",
  "DENY_NO_ACTOR",
  "DENY_MALFORMED",
  "DENY_UNKNOWN_COMMAND",
] as const;

export type GatewayOutcome = (typeof GATEWAY_OUTCOMES)[number];

export interface GatewayDecision {
  readonly outcome: GatewayOutcome;
  /** Present only on ALLOW. Nothing downstream may act without it. */
  readonly command?: Command;
  readonly args?: string;
  /** The verified actor, from the update — never from a callback payload. */
  readonly actorId?: TelegramUserId;
  /**
   * A short, non-leaking reason. Safe to log and to audit: it names the
   * decision, never the subject. "not on the allowlist" is a fact about the
   * caller; "project 41 not found" would be a fact about the system.
   */
  readonly reason: string;
}

/** An update the gateway understands, narrowed from Telegram's wire shape. */
export interface GatewayUpdate {
  readonly kind: "command" | "callback";
  /** The numeric id Telegram reports for the sender. */
  readonly fromId?: unknown;
  /** Raw text for a command update. */
  readonly text?: unknown;
  /** Opaque action id for a callback update. Resolved by P3-R03, not here. */
  readonly callbackData?: unknown;
}

const ALLOW_NOTHING: GatewayDecision = {
  outcome: "DENY_ALLOWLIST_EMPTY",
  reason: "allowlist is empty",
};

/**
 * Authorise one interaction.
 *
 * `now` is accepted and unused today. It is in the signature because the
 * decision will grow time-bounded rules (P3-R03 expiry, rate limiting), and
 * retrofitting a clock into a pure function is how `now` ends up read from
 * inside — which is the thing TD-21 was about.
 */
export function authorize(
  update: GatewayUpdate,
  allowlist: readonly TelegramUserId[],
  _now: Date,
): GatewayDecision {
  // FAIL CLOSED. An unset or empty allowlist denies everything; it must never
  // be read as "no restriction configured". This is the branch a misconfigured
  // deploy lands on, and the expensive direction to be wrong in.
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return ALLOW_NOTHING;
  }

  if (!isTelegramUserId(update.fromId)) {
    return { outcome: "DENY_NO_ACTOR", reason: "no verifiable sender id" };
  }

  const actorId = update.fromId;

  if (!allowlist.includes(actorId)) {
    // Deliberately identical in shape to every other refusal, and carrying
    // nothing about what exists. Spec §8: "no sensitive project information."
    return { outcome: "DENY_NOT_ALLOWLISTED", reason: "not authorised" };
  }

  if (update.kind === "callback") {
    // A callback is authorised here and RESOLVED by P3-R03. The gateway never
    // reads meaning out of callback data: it is attacker-controlled input, and
    // an opaque id is the only thing it is allowed to be.
    if (typeof update.callbackData !== "string" || update.callbackData.trim() === "") {
      return { outcome: "DENY_MALFORMED", reason: "callback carries no action id" };
    }
    return { outcome: "ALLOW", actorId, reason: "authorised callback" };
  }

  const parsed = parseCommand(update.text);
  if (parsed === null) {
    return { outcome: "DENY_MALFORMED", reason: "not a command" };
  }
  if (!isCommand(parsed.name)) {
    // An unknown command is refused and does NOTHING. It is not forwarded, not
    // guessed at, and not passed through to a handler that might interpret it.
    return { outcome: "DENY_UNKNOWN_COMMAND", reason: "unknown command" };
  }

  return {
    outcome: "ALLOW",
    command: parsed.name,
    args: parsed.args,
    actorId,
    reason: "authorised command",
  };
}

/**
 * Split `/command@botname args` into its parts.
 *
 * Returns `null` for anything that is not a command, rather than guessing.
 * The `@botname` suffix is Telegram's group addressing and is stripped, so
 * `/status@dc_bot` and `/status` are the same command.
 */
export function parseCommand(text: unknown): { name: string; args: string } | null {
  if (typeof text !== "string") return null;

  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.length < 2) return null;

  const space = trimmed.indexOf(" ");
  const head = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
  const args = space === -1 ? "" : trimmed.slice(space + 1).trim();

  const at = head.indexOf("@");
  const name = (at === -1 ? head : head.slice(0, at)).toLowerCase();

  // A command name is letters, digits and underscore -- Telegram's own rule.
  // Without this, `"//"` parsed to a command named `"/"`: refused downstream,
  // since `isCommand("/")` is false, but a parser returning a shape nobody can
  // act on is lying about what it found.
  if (!/^[a-z0-9_]+$/.test(name)) return null;

  return { name, args };
}

// ─── Allowlist construction ───────────────────────────────────────

/**
 * Parse an allowlist from configuration.
 *
 * **Anything unparseable yields an empty allowlist**, which denies everything.
 * A malformed value must not silently drop to a shorter list that still
 * authorises somebody: a typo in one id would then quietly widen or narrow
 * access with no signal. Refusing wholesale is loud and safe.
 */
export function parseAllowlist(raw: unknown): readonly TelegramUserId[] {
  if (typeof raw !== "string") return [];

  // Empty segments are NOT filtered out. `"123, ,456"` is a malformed list, and
  // dropping the blank would have salvaged a working allowlist from input the
  // author clearly did not write on purpose -- the exact silent narrowing this
  // function refuses to do.
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length === 0) return [];

  const ids: TelegramUserId[] = [];
  for (const part of parts) {
    // Strictly digits. `Number("12e3")` is 12000 and `Number(" 7 ")` is 7;
    // neither is an id anybody typed, and a coercion that succeeds on the wrong
    // input is worse than one that fails.
    if (!/^\d+$/.test(part)) return [];
    const n = Number(part);
    if (!isTelegramUserId(n)) return [];
    ids.push(n);
  }

  return ids;
}

// ─── What may be recorded ─────────────────────────────────────────

/**
 * The audit payload for one gateway decision (P3-R01 AC-08, P3-R06 AC-05).
 *
 * Ids and outcomes only. No message text, no callback data, no token, no
 * argument string — a denied caller's message body is exactly the kind of thing
 * that ends up in a log nobody meant to keep.
 *
 * Shaped as `P3-R06`'s `AuditInput` rather than as a type of its own. The two
 * were separate until R06 landed, and separate shapes agreeing by inspection is
 * how they stop agreeing later; the gateway test now feeds this straight into
 * `buildAuditRecord` and asserts the canonical writer accepts it.
 *
 * The type is structural on purpose — importing R06 here would drag the schema
 * into a module whose whole value is that it imports nothing.
 */
export interface GatewayAuditRecord {
  readonly actorType: "user";
  readonly action: "telegram.gateway.allow" | "telegram.gateway.deny";
  readonly actorId: TelegramUserId | null;
  readonly result: "OK" | "REFUSED";
  /** The gateway outcome, kept as the queryable detail of a refusal. */
  readonly entityType: "telegram_update";
  readonly entityId: GatewayOutcome;
  readonly at: string;
}

export function auditRecordFor(
  decision: GatewayDecision,
  now: Date,
): GatewayAuditRecord {
  const allowed = decision.outcome === "ALLOW";
  return {
    actorType: "user",
    action: allowed ? "telegram.gateway.allow" : "telegram.gateway.deny",
    // A denied caller's id is NOT recorded as a verified actor: nothing about
    // that update was authenticated by us.
    actorId: decision.actorId ?? null,
    result: allowed ? "OK" : "REFUSED",
    entityType: "telegram_update",
    entityId: decision.outcome,
    at: now.toISOString(),
  };
}
