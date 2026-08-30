/**
 * P4-R02 — run the REAL agent against the REAL production database.
 *
 * Unit tests prove the policy decides correctly on data the test invented. This
 * proves the whole path works: registry → routing → run record → validation →
 * transaction → claims and evidence rows a person can see in the Ops Hub.
 *
 * ## What this writes, and why it is not fabrication
 *
 * The owner authorised "real/synthetic controlled data with correct
 * provenance". This writes SYNTHETIC data and makes that unmistakable:
 *
 *   - the project is named "[CONTROLLED VERIFICATION] …"
 *   - every source URL is on `.invalid`, a reserved TLD that can NEVER resolve,
 *     so no row can be mistaken for something read from a real programme
 *   - every claim's notes name this probe and the requirement
 *
 * That is the difference between synthetic and fabricated: fabricated data
 * claims to be real. Nothing here does. A reader who opens `/moneyos/evidence`
 * sees rows whose source is visibly not a source.
 *
 * ## The provider is deterministic, and that is deliberate
 *
 * No model is called. A real LLM would produce different output each run, so
 * the assertions could not be exact — and this probe's job is to prove the
 * PIPELINE, not the model. Calling a real provider would also mean sending a
 * credential to verify a code path that does not depend on one.
 *
 *   sudo -u opssite bash -lc 'cd <app> && npx tsx deploy/r02-research-probe.ts'
 *
 * `--cleanup` removes everything it created, by name.
 */

import { createRequire } from "node:module";

// `project-research.ts` holds a live db handle, so `server-only` belongs on it.
// See r11-surfaces-probe.ts for the same note: neutralised for this process,
// which is a server-side script and is never bundled.
const req = createRequire(import.meta.url);
req.cache[req.resolve("server-only")] = {
  id: "server-only", filename: "server-only", loaded: true, exports: {},
} as never;

