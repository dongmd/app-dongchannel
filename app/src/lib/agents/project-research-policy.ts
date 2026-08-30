/**
 * P4-R02 — what the Project Research Agent may say, and may never say.
 *
 * This agent researches an affiliate project: merchant, programme, network,
 * payout, GEO and restriction facts. **`P0-R01` applies here with full force.**
 * This is the exact surface through which an invented commission rate or a
 * fabricated partnership claim would enter the system, and it is the one defect
 * this project has already committed once.
 *
 * So the module is built around a single idea: **a research output is a set of
 * three-state facts, each carrying where it came from.** Not a blob of prose
 * the model wrote, not a JSON object of numbers. A shape that has nowhere to
 * put an unsourced figure.
 *
 * ## Three states, because two would lose the distinction that matters
 *
 * `AC-04` and `AC-05` together:
 *
 *   `KNOWN`   — established, with a source and a time it was checked
 *   `ABSENT`  — researched, and the programme genuinely does not have this
 *   `UNKNOWN` — not established
 *
 * `ABSENT` and `UNKNOWN` are different facts to a downstream decision. "This
 * programme has no cookie window" is a finding. "We could not determine the
 * cookie window" is a gap. Collapsing them — as a nullable number would —
 * makes a gap look like a finding, and the decision that follows is made on a
 * fact nobody established.
 *
 * A `KNOWN` fact **cannot be constructed without a source**: the type has no
 * shape for one. `AC-03` is therefore enforced before any data layer sees it.
 *
 * ## Pure
 *
 * Imports nothing. `now` is a parameter. This is what lets `AC-09`'s negative
 * cases be written as data rather than as an integration test with a database.
 */

// ─── The facts this agent is allowed to research ───────────────────
//
// AC-04's first line of defence. A CLOSED set means the agent cannot invent a
// field, and an output naming `guaranteed_payout` or `partnership_tier` is
// refused before anyone reads its value.

export const RESEARCH_FACT_KEYS = [
  "commission_type",
  "commission_value",
  "commission_currency",
  "cookie_window_days",
  "payout_threshold",
  "payout_currency",
  "network_name",
  "programme_url",
  "ppc_allowed",
  "brand_bidding_allowed",
  "geo_restrictions",
  "content_restrictions",
] as const;

export type ResearchFactKey = (typeof RESEARCH_FACT_KEYS)[number];

const FACT_KEY_SET: ReadonlySet<string> = new Set(RESEARCH_FACT_KEYS);

export function isResearchFactKey(v: unknown): v is ResearchFactKey {
  return typeof v === "string" && FACT_KEY_SET.has(v);
}

// ─── A source. Not optional, by construction ───────────────────────

export interface FactSource {
  /** Where it was read. */
  readonly url: string;
  /** Who published it — the programme, a network, a directory. */
  readonly publisher: string | null;
  /** The words actually observed. Without this, "verified" means trust me. */
  readonly excerpt: string;
}

// ─── The three states ──────────────────────────────────────────────

export type ResearchFact =
  | {
      readonly key: ResearchFactKey;
      readonly state: "KNOWN";
      readonly value: string | number | boolean;
      /** `AC-03`. A KNOWN fact has nowhere to exist without these. */
      readonly source: FactSource;
      readonly checkedAt: Date;
    }
  | {
      readonly key: ResearchFactKey;
      readonly state: "ABSENT";
      /** Researched and found not to exist -- itself a finding, so it too is sourced. */
      readonly source: FactSource;
      readonly checkedAt: Date;
    }
  | {
      readonly key: ResearchFactKey;
      readonly state: "UNKNOWN";
      /** Why it could not be established. Not a source -- there was none. */
      readonly reason: string;
      readonly checkedAt: Date;
    };

/** What the agent is asked to produce. */
export interface ResearchOutput {
  readonly projectId: string;
  readonly facts: readonly ResearchFact[];
  /** Free-text summary. Records nothing; carries no facts. See below. */
  readonly summary: string;
}

// ─── AC-02 / AC-07: what this agent may never cause ────────────────
//
// Same shape as P3-R02's FORBIDDEN_EFFECTS and P4-R01's
// FORBIDDEN_AGENT_WRITES. A boundary written as a sentence in a design document
// is a boundary nothing enforces.

export const FORBIDDEN_RESEARCH_EFFECTS = [
  // AC-02. Status transitions belong to the owner or to an approval path. An
  // agent that could set READY_FOR_APPROVAL would put its own findings into the
  // decision queue.
  "UPDATE affiliate_projects SET status",
  "UPDATE affiliate_projects SET approved_by",
  "UPDATE affiliate_projects SET approved_at",
  "UPDATE affiliate_projects SET route",
  // AC-07.
  "INSERT article_approvals",
  "INSERT article_publish_intents",
  "INSERT affiliate_tests",
  // Claims default to CONFIDENTIAL/FIRST_PARTY and only a HUMAN may promote
  // one. P2-R07 made that a check constraint; naming it here keeps the rule
  // visible at the layer that would be tempted.
  "UPDATE claims SET visibility",
] as const;

