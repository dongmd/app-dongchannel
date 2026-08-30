/**
 * P4-R06 — the QA Agent, and why it is a different agent.
 *
 * `G-42`: *"a writer checking its own work is not a check."* Separate agent,
 * separate prompt, **no write access to the draft**.
 *
 * `G-43`: *"nothing mechanically prevents 'we tested this' at E1."* That
 * sentence is the requirement. A draft may make a claim whose *strength* the
 * evidence behind it does not support, and today nothing notices.
 *
 * ## The claim-strength check
 *
 * A claim's WORDING implies an evidence level. "We tested this" implies
 * first-party measurement — `E4`. "According to the vendor" implies a
 * secondary source — `E1`. When the wording implies more than the evidence
 * provides, the draft fails, and the failure names both.
 *
 * That is `AC-03`, and it is the one check here that is not structural. The
 * others — separate agent, no draft-mutating tool, no downgrade path — are all
 * enforced by the shape of things rather than by judgement.
 *
 * ## `AC-05`: there is no downgrade path
 *
 * Not "downgrading is forbidden" — the verdict type has no field that could
 * carry a lowered requirement, and this module returns only a verdict. It reads
 * `P4-R07`'s policy through `evaluateQaPolicy` and cannot alter what it reads.
 *
 * ## Pure
 */

// ─── What a claim's wording implies ────────────────────────────────
//
// AC-03. Ordered strongest-first, because the FIRST match wins and a phrase
// implying first-party measurement must not be caught by a weaker pattern that
// happens to appear in the same sentence.

export const CLAIM_STRENGTH_PATTERNS: readonly {
  readonly implies: string;
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  {
    implies: "E4",
    label: "first-party measurement",
    // The G-43 example, and its neighbours. All assert the project itself
    // measured something.
    pattern: /\b(we tested|we measured|we ran|our (?:testing|benchmark|measurement)|in our tests|chúng tôi (?:đã )?(?:thử nghiệm|đo|kiểm tra))\b/i,
  },
  {
    implies: "E3",
    label: "corroborated primary sources",
    pattern: /\b(multiple sources|independently confirmed|corroborated|verified by|đã được xác minh|nhiều nguồn)\b/i,
  },
  {
    implies: "E2",
    label: "a checked primary source",
    pattern: /\b(the vendor states|official (?:docs|documentation|pricing)|per the (?:terms|documentation)|theo tài liệu chính thức|trang chính thức)\b/i,
  },
  {
    implies: "E1",
    label: "a secondary source",
    pattern: /\b(reportedly|according to|reviews say|it is said|được cho là|theo (?:như )?ghi nhận)\b/i,
  },
];

const RANK: Readonly<Record<string, number>> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

export function rankOf(level: string): number {
  return RANK[level] ?? -1;
}

export interface StrengthClaim {
  readonly implies: string;
  readonly label: string;
  readonly phrase: string;
}

/**
 * What does this text claim about its own evidence?
 *
 * Returns the STRONGEST implication found, because a paragraph saying both
 * "according to the vendor" and "we tested this" is making the stronger claim
 * — and the weaker phrase does not excuse it.
 */
export function impliedStrength(text: string): StrengthClaim | null {
  for (const p of CLAIM_STRENGTH_PATTERNS) {
    const m = p.pattern.exec(text);
    if (m) return { implies: p.implies, label: p.label, phrase: m[0] };
  }
  return null;
}

// ─── What QA judges ────────────────────────────────────────────────

export interface JudgedSection {
  readonly section: string;
  readonly text: string;
  /** The claim keys this section cites, from `P4-R05`. */
  readonly citedClaims: readonly string[];
}

export interface JudgedClaim {
  readonly key: string;
  /** The evidence level actually supporting it. `null` = UNKNOWN. */
  readonly evidenceLevel: string | null;
}

export interface QaSubject {
  readonly draftId: string;
  readonly evidencePackId: string;
  readonly contentMode: string;
  readonly sections: readonly JudgedSection[];
  readonly claims: readonly JudgedClaim[];
}

// ─── The verdict ───────────────────────────────────────────────────

export const QA_AGENT_FAILURES = [
  "CLAIM_STRONGER_THAN_ITS_EVIDENCE",
  "CITED_CLAIM_HAS_NO_EVIDENCE_LEVEL",
  "CLAIM_BELOW_MODE_POLICY",
  "UNSUPPORTED_STRENGTH_CLAIM",
] as const;

export type QaAgentFailure = (typeof QA_AGENT_FAILURES)[number];

export interface QaFinding {
  readonly reason: QaAgentFailure;
  readonly section: string;
  /** The claim at fault. `null` when the section makes a strength claim with no citation at all. */
  readonly claimKey: string | null;
  /** What the wording implied. */
  readonly implied: string | null;
  /** What the evidence actually provides. `null` = UNKNOWN. */
  readonly actual: string | null;
  /** The phrase that made the claim, quoted so a person can find it. */
  readonly phrase: string | null;
}

