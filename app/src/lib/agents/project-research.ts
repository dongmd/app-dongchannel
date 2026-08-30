import "server-only";

/**
 * P4-R02 — running the Project Research Agent, and writing what it found.
 *
 * `project-research-policy.ts` decides; this persists. The split is the same
 * one `P4-R01` uses, and for the same reason: the decisions are testable as
 * data because they never touch a database.
 *
 * ## `AC-06`: a validation failure writes nothing at all
 *
 * Not "writes nothing important" — nothing. Validation happens **before** the
 * transaction opens, so the failure path never reaches a `BEGIN`. There is no
 * partial write to clean up because there is no write.
 *
 * ## `AC-02` / `AC-07`: this cannot advance a project, structurally
 *
 * The writes come from `planResearchWrites`, whose return type has exactly two
 * fields: `claims` and `evidence`. There is no shape in which a project status
 * update could travel, so "it never advances the project's own status" is a
 * property of the type rather than a rule somebody remembered.
 *
 * The plan is also built from the agent's *validated* output, and that output
 * has no field naming a table. `P4-R01`'s load-bearing property — model output
 * is data, never a command — is what makes this hold.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { affiliateProjects } from "@/lib/db/schema/aff";
import { claims, evidence } from "@/lib/db/schema/evidence";
import { agentRuns } from "@/lib/db/schema/agents";
import { AGENT_REGISTRY, PROJECT_RESEARCH_AGENT, type ModelPolicy } from "./agent-policy";
import { runAgent, type ProviderCall, type RunSink } from "./runner";
import {
  isResearchable,
  planResearchWrites,
  validateResearch,
  type ResearchRefusal,
} from "./project-research-policy";

export type ResearchOutcome =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly claimsWritten: number;
      readonly evidenceWritten: number;
    }
  | {
      readonly ok: false;
      readonly errorCode: ResearchRefusal | "PROJECT_NOT_FOUND" | "PROJECT_IN_EXECUTION_STATE" | string;
      readonly detail: string | null;
    };

export interface ResearchDeps {
  readonly policies: readonly ModelPolicy[];
  readonly call: ProviderCall;
  readonly now: () => Date;
  /** Who asked. Recorded on every row this run produces. */
  readonly requestedBy: string;
}

/**
 * Research one affiliate project.
 *
 * `AC-01`: the project must be in a non-execution state, checked against the
 * database rather than against what the caller believed.
 */
