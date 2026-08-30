/**
 * P4-R07 — the QA / evidence gate, keyed on content mode.
 *
 * `G-57`: *"a single QA bar applied to both a news item and a pricing review is
 * either too strict to ship news or too loose to protect commercial claims."*
 *
 * `P2-R05` already built the mode policy — TTL, QA depth, minimum evidence
 * level, SLA — and the evidence floor that configuration cannot lower. This
 * requirement adds the half that **enforces**: given a draft and its mode, may
 * it proceed?
 *
 * ## One policy, two readers
 *
 * `AC-06`. `P4-R06` (the QA agent) and `P4-R08`'s third publish gate both call
 * `evaluateQaPolicy`. Not two copies of the rule — two callers of one function.
 * Two copies is how a draft passes QA and is then refused at publish for a
 * reason QA never mentioned, or worse, the reverse.
 *
 * ## This module decides. It does not fetch, and it is not an agent.
 *
 * It imports only `content-mode-policy`, which is itself pure. No database, no
 * clock, no environment. The configuration arrives as a parameter. That is what
 * lets `AC-05`'s canonical test exist at all: the *same draft object* evaluated
 * twice, under two modes, with the outcomes compared.
 *
 * It is also explicitly **not a QA agent**. It renders no judgement about
 * whether a claim is *true* — that is `P4-R06`'s work and, ultimately, the
 * evidence's. It answers one question: does what we have meet the bar this mode
 * requires?
 */

import {
  CONTENT_MODES,
  EVIDENCE_FLOOR,
  MODE_POLICY_VERSION,
  type ContentMode,
  type EvidenceLevel,
  type ModePolicy,
  type ModePolicyOverrides,
  type QaDepth,
  evidenceRank,
  isContentMode,
  resolveModePolicy,
} from "./content-mode-policy";

// ─── AC-03: an unconfigured mode gets the STRICT end ───────────────

/**
 * The policy applied when the mode itself is not recognised.
 *
 * Computed from the defaults rather than written down, so it cannot drift below
 * the strictest configured mode when someone tightens one. `AC-03` says a mode
 * nobody configured must not become the permissive case, and the way to
 * guarantee that is to derive the fallback from the maximum rather than to
 * choose a number and hope it stays the maximum.
 */
export const STRICTEST_POLICY: ModePolicy = (() => {
  const all = CONTENT_MODES.map((m) => resolveModePolicy(m));
  const strictestEvidence = all.reduce<EvidenceLevel>(
    (acc, p) => (evidenceRank(p.minEvidenceLevel) > evidenceRank(acc) ? p.minEvidenceLevel : acc),
    EVIDENCE_FLOOR,
  );
  const depthRank: Readonly<Record<QaDepth, number>> = { EXPEDITED: 0, STANDARD: 1, FULL: 2 };
  const strictestDepth = all.reduce<QaDepth>(
    (acc, p) => (depthRank[p.qaDepth] > depthRank[acc] ? p.qaDepth : acc),
    "EXPEDITED",
  );
  return {
    minEvidenceLevel: strictestEvidence,
    qaDepth: strictestDepth,
    // The shortest TTL and SLA are the strict end of those axes: sooner review,
    // less time before the SLA bites.
    ttlDays: Math.min(...all.map((p) => p.ttlDays)),
    slaHours: Math.min(...all.map((p) => p.slaHours)),
  };
})();

const DEPTH_RANK: Readonly<Record<QaDepth, number>> = {
  EXPEDITED: 0,
  STANDARD: 1,
  FULL: 2,
};

/** Did the QA actually performed reach the depth this mode requires? */
export function depthSatisfies(completed: QaDepth, required: QaDepth): boolean {
  return DEPTH_RANK[completed] >= DEPTH_RANK[required];
}

// ─── What is being judged ──────────────────────────────────────────

export interface DraftClaim {
  readonly key: string;
  /**
   * `null` means the claim's evidence level is **not known**.
   *
   * Not "none", not `E0`. A claim nobody has assessed and a claim assessed as
   * unsupported are different situations, and only one of them is a research
   * gap. Both fail — but they fail with different reasons, because the fix
   * differs.
   */
  readonly evidenceLevel: EvidenceLevel | null;
}

export interface DraftUnderReview {
  readonly articleId: string;
  readonly mode: string;
  readonly claims: readonly DraftClaim[];
  /** The depth of QA actually completed. `null` = QA has not run. */
  readonly qaDepthCompleted: QaDepth | null;
}

// ─── The verdict ───────────────────────────────────────────────────

/**
 * Closed set. A refusal that could carry an ad-hoc string is a refusal no query
 * will ever aggregate and no Telegram message can reliably explain.
 */
export const QA_FAILURES = [
  "UNKNOWN_CONTENT_MODE",
  "QA_NOT_RUN",
  "QA_DEPTH_INSUFFICIENT",
  "CLAIM_EVIDENCE_UNKNOWN",
  "CLAIM_EVIDENCE_BELOW_POLICY",
] as const;

export type QaFailure = (typeof QA_FAILURES)[number];

export interface QaPass {
  readonly ok: true;
  readonly mode: ContentMode;
  readonly policyVersion: string;
  readonly requiredEvidence: EvidenceLevel;
  readonly requiredDepth: QaDepth;
  readonly claimsAssessed: number;
}

export interface QaBlock {
  readonly ok: false;
  /** `null` when the mode itself was not recognised. */
  readonly mode: ContentMode | null;
  readonly policyVersion: string;
  readonly reason: QaFailure;
  readonly requiredEvidence: EvidenceLevel;
  readonly requiredDepth: QaDepth;
  /** The specific claims at fault. Empty for whole-draft failures. */
  readonly offendingClaims: readonly DraftClaim[];
}

