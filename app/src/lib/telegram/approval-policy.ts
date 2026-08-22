/**
 * P3-R04 — approval records, separate from verification state.
 *
 * This is the project's central non-negotiable, expressed as a decision
 * function: **owner approval is a record of consent; fact verification is a
 * derived state describing what is known about the claims.** `P0-R01` is the
 * record of what happens when the two blur.
 *
 * ## Pure
 *
 * Imports nothing. `now` is a parameter, the hash is supplied, and the records
 * are injected. Every rule below is provable offline; the database enforces the
 * same rules independently in migration `0029`, and neither trusts the other.
 *
 * ## What this module refuses to do
 *
 * It has **no way to express** a change to the verification state. There is no
 * function here that returns one, no field that carries one, and no branch that
 * touches one. `AC-03`'s choke point is a database trigger; this is the other
 * half — making the write unsayable rather than merely unsaid.
 */

// ─── Approval ─────────────────────────────────────────────────────

export interface ApprovalRecord {
  readonly id: string;
  readonly articleId: string;
  /** AC-07. One revision. Never "the latest". */
  readonly revisionId: string;
  /** AC-10. From the verified update, never from the callback payload. */
  readonly approvedBy: number;
  readonly approvedAt: Date;
  /** AC-05/AC-06. Over everything the owner was shown. */
  readonly payloadHash: string;
  readonly callbackNonce: string;
  readonly expiresAt: Date;
  /** AC-08. A withdrawal is a new row pointing at what it withdraws. */
  readonly withdrawsId: string | null;
}

/**
 * The verification state, **read-only in this module**.
 *
 * Declared so `AC-04` can be asserted — an approval and an unverified article
 * coexisting — and for no other reason. Nothing here returns one.
 */
export interface VerificationState {
  readonly articleId: string;
  readonly evidenceLevel: "E0" | "E1" | "E2" | "E3" | "E4";
  readonly qaResult: string | null;
  readonly claimsChecked: number;
  readonly unsupportedClaims: number;
  readonly conflictingClaims: number;
  readonly lastVerifiedAt: Date | null;
}

// ─── Creating an approval ─────────────────────────────────────────

export const APPROVAL_REFUSALS = [
  "BAD_HASH",
  "BAD_ACTOR",
  "BAD_REVISION",
  "EXPIRY_NOT_AFTER_APPROVAL",
  "MISSING_NONCE",
] as const;
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number];

export type ApprovalVerdict =
  | { readonly ok: true; readonly record: Omit<ApprovalRecord, "id"> }
  | { readonly ok: false; readonly reason: ApprovalRefusal; readonly detail: string };

export interface ApprovalInput {
  readonly articleId: unknown;
  readonly revisionId: unknown;
  readonly approvedBy: unknown;
  readonly payloadHash: unknown;
  readonly callbackNonce: unknown;
  readonly ttlMs: number;
}

/** sha256 hex. The database enforces the same shape (`0029`). */
export const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isPayloadHash(v: unknown): v is string {
  return typeof v === "string" && PAYLOAD_HASH_PATTERN.test(v);
}

export function buildApproval(input: ApprovalInput, now: Date): ApprovalVerdict {
  if (!isPayloadHash(input.payloadHash)) {
    // Deliberately does not echo the value: a malformed hash is the one field
    // most likely to be something else entirely.
    return { ok: false, reason: "BAD_HASH", detail: "payload_hash must be sha256 hex" };
  }

  // AC-10. A string-shaped id must not become the owner by coercion.
  if (typeof input.approvedBy !== "number" || !Number.isSafeInteger(input.approvedBy) || input.approvedBy <= 0) {
    return { ok: false, reason: "BAD_ACTOR", detail: "approved_by must be a Telegram numeric id" };
  }

  if (typeof input.articleId !== "string" || input.articleId.trim() === "") {
    return { ok: false, reason: "BAD_REVISION", detail: "article_id is required" };
  }

  // AC-07. "latest" is not a revision — it is a promise to resolve one later,
  // which is exactly what an approval must not contain.
  if (
    typeof input.revisionId !== "string" ||
    input.revisionId.trim() === "" ||
    /^(latest|head|current)$/i.test(input.revisionId.trim())
  ) {
    return { ok: false, reason: "BAD_REVISION", detail: "revision_id must name one revision" };
  }

  if (typeof input.callbackNonce !== "string" || input.callbackNonce.trim() === "") {
    return { ok: false, reason: "MISSING_NONCE", detail: "callback_nonce is required" };
  }

  if (!(input.ttlMs > 0)) {
    return { ok: false, reason: "EXPIRY_NOT_AFTER_APPROVAL", detail: "ttl must be positive" };
  }

  return {
    ok: true,
    record: {
      articleId: input.articleId,
      revisionId: input.revisionId,
      approvedBy: input.approvedBy,
      approvedAt: now,
      payloadHash: input.payloadHash,
      callbackNonce: input.callbackNonce,
      expiresAt: new Date(now.getTime() + input.ttlMs),
      withdrawsId: null,
    },
  };
}

/**
 * AC-08. A withdrawal is a **new record**, never an edit.
 *
 * The same discipline `P0-R03` applies to `dc_verified`: withdrawing a claim
 * must never be harder than making one, and the original must survive so the
 * history says consent *was* given and then taken back — not that it never was.
 */