export async function researchProject(
  deps: ResearchDeps,
  projectId: string,
): Promise<ResearchOutcome> {
  const [project] = await db
    .select({ id: affiliateProjects.id, status: affiliateProjects.status })
    .from(affiliateProjects)
    .where(eq(affiliateProjects.id, projectId))
    .limit(1);

  if (!project) {
    return { ok: false, errorCode: "PROJECT_NOT_FOUND", detail: null };
  }

  // AC-01/AC-02. Refused BEFORE the agent runs, so an execution-state project
  // does not even consume a model call -- and the refusal is a recorded run.
  if (!isResearchable(project.status)) {
    const runId = await recordRefusal(
      deps, projectId, "PROJECT_IN_EXECUTION_STATE",
      `project is ${project.status}, which is an execution state`,
    );
    return { ok: false, errorCode: "PROJECT_IN_EXECUTION_STATE", detail: runId };
  }

  let runId = "";
  const sink: RunSink = async (row) => {
    const [r] = await db.insert(agentRuns).values({
      agentName: row.agentName,
      profile: row.profile,
      taskClass: row.taskClass,
      entityType: row.entityType,
      entityId: row.entityId,
      provider: row.provider,
      model: row.model,
      state: row.state,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      promptTokens: row.usage.promptTokens === null ? null : String(row.usage.promptTokens),
      completionTokens:
        row.usage.completionTokens === null ? null : String(row.usage.completionTokens),
      costUsd: row.usage.costUsd === null ? null : String(row.usage.costUsd),
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    }).returning({ id: agentRuns.id });
    runId = r?.id ?? "";
  };

  // AC-08. The run is recorded by P4-R01's framework, against this project.
  const outcome = await runAgent(
    { registry: AGENT_REGISTRY, policies: deps.policies, call: deps.call, sink, now: deps.now },
    {
      agentName: PROJECT_RESEARCH_AGENT.name,
      entityType: "affiliate_project",
      entityId: projectId,
      input: { projectId },
    },
  );

  if (!outcome.ok) {
    return { ok: false, errorCode: outcome.errorCode, detail: outcome.detail };
  }

  // AC-06. R02's own validation, on top of R01's coarse schema gate. The
  // three-state fact shape is this requirement's business, not the framework's.
  //
  // `facts` arrives as a JSON string through R01's flat schema and is parsed
  // here, because R01's schema language deliberately has no nested-object type
  // -- widening it to carry R02's shape would put R02's scope inside R01.
  const parsed = parseFacts(outcome.output, deps.now());
  if (!parsed.ok) {
    await markRunFailed(runId, parsed.reason, parsed.factKey);
    return { ok: false, errorCode: parsed.reason, detail: parsed.factKey };
  }

  const plan = planResearchWrites(parsed.output);

  // One transaction. Either the whole finding lands or none of it does -- a
  // half-written research result is worse than none, because the gap is
  // invisible to whatever reads it next.
  await db.transaction(async (tx) => {
    for (const c of plan.claims) {
      await tx.insert(claims).values({
        entityType: c.entityType,
        entityId: c.entityId,
        claimKey: c.claimKey,
        claimText: c.claimText,
        normalizedValue: c.normalizedValue,
        verificationStatus: c.verificationStatus,
        agentRunId: runId || null,
        notes: c.notes,
        // sourceAccess and visibility are LEFT AT THEIR DEFAULTS --
        // FIRST_PARTY and CONFIDENTIAL, the most restrictive on each axis.
        // P2-R07 made promotion require a named human; an agent setting them
        // would be that promotion without one.
      });
    }
    for (const e of plan.evidence) {
      await tx.insert(evidence).values({
        entityType: e.entityType,
        entityId: e.entityId,
        sourceUrl: e.sourceUrl,
        publisher: e.publisher,
        title: e.title,
        excerpt: e.excerpt,
        capturedAt: e.capturedAt,
        confidence: e.confidence,
        agentRunId: runId || null,
        notes: `P4-R02 · requested by ${deps.requestedBy}`,
      });
    }
  });

  return {
    ok: true,
    runId,
    claimsWritten: plan.claims.length,
    evidenceWritten: plan.evidence.length,
  };
}

function parseFacts(output: Record<string, unknown>, now: Date) {
  let facts: unknown = [];
  if (typeof output.facts === "string") {
    try {
      facts = JSON.parse(output.facts);
    } catch {
      return { ok: false as const, reason: "NOT_AN_OBJECT" as ResearchRefusal, factKey: null };
    }
  } else if (Array.isArray(output.facts)) {
    facts = output.facts;
  }

  // `checkedAt` arrives as an ISO string over any transport. Revive it before
  // validation, so `validateResearch` can hold the rule that a fact checked in
  // the future is refused.
  if (Array.isArray(facts)) {
    facts = facts.map((f) => {
      if (!f || typeof f !== "object") return f;
      const raw = (f as Record<string, unknown>).checkedAt;
      return typeof raw === "string" ? { ...(f as object), checkedAt: new Date(raw) } : f;
    });
  }

  const v = validateResearch(
    { projectId: output.projectId, facts, summary: output.summary ?? "" },
    now,
  );
  return v.ok
    ? { ok: true as const, output: v.output }
    : { ok: false as const, reason: v.reason, factKey: v.factKey };
}

async function markRunFailed(runId: string, code: string, detail: string | null) {
  if (!runId) return;
  await db
    .update(agentRuns)
    .set({ state: "FAILED", errorCode: code, errorMessage: detail })
    .where(eq(agentRuns.id, runId));
}

async function recordRefusal(
  deps: ResearchDeps, projectId: string, code: string, message: string,
): Promise<string> {
  const [r] = await db.insert(agentRuns).values({
    agentName: PROJECT_RESEARCH_AGENT.name,
    profile: PROJECT_RESEARCH_AGENT.profile,
    taskClass: PROJECT_RESEARCH_AGENT.taskClass,
    entityType: "affiliate_project",
    entityId: projectId,
    provider: null,
    model: null,
    state: "REFUSED",
    startedAt: null,
    finishedAt: null,
    errorCode: code,
    errorMessage: message,
  }).returning({ id: agentRuns.id });
  return r?.id ?? "";
}
