/**
 * P4-R09 AC-05 — deciding what goes to the owner, and through which assistant.
 *
 * The Ops Hub holds **no Telegram bot token and sends nothing itself**. Hermes
 * owns Telegram: it long-polls both bots and has the only sender. So the flow
 * is a queue and a collector:
 *
 *   publish fails → Ops Hub queues an alert → Hermes cron collects it
 *   → the assistant's existing Telegram sender → the owner
 *
 * ## Why a queue and not a push
 *
 * A push would need the Ops Hub to reach Telegram, which means a bot token in
 * the Ops Hub — the thing the owner ruled out — or an inbound API on Hermes,
 * which Hermes does not expose. Hermes' cron subsystem already collects and
 * delivers on a schedule, so the queue is the shape that fits what exists
 * rather than the shape that would need something new.
 *
 * ## Pure
 *
 * Imports nothing. The routing decision and the auth comparison are both
 * testable as data.
 */

// ─── Routing: which assistant carries the message ──────────────────

/**
 * Hermes runs one gateway per profile and one bot per gateway.
 *
 * These slugs are **Hermes'**, not ours — `aff` and `yt`, confirmed on the
 * host at `/opt/hermes-data/profiles/`. Inventing a third would queue an alert
 * no collector ever asks for, and it would sit unread forever looking
 * delivered.
 */
export const ASSISTANT_PROFILES = ["aff", "yt"] as const;
export type AssistantProfile = (typeof ASSISTANT_PROFILES)[number];

export function isAssistantProfile(v: unknown): v is AssistantProfile {
  return typeof v === "string" && (ASSISTANT_PROFILES as readonly string[]).includes(v);
}

/**
 * Which assistant does this entity belong to?
 *
 * Returns `null` rather than guessing. An alert about work no assistant owns
 * is a routing question for a person, not something to send to whichever bot
 * happens to be first — the owner would be answered by a bot that knows
 * nothing about it, which is worse than a delayed alert.
 */
export function routeToProfile(entityType: string): AssistantProfile | null {
  switch (entityType) {
    // The content/publishing pipeline is the affiliate-editorial engine's.
    case "article":
    case "article_publish_intent":
    case "affiliate_project":
    case "content_opportunity":
      return "aff";
    case "video":
    case "youtube_niche":
      return "yt";
    default:
      return null;
  }
}

// ─── What may be queued ────────────────────────────────────────────

export const ALERT_REFUSALS = [
  "UNKNOWN_PROFILE",
  "UNROUTABLE_ENTITY",
  "BODY_TOO_THIN",
  "BODY_CARRIES_A_SECRET",
  "NO_ENTITY",
] as const;

export type AlertRefusal = (typeof ALERT_REFUSALS)[number];

export interface QueuedAlert {
  readonly profile: AssistantProfile;
  readonly entityType: string;
  readonly entityId: string;
  readonly body: string;
}

export type AlertVerdict =
  | { readonly ok: true; readonly alert: QueuedAlert }
  | { readonly ok: false; readonly reason: AlertRefusal; readonly detail: string | null };

/**
 * `P3-R06 AC-05` reaching this path: ids travel, values do not.
 *
 * The body goes over Telegram, so a credential that reached it would be
 * readable in a chat log forever. Refusing the write is the only outcome that
 * actually removes it — redaction would leave the caller believing it had sent
 * what it meant to.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\b\d{6,}:AA[A-Za-z0-9_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bpostgres(?:ql)?:\/\/[^\s]+/,
];

/**
 * The floor the migration also enforces.
 *
 * `P4-R09 AC-05` says the alert must say WHY. "Publish failed" is 14
 * characters and satisfies nothing; `buildOwnerAlert` always produces the
 * article, the revision, the state, the attempt count and the reason.
 */
export const MIN_BODY_CHARS = 40;

export function prepareAlert(
  entityType: string,
  entityId: string,
  body: string,
): AlertVerdict {
  if (!entityType.trim() || !entityId.trim()) {
    return { ok: false, reason: "NO_ENTITY", detail: null };
  }

  const profile = routeToProfile(entityType);
  if (!profile) {
    return { ok: false, reason: "UNROUTABLE_ENTITY", detail: entityType };
  }

  const trimmed = body.trim();
  if (trimmed.length < MIN_BODY_CHARS) {
    return { ok: false, reason: "BODY_TOO_THIN", detail: String(trimmed.length) };
  }
  for (const p of SECRET_SHAPES) {
    if (p.test(trimmed)) {
      // The PATTERN is named, never the match. A refusal that quoted the
      // secret would put it somewhere else.
      return { ok: false, reason: "BODY_CARRIES_A_SECRET", detail: null };
    }
  }

  return { ok: true, alert: { profile, entityType, entityId, body: trimmed } };
}

// ─── The service boundary ──────────────────────────────────────────

/**
 * The collector is a shell script inside Hermes. It has no browser session, so
 * `requireRoleForApi` cannot authenticate it.
 *
 * This is the **minimal** boundary that admits it and nothing else: one shared
 * token, compared in constant time, and **fails closed when unconfigured** —
 * an endpoint that opened because its token was missing would be a public
 * queue of production failures.
 */
export type ServiceAuth =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "NOT_CONFIGURED" | "NO_TOKEN" | "TOKEN_MISMATCH" };

/**
 * Length-then-XOR, the same shape `P3-R01`'s `secretsMatch` uses.
 *
 * A `===` on secrets returns as soon as two bytes differ, and the time that
 * takes is a measurement of how much of the prefix was right.
 */
export function serviceTokenMatches(
  presented: string | null | undefined,
  expected: string | null | undefined,
): ServiceAuth {
  if (!expected) return { ok: false, reason: "NOT_CONFIGURED" };
  if (!presented) return { ok: false, reason: "NO_TOKEN" };
  if (presented.length !== expected.length) return { ok: false, reason: "TOKEN_MISMATCH" };

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: "TOKEN_MISMATCH" };
}

/**
 * What the collector receives.
 *
 * Deliberately NOT the whole row. The collector prints this verbatim into a
 * Telegram message, so anything here becomes chat content — internal ids and
 * timestamps would be noise to the owner and provenance the chat does not need
 * to carry. The Ops Hub keeps the full row.
 */
export function renderForDelivery(alerts: readonly { body: string }[]): string {
  return alerts.map((a) => a.body).join("\n\n———\n\n");
}
