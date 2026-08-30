/**
 * P4-R04 — the Evidence Research Agent's decisions.
 *
 * `G-14`: *"Every claim carries source + `checked_at`."* This gathers what a
 * brief requires, records each claim against its source, and keeps what is
 * KNOWN separate from what is merely believed.
 *
 * `P4-R02` researches an affiliate programme; this researches the claims a
 * BRIEF asks for. The shapes rhyme deliberately — three states, a source that
 * cannot be omitted — because the failure they guard against is identical:
 * a figure arriving in the system with nothing behind it.
 *
 * ## The two rules that are not about shape
 *
 * `AC-02`: evidence carries an access class, and `AUTHENTICATED` /
 * `FIRST_PARTY` findings default to `CONFIDENTIAL`. **No agent may promote
 * them.** A negotiated commission rate read from a partner portal is not
 * public information, and the mistake that publishes one is a single missing
 * default.
 *
 * `AC-05`: noticing a programme emits a **candidate**, never an
 * `AffiliateProject`. `P2-R07 AC-02` already forbids this structurally; it is
 * re-asserted here because this is the agent that would breach it.
 *
 * ## Pure
 */

// ─── Access class and visibility ───────────────────────────────────

export const ACCESS_CLASSES = ["PUBLIC_WEB", "AUTHENTICATED", "FIRST_PARTY"] as const;
export type AccessClass = (typeof ACCESS_CLASSES)[number];

