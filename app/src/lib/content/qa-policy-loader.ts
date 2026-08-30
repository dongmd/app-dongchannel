import "server-only";

/**
 * P4-R07 — read the mode policy configuration from the database.
 *
 * `AC-01`: the policy is a **table keyed on `content_mode`**, not a conditional
 * inside the QA agent. Adding a mode is a data change, and this is the only
 * place that data is read.
 *
 * `AC-03`: **an empty table means defaults, and the defaults are the strict
 * end.** That is not a fallback bolted on for safety — it is the behaviour the
 * criterion requires, and it is why this loader returns *overrides* rather than
 * a complete policy. A missing row cannot make a mode permissive because a
 * missing row contributes nothing; `resolveModePolicy` starts from
 * `DEFAULT_MODE_POLICY` and `EVIDENCE_FLOOR` clamps what configuration may do.
 *
 * The decision lives in `qa-policy.ts`, which imports nothing and knows no
 * database. This module only fetches.
 */

import { db } from "@/lib/db";
import { contentModePolicies } from "@/lib/db/schema/content";
import {
  MODE_POLICY_VERSION,
  type ModePolicyOverride,
  type ModePolicyOverrides,
  isContentMode,
} from "./content-mode-policy";

export interface LoadedPolicyConfig {
  readonly overrides: ModePolicyOverrides;
  /**
   * `AC-02`. The version the CONFIGURATION was written under.
   *
   * When rows disagree, or when there are none, this is the code baseline. A
   * mixed table is reported as mixed rather than resolved to whichever row
   * happened to sort first — see below.
   */
  readonly policyVersion: string;
  readonly rowsFound: number;
  /**
   * True when configured rows carry more than one version.
   *
   * Not an error here: this module reports, it does not decide. But a caller
   * comparing a decision against "the policy version" needs to know that the
   * question had more than one answer.
   */
  readonly versionsMixed: boolean;
}

export async function loadModePolicyConfig(): Promise<LoadedPolicyConfig> {
  const rows = await db
    .select({
      mode: contentModePolicies.mode,
      ttlDays: contentModePolicies.ttlDays,
      qaDepth: contentModePolicies.qaDepth,
      minEvidenceLevel: contentModePolicies.minEvidenceLevel,
      slaHours: contentModePolicies.slaHours,
      policyVersion: contentModePolicies.policyVersion,
    })
    .from(contentModePolicies);

  const overrides: Record<string, ModePolicyOverride> = {};
  const versions = new Set<string>();

  for (const r of rows) {
    // A row whose mode is not a known mode is SKIPPED, not guessed at. It
    // cannot override anything, so the mode it was meant for keeps the strict
    // default -- AC-03 holding even against malformed configuration.
    if (!isContentMode(r.mode)) continue;

    const o: ModePolicyOverride = {};
    // NULL means "no opinion on this field", which is why every column is
    // nullable. Copying nulls in would overwrite a default with nothing.
    if (r.ttlDays !== null) o.ttlDays = r.ttlDays;
    if (r.qaDepth !== null) o.qaDepth = r.qaDepth;
    if (r.minEvidenceLevel !== null) o.minEvidenceLevel = r.minEvidenceLevel;
    if (r.slaHours !== null) o.slaHours = r.slaHours;

    overrides[r.mode] = o;
    versions.add(r.policyVersion);
  }

  return {
    overrides: overrides as ModePolicyOverrides,
    // With no rows the code baseline IS the version in force, and saying so is
    // more honest than reporting nothing.
    policyVersion: versions.size === 1 ? [...versions][0]! : MODE_POLICY_VERSION,
    rowsFound: rows.length,
    versionsMixed: versions.size > 1,
  };
}