// ─── Validation ────────────────────────────────────────────────────

export const RESEARCH_REFUSALS = [
  "NOT_AN_OBJECT",
  "NO_PROJECT",
  "UNKNOWN_FACT_KEY",
  "DUPLICATE_FACT_KEY",
  "KNOWN_FACT_WITHOUT_SOURCE",
  "KNOWN_FACT_WITHOUT_VALUE",
  "SOURCE_WITHOUT_EXCERPT",
  "SOURCE_URL_NOT_ABSOLUTE",
  "UNKNOWN_FACT_WITHOUT_REASON",
  "UNKNOWN_FACT_CARRIES_A_VALUE",
  "CHECKED_AT_IN_THE_FUTURE",
  "NUMERIC_VALUE_NOT_FINITE",
] as const;

export type ResearchRefusal = (typeof RESEARCH_REFUSALS)[number];

export type ResearchVerdict =
  | { readonly ok: true; readonly output: ResearchOutput }
  | {
      readonly ok: false;
      readonly reason: ResearchRefusal;
      /** Which fact key was at fault; `null` for whole-output failures. */
      readonly factKey: string | null;
    };

/**
 * `AC-04` / `AC-06`. Validate a research output before anything is written.
 *
 * The failures are ordered so the most specific complaint wins: a fact claiming
 * `KNOWN` with no source is reported as exactly that, rather than as a generic
 * schema failure that leaves someone guessing which of twelve fields was wrong.
 */
export function validateResearch(raw: unknown, now: Date): ResearchVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "NOT_AN_OBJECT", factKey: null };
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.projectId !== "string" || o.projectId.trim() === "") {
    return { ok: false, reason: "NO_PROJECT", factKey: null };
  }
  if (!Array.isArray(o.facts)) {
    return { ok: false, reason: "NOT_AN_OBJECT", factKey: null };
  }

  const seen = new Set<string>();

  for (const f of o.facts as unknown[]) {
    if (f === null || typeof f !== "object") {
      return { ok: false, reason: "NOT_AN_OBJECT", factKey: null };
    }
    const fact = f as Record<string, unknown>;
    const key = fact.key;

    if (!isResearchFactKey(key)) {
      // The closed set doing its work: an invented field never reaches a value.
      return { ok: false, reason: "UNKNOWN_FACT_KEY", factKey: String(key) };
    }
    if (seen.has(key)) {
      // Two answers for one question is not research.
      return { ok: false, reason: "DUPLICATE_FACT_KEY", factKey: key };
    }
    seen.add(key);

    const checkedAt = fact.checkedAt;
    if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) {
      return { ok: false, reason: "KNOWN_FACT_WITHOUT_SOURCE", factKey: key };
    }
    if (checkedAt.getTime() > now.getTime()) {
      // A fact checked in the future is a clock error or a fabrication, and
      // either way its freshness cannot be reasoned about.
      return { ok: false, reason: "CHECKED_AT_IN_THE_FUTURE", factKey: key };
    }

    if (fact.state === "UNKNOWN") {
      if (typeof fact.reason !== "string" || fact.reason.trim() === "") {
        return { ok: false, reason: "UNKNOWN_FACT_WITHOUT_REASON", factKey: key };
      }
      if ("value" in fact && fact.value !== undefined) {
        // An UNKNOWN carrying a value is the exact shape of a guess wearing a
        // disclaimer. Downstream code reading `.value` would never see the state.
        return { ok: false, reason: "UNKNOWN_FACT_CARRIES_A_VALUE", factKey: key };
      }
      continue;
    }

    if (fact.state !== "KNOWN" && fact.state !== "ABSENT") {
      return { ok: false, reason: "UNKNOWN_FACT_KEY", factKey: key };
    }

    // KNOWN and ABSENT are both findings, and a finding without a source is an
    // assertion. AC-03 enforced here rather than at the data layer, so a bad
    // output never reaches a transaction at all.
    const src = fact.source;
    if (src === null || typeof src !== "object") {
      return { ok: false, reason: "KNOWN_FACT_WITHOUT_SOURCE", factKey: key };
    }
    const s = src as Record<string, unknown>;
    if (typeof s.url !== "string" || !/^https?:\/\/\S+$/.test(s.url)) {
      return { ok: false, reason: "SOURCE_URL_NOT_ABSOLUTE", factKey: key };
    }
    if (typeof s.excerpt !== "string" || s.excerpt.trim().length < 3) {
      // Without the observed words, "checked" means trusting whoever ran it.
      return { ok: false, reason: "SOURCE_WITHOUT_EXCERPT", factKey: key };
    }

    if (fact.state === "KNOWN") {
      const v = fact.value;
      if (v === undefined || v === null || v === "") {
        return { ok: false, reason: "KNOWN_FACT_WITHOUT_VALUE", factKey: key };
      }
      if (typeof v === "number" && !Number.isFinite(v)) {
        return { ok: false, reason: "NUMERIC_VALUE_NOT_FINITE", factKey: key };
      }
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        return { ok: false, reason: "KNOWN_FACT_WITHOUT_VALUE", factKey: key };
      }
    }
  }

  return {
    ok: true,
    output: {
      projectId: o.projectId,
      facts: o.facts as readonly ResearchFact[],
      summary: typeof o.summary === "string" ? o.summary : "",
    },
  };
}

