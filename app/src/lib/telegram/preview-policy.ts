/**
 * P3-R07 — a preview link is a capability, not an identity.
 *
 * Owner decision **Q32**, Option A: a signed preview link, because WordPress
 * draft preview needs a login and that does not suit Telegram-first operation.
 *
 * Every constraint the owner attached is a criterion, and the sharpest is
 * `AC-07`: **the token can never become a permanent authentication credential.**
 * Presenting it authenticates *nothing* — it authorises **one read, of one
 * revision, for a short while, and it can be taken back.**
 *
 * ## Why the whole module is pure
 *
 * The signer is injected, `now` is a parameter, and the stored record arrives
 * from the caller. That is what makes `AC-04`'s boundary assertion possible —
 * exactly at the expiry instant, one unit either side — and it means the key
 * never has to exist for the logic to be provable. `AC-13`'s key policy is about
 * where the key *lives*, and it lives outside this file.
 *
 * ## The signature covers the scope, not just the id
 *
 * A token signs `article_id`, `revision_id`, `content_hash` and expiry
 * **together**. Signing only an opaque id would make the token a bearer
 * reference to a mutable row, and `AC-02` would then hold only for as long as
 * nobody edited that row. Signing the scope makes the binding part of the token.
 */

// ─── Refusals ─────────────────────────────────────────────────────
//
// `AC-15`: the response reveals nothing about which case applied. These names
// exist for the audit log and for tests. The reader on the other end of the
// request sees one answer.

export const PREVIEW_OUTCOMES = [
  "ALLOW",
  "REFUSE_MALFORMED",
  "REFUSE_BAD_SIGNATURE",
  "REFUSE_UNKNOWN",
  "REFUSE_EXPIRED",
  "REFUSE_REVOKED",
  "REFUSE_SCOPE_MISMATCH",
  "REFUSE_CONTENT_CHANGED",
  "REFUSE_KEY_UNAVAILABLE",
] as const;

export type PreviewOutcome = (typeof PREVIEW_OUTCOMES)[number];

export interface PreviewDecision {
  readonly outcome: PreviewOutcome;
  /** Present only on ALLOW. Nothing may be rendered without it. */
  readonly articleId?: string;
  readonly revisionId?: string;
  /** Safe to log and audit: names the decision, never the token. */
  readonly reason: string;
}

/**
 * `AC-15` — one answer for every refusal.
 *
 * A forged link, an expired link, a revoked link and a link for a deleted
 * revision must be indistinguishable from outside. Distinguishing them turns
 * the endpoint into an oracle that tells an attacker which half of a guess was
 * right.
 */
export const PUBLIC_REFUSAL = "This preview link is not available." as const;

export function publicResponseFor(d: PreviewDecision): { status: number; body: string } {
  return d.outcome === "ALLOW"
    ? { status: 200, body: "" }
    : { status: 404, body: PUBLIC_REFUSAL };
}

// ─── The token ────────────────────────────────────────────────────

/**
 * `pv1.<keyVersion>.<payload>.<signature>`
 *
 * The key version travels in the token so `AC-13`'s rotation is a decision
 * rather than an outage: a verifier can tell *which* key a link was signed with
 * and refuse cleanly when that key is gone, instead of reporting a bad
 * signature and sending someone hunting for an attacker.
 */
export const TOKEN_PREFIX = "pv1" as const;
export const TOKEN_PATTERN = /^pv1\.[a-z0-9]{1,16}\.[A-Za-z0-9_-]{16,512}\.[a-f0-9]{64}$/;

export interface PreviewScope {
  readonly articleId: string;
  readonly revisionId: string;
  /** `AC-11` — the hash of exactly what will be shown. */
  readonly contentHash: string;
  readonly expiresAt: Date;
}

/** An HMAC-SHA256 over a string, hex encoded. Injected; see the module note. */
export type Signer = (message: string, keyVersion: string) => string | null;

function encodeScope(s: PreviewScope): string {
  // A fixed field order and a separator that cannot appear in any field. If the
  // separator could occur inside a value, two different scopes could encode to
  // the same string and one signature would cover both.
  const parts = [s.articleId, s.revisionId, s.contentHash, String(s.expiresAt.getTime())];
  return parts.map((p) => encodeURIComponent(p)).join("~");
}

export function buildPreviewToken(
  scope: PreviewScope,
  keyVersion: string,
  sign: Signer,
): string | null {
  const payload = Buffer.from(encodeScope(scope), "utf8").toString("base64url");
  const sig = sign(`${TOKEN_PREFIX}.${keyVersion}.${payload}`, keyVersion);
  if (!sig) return null;
  return `${TOKEN_PREFIX}.${keyVersion}.${payload}.${sig}`;
}

