/**
 * P4-R03 — the Content Strategy capability of `CONTENT_AGENT`.
 *
 * Owner-approved 2026-08-30 as a **capability**, not a new top-level agent: the
 * MASTER's §13.1 roster is unchanged. What it does is turn an approved `P2`
 * content opportunity into a **brief** the Writer can execute — angle, content
 * mode, required evidence level, target structure — **without writing the
 * article**.
 *
 * ## The one line that defines the requirement
 *
 * `AC-04`: **a brief is not a draft.** Everything else follows. A brief that
 * drifted into prose would make `P4-R05` redundant and, worse, would put
 * article text into a pipeline stage that has no QA gate behind it — the draft
 * would reach an owner having passed nothing.
 *
 * So the output type has **nowhere to put body copy**. Not a rule; a shape.
 *
 * ## What it reads and does not recompute
 *
 * `AC-01`: the `P2-R03` score is read, never recomputed — the same boundary
 * `P3-R02 AC-03` holds for `/contentplan` and `P4-R11 AC-02` holds for the
 * queue. `AC-03`: the required evidence level comes from `P4-R07`'s policy,
 * not from a judgement made here. This capability decides the *angle and the
 * shape*; it decides no numbers at all.
 *
 * ## Pure
 *
 * Imports nothing. The evidence requirement arrives as a parameter, resolved by
 * the caller from `P4-R07`, which is what makes `AC-07`'s control testable:
 * feed a mode whose bar the system cannot currently meet and assert the brief
 * still STATES the requirement rather than lowering it.
 */

// ─── What a brief is ───────────────────────────────────────────────

/**
 * The sections a brief may ask for. A CLOSED set, because an open one is how a
 * "structure" field starts carrying instructions and ends carrying prose.
 */
export const BRIEF_SECTIONS = [
  "INTRO",
  "WHAT_IT_IS",
  "HOW_IT_WORKS",
  "COMPARISON",
  "PRICING",
  "PROS_CONS",
  "WHO_ITS_FOR",
  "ALTERNATIVES",
  "VERDICT",
  "SOURCES",
  "FAQ",
] as const;

export type BriefSection = (typeof BRIEF_SECTIONS)[number];

const SECTION_SET: ReadonlySet<string> = new Set(BRIEF_SECTIONS);

export function isBriefSection(v: unknown): v is BriefSection {
  return typeof v === "string" && SECTION_SET.has(v);
}

/**
 * A claim the article will need to establish.
 *
 * The brief names WHAT must be evidenced, never what the answer is. A brief
 * that carried answers would be doing `P4-R04`'s research and `P4-R05`'s
 * writing, and the evidence gate would have nothing left to check.
 */
export interface RequiredClaim {
  readonly key: string;
  /** The question, phrased as a question. Never an assertion. */
  readonly question: string;
}

export interface ContentBrief {
  readonly opportunityId: string;
  /** One mode, from P2's existing vocabulary. AC-02. */
  readonly contentMode: string;
  /**
   * The angle in one sentence: what this piece argues or answers.
   *
   * Length-capped at `ANGLE_MAX_CHARS`, and that cap is the enforcement of
   * `AC-04`. An "angle" with room for eight hundred words is a draft.
   */
  readonly angle: string;
  readonly targetSections: readonly BriefSection[];
  readonly requiredClaims: readonly RequiredClaim[];
  /**
   * `AC-03`. Read from `P4-R07`, restated here so the brief is self-contained
   * and a later reader does not have to re-derive it under a policy that may by
   * then have changed.
   */
  readonly requiredEvidenceLevel: string;
  readonly policyVersion: string;
  /**
   * `AC-07`. True when the required evidence level is above what the system
   * currently holds for this opportunity.
   *
   * The brief is still produced. The requirement is still stated. This flag
   * makes the shortfall VISIBLE rather than resolving it — because the only
   * two ways to resolve it here would be to lower the bar or to hide the gap,
   * and both are the failure the criterion names.
   */
  readonly evidenceShortfall: boolean;
  /** The stored P2-R03 score, carried through unchanged. Never recomputed. */
  readonly opportunityScore: number | null;
}