export function buildWithdrawal(
  original: ApprovalRecord,
  withdrawnBy: number,
  now: Date,
): ApprovalVerdict {
  if (!Number.isSafeInteger(withdrawnBy) || withdrawnBy <= 0) {
    return { ok: false, reason: "BAD_ACTOR", detail: "withdrawn_by must be a Telegram numeric id" };
  }
  return {
    ok: true,
    record: {
      articleId: original.articleId,
      revisionId: original.revisionId,
      approvedBy: withdrawnBy,
      approvedAt: now,
      payloadHash: original.payloadHash,
      callbackNonce: original.callbackNonce,
      // A withdrawal is not itself a consent window; it takes effect at once
      // and its expiry is only there to satisfy the same CHECK.
      expiresAt: new Date(now.getTime() + 1000),
      withdrawsId: original.id,
    },
  };
}

// ─── Does this approval authorise a publish? ──────────────────────

export const PUBLISH_AUTHORISATIONS = [
  "AUTHORISED",
  "NO_APPROVAL",
  "WITHDRAWN",
  "EXPIRED",
  "REVISION_MISMATCH",
  "CONTENT_CHANGED",
] as const;
export type PublishAuthorisation = (typeof PUBLISH_AUTHORISATIONS)[number];

export interface PublishCheck {
  readonly approval: ApprovalRecord | null;
  /** Whether a later row withdraws this approval. Resolved by the caller. */
  readonly isWithdrawn?: boolean;
  /** The revision the publisher intends to send. */
  readonly revisionId: string;
  /** The hash of that revision's content, recomputed NOW. */
  readonly currentHash: string;
}

export interface PublishVerdict {
  readonly authorisation: PublishAuthorisation;
  readonly reason: string;
}

/**
 * `AC-05`, `AC-07`, `AC-09` in one decision.
 *
 * Order is deliberate: existence → withdrawal → revision → **content** →
 * expiry. Content is checked before expiry so that an edited-then-expired
 * article reports the **edit**, which is the fact the owner needs: an expiry is
 * a schedule, a changed hash means the thing they consented to no longer
 * exists.
 */
export function authorisesPublish(check: PublishCheck, now: Date): PublishVerdict {
  const a = check.approval;

  if (a === null) {
    return { authorisation: "NO_APPROVAL", reason: "no approval for this article" };
  }

  if (a.withdrawsId !== null || check.isWithdrawn === true) {
    return { authorisation: "WITHDRAWN", reason: "the approval was withdrawn" };
  }

  // AC-07. The approval names one revision; publishing a different one is not
  // covered by it, however recent.
  if (a.revisionId !== check.revisionId) {
    return { authorisation: "REVISION_MISMATCH", reason: "the approval names a different revision" };
  }

  // AC-05. Editing after approval invalidates it.
  if (!isPayloadHash(check.currentHash) || a.payloadHash !== check.currentHash) {
    return { authorisation: "CONTENT_CHANGED", reason: "the content changed after approval" };
  }

  // AC-09. `>=`: the expiry instant is the first moment the approval no longer
  // authorises anything, as in P3-R03.
  if (!(a.expiresAt instanceof Date) || Number.isNaN(a.expiresAt.getTime())) {
    return { authorisation: "EXPIRED", reason: "the approval has no usable expiry" };
  }
  if (now.getTime() >= a.expiresAt.getTime()) {
    return { authorisation: "EXPIRED", reason: "the approval has expired" };
  }

  return { authorisation: "AUTHORISED", reason: "approved" };
}

// ─── AC-04: the two records may disagree, and that is the design ──

/**
 * Whether the article's claims are actually known to be checked.
 *
 * **Computed from the verification state alone.** No parameter of this function
 * is an approval, and that is the point: there is no way to pass consent into
 * the question of whether facts were checked.
 */
export function isFactVerified(v: VerificationState | null): boolean {
  if (v === null) return false;
  if (v.qaResult !== "pass") return false;
  if (v.unsupportedClaims > 0 || v.conflictingClaims > 0) return false;
  if (v.claimsChecked <= 0) return false;
  if (v.lastVerifiedAt === null) return false;
  return v.evidenceLevel === "E3" || v.evidenceLevel === "E4";
}

/**
 * The state of an article as two independent facts.
 *
 * `AC-04`: an approved article whose claims are unsourced is **approved and
 * unverified**, and both records exist and disagree. The disagreement is not a
 * bug to reconcile — it is the thing the separation exists to make visible.
 */
export interface ArticleState {
  readonly approved: boolean;
  readonly factVerified: boolean;
}

export function articleState(
  approval: ApprovalRecord | null,
  verification: VerificationState | null,
): ArticleState {
  return {
    approved: approval !== null && approval.withdrawsId === null,
    factVerified: isFactVerified(verification),
  };
}

// ─── The Telegram-action marker (AC-03) ───────────────────────────

/**
 * The session flag migration `0029` keys its guard on.
 *
 * Every Telegram-originated transaction sets it, and the database then refuses
 * any write to `article_verification` for the life of that transaction. A call
 * site that forgets to route through the approval module cannot accidentally
 * gain permission — it is the module the Telegram path must use that sets the
 * flag, so the only way to be exempt is to not be a Telegram action.
 */
export const TELEGRAM_ACTION_FLAG = "dc.in_telegram_action";
export const TELEGRAM_ACTION_ON = "on";

/** SQL a Telegram-originated transaction runs before anything else. */
export function markTelegramActionSql(): string {
  return `SELECT set_config('${TELEGRAM_ACTION_FLAG}', '${TELEGRAM_ACTION_ON}', true)`;
}