export const VISIBILITIES = ["PUBLIC", "INTERNAL", "CONFIDENTIAL"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/**
 * `AC-02`. What an access class implies, and the agent may not argue with it.
 *
 * `PUBLIC_WEB` maps to `INTERNAL`, not `PUBLIC` — reading something on the open
 * web makes it *quotable*, not *cleared for publication*. Deciding a claim may
 * appear in an article is an editorial act, and this is not the editor.
 */
export const VISIBILITY_FOR_ACCESS: Readonly<Record<AccessClass, Visibility>> = {
  PUBLIC_WEB: "INTERNAL",
  AUTHENTICATED: "CONFIDENTIAL",
  FIRST_PARTY: "CONFIDENTIAL",
};

export function isAccessClass(v: unknown): v is AccessClass {
  return typeof v === "string" && (ACCESS_CLASSES as readonly string[]).includes(v);
}

// ─── What the agent produces ───────────────────────────────────────

export interface EvidenceSource {
  readonly url: string;
  readonly publisher: string | null;
  readonly excerpt: string;
  readonly accessClass: AccessClass;
}

export type ResearchedClaim =
  | {
      readonly key: string;
      readonly question: string;
      readonly state: "ESTABLISHED";
      readonly answer: string;
      /** `AC-01`. At least one. The type requires a non-empty array. */
      readonly sources: readonly [EvidenceSource, ...EvidenceSource[]];
      readonly checkedAt: Date;
    }
  | {
      readonly key: string;
      readonly question: string;
      /**
       * `AC-03`. Could not be verified.
       *
       * `UNKNOWN` is **not** `false`, and the two must stay distinguishable
       * downstream — which is why this state has no `answer` field at all
       * rather than an answer of `false` or `""`.
       */
      readonly state: "UNKNOWN";
      readonly reason: string;
      readonly checkedAt: Date;
    };

/** `AC-05`. A programme NOTICED, never a project created. */
export interface ProgrammeCandidate {
  readonly vendorName: string;
  readonly observedUrl: string;
  readonly observedAt: Date;
}

export interface EvidencePack {
  readonly briefId: string;
  readonly claims: readonly ResearchedClaim[];
  /** `AC-05`. Candidates only. There is no field for a project. */
  readonly candidates: readonly ProgrammeCandidate[];
}

// ─── Refusals ──────────────────────────────────────────────────────

export const EVIDENCE_REFUSALS = [
  "NOT_AN_OBJECT",
  "NO_BRIEF",
  "UNDECLARED_FIELD",
  "DUPLICATE_CLAIM_KEY",
  "ESTABLISHED_WITHOUT_SOURCE",
  "ESTABLISHED_WITHOUT_ANSWER",
  "SOURCE_URL_NOT_ABSOLUTE",
  "SOURCE_WITHOUT_EXCERPT",
  "UNKNOWN_ACCESS_CLASS",
  "AGENT_SET_VISIBILITY",
  "UNKNOWN_WITHOUT_REASON",
  "UNKNOWN_CARRIES_AN_ANSWER",
  "CHECKED_AT_IN_THE_FUTURE",
  "CANDIDATE_WITHOUT_URL",
  "ATTEMPTED_PROJECT_CREATION",
] as const;

export type EvidenceRefusal = (typeof EVIDENCE_REFUSALS)[number];

export type EvidenceVerdict =
  | { readonly ok: true; readonly pack: EvidencePack }
  | { readonly ok: false; readonly reason: EvidenceRefusal; readonly detail: string | null };

/** Top-level fields the agent may emit. */
const PACK_FIELDS: ReadonlySet<string> = new Set(["briefId", "claims", "candidates"]);

/**
 * `AC-04` / `AC-05`. Field names that would mean the agent tried to reach past
 * its own output into something it does not own.
 *
 * `AC-04` is verified for real by database read-back around a run — inspection
 * cannot prove a negative about behaviour. This catches the *intent* early and
 * names it, which is worth doing even though the read-back is the real proof.
 */
const FORBIDDEN_PACK_FIELDS = [
  "project", "affiliateProject", "projectId", "createProject",
  "article", "articleId", "opportunity", "opportunityUpdate",
  "visibility", "verificationStatus", "dcVerified",
] as const;

export function validateEvidencePack(raw: unknown, now: Date): EvidenceVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
  }
  const o = raw as Record<string, unknown>;

  for (const f of FORBIDDEN_PACK_FIELDS) {
    if (f in o) {
      // AC-05's structural prohibition, and AC-02's promotion ban, caught at
      // the boundary rather than after a write.
      const reason: EvidenceRefusal =
        f === "visibility" || f === "verificationStatus" || f === "dcVerified"
          ? "AGENT_SET_VISIBILITY"
          : "ATTEMPTED_PROJECT_CREATION";
      return { ok: false, reason, detail: f };
    }
  }
  for (const k of Object.keys(o)) {
    if (!PACK_FIELDS.has(k)) return { ok: false, reason: "UNDECLARED_FIELD", detail: k };
  }

  if (typeof o.briefId !== "string" || o.briefId.trim() === "") {
    return { ok: false, reason: "NO_BRIEF", detail: null };
  }

  const claims = Array.isArray(o.claims) ? o.claims : [];
  const seen = new Set<string>();

  for (const c of claims) {
    if (c === null || typeof c !== "object") {
      return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
    }
    const cl = c as Record<string, unknown>;
    if (typeof cl.key !== "string" || cl.key.trim() === "") {
      return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
    }
    if (seen.has(cl.key)) return { ok: false, reason: "DUPLICATE_CLAIM_KEY", detail: cl.key };
    seen.add(cl.key);

    if (!(cl.checkedAt instanceof Date) || Number.isNaN(cl.checkedAt.getTime())) {
      return { ok: false, reason: "ESTABLISHED_WITHOUT_SOURCE", detail: cl.key };
    }
    if (cl.checkedAt.getTime() > now.getTime()) {
      return { ok: false, reason: "CHECKED_AT_IN_THE_FUTURE", detail: cl.key };
    }

    if (cl.state === "UNKNOWN") {
      if (typeof cl.reason !== "string" || cl.reason.trim() === "") {
        return { ok: false, reason: "UNKNOWN_WITHOUT_REASON", detail: cl.key };
      }
      if ("answer" in cl && cl.answer !== undefined) {
        // AC-03. An UNKNOWN carrying an answer is how UNKNOWN becomes false --
        // or worse, becomes a figure -- one careless reader downstream.
        return { ok: false, reason: "UNKNOWN_CARRIES_AN_ANSWER", detail: cl.key };
      }
      continue;
    }

    if (cl.state !== "ESTABLISHED") {
      return { ok: false, reason: "NOT_AN_OBJECT", detail: cl.key };
    }
    if (typeof cl.answer !== "string" || cl.answer.trim() === "") {
      return { ok: false, reason: "ESTABLISHED_WITHOUT_ANSWER", detail: cl.key };
    }

    // AC-01. At least one source, and every one of them complete.
    if (!Array.isArray(cl.sources) || cl.sources.length === 0) {
      return { ok: false, reason: "ESTABLISHED_WITHOUT_SOURCE", detail: cl.key };
    }
    for (const s of cl.sources) {
      if (s === null || typeof s !== "object") {
        return { ok: false, reason: "ESTABLISHED_WITHOUT_SOURCE", detail: cl.key };
      }
      const src = s as Record<string, unknown>;
      if (typeof src.url !== "string" || !/^https?:\/\/\S+$/.test(src.url)) {
        return { ok: false, reason: "SOURCE_URL_NOT_ABSOLUTE", detail: cl.key };
      }
      if (typeof src.excerpt !== "string" || src.excerpt.trim().length < 3) {
        return { ok: false, reason: "SOURCE_WITHOUT_EXCERPT", detail: cl.key };
      }
      if (!isAccessClass(src.accessClass)) {
        // AC-02. A source with no access class cannot be classified, and an
        // unclassified source defaulting to public is the failure this exists
        // to prevent.
        return { ok: false, reason: "UNKNOWN_ACCESS_CLASS", detail: cl.key };
      }
      if ("visibility" in src) {
        return { ok: false, reason: "AGENT_SET_VISIBILITY", detail: cl.key };
      }
    }
  }

  const candidates = Array.isArray(o.candidates) ? o.candidates : [];
  for (const c of candidates) {
    if (c === null || typeof c !== "object") {
      return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
    }
    const cand = c as Record<string, unknown>;
    if (typeof cand.observedUrl !== "string" || !/^https?:\/\/\S+$/.test(cand.observedUrl)) {
      return { ok: false, reason: "CANDIDATE_WITHOUT_URL", detail: String(cand.vendorName) };
    }
  }

  return {
    ok: true,
    pack: {
      briefId: o.briefId,
      claims: claims as readonly ResearchedClaim[],
      candidates: candidates as readonly ProgrammeCandidate[],
    },
  };
}