// ─── Turning findings into rows ────────────────────────────────────

export interface ClaimWrite {
  readonly entityType: "affiliate_project";
  readonly entityId: string;
  readonly claimKey: ResearchFactKey;
  readonly claimText: string;
  readonly normalizedValue: unknown;
  /**
   * `AC-05` reaching persistence.
   *
   * `UNVERIFIED` for a sourced finding: the agent read it, and reading is not
   * verifying. `UNKNOWN` for a gap. **Never `VERIFIED`** — no agent may set
   * that, because owner approval is not fact verification and neither is
   * agent output.
   */
  readonly verificationStatus: "UNVERIFIED" | "UNKNOWN";
  readonly notes: string;
}

export interface EvidenceWrite {
  readonly entityType: "affiliate_project";
  readonly entityId: string;
  readonly sourceUrl: string;
  readonly publisher: string | null;
  readonly title: string;
  readonly excerpt: string;
  readonly capturedAt: Date;
  readonly confidence: "UNKNOWN";
}

export interface ResearchWritePlan {
  readonly claims: readonly ClaimWrite[];
  readonly evidence: readonly EvidenceWrite[];
}

/**
 * `AC-07`. What a validated research output becomes.
 *
 * Only claims and evidence. There is no branch here that emits a project
 * update, and the return type has no field one could travel in — so "it does
 * not write execution fields" is a property of the type rather than a promise
 * about the code.
 *
 * Every fact produces a claim, including `UNKNOWN` ones. A gap that left no row
 * would be indistinguishable from a fact nobody thought to research, and the
 * next agent would have no way to know the question had been asked.
 */
export function planResearchWrites(output: ResearchOutput): ResearchWritePlan {
  const claims: ClaimWrite[] = [];
  const evidence: EvidenceWrite[] = [];

  for (const f of output.facts) {
    if (f.state === "UNKNOWN") {
      claims.push({
        entityType: "affiliate_project",
        entityId: output.projectId,
        claimKey: f.key,
        claimText: `UNKNOWN — ${f.reason}`,
        // No value, at any level. A downstream reader parsing normalizedValue
        // must find nothing rather than a placeholder it might coerce.
        normalizedValue: null,
        verificationStatus: "UNKNOWN",
        notes: `Không xác định được. Lý do: ${f.reason}`,
      });
      continue;
    }

    const isAbsent = f.state === "ABSENT";
    claims.push({
      entityType: "affiliate_project",
      entityId: output.projectId,
      claimKey: f.key,
      claimText: isAbsent ? "ABSENT — researched, not offered by this programme" : String(f.value),
      // ABSENT records `false`-as-absence explicitly rather than null, so it is
      // machine-distinguishable from UNKNOWN's null.
      normalizedValue: isAbsent ? { state: "ABSENT" } : { state: "KNOWN", value: f.value },
      verificationStatus: "UNVERIFIED",
      notes: isAbsent
        ? "Đã nghiên cứu: chương trình không có mục này."
        : `Đã đọc từ nguồn. Chưa xác minh độc lập.`,
    });

    evidence.push({
      entityType: "affiliate_project",
      entityId: output.projectId,
      sourceUrl: f.source.url,
      publisher: f.source.publisher,
      title: `${f.key} — ${isAbsent ? "not offered" : "as published"}`,
      excerpt: f.source.excerpt,
      capturedAt: f.checkedAt,
      // The agent read a page. It did not assess how much to trust it, and a
      // confidence it did not establish must not be asserted.
      confidence: "UNKNOWN",
    });
  }

  return { claims, evidence };
}

// ─── AC-01 / AC-02: the states this agent may consume ──────────────

/**
 * A project may be researched only from a NON-EXECUTION state.
 *
 * The list is the complement of `P3-R02`'s `EXECUTION_STATES`, written out
 * rather than imported so this module stays free of imports — and asserted
 * against that list by test, which is the check that matters. Two hand-kept
 * lists is exactly the drift this project keeps finding, so the test compares
 * them rather than trusting either.
 */
export const RESEARCHABLE_STATES = ["CANDIDATE", "RESEARCH", "HOLD", "STOPPED"] as const;
export type ResearchableState = (typeof RESEARCHABLE_STATES)[number];

export function isResearchable(status: string): status is ResearchableState {
  return (RESEARCHABLE_STATES as readonly string[]).includes(status);
}
