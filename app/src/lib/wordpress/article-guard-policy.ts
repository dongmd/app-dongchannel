/**
 * P1-R06 — the decision half of the §1B guard, kept pure on purpose.
 *
 * This module imports nothing: no `server-only`, no database, no fetch. R05
 * taught the lesson (TD-21) — a decision buried inside a module that needs a
 * live `DATABASE_URL` can only be exercised against production, and the one
 * decision here is the one that protects the owner's writing.
 *
 * PROPOSED §7A: *there is no silent overwrite path for WordPress prose. None.*
 * This file is where that sentence is enforced.
 *
 * **Refusal is the default.** Permission is the exception, and it has to be
 * earned by passing every enumerated check. Owner instruction 2026-08-19:
 * conflict, unknown, missing baseline, version mismatch and unexpected state
 * all fail closed.
 */

/** The contract version this build knows how to compare. */
export const HASH_CONTRACT_VERSION = "v1";

/**
 * The only sync states from which a write may be permitted.
 *
 * An allowlist rather than a `switch` with a permissive default (AC-11): a
 * state added later refuses until someone puts it here deliberately. Getting
 * this backwards is how a new state silently becomes a write path.
 */
export const PERMITTING_STATES: ReadonlySet<string> = new Set(["BASELINE_SET"]);

export type ArticleGuardRefusal =
  | "NO_BASELINE" //          nothing recorded; absence is not agreement
  | "EXISTING_CONFLICT" //    already diverged and not resolved
  | "CONTENT_CHANGED" //      the human edited the prose
  | "MODIFIED_CHANGED" //     WordPress moved post_modified
  | "STATUS_CHANGED" //       published/draft changed under us
  | "UNKNOWN_HASH" //         either side cannot state a hash
  | "UNKNOWN_TIMESTAMP" //    either side cannot state a timestamp
  | "CONTRACT_MISMATCH" //    the two hashes are not comparable
  | "UPSTREAM_UNAVAILABLE" // WordPress could not be read
  | "NOT_FOUND" //            the post is gone
  | "UNEXPECTED_STATE"; //    the catch-all, and it refuses

export interface ArticleBaseline {
  state: string;
  wpContentHash: string | null;
  wpPostModifiedGmt: string | null;
  wpPostStatus: string | null;
  hashContractVersion: string | null;
}

export interface ArticleObservation {
  wpContentHash: string | null;
  postModifiedGmt: string | null;
  postStatus: string | null;
}

export type GuardDecision =
  | {
      decision: "ALLOW";
      wpContentHash: string;
      postModifiedGmt: string;
      postStatus: string;
    }
  | {
      decision: "REFUSE";
      reason: ArticleGuardRefusal;
      detail: string;
    };

function refuse(reason: ArticleGuardRefusal, detail: string): GuardDecision {
  return { decision: "REFUSE", reason, detail };
}

/** The version prefix of an opaque hash, or null if it does not carry one. */
export function hashContractVersionOf(hash: string | null | undefined): string | null {
  if (typeof hash !== "string") return null;
  const i = hash.indexOf(":");
  if (i <= 0) return null;
  const prefix = hash.slice(0, i);
  // A prefix with nothing after it is not a hash, it is a label.
  return hash.length > i + 1 ? prefix : null;
}

function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Decide whether an agent-driven update to this article may proceed.
 *
 * PROPOSED §7A steps 1–3. Both the hash **and** `post_modified_gmt` must be
 * unchanged, deliberately: `post_modified` alone moves for reasons that are not
 * content, and a hash alone misses an edit reverted and re-applied. Requiring
 * both costs one extra owner interaction when it is wrong; being wrong the
 * other way costs the owner's writing.
 */