// ─── Turning a pack into rows ──────────────────────────────────────

export interface EvidenceClaimWrite {
  readonly claimKey: string;
  readonly claimText: string;
  readonly normalizedValue: unknown;
  readonly verificationStatus: "UNVERIFIED" | "UNKNOWN";
  /** Derived from the STRICTEST access class among its sources. AC-02. */
  readonly visibility: Visibility;
  readonly sourceAccess: AccessClass;
  readonly evidenceCount: number;
}

const ACCESS_STRICTNESS: Readonly<Record<AccessClass, number>> = {
  PUBLIC_WEB: 0,
  AUTHENTICATED: 1,
  FIRST_PARTY: 2,
};

/**
 * `AC-02`. A claim rests on its **strictest** source, not its most convenient.
 *
 * A figure corroborated by a public page and a partner portal is still partner
 * information: the public page did not make the confidential one less
 * confidential. Taking the most permissive class would let any confidential
 * fact be laundered by finding one open-web mention of something similar.
 */
export function strictestAccess(sources: readonly EvidenceSource[]): AccessClass {
  return sources.reduce<AccessClass>(
    (acc, s) => (ACCESS_STRICTNESS[s.accessClass] > ACCESS_STRICTNESS[acc] ? s.accessClass : acc),
    "PUBLIC_WEB",
  );
}

export function planEvidenceWrites(pack: EvidencePack): readonly EvidenceClaimWrite[] {
  return pack.claims.map((c) => {
    if (c.state === "UNKNOWN") {
      return {
        claimKey: c.key,
        claimText: `UNKNOWN — ${c.reason}`,
        normalizedValue: null,
        verificationStatus: "UNKNOWN" as const,
        // A gap is not public information either. Nothing was established, so
        // nothing has been cleared.
        visibility: "CONFIDENTIAL" as const,
        sourceAccess: "FIRST_PARTY" as const,
        evidenceCount: 0,
      };
    }
    const access = strictestAccess(c.sources);
    return {
      claimKey: c.key,
      claimText: c.answer,
      normalizedValue: { state: "ESTABLISHED", answer: c.answer },
      // Researched is not verified. P4-R06 and the evidence together decide
      // that; reading a page does not.
      verificationStatus: "UNVERIFIED" as const,
      visibility: VISIBILITY_FOR_ACCESS[access],
      sourceAccess: access,
      evidenceCount: c.sources.length,
    };
  });
}

/**
 * `AC-06`. A run that found nothing is a NORMAL outcome.
 *
 * Distinguishable from a failure because it is `ok` with an empty pack, and a
 * failure is `ok: false` with a reason. Treating "found nothing" as an error
 * would teach whoever reads `agent_runs` to ignore failures.
 */
export function isEmptyPack(pack: EvidencePack): boolean {
  return pack.claims.length === 0 && pack.candidates.length === 0;
}
