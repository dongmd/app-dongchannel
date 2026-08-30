/**
 * P4-R08 — the Publisher's three gates.
 *
 * `G-50`: automated publish after approval, **without** weakening the
 * anti-autonomous-publish guarantee and **without** letting approval imply
 * verification.
 *
 * ## The publisher does not trust P3's word
 *
 * `P3-R05 AC-08` and `P3-R07 AC-12` both say so, and `AC-02` restates it: the
 * three gates are **re-checked here**, independently, against current state.
 * An intent is a request to publish, not a decision that publishing is still
 * valid — the approval may have been withdrawn and the article may have moved
 * since it was written.
 *
 * ## `AC-04`, the one this project has already broken
 *
 * **`dc_verified` is set from the VERIFICATION STATE, never from the approval.**
 * An owner-approved article whose claims are unsourced publishes *unverified* —
 * with the reader notice, out of schema, `noindex`. `P0-R01` was exactly this
 * failure: approval was read as verification and invented facts went out.
 *
 * The two live in different fields of the result here, computed from different
 * inputs, so there is no expression in which one could be assigned from the
 * other.
 *
 * ## Pure
 */

// ─── What the publisher is given ───────────────────────────────────

export interface PublishIntent {
  readonly id: string;
  readonly articleId: string;
  readonly revisionId: string;
  /** The hash of what the owner approved. */
  readonly contentHash: string;
  readonly state: string;
}

export interface ApprovalState {
  readonly approvalId: string | null;
  readonly articleId: string;
  readonly revisionId: string;
  /** `P3-R04`: a withdrawal is a SEPARATE row, so this is derived, not a column. */
  readonly withdrawn: boolean;
}

export interface ArticleState {
  readonly articleId: string;
  readonly revisionId: string;
  /** The hash of the article NOW. */
  readonly contentHash: string;
  readonly contentMode: string;
  /** WordPress's `post_modified` for the target post, if it exists. */
  readonly wpPostId: number | null;
  readonly wpModifiedGmt: string | null;
  /** What the publisher recorded when it last wrote. `null` = never published. */
  readonly lastPublishedHash: string | null;
  readonly lastPublishedModifiedGmt: string | null;
}

/** The QA verdict from `P4-R07`/`P4-R06`, passed in rather than recomputed. */
export interface QaGateInput {
  readonly passed: boolean;
  readonly reason: string | null;
}

/** `AC-04`. Where verification comes from — and it is not the approval. */
export interface VerificationState {
  /** Every claim meets the mode's evidence bar. Computed by P4-R06. */
  readonly allClaimsMeetBar: boolean;
  readonly unsourcedClaimCount: number;
}

// ─── Refusals ──────────────────────────────────────────────────────

export const PUBLISH_REFUSALS = [
  "INTENT_NOT_OPEN",
  "APPROVAL_MISSING",
  "APPROVAL_WITHDRAWN",
  "APPROVAL_FOR_ANOTHER_REVISION",
  "CONTENT_HASH_MOVED",
  "INTENT_REVISION_MISMATCH",
  "QA_GATE_FAILED",
  "HUMAN_EDIT_CONFLICT",
] as const;

export type PublishRefusal = (typeof PUBLISH_REFUSALS)[number];

export interface PublishPlan {
  readonly intentId: string;
  readonly articleId: string;
  readonly revisionId: string;
  readonly contentHash: string;
  /**
   * `AC-04`. Computed from the VERIFICATION state, never from the approval.
   *
   * A separate field from anything approval-derived, so no expression can
   * assign one from the other.
   */
  readonly dcVerified: boolean;
  /** What an unverified article must carry. Empty when verified. */
  readonly unverifiedNotice: string | null;
  readonly excludeFromSchema: boolean;
  readonly noindex: boolean;
  readonly wpPostId: number | null;
}

export type PublishDecision =
  | { readonly ok: true; readonly plan: PublishPlan }
  | { readonly ok: false; readonly reason: PublishRefusal; readonly detail: string | null };

// ─── The gates ─────────────────────────────────────────────────────

/**
 * `AC-01`…`AC-08`. Decide whether this intent may publish, and as what.
 *
 * Gate order is deliberate and each refusal is distinct, because `AC-10` asks
 * for each gate to be provably reachable **in isolation**. A single
 * `NOT_ELIGIBLE` would make that impossible to demonstrate and impossible to
 * debug.
 */