export function decideArticleSync(
  baseline: ArticleBaseline | null | undefined,
  observed: ArticleObservation,
): GuardDecision {
  // ---- Missing baseline (AC-08). A first-ever sync must establish a baseline
  // explicitly. Writing on the assumption that "nothing recorded" means
  // "nothing changed" is the exact failure G-58 describes.
  if (!baseline) {
    return refuse("NO_BASELINE", "no sync-state row for this article");
  }

  // ---- State allowlist (AC-11, AC-14), before any comparison. A recorded
  // conflict does not expire; it is cleared by resolving it, never by waiting.
  if (baseline.state === "CONFLICT") {
    return refuse("EXISTING_CONFLICT", "an unresolved conflict is recorded for this article");
  }

  if (!PERMITTING_STATES.has(baseline.state)) {
    return refuse("UNEXPECTED_STATE", `sync state ${JSON.stringify(baseline.state)} does not permit writes`);
  }

  // ---- Unknown is not unchanged (AC-09). Both sides must be able to state
  // both values; a null timestamp is WordPress saying it cannot date the post.
  if (!present(observed.wpContentHash)) {
    return refuse("UNKNOWN_HASH", "WordPress returned no content hash");
  }

  if (!present(baseline.wpContentHash)) {
    return refuse("UNKNOWN_HASH", "the baseline carries no content hash");
  }

  if (!present(observed.postModifiedGmt)) {
    return refuse("UNKNOWN_TIMESTAMP", "WordPress returned a null post_modified_gmt");
  }

  if (!present(baseline.wpPostModifiedGmt)) {
    return refuse("UNKNOWN_TIMESTAMP", "the baseline carries no post_modified_gmt");
  }

  // ---- Comparable at all? (AC-10) Two hashes from different contract versions
  // are different strings for reasons that have nothing to do with the content,
  // so comparing them would report a conflict that is not one -- or, if the
  // format ever collides, agreement that is not one either.
  const observedVersion = hashContractVersionOf(observed.wpContentHash);
  const baselineVersion = hashContractVersionOf(baseline.wpContentHash);

  if (observedVersion !== HASH_CONTRACT_VERSION) {
    return refuse(
      "CONTRACT_MISMATCH",
      `WordPress hash carries version ${JSON.stringify(observedVersion)}, expected ${HASH_CONTRACT_VERSION}`,
    );
  }

  if (baselineVersion !== HASH_CONTRACT_VERSION) {
    return refuse(
      "CONTRACT_MISMATCH",
      `baseline hash carries version ${JSON.stringify(baselineVersion)}, expected ${HASH_CONTRACT_VERSION}`,
    );
  }

  if (present(baseline.hashContractVersion) && baseline.hashContractVersion !== observedVersion) {
    return refuse(
      "CONTRACT_MISMATCH",
      `baseline was taken under ${baseline.hashContractVersion}, WordPress now returns ${observedVersion}`,
    );
  }

  // ---- Status. A post that moved between draft and published is not the post
  // the baseline described, whatever its hash says.
  if (present(baseline.wpPostStatus)) {
    if (!present(observed.postStatus)) {
      return refuse("UNEXPECTED_STATE", "WordPress returned no post status");
    }

    if (observed.postStatus !== baseline.wpPostStatus) {
      return refuse(
        "STATUS_CHANGED",
        `post status moved ${baseline.wpPostStatus} -> ${observed.postStatus}`,
      );
    }
  }

  // ---- The two checks that matter, both required (AC-06).
  if (observed.wpContentHash !== baseline.wpContentHash) {
    return refuse("CONTENT_CHANGED", "content hash differs from the baseline: a human edited this");
  }

  if (observed.postModifiedGmt !== baseline.wpPostModifiedGmt) {
    return refuse(
      "MODIFIED_CHANGED",
      `post_modified_gmt moved ${baseline.wpPostModifiedGmt} -> ${observed.postModifiedGmt}`,
    );
  }

  // Everything enumerated above passed, and the state is on the allowlist.
  // This is the only expression in the module that produces ALLOW.
  return {
    decision: "ALLOW",
    wpContentHash: observed.wpContentHash,
    postModifiedGmt: observed.postModifiedGmt,
    postStatus: observed.postStatus ?? "",
  };
}

/** Refusals that describe a divergence worth recording as conflict context. */
const DIVERGENCE_REASONS: ReadonlySet<ArticleGuardRefusal> = new Set<ArticleGuardRefusal>([
  "CONTENT_CHANGED",
  "MODIFIED_CHANGED",
  "STATUS_CHANGED",
]);

export function isDivergence(reason: ArticleGuardRefusal): boolean {
  return DIVERGENCE_REASONS.has(reason);
}
