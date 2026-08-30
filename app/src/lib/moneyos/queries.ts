import "server-only";

/**
 * P4-R11 — every read the AI Money OS surfaces make.
 *
 * ## The `ORDER BY` lives here and nowhere else
 *
 * `AC-02` says the UI computes no ranking. That is only enforceable if there is
 * exactly one place ordering is decided, so this is it — the same discipline
 * `P3-R02`'s `command-queries.ts` holds for `/contentplan`. A `.sort()` in a
 * page component would be a second ranking authority, and two authorities that
 * disagree is how a queue starts lying.
 *
 * The opportunity queue orders by the **stored** `P2-R03` `normalised_score`,
 * descending, `NULLS LAST`. `NULLS LAST` is a decision, not a default: an
 * unscored opportunity is not a badly-scoring one, and floating it to the top
 * or burying it silently would both be claims the score never made.
 *
 * ## This module reads. It never writes.
 *
 * No insert, no update, no delete. The AI Money OS surfaces are a projection;
 * `P2` owns these models, `P4-R01` owns `agent_runs`, and `P3` owns approvals
 * and publish intents. `boundary.test.ts` asserts that on the source.
 */

import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { contentOpportunities } from "@/lib/db/schema/opportunity-content";
import { contentOpportunityScores } from "@/lib/db/schema/opportunity-scoring";
import { opportunitySignals } from "@/lib/db/schema/opportunity";
import { topicClusters } from "@/lib/db/schema/topic-cluster";
import { trendAllowlist } from "@/lib/db/schema/trend-radar";
import { affiliateProjectCandidates } from "@/lib/db/schema/discovery-candidate";
import { claims, evidence } from "@/lib/db/schema/evidence";
import { agentRuns } from "@/lib/db/schema/agents";
import { markets } from "@/lib/db/schema/aff";

/** Every list is capped. An unbounded query on a growing table is an outage. */
const LIMIT = 100;

export interface OpportunityRow {
  id: string;
  title: string;
  contentMode: string | null;
  status: string;
  profileSlug: string | null;
  createdAt: Date;
  /** Stored P2-R03 values. NULL means unscored, which is not a low score. */
  normalisedScore: number | null;
  scoringConfigVersion: string | null;
  knownDimensions: number | null;
  totalDimensions: number | null;
}

/**
 * The opportunity queue.
 *
 * The join is `LEFT` on purpose: an opportunity with no score must still appear.
 * An inner join would make unscored opportunities *invisible*, which is the
 * worst possible way to represent "we have not assessed this yet" — the queue
 * would look complete while hiding exactly the rows needing attention.
 */
export async function listOpportunities(): Promise<OpportunityRow[]> {
  const rows = await db
    .select({
      id: contentOpportunities.id,
      title: contentOpportunities.title,
      contentMode: contentOpportunities.contentMode,
      status: contentOpportunities.status,
      profileSlug: contentOpportunities.profileSlug,
      createdAt: contentOpportunities.createdAt,
      normalisedScore: contentOpportunityScores.normalisedScore,
      scoringConfigVersion: contentOpportunityScores.scoringConfigVersion,
      knownDimensions: contentOpportunityScores.knownDimensions,
      totalDimensions: contentOpportunityScores.totalDimensions,
    })
    .from(contentOpportunities)
    .leftJoin(
      contentOpportunityScores,
      eq(contentOpportunityScores.contentOpportunityId, contentOpportunities.id),
    )
    // The one ranking authority. NULLS LAST is deliberate -- see the header.
    .orderBy(
      sql`${contentOpportunityScores.normalisedScore} DESC NULLS LAST`,
      desc(contentOpportunities.createdAt),
    )
    .limit(LIMIT);

  return rows as OpportunityRow[];
}

export async function listSignals() {
  return db
    .select({
      id: opportunitySignals.id,
      title: opportunitySignals.title,
      kind: opportunitySignals.kind,
      originMode: opportunitySignals.originMode,
      status: opportunitySignals.status,
      confidence: opportunitySignals.confidence,
      language: opportunitySignals.language,
      discoveredAt: opportunitySignals.discoveredAt,
    })
    .from(opportunitySignals)
    .orderBy(desc(opportunitySignals.discoveredAt))
    .limit(LIMIT);
}

export async function listClusters() {
  return db
    .select({
      id: topicClusters.id,
      key: topicClusters.key,
      title: topicClusters.title,
      state: topicClusters.state,
      profileSlug: topicClusters.profileSlug,
      updatedAt: topicClusters.updatedAt,
    })
    .from(topicClusters)
    .orderBy(desc(topicClusters.updatedAt))
    .limit(LIMIT);
}

export async function listTrends() {
  return db
    .select({
      id: trendAllowlist.id,
      term: trendAllowlist.term,
      enabled: trendAllowlist.enabled,
      rationale: trendAllowlist.rationale,
      addedBy: trendAllowlist.addedBy,
      createdAt: trendAllowlist.createdAt,
    })
    .from(trendAllowlist)
    .orderBy(desc(trendAllowlist.createdAt))
    .limit(LIMIT);
}