/**
 * `AC-04`, as a number.
 *
 * 280 characters is a sentence or two. It is not a paragraph and it is
 * certainly not an article. The cap exists so "a brief is not a draft" is
 * checkable rather than a matter of taste, and so that a model instructed to
 * "be thorough" cannot quietly turn the angle field into body copy.
 */
export const ANGLE_MAX_CHARS = 280;

/** The same reasoning, for the question text on a required claim. */
export const QUESTION_MAX_CHARS = 200;

// ─── Refusals ──────────────────────────────────────────────────────

/**
 * The only fields a brief output may carry.
 *
 * Everything a brief DERIVES -- the evidence level, the policy version, the
 * shortfall flag, the score -- is supplied by the caller and is not on this
 * list, so an output naming one is refused rather than overruled.
 */
const BRIEF_INPUT_FIELDS: ReadonlySet<string> = new Set([
  "opportunityId", "contentMode", "angle", "targetSections", "requiredClaims",
]);

export const BRIEF_REFUSALS = [
  "NOT_AN_OBJECT",
  "UNDECLARED_BRIEF_FIELD",
  "NO_OPPORTUNITY",
  "NO_CONTENT_MODE",
  "UNKNOWN_CONTENT_MODE",
  "NO_ANGLE",
  "ANGLE_TOO_LONG",
  "NO_SECTIONS",
  "UNKNOWN_SECTION",
  "DUPLICATE_SECTION",
  "QUESTION_TOO_LONG",
  "CLAIM_IS_AN_ASSERTION",
  "DUPLICATE_CLAIM_KEY",
  "BRIEF_CONTAINS_PROSE",
  "NO_EVIDENCE_LEVEL",
] as const;

export type BriefRefusal = (typeof BRIEF_REFUSALS)[number];

export type BriefVerdict =
  | { readonly ok: true; readonly brief: ContentBrief }
  | { readonly ok: false; readonly reason: BriefRefusal; readonly detail: string | null };

/**
 * Fields a brief must never contain.
 *
 * `AC-04` from the other direction: the type has no body-copy field, and this
 * catches an output that tried to smuggle one in under a name the schema does
 * not know. `P4-R01`'s `UNDECLARED_FIELD` catches this too; the duplication is
 * deliberate, because this one names *why*.
 */
export const PROSE_FIELDS = [
  "body", "content", "draft", "article", "text", "prose", "paragraphs", "html", "markdown",
] as const;

export interface BriefInputs {
  /** The mode's requirement, resolved by the caller from P4-R07. */
  readonly requiredEvidenceLevel: string;
  readonly policyVersion: string;
  /** Is the required level above what the system holds? Decided by the caller. */
  readonly evidenceShortfall: boolean;
  /** The stored P2-R03 score. Passed through, never recomputed. */
  readonly opportunityScore: number | null;
  /** P2's mode vocabulary, injected so this module imports nothing. */
  readonly knownModes: readonly string[];
}

/**
 * Validate one brief.
 *
 * There is no path here that produces a brief with the evidence level lowered.
 * `AC-07` asks for a test that the downgrade path does not exist, and the
 * honest way to satisfy that is for it genuinely not to: `requiredEvidenceLevel`
 * is copied from `inputs`, and nothing in this function can alter it.
 */