export function decidePublish(
  intent: PublishIntent,
  approval: ApprovalState | null,
  article: ArticleState,
  qa: QaGateInput,
  verification: VerificationState,
): PublishDecision {
  // AC-01. Only OPEN intents. There is no other queue and no other state that
  // means "ready".
  if (intent.state !== "OPEN") {
    return { ok: false, reason: "INTENT_NOT_OPEN", detail: intent.state };
  }

  // AC-03. The intent names a revision; the article must be that revision.
  // An intent for a revision the article has moved past has nothing to publish.
  if (intent.revisionId !== article.revisionId) {
    return { ok: false, reason: "INTENT_REVISION_MISMATCH", detail: article.revisionId };
  }

  // ---- Gate 1: a valid, unwithdrawn approval. Re-checked, not trusted.
  if (!approval || !approval.approvalId) {
    return { ok: false, reason: "APPROVAL_MISSING", detail: null };
  }
  if (approval.withdrawn) {
    return { ok: false, reason: "APPROVAL_WITHDRAWN", detail: approval.approvalId };
  }
  if (approval.revisionId !== intent.revisionId) {
    // An approval for a different revision is not an approval for this one.
    return { ok: false, reason: "APPROVAL_FOR_ANOTHER_REVISION", detail: approval.revisionId };
  }

  // ---- Gate 2: the content hash still matches what was approved.
  if (article.contentHash !== intent.contentHash) {
    return { ok: false, reason: "CONTENT_HASH_MOVED", detail: null };
  }

  // ---- AC-08: never overwrite a human's edits.
  //
  // Checked BEFORE QA on purpose. A human edit is a fact about the world that
  // no amount of QA changes, and reporting a QA failure for an article somebody
  // is actively editing would send the wrong person to fix the wrong thing.
  if (article.wpPostId !== null && article.lastPublishedModifiedGmt !== null) {
    if (article.wpModifiedGmt !== article.lastPublishedModifiedGmt) {
      return { ok: false, reason: "HUMAN_EDIT_CONFLICT", detail: article.wpModifiedGmt };
    }
  }

  // ---- Gate 3: mode-appropriate QA. P4-R07 decides; this reads the verdict.
  if (!qa.passed) {
    return { ok: false, reason: "QA_GATE_FAILED", detail: qa.reason };
  }

  // ---- AC-04. VERIFICATION, not approval.
  //
  // `approval` is in scope and is deliberately not consulted here. An article
  // the owner approved, whose claims nobody sourced, publishes UNVERIFIED.
  const verified = verification.allClaimsMeetBar && verification.unsourcedClaimCount === 0;

  return {
    ok: true,
    plan: {
      intentId: intent.id,
      articleId: intent.articleId,
      revisionId: intent.revisionId,
      contentHash: intent.contentHash,
      dcVerified: verified,
      unverifiedNotice: verified
        ? null
        : "Bài viết này chưa được xác minh đầy đủ. Một số thông tin chưa có nguồn kiểm chứng.",
      // An unverified article stays out of structured data and out of the
      // index: a schema block is a machine-readable assertion of correctness,
      // and indexing an unverified page invites it to be cited as one.
      excludeFromSchema: !verified,
      noindex: !verified,
      wpPostId: article.wpPostId,
    },
  };
}

/**
 * `AC-05`. What consuming the intent must set, together.
 *
 * The `publish_intent_resolution_consistent` CHECK in `P3`'s migration refuses
 * any other combination, so this exists to make the pair obvious at the call
 * site rather than to enforce it — the database already does that.
 */
export function consumeIntentPatch(now: Date) {
  return { state: "CONSUMED" as const, resolvedAt: now };
}

/**
 * `AC-07`. The publish signing key is NOT the preview key.
 *
 * One key doing two jobs means rotating it for one reason silently breaks the
 * other — and the two have different lifetimes: a preview key rotates when a
 * link leaks, a publish key when the integration account changes.
 */
export const PUBLISH_KEY_ENV = "DC_PUBLISH_SIGNING_KEY_V1";
export const PREVIEW_KEY_ENV = "PREVIEW_SIGNING_KEY_V1";

export function keysAreDistinct(publishKey: string | null, previewKey: string | null): boolean {
  if (!publishKey || !previewKey) return true; // absent is not shared
  return publishKey !== previewKey;
}
