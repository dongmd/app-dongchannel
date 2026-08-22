/**
 * P3-R06 — what may be written to the audit log, and what may not.
 *
 * `audit_events` is the **canonical audit authority** (AC-01, owner
 * instruction 2026-08-21). There is no second audit log, and this module does
 * not create one: it decides the *shape* of a record. Writing is
 * `lib/audit/write.ts`; enforcing append-only is migration `0028`.
 *
 * ## Pure
 *
 * Imports nothing, reads no clock, touches no database. `now` is a parameter.
 * Every redaction rule is therefore provable without a connection, and the
 * database CHECK in `0028` is the second, independent enforcement of the same
 * rule — neither trusts the other.
 *
 * ## Data minimisation is the point, not a side note
 *
 * The owner's spec §10 says to store a Telegram reference **"where safe"**.
 * That phrase is doing real work, and `AC-05` makes it mechanical: **ids
 * only**. A denied caller's message body is exactly the sort of thing that
 * ends up in a log nobody meant to keep, and an audit log is the one table
 * whose rows can never be edited or deleted afterwards — so a secret written
 * here is written for good.
 */

// ─── The closed action vocabulary ─────────────────────────────────
//
// AC-06 enumerates the P3 state changes that must produce an entry. A closed
// set means a new action cannot be logged under an ad-hoc string that no
// query will ever look for.