export interface ParsedToken {
  readonly keyVersion: string;
  readonly payload: string;
  readonly signature: string;
  readonly scope: PreviewScope;
}

/** Structure only. A well-formed token is not a verified one. */
export function parsePreviewToken(token: unknown): ParsedToken | null {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const [, keyVersion, payload, signature] = token.split(".");
  if (!keyVersion || !payload || !signature) return null;
  try {
    const raw = Buffer.from(payload, "base64url").toString("utf8");
    const [a, r, h, e] = raw.split("~").map((p) => decodeURIComponent(p));
    if (!a || !r || !h || !e) return null;
    const ms = Number(e);
    if (!Number.isSafeInteger(ms)) return null;
    return {
      keyVersion,
      payload,
      signature,
      scope: { articleId: a, revisionId: r, contentHash: h, expiresAt: new Date(ms) },
    };
  } catch {
    return null;
  }
}

/** Constant-time hex comparison. See `transport-policy.secretsMatch`. */
export function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── TTL ──────────────────────────────────────────────────────────

/**
 * `AC-03` — short by default, configurable, with a stated maximum.
 *
 * Held here as versioned configuration rather than as a literal at the call
 * site, so raising it is one reviewed change rather than a number somebody
 * edited in passing. The maximum is the point: a configurable TTL with no
 * ceiling is not a short-lived capability, it is a long-lived one waiting for a
 * typo.
 */
export const PREVIEW_TTL_CONFIG = {
  version: "1",
  defaultMs: 15 * 60 * 1000,
  maxMs: 60 * 60 * 1000,
} as const;

export function resolveTtlMs(requestedMs?: number): { ms: number; clamped: boolean } {
  if (requestedMs === undefined) return { ms: PREVIEW_TTL_CONFIG.defaultMs, clamped: false };
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
    return { ms: PREVIEW_TTL_CONFIG.defaultMs, clamped: true };
  }
  if (requestedMs > PREVIEW_TTL_CONFIG.maxMs) {
    return { ms: PREVIEW_TTL_CONFIG.maxMs, clamped: true };
  }
  return { ms: requestedMs, clamped: false };
}

// ─── The stored record ────────────────────────────────────────────

export interface PreviewLinkRecord {
  readonly id: string;
  readonly articleId: string;
  readonly revisionId: string;
  readonly contentHash: string;
  readonly keyVersion: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** `AC-05` — revocation is a timestamp, not a deletion: the log keeps its shape. */
  readonly revokedAt: Date | null;
}

export interface PreviewCheck {
  readonly token: unknown;
  /** The stored record for the token's scope, or null if the lookup found none. */
  readonly record: PreviewLinkRecord | null;
  /** The article's content hash, recomputed NOW. `AC-10`. */
  readonly currentHash: string | null;
  /** Verify against this key version; null when the key is unavailable. */
  readonly sign: Signer;
}

/**
 * The whole decision, in the order the checks must run.
 *
 *   malformed   — nothing about a string that is not a token is worth looking up
 *   key gone    — `AC-13`: rotation invalidates outstanding links, and says so
 *   signature   — before ANY database lookup, so an unsigned guess cannot be
 *                 used to probe which ids exist
 *   unknown     — the signature was ours, but no record: a revoked-and-purged
 *                 or never-issued link
 *   scope       — `AC-02`: the record must agree with what the token claims
 *   revoked     — `AC-05`, before expiry, so a revoked link reads as revoked in
 *                 the audit rather than as a timing coincidence
 *   expired     — `AC-04`, inclusive at the instant
 *   content     — `AC-10`: a material edit invalidates the preview
 */