export type QaAgentVerdict =
  | { readonly ok: true; readonly draftId: string; readonly evidencePackId: string; readonly claimsChecked: number }
  | { readonly ok: false; readonly draftId: string; readonly evidencePackId: string; readonly findings: readonly QaFinding[] };

/**
 * `AC-03` / `AC-04`. Judge a draft against the evidence behind it.
 *
 * `requiredLevel` comes from `P4-R07` — this module does not decide it and
 * cannot change it. **All** findings are collected rather than the first,
 * because a person fixing a draft needs the whole list; returning one at a time
 * turns one review into five.
 */
export function judgeDraft(subject: QaSubject, requiredLevel: string): QaAgentVerdict {
  const byKey = new Map(subject.claims.map((c) => [c.key, c]));
  const findings: QaFinding[] = [];
  const base = { draftId: subject.draftId, evidencePackId: subject.evidencePackId };

  for (const sec of subject.sections) {
    const strength = impliedStrength(sec.text);

    if (strength) {
      if (sec.citedClaims.length === 0) {
        // "We tested this" citing nothing. The strongest possible claim with
        // no evidence attached at all.
        findings.push({
          reason: "UNSUPPORTED_STRENGTH_CLAIM", section: sec.section, claimKey: null,
          implied: strength.implies, actual: null, phrase: strength.phrase,
        });
      }
      for (const key of sec.citedClaims) {
        const claim = byKey.get(key);
        if (!claim || claim.evidenceLevel === null) {
          // UNKNOWN evidence cannot support ANY strength claim. UNKNOWN is not
          // a low level -- it is the absence of one, and treating it as E0
          // would let it be compared.
          findings.push({
            reason: "CITED_CLAIM_HAS_NO_EVIDENCE_LEVEL", section: sec.section, claimKey: key,
            implied: strength.implies, actual: null, phrase: strength.phrase,
          });
          continue;
        }
        if (rankOf(claim.evidenceLevel) < rankOf(strength.implies)) {
          // G-43, mechanically. "We tested this" at E1.
          findings.push({
            reason: "CLAIM_STRONGER_THAN_ITS_EVIDENCE", section: sec.section, claimKey: key,
            implied: strength.implies, actual: claim.evidenceLevel, phrase: strength.phrase,
          });
        }
      }
    }

    // Independently of wording: every cited claim must meet the MODE's bar.
    for (const key of sec.citedClaims) {
      const claim = byKey.get(key);
      if (!claim) continue; // already reported above when a strength claim was made
      if (claim.evidenceLevel === null) {
        if (!strength) {
          findings.push({
            reason: "CITED_CLAIM_HAS_NO_EVIDENCE_LEVEL", section: sec.section, claimKey: key,
            implied: null, actual: null, phrase: null,
          });
        }
        continue;
      }
      if (rankOf(claim.evidenceLevel) < rankOf(requiredLevel)) {
        findings.push({
          reason: "CLAIM_BELOW_MODE_POLICY", section: sec.section, claimKey: key,
          implied: requiredLevel, actual: claim.evidenceLevel, phrase: null,
        });
      }
    }
  }

  if (findings.length > 0) return { ok: false, ...base, findings };
  return { ok: true, ...base, claimsChecked: subject.claims.length };
}

/**
 * `AC-04`. A failure a person can act on.
 *
 * Names the section, the claim, what the wording implied, what the evidence
 * actually is, and quotes the phrase. "QA failed" is explicitly not a pass of
 * that criterion, and neither is a reason code on its own.
 */
export function explainFinding(f: QaFinding): string {
  const where = `[${f.section}]`;
  const claim = f.claimKey ? ` · claim \`${f.claimKey}\`` : "";
  const quote = f.phrase ? ` · "${f.phrase}"` : "";

  switch (f.reason) {
    case "CLAIM_STRONGER_THAN_ITS_EVIDENCE":
      return `${where}${claim} · câu chữ hàm ý ${f.implied} nhưng bằng chứng chỉ ở ${f.actual}${quote}`;
    case "CITED_CLAIM_HAS_NO_EVIDENCE_LEVEL":
      return `${where}${claim} · bằng chứng ở mức KHÔNG XÁC ĐỊNH — không thể chống lưng cho khẳng định nào${quote}`;
    case "CLAIM_BELOW_MODE_POLICY":
      return `${where}${claim} · bằng chứng ${f.actual} thấp hơn mức ${f.implied} mà chế độ nội dung yêu cầu`;
    case "UNSUPPORTED_STRENGTH_CLAIM":
      return `${where} · khẳng định hàm ý ${f.implied} nhưng không trích dẫn bằng chứng nào${quote}`;
  }
}

/**
 * `AC-06`. A QA pass confers nothing.
 *
 * It is ONE of the three gates `P4-R08` checks. This function exists so that
 * statement is visible in code: it converts a verdict to a boolean and there is
 * no path from here to an approval, a verification state, or a publish.
 */
export function qaGatePasses(v: QaAgentVerdict): boolean {
  return v.ok;
}