export function validateBrief(raw: unknown, inputs: BriefInputs): BriefVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
  }
  const o = raw as Record<string, unknown>;

  for (const f of PROSE_FIELDS) {
    if (f in o) {
      return { ok: false, reason: "BRIEF_CONTAINS_PROSE", detail: f };
    }
  }

  // Anything the brief does not declare is refused.
  //
  // `P4-R01`'s schema gate already rejects undeclared fields, and this
  // duplicates it deliberately. The reason is specific rather than defensive:
  // the fields this module DERIVES -- `requiredEvidenceLevel`, `policyVersion`,
  // `evidenceShortfall`, `opportunityScore` -- all come from `inputs`. Ignoring
  // an output that named one of them would mean a brief could ASK for a lower
  // evidence bar and be silently overruled rather than refused, and "silently
  // overruled" is a state nobody reviews.
  //
  // Found by a test that asserted the stronger property before the code held
  // it. The test was right.
  for (const k of Object.keys(o)) {
    if (!BRIEF_INPUT_FIELDS.has(k)) {
      return { ok: false, reason: "UNDECLARED_BRIEF_FIELD", detail: k };
    }
  }

  if (typeof o.opportunityId !== "string" || o.opportunityId.trim() === "") {
    return { ok: false, reason: "NO_OPPORTUNITY", detail: null };
  }

  if (typeof o.contentMode !== "string" || o.contentMode.trim() === "") {
    return { ok: false, reason: "NO_CONTENT_MODE", detail: null };
  }
  if (!inputs.knownModes.includes(o.contentMode)) {
    // AC-02. A brief cannot introduce a mode; P2 owns that vocabulary.
    return { ok: false, reason: "UNKNOWN_CONTENT_MODE", detail: o.contentMode };
  }

  if (typeof o.angle !== "string" || o.angle.trim() === "") {
    return { ok: false, reason: "NO_ANGLE", detail: null };
  }
  if (o.angle.length > ANGLE_MAX_CHARS) {
    // AC-04, enforced as a number rather than as taste.
    return { ok: false, reason: "ANGLE_TOO_LONG", detail: String(o.angle.length) };
  }

  if (!Array.isArray(o.targetSections) || o.targetSections.length === 0) {
    return { ok: false, reason: "NO_SECTIONS", detail: null };
  }
  const seenSections = new Set<string>();
  for (const s of o.targetSections) {
    if (!isBriefSection(s)) return { ok: false, reason: "UNKNOWN_SECTION", detail: String(s) };
    if (seenSections.has(s)) return { ok: false, reason: "DUPLICATE_SECTION", detail: s };
    seenSections.add(s);
  }

  const claims = Array.isArray(o.requiredClaims) ? o.requiredClaims : [];
  const seenClaims = new Set<string>();
  for (const c of claims) {
    if (c === null || typeof c !== "object") {
      return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
    }
    const claim = c as Record<string, unknown>;
    if (typeof claim.key !== "string" || claim.key.trim() === "") {
      return { ok: false, reason: "NOT_AN_OBJECT", detail: null };
    }
    if (seenClaims.has(claim.key)) {
      return { ok: false, reason: "DUPLICATE_CLAIM_KEY", detail: claim.key };
    }
    seenClaims.add(claim.key);

    if (typeof claim.question !== "string" || claim.question.trim() === "") {
      return { ok: false, reason: "CLAIM_IS_AN_ASSERTION", detail: claim.key };
    }
    if (claim.question.length > QUESTION_MAX_CHARS) {
      return { ok: false, reason: "QUESTION_TOO_LONG", detail: claim.key };
    }
    if (!isQuestion(claim.question)) {
      // A brief names what must be ESTABLISHED. "The price is $49" is a claim
      // the strategist has no evidence for and no business making -- and a
      // Writer handed it would treat it as given.
      return { ok: false, reason: "CLAIM_IS_AN_ASSERTION", detail: claim.key };
    }
  }

  if (!inputs.requiredEvidenceLevel) {
    return { ok: false, reason: "NO_EVIDENCE_LEVEL", detail: null };
  }

  return {
    ok: true,
    brief: {
      opportunityId: o.opportunityId,
      contentMode: o.contentMode,
      angle: o.angle.trim(),
      targetSections: o.targetSections as readonly BriefSection[],
      requiredClaims: claims as readonly RequiredClaim[],
      // Copied from inputs. Nothing above can have changed it, which is AC-07's
      // "the downgrade path does not exist" made true rather than asserted.
      requiredEvidenceLevel: inputs.requiredEvidenceLevel,
      policyVersion: inputs.policyVersion,
      evidenceShortfall: inputs.evidenceShortfall,
      opportunityScore: inputs.opportunityScore,
    },
  };
}

/**
 * Is this phrased as a question?
 *
 * Deliberately simple: a question mark, or an opening interrogative. The point
 * is not linguistic analysis — it is to make the *assertion* shape fail, so a
 * strategist cannot hand the Writer a fact nobody established.
 */
function isQuestion(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (t.endsWith("?")) return true;
  return /^(what|which|how|why|when|where|who|is|are|does|do|can|should|bao nhiêu|có |nào |liệu )/.test(t);
}