export const AUDIT_ACTIONS = [
  // P3-R01 AC-07/AC-08, added 2026-08-22. The transport answers "did Telegram
  // send this"; the gateway answers "may this caller act". Collapsing them into
  // one action would make an attack on the endpoint indistinguishable from a
  // misconfigured allowlist -- two very different things to be woken up for.
  //
  // The vocabulary being CLOSED means an addition is deliberate and reviewed,
  // not that it can never grow. This is the mechanism working.
  "telegram.transport.accept",
  "telegram.transport.refuse",
  "telegram.gateway.allow",
  "telegram.gateway.deny",
  "telegram.command",
  "telegram.callback.resolve",
  "telegram.callback.replay",
  "telegram.ratelimit.refuse",
  "approval.create",
  "approval.confirm",
  "approval.cancel",
  "approval.expire",
  "preview.issue",
  "preview.use",
  "preview.revoke",
  "preview.refuse",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(v: unknown): v is AuditAction {
  return typeof v === "string" && ACTION_SET.has(v);
}

/** AC-04. The outcome, not merely that something was attempted. */
export const AUDIT_RESULTS = ["OK", "REFUSED", "EXPIRED", "REPLAYED", "ERROR"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

// ─── Rejection reasons ────────────────────────────────────────────

export const AUDIT_REJECTIONS = [
  "UNKNOWN_ACTION",
  "UNKNOWN_RESULT",
  "TELEGRAM_REF_NOT_IDS",
  "SECRET_IN_PAYLOAD",
  "PAYLOAD_NOT_PLAIN",
  "MISSING_BEFORE_AFTER",
] as const;
export type AuditRejection = (typeof AUDIT_REJECTIONS)[number];

export type AuditVerdict =
  | { readonly ok: true; readonly record: AuditRecord }
  | { readonly ok: false; readonly reason: AuditRejection; readonly detail: string };

export interface AuditRecord {
  readonly actorType: "user" | "system" | "agent";
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly beforeJson: Record<string, unknown> | null;
  readonly afterJson: Record<string, unknown> | null;
  readonly requestId: string | null;
  readonly result: AuditResult;
  readonly telegramRef: string | null;
  readonly at: Date;
}

export interface AuditInput {
  readonly actorType?: "user" | "system" | "agent";
  /** A Telegram numeric id, a uuid, or null. Never an email or a handle. */
  readonly actorId?: string | number | null;
  readonly action: string;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly requestId?: string | null;
  readonly result: string;
  /** `chatId` or `chatId:messageId`. Ids only — AC-05. */
  readonly telegramRef?: string | null;
}

// ─── Secret detection ─────────────────────────────────────────────
//
// The same shapes `lib/log-redact.ts` scrubs, applied here as a REFUSAL rather
// than a scrub. Redaction is right for a log line, which is best-effort and
// disposable. It is wrong here: an audit row cannot be edited afterwards, so a
// secret that slips in is permanent. Refusing the write forces the caller to
// fix what they are passing, which is the only outcome that actually removes
// the secret from the system.

const SECRET_SHAPES: readonly RegExp[] = [
  /\bbot\d{6,12}:[A-Za-z0-9_-]{30,}/, // Telegram bot token, as it appears in the API URL
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, // ...and bare
  /GOCSPX-[A-Za-z0-9_-]{20,}/, // Google client secret
  /\bsk-[A-Za-z0-9_-]{20,}/, // API key
  /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:[^@\s]+@/i, // DSN with an inline password
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const SECRET_KEY_NAMES = [
  "password", "passwd", "secret", "token", "apikey", "api_key",
  "authorization", "credential", "private_key", "cookie", "dsn",
];

function looksSecret(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

function hasSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_NAMES.some((s) => k.includes(s));
}

/**
 * Walk a payload for anything that must never be written.
 *
 * Returns the offending path, or `null`. Depth-bounded and cycle-safe: a
 * validator that can be made to hang by its input is a denial of service on the
 * write path, and this one sits in front of every audited action.
 */
export function findSecret(
  value: unknown,
  path = "$",
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (depth > 12) return `${path}: nesting too deep to validate`;

  if (typeof value === "string") {
    return looksSecret(value) ? `${path}: value matches a secret shape` : null;
  }
  if (value === null || typeof value !== "object") return null;

  if (seen.has(value as object)) return null;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecret(value[i], `${path}[${i}]`, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (hasSecretKey(k)) return `${path}.${k}: key name is a secret`;
    const hit = findSecret(v, `${path}.${k}`, depth + 1, seen);
    if (hit) return hit;
  }
  return null;
}

/** AC-05. Ids only: digits, optionally `chat:message`. */
export const TELEGRAM_REF_PATTERN = /^\d{1,20}(:\d{1,20})?$/;

export function isTelegramRef(v: unknown): v is string {
  return typeof v === "string" && TELEGRAM_REF_PATTERN.test(v);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Build a record, or refuse and say why.
 *
 * **Refusing is the safe direction here.** AC-09 makes a failed audit write
 * fail the operation, so a refusal here stops the action rather than silently
 * logging less than it should — which is the outcome that keeps the log
 * trustworthy.
 */
export function buildAuditRecord(input: AuditInput, now: Date): AuditVerdict {
  if (!isAuditAction(input.action)) {
    return { ok: false, reason: "UNKNOWN_ACTION", detail: String(input.action) };
  }
  if (!(AUDIT_RESULTS as readonly string[]).includes(input.result)) {
    return { ok: false, reason: "UNKNOWN_RESULT", detail: String(input.result) };
  }

  const ref = input.telegramRef ?? null;
  if (ref !== null && !isTelegramRef(ref)) {
    // Deliberately does NOT echo the value: it is the thing suspected of
    // carrying a secret.
    return { ok: false, reason: "TELEGRAM_REF_NOT_IDS", detail: "telegram_ref must be ids only" };
  }

  // AC-07. Both halves or neither: an entry saying only what a thing became
  // cannot answer what it was.
  const hasBefore = input.before !== undefined && input.before !== null;
  const hasAfter = input.after !== undefined && input.after !== null;
  if (hasBefore !== hasAfter) {
    return {
      ok: false,
      reason: "MISSING_BEFORE_AFTER",
      detail: hasBefore ? "before without after" : "after without before",
    };
  }

  if (hasBefore && !(isPlainRecord(input.before) && isPlainRecord(input.after))) {
    return { ok: false, reason: "PAYLOAD_NOT_PLAIN", detail: "before/after must be objects" };
  }

  for (const [label, payload] of [
    ["before", input.before],
    ["after", input.after],
    ["entityId", input.entityId],
    ["actorId", input.actorId],
  ] as const) {
    const hit = findSecret(payload, `$.${label}`);
    if (hit) return { ok: false, reason: "SECRET_IN_PAYLOAD", detail: hit };
  }

  return {
    ok: true,
    record: {
      actorType: input.actorType ?? "user",
      actorId: input.actorId === null || input.actorId === undefined ? null : String(input.actorId),
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      beforeJson: hasBefore ? (input.before as Record<string, unknown>) : null,
      afterJson: hasAfter ? (input.after as Record<string, unknown>) : null,
      requestId: input.requestId ?? null,
      result: input.result as AuditResult,
      telegramRef: ref,
      at: now,
    },
  };
}

// ─── Retention (AC-11) ────────────────────────────────────────────

/**
 * **There is no retention expiry, and that is the policy.**
 *
 * Stating it is the requirement: AC-11 asks for retention to be *stated*, and
 * the honest statement is that entries are kept indefinitely. Nothing prunes
 * this table, and nothing can — migration `0028` refuses `DELETE` and
 * `TRUNCATE` for every role, so an incidental cleanup job would fail loudly
 * rather than quietly shorten the history.
 *
 * Changing this later means a migration that drops a trigger: a visible schema
 * change with a reviewer, not a cron entry nobody reads.
 */
export const AUDIT_RETENTION = {
  policy: "INDEFINITE",
  expiryMechanism: "NONE",
  enforcedBy: "migration 0028 — BEFORE DELETE and BEFORE TRUNCATE triggers",
  changeRequires: "a migration that drops the triggers, reviewed as a schema change",
} as const;
