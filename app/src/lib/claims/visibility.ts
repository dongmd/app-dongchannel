// P1-R04 — visibility enforcement (G-59).
//
// The database refuses to store a PUBLIC claim whose source_access is not
// PUBLIC_WEB unless a named owner overrode it. This module is the second half:
// the rule that decides what may leave the system, applied at the boundary
// rather than in the UI.
//
// Hiding a field in a template is not access control. Anything that reaches
// WordPress, a public API response or a log must pass through here first.

export type ClaimVisibility = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL";
export type ClaimSourceAccess = "PUBLIC_WEB" | "AUTHENTICATED" | "FIRST_PARTY";

export interface ClassifiedClaim {
  id: string;
  claimKey: string;
  claimText: string;
  normalizedValue?: unknown;
  visibility: ClaimVisibility;
  sourceAccess: ClaimSourceAccess;
  visibilityOverrideBy?: string | null;
  verificationStatus?: string;
  expiresAt?: Date | null;
  /** Provenance. A claim with neither is not publishable, whatever its visibility. */
  sourceId?: string | null;
  evidenceCount?: number;
}

export type PublishRefusal =
  | "NOT_PUBLIC"
  | "RESTRICTED_SOURCE_WITHOUT_OVERRIDE"
  | "EXPIRED"
  | "NO_PROVENANCE";

export interface PublishDecision {
  allowed: boolean;
  reason?: PublishRefusal;
}

/**
 * May this claim be sent to WordPress or any other public surface?
 *
 * Fails closed: every condition must be satisfied, and an unrecognised state
 * refuses rather than falls through.
 */
export function canPublish(claim: ClassifiedClaim, now: Date = new Date()): PublishDecision {
  if (claim.visibility !== "PUBLIC") {
    return { allowed: false, reason: "NOT_PUBLIC" };
  }

  // Belt and braces with the database check. A row could reach here from a
  // fixture, a cache or a future code path that bypassed the insert.
  if (claim.sourceAccess !== "PUBLIC_WEB" && !claim.visibilityOverrideBy) {
    return { allowed: false, reason: "RESTRICTED_SOURCE_WITHOUT_OVERRIDE" };
  }

  // "Usable in content *while current*" -- an expired public rate is not a
  // public rate, it is a stale one.
  if (claim.expiresAt && claim.expiresAt <= now) {
    return { allowed: false, reason: "EXPIRED" };
  }

  // Every published claim must be traceable to where it came from.
  if (!claim.sourceId && !claim.evidenceCount) {
    return { allowed: false, reason: "NO_PROVENANCE" };
  }

  return { allowed: true };
}

/** The only supported way to build a WordPress-bound payload from claims. */
export function selectPublishable<T extends ClassifiedClaim>(claims: T[], now?: Date): T[] {
  return claims.filter((c) => canPublish(c, now).allowed);
}

/**
 * Throw rather than return. For code paths where silently dropping a claim
 * would be worse than failing -- a publisher that quietly omits a price is
 * harder to notice than one that stops.
 */
export function assertPublishable(claim: ClassifiedClaim, now?: Date): void {
  const decision = canPublish(claim, now);
  if (!decision.allowed) {
    throw new Error(`claim ${claim.id} is not publishable: ${decision.reason}`);
  }
}

/**
 * Strip a claim down to what a public consumer may see.
 *
 * Deliberately builds a new object field by field. Spreading and deleting
 * leaks whatever gets added to the row later -- the failure mode where a new
 * column silently becomes public because nobody updated the redaction list.
 */
export interface PublicClaim {
  claimKey: string;
  claimText: string;
  normalizedValue?: unknown;
  verificationStatus?: string;
}

export function toPublicClaim(claim: ClassifiedClaim, now?: Date): PublicClaim {
  assertPublishable(claim, now);
  return {
    claimKey: claim.claimKey,
    claimText: claim.claimText,
    normalizedValue: claim.normalizedValue,
    verificationStatus: claim.verificationStatus,
  };
}

// ─── Source ingest guard ──────────────────────────────────────────

export interface IngestableSource {
  id: string;
  key: string;
  isEnabled: boolean;
  requiresAuth: boolean;
  configRef?: string | null;
}

export type IngestRefusal = "SOURCE_DISABLED" | "AUTH_REQUIRED_WITHOUT_CONFIG";

/**
 * A connector existing is not permission to run it.
 *
 * `is_enabled` defaults to false precisely so that registering a source does
 * not start ingesting from it, and this is where that default is honoured.
 */
export function canIngest(source: IngestableSource): {
  allowed: boolean;
  reason?: IngestRefusal;
} {
  if (!source.isEnabled) {
    return { allowed: false, reason: "SOURCE_DISABLED" };
  }
  if (source.requiresAuth && !source.configRef) {
    return { allowed: false, reason: "AUTH_REQUIRED_WITHOUT_CONFIG" };
  }
  return { allowed: true };
}

// ─── Raw payload guard ────────────────────────────────────────────

/**
 * Raw source payloads are provenance, not display data. They come straight
 * from a provider and may carry account identifiers, internal rates or
 * anything else the provider happened to include.
 *
 * There is no "redact the raw payload" path on purpose: the safe operation is
 * not exposing it. This exists so a call site that wants to show something has
 * to say so explicitly and get a summary instead.
 */
export function describeRawPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return "none";
  if (Array.isArray(payload)) return `array(${payload.length})`;
  if (typeof payload === "object") {
    return `object(${Object.keys(payload as Record<string, unknown>).length} keys)`;
  }
  return typeof payload;
}
