/**
 * P3-R01 AC-07 — the transport boundary.
 *
 * The webhook entry point verifies that a request genuinely came from Telegram
 * **before any handler runs**, and an unauthenticated POST is rejected without
 * side effects.
 *
 * ## What the transport is, and everything it is not
 *
 * It answers one question: *did Telegram send this?* It does **not** decide who
 * the caller is (`P3-R01`'s gateway), what a button means (`P3-R03`), what a
 * command does (`P3-R02`), or whether anything may be approved (`P3-R04`,
 * `P3-R05`). Each of those is a separate refusal on a separate record, and
 * folding any of them in here would put a second authorisation opinion at the
 * edge of the system — the layer with the least context and the most exposure.
 *
 * ## Verification is the secret token header, and nothing else
 *
 * Telegram sends `X-Telegram-Bot-Api-Secret-Token`, set when the webhook is
 * registered. Source-IP allowlisting is not used as the check: the published
 * ranges change, a proxy rewrites the source, and a check that silently starts
 * matching nothing fails **open** — which is the wrong direction for the only
 * thing standing between the internet and the control plane.
 *
 * ## Fail-closed when unconfigured
 *
 * No configured secret means every request is rejected. That is the activation
 * gate expressed as behaviour: the route can be **deployed** while the
 * transport stays shut, and it opens only when a secret is deliberately
 * installed. A default of "accept when unset" would make deployment and
 * activation the same act.
 *
 * ## Pure, so it can be proven without a secret
 *
 * Nothing imported, `now` and the expected secret both parameters. `Q22` is an
 * activation credential dependency, not a coding blocker — the same argument
 * `P3-R01` made for the bot token.
 */

export const TRANSPORT_OUTCOMES = [
  "ACCEPT",
  "REJECT_NOT_CONFIGURED",
  "REJECT_NO_SECRET",
  "REJECT_BAD_SECRET",
  "REJECT_METHOD",
  "REJECT_BODY_TOO_LARGE",
  "REJECT_MALFORMED_BODY",
] as const;

export type TransportOutcome = (typeof TRANSPORT_OUTCOMES)[number];

export interface TransportDecision {
  readonly outcome: TransportOutcome;
  /**
   * Safe to log and to audit: it names the decision, never the material. A
   * reason that echoed the presented token would put a guessed secret into the
   * log of the system it was guessed against.
   */
  readonly reason: string;
}

export interface TransportRequest {
  readonly method: string;
  /** The value of `X-Telegram-Bot-Api-Secret-Token`, or absent. */
  readonly secretHeader?: unknown;
  readonly contentLength?: number;
}

/**
 * A Telegram update, in the only shape this system reads.
 *
 * Deliberately narrow. The wire format has dozens of fields; naming the four
 * that matter means a new one cannot arrive and be acted on by accident.
 */
export interface TelegramUpdateBody {
  readonly update_id?: unknown;
  readonly message?: { readonly from?: { readonly id?: unknown }; readonly text?: unknown };
  readonly callback_query?: {
    readonly from?: { readonly id?: unknown };
    readonly data?: unknown;
  };
}

/**
 * A Telegram update is small. A megabyte arriving at this endpoint is not a
 * message, and reading it before deciding whether to trust the sender is work
 * done on behalf of someone who has not authenticated.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * `===` on strings can return as soon as it finds a difference, which makes the
 * comparison time a function of how many leading characters were right. The
 * length is compared first and separately — it is not secret, and a
 * fixed-length loop over mismatched lengths would either read past the end or
 * quietly compare the wrong thing.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Decide whether a request may be read at all.
 *
 * The order is the point. Method, then configuration, then the header, then the
 * size — each cheaper and less trusting than the next, and none of them touches
 * the body. Nothing here parses, looks anything up, or writes: an
 * unauthenticated POST leaves no trace but the audit entry recording that it was
 * refused.
 */
export function verifyTransport(
  req: TransportRequest,
  expectedSecret: string | undefined,
): TransportDecision {
  if (req.method !== "POST") {
    return { outcome: "REJECT_METHOD", reason: "only POST is accepted" };
  }

  // Before the header check, deliberately: an unconfigured transport must
  // refuse everything, including a request that happens to carry a header.
  if (!expectedSecret || expectedSecret.length === 0) {
    return {
      outcome: "REJECT_NOT_CONFIGURED",
      reason: "transport is not configured",
    };
  }

  const presented = req.secretHeader;
  if (typeof presented !== "string" || presented.length === 0) {
    return { outcome: "REJECT_NO_SECRET", reason: "missing verification header" };
  }
  if (!secretsMatch(presented, expectedSecret)) {
    return { outcome: "REJECT_BAD_SECRET", reason: "verification failed" };
  }

  if (typeof req.contentLength === "number" && req.contentLength > MAX_BODY_BYTES) {
    return { outcome: "REJECT_BODY_TOO_LARGE", reason: "body exceeds the accepted size" };
  }

  return { outcome: "ACCEPT", reason: "verified" };
}

/**
 * Narrow a parsed body to the gateway's input shape.
 *
 * Returns `null` rather than throwing: a malformed body from a *verified*
 * sender is still a refusal rather than an error, and the caller records it the
 * same way as any other.
 *
 * `from.id` is read from the update itself and never from `callback_query.data`
 * — the payload is attacker-controlled even when the transport is verified,
 * which is the distinction `P3-R03` exists to hold.
 */
export function narrowUpdate(
  body: TelegramUpdateBody,
): { kind: "command" | "callback"; fromId?: unknown; text?: unknown; callbackData?: unknown } | null {
  if (body.callback_query) {
    return {
      kind: "callback",
      fromId: body.callback_query.from?.id,
      callbackData: body.callback_query.data,
    };
  }
  if (body.message) {
    return {
      kind: "command",
      fromId: body.message.from?.id,
      text: body.message.text,
    };
  }
  return null;
}

/**
 * The audit action names this layer emits, for `P3-R01` AC-08.
 *
 * A closed set, and distinct from the gateway's: "Telegram could not be
 * verified" and "the caller is not on the allowlist" are different events, and
 * collapsing them would make an attack on the endpoint indistinguishable from a
 * misconfigured allowlist.
 */
export const TRANSPORT_AUDIT_ACCEPT = "telegram.transport.accept" as const;
export const TRANSPORT_AUDIT_REFUSE = "telegram.transport.refuse" as const;

export interface TransportAuditRecord {
  readonly actorType: "system";
  readonly action: typeof TRANSPORT_AUDIT_ACCEPT | typeof TRANSPORT_AUDIT_REFUSE;
  readonly result: "OK" | "REFUSED";
  readonly reason: string;
}

/**
 * `AC-08` — every denial is recorded.
 *
 * A denial that leaves no trace is indistinguishable from an attack that never
 * happened, so this returns a record for **every** outcome including `ACCEPT`.
 * The reason is the decision's own, which never contains presented material.
 */
export function transportAuditRecordFor(d: TransportDecision): TransportAuditRecord {
  return {
    actorType: "system",
    action: d.outcome === "ACCEPT" ? TRANSPORT_AUDIT_ACCEPT : TRANSPORT_AUDIT_REFUSE,
    result: d.outcome === "ACCEPT" ? "OK" : "REFUSED",
    reason: `${d.outcome}: ${d.reason}`,
  };
}