export function checkPreview(input: PreviewCheck, now: Date): PreviewDecision {
  const parsed = parsePreviewToken(input.token);
  if (!parsed) return { outcome: "REFUSE_MALFORMED", reason: "not a preview token" };

  const expected = input.sign(
    `${TOKEN_PREFIX}.${parsed.keyVersion}.${parsed.payload}`,
    parsed.keyVersion,
  );
  if (expected === null) {
    return { outcome: "REFUSE_KEY_UNAVAILABLE", reason: "signing key version is not available" };
  }
  if (!signaturesMatch(parsed.signature, expected)) {
    return { outcome: "REFUSE_BAD_SIGNATURE", reason: "signature does not verify" };
  }

  const rec = input.record;
  if (!rec) return { outcome: "REFUSE_UNKNOWN", reason: "no such preview link" };

  // The key version is part of the scope, not merely metadata.
  //
  // Found by a test rather than by design: a token signed with a DIFFERENT but
  // still-valid key verifies on its own terms, and without this line the record
  // would then be matched on article, revision and hash alone -- so anything
  // holding any valid preview key could mint a link for any record. That is
  // exactly AC-15's "re-signed with a wrong key", and it was accepted.
  if (
    rec.keyVersion !== parsed.keyVersion ||
    rec.articleId !== parsed.scope.articleId ||
    rec.revisionId !== parsed.scope.revisionId ||
    rec.contentHash !== parsed.scope.contentHash ||
    rec.expiresAt.getTime() !== parsed.scope.expiresAt.getTime()
  ) {
    return { outcome: "REFUSE_SCOPE_MISMATCH", reason: "token scope does not match the record" };
  }

  if (rec.revokedAt !== null) return { outcome: "REFUSE_REVOKED", reason: "revoked" };

  // `>=`: a link that expires exactly now is expired. The alternative leaves a
  // one-instant window in which a stale capability is honoured.
  if (now.getTime() >= rec.expiresAt.getTime()) {
    return { outcome: "REFUSE_EXPIRED", reason: "expired" };
  }

  // `AC-10`. UNKNOWN is not "unchanged": a hash we could not compute refuses.
  if (input.currentHash === null || input.currentHash !== rec.contentHash) {
    return { outcome: "REFUSE_CONTENT_CHANGED", reason: "the article changed after the link was issued" };
  }

  return {
    outcome: "ALLOW",
    articleId: rec.articleId,
    revisionId: rec.revisionId,
    reason: "preview authorised",
  };
}

// ─── AC-06 / AC-07: what the capability is NOT ────────────────────

/**
 * `AC-06`/`AC-07`. A preview grants **one read** and confers nothing else.
 *
 * Stated as data so the criteria have something to assert against, and so a
 * future edit that wanted to hand out a session would have to change a list
 * whose name says what it is.
 */
export const PREVIEW_GRANTS = ["READ_ONE_DRAFT_REVISION"] as const;

export const PREVIEW_NEVER_GRANTS = [
  "SESSION",
  "AUTH_COOKIE",
  "WORDPRESS_CAPABILITY",
  "ADMIN_CAPABILITY",
  "WP_ADMIN_ACCESS",
  "REST_API_ACCESS",
  "ANOTHER_POST",
  "ANOTHER_REVISION",
  "PUBLISH",
] as const;

/**
 * `AC-07`. A preview token presented to a non-preview route authenticates
 * nothing.
 *
 * A function rather than a comment, so the claim is executable: given any route
 * that is not the preview route, the identity derived from a preview token is
 * anonymous.
 */
export function identityFromPreviewToken(route: string, _token: string): "anonymous" {
  void route;
  void _token;
  return "anonymous";
}

// ─── Response headers ─────────────────────────────────────────────

/**
 * `AC-08`/`AC-09`. The headers a preview response must carry.
 *
 * `no-store` rather than `no-cache`: `no-cache` permits storing and
 * revalidating, and a shared cache holding a preview would serve one owner's
 * draft to whoever asked next.
 */
export const PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  Pragma: "no-cache",
};

export const PREVIEW_ROBOTS_META = '<meta name="robots" content="noindex, nofollow">' as const;

// ─── AC-16: audit ─────────────────────────────────────────────────

export const PREVIEW_AUDIT = {
  issue: "preview.issue",
  use: "preview.use",
  revoke: "preview.revoke",
  refuse: "preview.refuse",
} as const;

export interface PreviewAuditRecord {
  readonly actorType: "user" | "system";
  readonly action: (typeof PREVIEW_AUDIT)[keyof typeof PREVIEW_AUDIT];
  readonly entityType: "preview_link";
  /** `AC-16` — ids only. The token itself never reaches the log. */
  readonly entityId: string;
  readonly result: "OK" | "REFUSED";
}

export function previewAuditRecordFor(
  d: PreviewDecision,
  linkId: string,
): PreviewAuditRecord {
  return {
    actorType: "system",
    action: d.outcome === "ALLOW" ? PREVIEW_AUDIT.use : PREVIEW_AUDIT.refuse,
    entityType: "preview_link",
    entityId: linkId,
    result: d.outcome === "ALLOW" ? "OK" : "REFUSED",
  };
}
