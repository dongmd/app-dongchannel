import { isOpportunityOriginType, type OpportunityOriginType } from "./opportunity-policy";
import type { ClaimSourceAccess, ClaimVisibility } from "../claims/visibility";

/**
 * P2-R07 — discovery in both directions.
 *
 * Imports one pure policy module, and nothing else. No database, no network,
 * no clock.
 *
 * ## Both directions, or it is not bidirectional
 *
 *   A.  content / trend / tool / SEO / evidence research
 *         → notices a vendor runs an affiliate programme
 *         → emits an AffiliateProject **CANDIDATE**
 *
 *   B.  an affiliate programme / offer
 *         → routes to a ContentOpportunity **CANDIDATE**, when there is a
 *           legitimate content opportunity in it
 *
 * Implementing one and calling the requirement done would leave the "money
 * engine feeds the editorial engine" half of the model unbuilt, which is the
 * half that turns an affiliate project into articles worth reading.
 *
 * ## What a candidate is NOT
 *
 *   AffiliateProject CANDIDATE  ≠  AffiliateProject
 *   ContentOpportunity          ≠  a WordPress post
 *
 * Nothing here creates a live project, applies to a network, touches Google
 * Ads, edits or publishes WordPress, or stands in for owner approval. A
 * candidate is a **proposal awaiting triage**, and the vocabulary below cannot
 * express anything else.
 *
 * ## And the rule this surface exists to protect
 *
 * This is the single most likely place for invented affiliate terms to enter
 * the system: a research agent that "knows" a programme pays 30% and drops it
 * in a field. Every commercial fact here is therefore tri-state or nullable
 * with an explicit verification state, and **UNKNOWN is the default**. P0-R01
 * happened because an unchecked claim was written down as a fact.
 */

// ─── Tri-state facts ──────────────────────────────────────────────

/**
 * `UNKNOWN` is not `NO`.
 *
 * "We have not checked whether this programme allows PPC" and "this programme
 * forbids PPC" lead to different decisions, and collapsing them means either
 * inventing a prohibition or inventing a permission. Both are fabrication.
 */
export const TRISTATE = ["YES", "NO", "UNKNOWN"] as const;
export type Tristate = (typeof TRISTATE)[number];

/** Every commercial fact a candidate may carry, and none may be inferred. */
export const VERIFIABLE_FACTS = [
  "programme_exists",
  "network",
  "payout",
  "epc",
  "geo",
  "cookie_duration",
  "ppc_allowed",
  "brand_bidding_allowed",
  "deep_link_support",
  "product_availability",
] as const;
export type VerifiableFact = (typeof VERIFIABLE_FACTS)[number];

export interface FactValue<T> {
  readonly value: T | null;
  readonly state: Tristate;
  /** Where it was seen. Required whenever the state is not UNKNOWN. */
  readonly observedUrl?: string | null;
  readonly observedAt?: Date | null;
  /**
   * AC-06 — P1-R04's two axes travel with the fact.
   *
   * Where it came from decides how sensitive it inherently is; where it may be
   * shown is a decision made about it. A payout figure read off a public
   * affiliate page and the same figure read off a logged-in dashboard are not
   * the same fact, and only `sourceAccess` records the difference.
   */
  readonly sourceAccess?: ClaimSourceAccess;
  readonly visibility?: ClaimVisibility;
}

/**
 * AC-06 — the P1-R04 default, applied here rather than restated.
 *
 * `AUTHENTICATED` and `FIRST_PARTY` default to `CONFIDENTIAL`, and **no agent
 * may promote them** — promotion needs a named human, which is the rule
 * `claims.visibility_override_by` enforces in the database. A dashboard-only
 * commission rate published because nobody classified it is the failure P1-R04
 * exists to prevent.
 */
export function defaultVisibilityFor(access: ClaimSourceAccess): ClaimVisibility {
  return access === "PUBLIC_WEB" ? "PUBLIC" : "CONFIDENTIAL";
}

export type VisibilityVerdict =
  | { readonly ok: true; readonly visibility: ClaimVisibility }
  | { readonly ok: false; readonly reason: "AGENT_MAY_NOT_PROMOTE" | "NO_SOURCE_ACCESS" };

/**
 * What visibility a fact may hold, given who is asking.
 *
 * An agent may only ever *lower* visibility, never raise it. That asymmetry is
 * the whole guarantee: forgetting to classify something leaves it confidential,
 * and no automated path can talk it into being public.
 */