export async function listCandidates() {
  return db
    .select({
      id: affiliateProjectCandidates.id,
      candidateKey: affiliateProjectCandidates.candidateKey,
      vendorName: affiliateProjectCandidates.vendorName,
      programmeExists: affiliateProjectCandidates.programmeExists,
      status: affiliateProjectCandidates.status,
      statusReason: affiliateProjectCandidates.statusReason,
      createdAt: affiliateProjectCandidates.createdAt,
    })
    .from(affiliateProjectCandidates)
    .orderBy(desc(affiliateProjectCandidates.createdAt))
    .limit(LIMIT);
}

export async function listEvidence() {
  return db
    .select({
      id: evidence.id,
      title: evidence.title,
      publisher: evidence.publisher,
      sourceUrl: evidence.sourceUrl,
      entityType: evidence.entityType,
      confidence: evidence.confidence,
      status: evidence.status,
      capturedAt: evidence.capturedAt,
      freshUntil: evidence.freshUntil,
    })
    .from(evidence)
    .orderBy(desc(evidence.capturedAt))
    .limit(LIMIT);
}

export async function listClaims() {
  return db
    .select({
      id: claims.id,
      claimKey: claims.claimKey,
      claimText: claims.claimText,
      entityType: claims.entityType,
      verificationStatus: claims.verificationStatus,
      verifiedAt: claims.verifiedAt,
      expiresAt: claims.expiresAt,
    })
    .from(claims)
    .orderBy(desc(claims.createdAt))
    .limit(LIMIT);
}

/**
 * `AC-05` — agent runs.
 *
 * Selects `errorCode` and `errorMessage` because the criterion asks for **why
 * it failed**, not merely that it did. A run surface that showed only a red
 * badge would satisfy a reading of "shows agent runs" and would be useless at
 * the moment someone actually needs it.
 */
export async function listAgentRuns() {
  return db
    .select({
      id: agentRuns.id,
      agentName: agentRuns.agentName,
      profile: agentRuns.profile,
      taskClass: agentRuns.taskClass,
      entityType: agentRuns.entityType,
      entityId: agentRuns.entityId,
      provider: agentRuns.provider,
      model: agentRuns.model,
      state: agentRuns.state,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      costUsd: agentRuns.costUsd,
      errorCode: agentRuns.errorCode,
      errorMessage: agentRuns.errorMessage,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .orderBy(desc(agentRuns.createdAt))
    .limit(LIMIT);
}

export interface SurfaceCount {
  readonly key: string;
  readonly count: number;
}

/**
 * Row counts for the index page.
 *
 * Each count is a real `count(*)`. A hard-coded `0` would render identically
 * today — every one of these tables is empty in production — and would keep
 * rendering `0` on the day they are not. That is the `DC-011`/`DC-012` defect
 * this project already has on record: a KPI shipped as a literal zero awaiting
 * a story that had long since landed.
 */
export async function surfaceCounts(): Promise<SurfaceCount[]> {
  const [opp, sig, clu, tre, can, evi, run] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(contentOpportunities),
    db.select({ n: sql<number>`count(*)::int` }).from(opportunitySignals),
    db.select({ n: sql<number>`count(*)::int` }).from(topicClusters),
    db.select({ n: sql<number>`count(*)::int` }).from(trendAllowlist),
    db.select({ n: sql<number>`count(*)::int` }).from(affiliateProjectCandidates),
    db.select({ n: sql<number>`count(*)::int` }).from(evidence),
    db.select({ n: sql<number>`count(*)::int` }).from(agentRuns),
  ]);

  return [
    { key: "opportunities", count: opp[0]?.n ?? 0 },
    { key: "signals", count: sig[0]?.n ?? 0 },
    { key: "clusters", count: clu[0]?.n ?? 0 },
    { key: "trends", count: tre[0]?.n ?? 0 },
    { key: "candidates", count: can[0]?.n ?? 0 },
    { key: "evidence", count: evi[0]?.n ?? 0 },
    { key: "agents", count: run[0]?.n ?? 0 },
  ];
}

/**
 * `AC-07`, the `DC-011b` case. `/aff/markets` shipped copy promising a Markets
 * UI "in follow-up story DC-011b" -- a story that existed in no register.
 *
 * The surface is delivered READ-ONLY. The `markets` table is real and empty;
 * building an editor for a table nothing writes to would be UI ahead of a
 * capability, which is the thing this requirement is under instruction not to
 * do. A truthful list of what is there is the delivery.
 */
export async function listMarkets() {
  return db
    .select({
      id: markets.id,
      name: markets.name,
      summary: markets.summary,
      demandScore: markets.demandScore,
      longevityScore: markets.longevityScore,
      competitionScore: markets.competitionScore,
      policyRiskScore: markets.policyRiskScore,
      status: markets.status,
    })
    .from(markets)
    .orderBy(markets.name)
    .limit(LIMIT);
}
