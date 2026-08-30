/**
 * P4-R05 — the Writer Agent.
 *
 * *"Brief + evidence pack only; cannot invent facts."* A draft is produced from
 * those two things and from nothing else.
 *
 * ## Making `AC-02` mechanical
 *
 * *"Every factual claim in the draft traces to a claim in the evidence pack."*
 * That is easy to state and easy to fake — a Writer can be told to cite its
 * sources and simply not. So the check is not on the citations; it is on the
 * **figures**.
 *
 * A number, a price, a percentage or a duration in the prose is a factual
 * assertion a reader will act on. The rule is therefore:
 *
 * > **Every figure appearing in the draft must appear in the answer of an
 * > `ESTABLISHED` claim that the section citing it declares.**
 *
 * A Writer that invents "12%" has to invent it somewhere, and the moment it
 * lands in prose it has no matching evidence answer. This catches the
 * fabrication rather than the missing citation — which matters, because a
 * fabricated claim with a *plausible* citation is the failure mode a
 * citation-count check waves through.
 *
 * `AC-04` falls out of the same rule for free: an `UNKNOWN` claim has **no
 * answer**, so no figure can ever match it. "A test feeds an UNKNOWN payout and
 * asserts no figure appears" is not a separate mechanism — it is this one.
 *
 * ## Pure
 */

// ─── The evidence pack, as the Writer sees it ──────────────────────

export interface PackClaim {
  readonly key: string;
  /** `ESTABLISHED` claims have an answer. `UNKNOWN` ones do not, ever. */
  readonly state: "ESTABLISHED" | "UNKNOWN";
  readonly answer: string | null;
}

export interface WriterInputs {
  readonly briefId: string;
  /** The sections the brief asked for. A draft may not invent one. */
  readonly allowedSections: readonly string[];
  readonly pack: readonly PackClaim[];
}

// ─── The draft ─────────────────────────────────────────────────────

export interface DraftSection {
  readonly section: string;
  readonly text: string;
  /** The claim keys this section rests on. */
  readonly citedClaims: readonly string[];
}

export interface Draft {
  readonly briefId: string;
  readonly title: string;
  readonly sections: readonly DraftSection[];
  /**
   * Claims the draft acknowledges it could not establish.
   *
   * `AC-04`'s "hedged" path, made explicit. A Writer that wants to mention an
   * unknown must SAY it is unknown, here, rather than writing around it — so a
   * reader downstream can tell an acknowledged gap from a topic simply not
   * covered.
   */
  readonly acknowledgedUnknowns: readonly string[];
}

// ─── Refusals ──────────────────────────────────────────────────────

export const DRAFT_REFUSALS = [
  "NOT_AN_OBJECT",
  "WRONG_BRIEF",
  "UNDECLARED_FIELD",
  "NO_TITLE",
  "NO_SECTIONS",
  "SECTION_NOT_IN_BRIEF",
  "DUPLICATE_SECTION",
  "EMPTY_SECTION",
  "CITED_CLAIM_NOT_IN_PACK",
  "CITED_CLAIM_IS_UNKNOWN",
  "UNEVIDENCED_FIGURE",
  "ACKNOWLEDGED_UNKNOWN_NOT_IN_PACK",
  "ACKNOWLEDGED_CLAIM_IS_ESTABLISHED",
  "DRAFT_CARRIES_PRIVILEGED_FIELD",
] as const;

export type DraftRefusal = (typeof DRAFT_REFUSALS)[number];

export type DraftVerdict =
  | { readonly ok: true; readonly draft: Draft }
  | {
      readonly ok: false;
      readonly reason: DraftRefusal;
      readonly detail: string | null;
      /** For UNEVIDENCED_FIGURE: the figures with nothing behind them. */
      readonly figures?: readonly string[];
    };

const DRAFT_FIELDS: ReadonlySet<string> = new Set([
  "briefId", "title", "sections", "acknowledgedUnknowns",
]);

/**
 * `AC-03` / `AC-05`. Fields whose presence means the Writer tried to consent,
 * verify or publish on the owner's behalf.
 *
 * Drafting is not verifying and is not consenting. These are refused by name so
 * the refusal says *which* boundary was crossed, rather than reporting a
 * generic schema failure that a reader has to decode.
 */
const PRIVILEGED_FIELDS = [
  "verified", "dcVerified", "dc_verified", "verificationStatus",
  "approved", "approval", "approvedBy",
  "publish", "publishIntent", "publishAt", "status",
] as const;

// ─── Figures ───────────────────────────────────────────────────────

/**
 * Anything a reader would treat as a fact they could act on.
 *
 * Deliberately broad — currency, percentages, plain numbers, durations. A
 * false positive costs a citation; a false negative ships an invented price.
 *
 * Small integers up to `FIGURE_MIN` are excluded: "the three plans" and "two
 * ways to do this" are prose, not claims, and treating them as figures would
 * make the rule so noisy it would be turned off. The threshold is the point
 * where a number starts looking like data.
 */
export const FIGURE_MIN = 10;

const FIGURE_PATTERN = /(?:[$£€]\s?\d[\d,]*(?:\.\d+)?)|(?:\d[\d,]*(?:\.\d+)?\s?%)|(?:\d[\d,]*(?:\.\d+)?)/g;