export function resolveVisibility(
  fact: FactValue<unknown>,
  actor: "AGENT" | "OWNER",
): VisibilityVerdict {
  if (fact.state === "UNKNOWN") return { ok: true, visibility: "CONFIDENTIAL" };
  if (!fact.sourceAccess) return { ok: false, reason: "NO_SOURCE_ACCESS" };

  const floor = defaultVisibilityFor(fact.sourceAccess);
  const asked = fact.visibility ?? floor;

  const rank: Record<ClaimVisibility, number> = { CONFIDENTIAL: 0, INTERNAL: 1, PUBLIC: 2 };
  if (actor === "AGENT" && rank[asked] > rank[floor]) {
    return { ok: false, reason: "AGENT_MAY_NOT_PROMOTE" };
  }
  return { ok: true, visibility: asked };
}

export function unknownFact<T>(): FactValue<T> {
  return { value: null, state: "UNKNOWN" };
}

export type FactVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly fact: VerifiableFact;
      readonly reason: "CLAIMED_WITHOUT_SOURCE" | "VALUE_WITHOUT_STATE" | "UNKNOWN_WITH_VALUE";
    };

/**
 * A fact may be UNKNOWN with no value, or known with a value **and a source**.
 * Nothing else is a legal state.
 *
 * The third refusal is the subtle one: a value carried alongside `UNKNOWN` is
 * how a guess survives. Somebody writes the number they expect, marks it
 * unverified, and three screens later the number is displayed because the
 * state was not checked.
 */
export function checkFact<T>(fact: VerifiableFact, f: FactValue<T>): FactVerdict {
  if (!(TRISTATE as readonly string[]).includes(f.state)) {
    return { ok: false, fact, reason: "VALUE_WITHOUT_STATE" };
  }
  if (f.state === "UNKNOWN") {
    if (f.value !== null && f.value !== undefined) {
      return { ok: false, fact, reason: "UNKNOWN_WITH_VALUE" };
    }
    return { ok: true };
  }
  if (!f.observedUrl?.trim() || !f.observedAt || Number.isNaN(f.observedAt.getTime())) {
    return { ok: false, fact, reason: "CLAIMED_WITHOUT_SOURCE" };
  }
  return { ok: true };
}

// ─── Direction A: research → affiliate project candidate ──────────