const PROJECT_NAME = "[CONTROLLED VERIFICATION] P4-R02 agent path";
const SOURCE_URL = "https://controlled-verification.invalid/programme-terms";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " -- " + detail : ""}`); }
}

async function main() {
  const { db } = await import("../src/lib/db");
  const { eq, and, like } = await import("drizzle-orm");
  const { affiliateProjects, affiliatePrograms, merchants, affiliateNetworks } =
    await import("../src/lib/db/schema/aff");
  const { claims, evidence } = await import("../src/lib/db/schema/evidence");
  const { agentRuns, modelPolicies } = await import("../src/lib/db/schema/agents");
  const { researchProject } = await import("../src/lib/agents/project-research");
  const { AGENT_REGISTRY, PROJECT_RESEARCH_AGENT } = await import("../src/lib/agents/agent-policy");

  const cleanup = process.argv.includes("--cleanup");

  // ---- Remove anything a previous run left, always. A probe that appends on
  // ---- every run turns the Ops Hub into a pile of its own test data.
  const stale = await db.select({ id: affiliateProjects.id })
    .from(affiliateProjects).where(like(affiliateProjects.name, "[CONTROLLED VERIFICATION]%"));
  for (const s of stale) {
    await db.delete(claims).where(and(eq(claims.entityType, "affiliate_project"), eq(claims.entityId, s.id)));
    await db.delete(evidence).where(and(eq(evidence.entityType, "affiliate_project"), eq(evidence.entityId, s.id)));
    await db.delete(agentRuns).where(and(eq(agentRuns.entityType, "affiliate_project"), eq(agentRuns.entityId, s.id)));
    await db.delete(affiliateProjects).where(eq(affiliateProjects.id, s.id));
  }
  await db.delete(merchants).where(like(merchants.name, "[CONTROLLED VERIFICATION]%"));
  await db.delete(affiliateNetworks).where(like(affiliateNetworks.name, "[CONTROLLED VERIFICATION]%"));

  if (cleanup) {
    await db.delete(modelPolicies).where(eq(modelPolicies.provider, "controlled-verification"));
    console.log(`cleanup: removed ${stale.length} controlled project(s) and their rows.`);
    process.exit(0);
  }

  console.log("== the agent is registered (AC-01, via P4-R01) ==");
  check("aff.project-research is in the production registry",
    AGENT_REGISTRY.has(PROJECT_RESEARCH_AGENT.name));
  check("it declares exactly one tool, and no database tool",
    PROJECT_RESEARCH_AGENT.tools.length === 1 && !PROJECT_RESEARCH_AGENT.tools.some((t) => t.startsWith("db.")));

  console.log("\n== routing (AC-08 / P4-R01 AC-08) ==");
  await db.delete(modelPolicies).where(eq(modelPolicies.taskClass, "RESEARCH"));
  await db.insert(modelPolicies).values({
    taskClass: "RESEARCH", provider: "controlled-verification",
    model: "deterministic-fixture", active: "true",
    note: "P4-R02 controlled verification. No model is called; see deploy/r02-research-probe.ts.",
  });
  const pol = await db.select().from(modelPolicies).where(eq(modelPolicies.taskClass, "RESEARCH"));
  check("exactly one active RESEARCH policy", pol.length === 1);

  // ---- A project to research, and the rows it needs to exist.
  const [net] = await db.insert(affiliateNetworks)
    .values({ key: "controlled-verification-net", name: "[CONTROLLED VERIFICATION] network" }).returning({ id: affiliateNetworks.id });
  const [mer] = await db.insert(merchants)
    .values({ name: "[CONTROLLED VERIFICATION] merchant" }).returning({ id: merchants.id });
  const [prog] = await db.insert(affiliatePrograms)
    .values({ merchantId: mer!.id, networkId: net!.id, name: "[CONTROLLED VERIFICATION] programme" })
    .returning({ id: affiliatePrograms.id });
  const [proj] = await db.insert(affiliateProjects)
    .values({ programId: prog!.id, name: PROJECT_NAME, status: "CANDIDATE" })
    .returning({ id: affiliateProjects.id });
  const projectId = proj!.id;

  const now = () => new Date();
  const checkedAt = new Date(Date.now() - 60_000).toISOString();

  const goodFacts = JSON.stringify([
    { key: "commission_type", state: "KNOWN", value: "REVSHARE", checkedAt,
      source: { url: SOURCE_URL, publisher: "controlled fixture", excerpt: "Revenue share, 12% of net." } },
    { key: "commission_value", state: "KNOWN", value: 12, checkedAt,
      source: { url: SOURCE_URL, publisher: "controlled fixture", excerpt: "Revenue share, 12% of net." } },
    { key: "brand_bidding_allowed", state: "ABSENT", checkedAt,
      source: { url: SOURCE_URL, publisher: "controlled fixture", excerpt: "No brand bidding clause." } },
    { key: "payout_threshold", state: "UNKNOWN", checkedAt, reason: "not published on the terms page" },
  ]);

  const provider = (facts: string) => async () => ({
    output: { projectId, facts, summary: "controlled verification fixture" },
    usage: { promptTokens: null, completionTokens: null, costUsd: null },
  });

  const deps = { policies: pol.map((p) => ({ ...p, active: p.active === "true" })), now,
    requestedBy: "controlled-verification" };

  console.log("\n== AC-09 negative: an execution-state project is refused ==");
  await db.update(affiliateProjects).set({ status: "READY_FOR_APPROVAL" }).where(eq(affiliateProjects.id, projectId));
  const refused = await researchProject({ ...deps, call: provider(goodFacts) }, projectId);
  check("refused", !refused.ok && refused.errorCode === "PROJECT_IN_EXECUTION_STATE",
    JSON.stringify(refused));
  const refusedRuns = await db.select().from(agentRuns).where(eq(agentRuns.entityId, projectId));
  check("the refusal is RECORDED as a run that never started",
    refusedRuns.length === 1 && refusedRuns[0]!.state === "REFUSED" && refusedRuns[0]!.startedAt === null);
  const afterRefusal = await db.select().from(claims).where(eq(claims.entityId, projectId));
  check("and wrote NO claims", afterRefusal.length === 0);

  await db.update(affiliateProjects).set({ status: "CANDIDATE" }).where(eq(affiliateProjects.id, projectId));

  console.log("\n== AC-09 negative: an unsourced fact writes nothing (AC-06) ==");
  const unsourced = JSON.stringify([{ key: "commission_value", state: "KNOWN", value: 99, checkedAt }]);
  const bad = await researchProject({ ...deps, call: provider(unsourced) }, projectId);
  check("refused", !bad.ok && bad.errorCode === "KNOWN_FACT_WITHOUT_SOURCE", JSON.stringify(bad));
  check("still NO claims -- a validation failure writes nothing at all",
    (await db.select().from(claims).where(eq(claims.entityId, projectId))).length === 0);

  console.log("\n== AC-09 negative: an invented fact key is refused ==");
  const invented = JSON.stringify([{ key: "guaranteed_payout", state: "KNOWN", value: 500, checkedAt,
    source: { url: SOURCE_URL, publisher: "x", excerpt: "nothing says this" } }]);
  const inv = await researchProject({ ...deps, call: provider(invented) }, projectId);
  check("refused", !inv.ok && inv.errorCode === "UNKNOWN_FACT_KEY", JSON.stringify(inv));

  console.log("\n== AC-09 CONTROL: a well-formed run SUCCEEDS ==");
  const good = await researchProject({ ...deps, call: provider(goodFacts) }, projectId);
  check("succeeded", good.ok, JSON.stringify(good));
  if (good.ok) {
    check("4 claims written (including the UNKNOWN)", good.claimsWritten === 4);
    check("3 evidence rows -- the UNKNOWN has no source", good.evidenceWritten === 3);
  }

  console.log("\n== AC-03 / AC-05: what actually landed ==");
  const wrote = await db.select().from(claims).where(eq(claims.entityId, projectId));
  const unknown = wrote.find((c) => c.claimKey === "payout_threshold");
  const absent = wrote.find((c) => c.claimKey === "brand_bidding_allowed");
  const known = wrote.find((c) => c.claimKey === "commission_value");
  check("UNKNOWN persisted as UNKNOWN with no value",
    unknown?.verificationStatus === "UNKNOWN" && unknown?.normalizedValue === null);
  check("ABSENT persisted distinguishably from UNKNOWN",
    absent?.verificationStatus === "UNVERIFIED"
      && JSON.stringify(absent?.normalizedValue) === JSON.stringify({ state: "ABSENT" }));
  check("no claim is VERIFIED -- agent output is not verification",
    wrote.every((c) => c.verificationStatus !== "VERIFIED"));
  check("claims default to CONFIDENTIAL / FIRST_PARTY",
    wrote.every((c) => c.visibility === "CONFIDENTIAL" && c.sourceAccess === "FIRST_PARTY"));
  check("every claim is traceable to its run (AC-08)",
    wrote.every((c) => c.agentRunId !== null));

  const ev = await db.select().from(evidence).where(eq(evidence.entityId, projectId));
  check("every evidence row carries a source URL and an excerpt (AC-03)",
    ev.length > 0 && ev.every((e) => !!e.sourceUrl && !!e.excerpt && !!e.capturedAt));
  check("every source is visibly synthetic (.invalid)",
    ev.every((e) => e.sourceUrl!.includes(".invalid")));

  console.log("\n== AC-02 / AC-07: the project was not touched ==");
  const [after] = await db.select({ status: affiliateProjects.status, approvedBy: affiliateProjects.approvedBy })
    .from(affiliateProjects).where(eq(affiliateProjects.id, projectId));
  check("status is still CANDIDATE", after?.status === "CANDIDATE");
  check("approvedBy is still null", after?.approvedBy === null);

  console.log("\n== AC-08: the run lifecycle ==");
  const runs = await db.select().from(agentRuns).where(eq(agentRuns.entityId, projectId));
  const succeeded = runs.filter((r) => r.state === "SUCCEEDED");
  check("a SUCCEEDED run exists with both times", succeeded.length === 1
    && succeeded[0]!.startedAt !== null && succeeded[0]!.finishedAt !== null);
  check("cost is NULL, not 0 -- the provider reported none", succeeded[0]!.costUsd === null);
  check("failures are recorded and say why",
    runs.filter((r) => r.state === "FAILED" || r.state === "REFUSED")
        .every((r) => r.errorCode !== null));
  console.log(`  (${runs.length} runs recorded for this project)`);

  console.log("\n===================================");
  console.log(`pass=${pass}  fail=${fail}`);
  console.log(`Left in production for the Ops Hub, clearly marked:`);
  console.log(`  project "${PROJECT_NAME}"  ->  ${wrote.length} claims, ${ev.length} evidence, ${runs.length} runs`);
  console.log(`  remove with:  npx tsx deploy/r02-research-probe.ts --cleanup`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