/** Extract the figures a reader would treat as claims. */
export function extractFigures(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FIGURE_PATTERN)) {
    const raw = m[0];
    const numeric = Number(raw.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(numeric)) continue;
    // A bare small number is prose. A small number with a currency symbol or a
    // percent sign is not -- "$5" and "3%" are both claims.
    const decorated = /[$£€%]/.test(raw);
    if (!decorated && numeric < FIGURE_MIN) continue;
    out.push(normaliseFigure(raw));
  }
  return out;
}

/** `$1,299.00` and `1299` are the same claim. Compare on the number. */
function normaliseFigure(s: string): string {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? String(n) : s;
}

/** Does an evidence answer contain this figure? */
function answerContains(answer: string, figure: string): boolean {
  return extractFigures(answer).includes(figure);
}

// ─── Validation ────────────────────────────────────────────────────

export function validateDraft(raw: unknown, inputs: WriterInputs): DraftVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
  }
  const o = raw as Record<string, unknown>;

  for (const f of PRIVILEGED_FIELDS) {
    if (f in o) {
      return { ok: false, reason: "DRAFT_CARRIES_PRIVILEGED_FIELD", detail: f };
    }
  }
  for (const k of Object.keys(o)) {
    if (!DRAFT_FIELDS.has(k)) return { ok: false, reason: "UNDECLARED_FIELD", detail: k };
  }

  if (o.briefId !== inputs.briefId) {
    // AC-01. A draft for a different brief is a draft built from inputs this
    // run was not given.
    return { ok: false, reason: "WRONG_BRIEF", detail: String(o.briefId) };
  }
  if (typeof o.title !== "string" || o.title.trim() === "") {
    return { ok: false, reason: "NO_TITLE", detail: null };
  }
  if (!Array.isArray(o.sections) || o.sections.length === 0) {
    return { ok: false, reason: "NO_SECTIONS", detail: null };
  }

  const byKey = new Map(inputs.pack.map((c) => [c.key, c]));
  const seenSections = new Set<string>();

  for (const s of o.sections) {
    if (s === null || typeof s !== "object") {
      return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
    }
    const sec = s as Record<string, unknown>;

    if (typeof sec.section !== "string" || !inputs.allowedSections.includes(sec.section)) {
      // The brief decides the structure. A Writer adding a section is writing
      // to a plan nobody approved.
      return { ok: false, reason: "SECTION_NOT_IN_BRIEF", detail: String(sec.section) };
    }
    if (seenSections.has(sec.section)) {
      return { ok: false, reason: "DUPLICATE_SECTION", detail: sec.section };
    }
    seenSections.add(sec.section);

    if (typeof sec.text !== "string" || sec.text.trim() === "") {
      return { ok: false, reason: "EMPTY_SECTION", detail: sec.section };
    }

    const cited = Array.isArray(sec.citedClaims) ? sec.citedClaims : [];
    for (const key of cited) {
      const claim = byKey.get(String(key));
      if (!claim) {
        // AC-02. A citation to something the pack does not contain.
        return { ok: false, reason: "CITED_CLAIM_NOT_IN_PACK", detail: String(key) };
      }
      if (claim.state === "UNKNOWN") {
        // AC-04. An UNKNOWN may be ACKNOWLEDGED, never CITED as support. The
        // difference is the whole criterion: acknowledging says "we do not
        // know", citing says "this is why".
        return { ok: false, reason: "CITED_CLAIM_IS_UNKNOWN", detail: String(key) };
      }
    }

    // AC-02 / AC-04, the load-bearing check. Every figure in the prose must
    // appear in the answer of a claim THIS SECTION cites.
    const figures = extractFigures(sec.text);
    const supported = cited
      .map((k) => byKey.get(String(k)))
      .filter((c): c is PackClaim => !!c && c.state === "ESTABLISHED" && c.answer !== null);

    const unevidenced = figures.filter(
      (f) => !supported.some((c) => answerContains(c.answer!, f)),
    );
    if (unevidenced.length > 0) {
      return {
        ok: false,
        reason: "UNEVIDENCED_FIGURE",
        detail: sec.section,
        figures: [...new Set(unevidenced)],
      };
    }
  }

  const acknowledged = Array.isArray(o.acknowledgedUnknowns) ? o.acknowledgedUnknowns : [];
  for (const key of acknowledged) {
    const claim = byKey.get(String(key));
    if (!claim) {
      return { ok: false, reason: "ACKNOWLEDGED_UNKNOWN_NOT_IN_PACK", detail: String(key) };
    }
    if (claim.state !== "UNKNOWN") {
      // Acknowledging an established claim as unknown would understate what
      // the system knows -- a different lie, and still a lie.
      return { ok: false, reason: "ACKNOWLEDGED_CLAIM_IS_ESTABLISHED", detail: String(key) };
    }
  }

  return {
    ok: true,
    draft: {
      briefId: inputs.briefId,
      title: o.title.trim(),
      sections: o.sections as readonly DraftSection[],
      acknowledgedUnknowns: acknowledged.map(String),
    },
  };
}

/**
 * `AC-02` restated for a reader: which claims does this draft actually rest on?
 *
 * `P4-R06` needs this to check the draft against the mode's evidence policy
 * without re-deriving it from the prose.
 */
export function citedClaimKeys(draft: Draft): readonly string[] {
  return [...new Set(draft.sections.flatMap((s) => s.citedClaims))];
}