export type QaVerdict = QaPass | QaBlock;

// ─── The gate ──────────────────────────────────────────────────────

/**
 * `AC-04` — a failing draft is **blocked**, and the block is a value the caller
 * cannot ignore.
 *
 * There is no "warn" outcome and no severity. A verdict is `ok` or it is not,
 * because the failure mode the criterion names is an article being *silently
 * downgraded* — shipped with a note somewhere that nobody reads. A boolean with
 * a reason cannot be downgraded; a score can.
 *
 * `now` is not a parameter because nothing here is time-dependent: TTL and SLA
 * are `P2-R05`'s axes and are evaluated elsewhere. Adding an unused clock would
 * invite someone to use it.
 */
export function evaluateQaPolicy(
  draft: DraftUnderReview,
  overrides?: ModePolicyOverrides,
  policyVersion: string = MODE_POLICY_VERSION,
): QaVerdict {
  // AC-03. An unrecognised mode is judged at the STRICT end, not waved through.
  if (!isContentMode(draft.mode)) {
    return {
      ok: false,
      mode: null,
      policyVersion,
      reason: "UNKNOWN_CONTENT_MODE",
      requiredEvidence: STRICTEST_POLICY.minEvidenceLevel,
      requiredDepth: STRICTEST_POLICY.qaDepth,
      offendingClaims: [],
    };
  }

  const mode: ContentMode = draft.mode;
  const policy = resolveModePolicy(mode, overrides);
  const base = {
    mode,
    policyVersion,
    requiredEvidence: policy.minEvidenceLevel,
    requiredDepth: policy.qaDepth,
  } as const;

  if (draft.qaDepthCompleted === null) {
    return { ok: false, ...base, reason: "QA_NOT_RUN", offendingClaims: [] };
  }

  if (!depthSatisfies(draft.qaDepthCompleted, policy.qaDepth)) {
    return { ok: false, ...base, reason: "QA_DEPTH_INSUFFICIENT", offendingClaims: [] };
  }

  // UNKNOWN before BELOW_POLICY, deliberately. A claim nobody assessed is a
  // process gap; a claim assessed and found thin is a research gap. Reporting
  // the second when the first is true sends someone to find better sources for
  // a claim that was never checked at all.
  const unknown = draft.claims.filter((c) => c.evidenceLevel === null);
  if (unknown.length > 0) {
    return { ok: false, ...base, reason: "CLAIM_EVIDENCE_UNKNOWN", offendingClaims: unknown };
  }

  const below = draft.claims.filter(
    (c) => evidenceRank(c.evidenceLevel!) < evidenceRank(policy.minEvidenceLevel),
  );
  if (below.length > 0) {
    return { ok: false, ...base, reason: "CLAIM_EVIDENCE_BELOW_POLICY", offendingClaims: below };
  }

  return { ok: true, ...base, claimsAssessed: draft.claims.length };
}

// ─── AC-04: the reason has to be legible to the owner ──────────────

/**
 * One line the owner can act on, for the Telegram refusal.
 *
 * `AC-05` requires the reason to name **the mode and the shortfall**, so both
 * appear in every message. A refusal reading "QA failed" would satisfy "blocks
 * the publish" and fail the half of the criterion that matters — the owner
 * would have to open a log to learn anything.
 *
 * Claim keys are included; claim TEXT is not. A key identifies which claim
 * without pushing draft content through the Telegram transport.
 */
export function explainQaVerdict(v: QaVerdict): string {
  if (v.ok) {
    return (
      `QA đạt · chế độ ${v.mode} · yêu cầu ${v.requiredEvidence}/${v.requiredDepth} · ` +
      `${v.claimsAssessed} claim đã đánh giá`
    );
  }

  const mode = v.mode ?? "KHÔNG RÕ";
  const keys = v.offendingClaims.map((c) => c.key).slice(0, 5).join(", ");
  const more = v.offendingClaims.length > 5 ? ` (+${v.offendingClaims.length - 5} nữa)` : "";

  switch (v.reason) {
    case "UNKNOWN_CONTENT_MODE":
      return (
        `QA chặn · chế độ không hợp lệ · áp mức nghiêm nhất ` +
        `${v.requiredEvidence}/${v.requiredDepth}`
      );
    case "QA_NOT_RUN":
      return `QA chặn · chế độ ${mode} · QA chưa chạy · cần độ sâu ${v.requiredDepth}`;
    case "QA_DEPTH_INSUFFICIENT":
      return `QA chặn · chế độ ${mode} · độ sâu QA chưa đạt · cần ${v.requiredDepth}`;
    case "CLAIM_EVIDENCE_UNKNOWN":
      return (
        `QA chặn · chế độ ${mode} · ${v.offendingClaims.length} claim CHƯA được đánh giá ` +
        `bằng chứng: ${keys}${more}`
      );
    case "CLAIM_EVIDENCE_BELOW_POLICY":
      return (
        `QA chặn · chế độ ${mode} · ${v.offendingClaims.length} claim dưới mức ` +
        `${v.requiredEvidence}: ${keys}${more}`
      );
  }
}

/**
 * `AC-06`'s second reader. `P4-R08`'s third gate asks exactly one thing, and
 * asks it of the same function, so a publish cannot be allowed by a rule QA
 * never applied.
 */
export function publishGatePasses(verdict: QaVerdict): boolean {
  return verdict.ok;
}