export const CANDIDATE_STATUSES = ["PROPOSED", "TRIAGED", "ACCEPTED", "REJECTED"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export interface AffiliateCandidateDraft {
  readonly vendorKey: string;
  readonly vendorName: string;
  readonly programmeExists: FactValue<boolean>;
  readonly facts: Partial<Record<VerifiableFact, FactValue<unknown>>>;
  /** AC: a candidate must trace back to the signals that produced it. */
  readonly supportingSignalIds: readonly string[];
}

export type CandidateVerdict =
  | { readonly ok: true; readonly candidateKey: string; readonly status: "PROPOSED" }
  | {
      readonly ok: false;
      readonly reason:
        | "NO_VENDOR"
        | "NO_SUPPORTING_EVIDENCE"
        | "FACT_INVALID"
        | "PROGRAMME_NOT_OBSERVED";
      readonly detail?: string;
    };

/**
 * Direction A. Research noticed something; this decides whether it is a
 * candidate, and refuses if the noticing cannot be evidenced.
 *
 * `programmeExists` must be an actual observation. A candidate whose central
 * claim — *that there is a programme at all* — is UNKNOWN is not a discovery,
 * it is a hunch, and the queue would fill with vendors nobody checked.
 */
export function proposeAffiliateCandidate(draft: AffiliateCandidateDraft): CandidateVerdict {
  if (!draft.vendorKey.trim() || !draft.vendorName.trim()) {
    return { ok: false, reason: "NO_VENDOR" };
  }
  if (draft.supportingSignalIds.length === 0) {
    // A candidate with no signal behind it cannot be traced back to anything.
    return { ok: false, reason: "NO_SUPPORTING_EVIDENCE" };
  }

  const existence = checkFact("programme_exists", draft.programmeExists);
  if (!existence.ok) return { ok: false, reason: "FACT_INVALID", detail: "programme_exists" };
  if (draft.programmeExists.state !== "YES") {
    return { ok: false, reason: "PROGRAMME_NOT_OBSERVED" };
  }

  for (const fact of VERIFIABLE_FACTS) {
    const value = draft.facts[fact];
    if (value === undefined) continue; // absent is UNKNOWN, which is fine
    const v = checkFact(fact, value);
    if (!v.ok) return { ok: false, reason: "FACT_INVALID", detail: `${fact}:${v.reason}` };

    // AC-06. A known fact must be classified, and an agent may not promote it.
    const vis = resolveVisibility(value, "AGENT");
    if (!vis.ok) return { ok: false, reason: "FACT_INVALID", detail: `${fact}:${vis.reason}` };
  }

  return { ok: true, candidateKey: candidateKeyFor(draft.vendorKey), status: "PROPOSED" };
}

/**
 * Idempotency: the candidate key is the vendor, not the run.
 *
 * Re-running research on the same vendor must not produce a second candidate,
 * and several different signals must be able to support one candidate without
 * any of them being lost — which is why the evidence link is a table and the
 * key is not derived from it.
 */
export function candidateKeyFor(vendorKey: string): string {
  return `AFFILIATE_CANDIDATE:${vendorKey.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

// ─── Direction B: affiliate programme → content opportunity ───────

export interface ProgrammeContext {
  readonly programmeId: string;
  readonly vendorName: string;
  /** Whether the topic is in editorial scope at all. */
  readonly inTopicScope: boolean;
  /** Whether there is something to say beyond "this exists". */
  readonly hasAngle: boolean;
  readonly supportingSignalIds: readonly string[];
}

export type ContentRoutingVerdict =
  | {
      readonly ok: true;
      readonly originType: OpportunityOriginType;
      readonly originId: string;
      readonly claimsToCheck: readonly string[];
    }
  | { readonly ok: false; readonly reason: "OUT_OF_TOPIC_SCOPE" | "NO_ANGLE"; readonly detail: string };

/**
 * Direction B. A programme becomes a **ContentOpportunity candidate** when
 * there is a legitimate content opportunity in it — not automatically.
 *
 * "This vendor pays a commission" is not an article. Routing every programme
 * into content is how an affiliate site ends up with a page per merchant and
 * nothing anyone wants to read, which is precisely the failure the 70/30 mix
 * exists to avoid.
 *
 * The opportunity is created with `origin_type = AFFILIATE_OFFER` and the
 * programme's id, so the trace back is structural. And it carries **claims to
 * check**, never checked claims: what the article would have to verify if it
 * were written.
 */
export function routeProgrammeToContent(ctx: ProgrammeContext): ContentRoutingVerdict {
  if (!ctx.inTopicScope) {
    return { ok: false, reason: "OUT_OF_TOPIC_SCOPE", detail: ctx.vendorName };
  }
  if (!ctx.hasAngle) {
    return { ok: false, reason: "NO_ANGLE", detail: ctx.vendorName };
  }

  const originType: OpportunityOriginType = "AFFILIATE_OFFER";
  if (!isOpportunityOriginType(originType)) {
    throw new Error("AFFILIATE_OFFER must be one of the eight origin types");
  }

  return {
    ok: true,
    originType,
    originId: ctx.programmeId,
    // Questions, not answers. P2-R01 AC-12: an opportunity may record a claim
    // to check, never a checked claim.
    claimsToCheck: [
      "what the programme actually pays, from the vendor's own page",
      "which GEOs the programme accepts",
      "whether PPC and brand bidding are permitted",
      "whether the product is currently available",
    ],
  };
}

// ─── Explainability ───────────────────────────────────────────────

export interface DiscoveryOutcome {
  readonly direction: "A_RESEARCH_TO_AFFILIATE" | "B_AFFILIATE_TO_CONTENT";
  readonly produced: "CANDIDATE" | "NO_ACTION";
  readonly reason: string;
  readonly supportingSignalIds: readonly string[];
}

/**
 * Producing nothing is the common case and is not an error — but it must be
 * **recorded with a reason**. A research run that silently produces nothing is
 * indistinguishable from one that never ran.
 */
export function outcomeFor(
  direction: DiscoveryOutcome["direction"],
  verdict: { ok: boolean; reason?: string },
  supportingSignalIds: readonly string[],
): DiscoveryOutcome {
  return verdict.ok
    ? { direction, produced: "CANDIDATE", reason: "candidate proposed", supportingSignalIds }
    : {
        direction,
        produced: "NO_ACTION",
        reason: verdict.reason ?? "unspecified",
        supportingSignalIds,
      };
}

export function isExplainable(outcome: DiscoveryOutcome): boolean {
  return outcome.reason.trim().length > 0;
}

// ─── What this layer may do ───────────────────────────────────────

/**
 * No `CREATE_PROJECT`, no `APPLY_TO_NETWORK`, no `CREATE_ADS_CAMPAIGN`, no
 * `PUBLISH`, no `EDIT_ARTICLE`, no `APPROVE`. A module written against this
 * vocabulary cannot express any of them.
 */
export const DISCOVERY_ACTIONS = [
  "PROPOSE_AFFILIATE_CANDIDATE",
  "PROPOSE_CONTENT_OPPORTUNITY",
  "RECORD_NO_ACTION",
  "LINK_EVIDENCE",
  "NONE",
] as const;
export type DiscoveryAction = (typeof DISCOVERY_ACTIONS)[number];
