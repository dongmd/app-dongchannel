import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { articleContentModes, contentModePolicies } from "@/lib/db/schema/content";
import { auditEvents } from "@/lib/db/schema/audit";
import {
  MODE_POLICY_VERSION,
  deriveModeState,
  isContentMode,
  type ContentMode,
  type ModePolicyOverrides,
  type RefreshAction,
  type RefreshState,
} from "./content-mode-policy";

// P2-R05 AC-04 — the worker that consumes the TTL, and the only thing that
// does.
//
// G-21's complaint about `is_stale()` was not only that 90 days was hard-coded.
// It was that it "triggers nothing": a boolean rendered in an admin column that
// no process ever acted on. This is the process.
//
// **What it is allowed to do is a marking, and nothing else.** It imports no
// WordPress client, no publisher and no post writer -- deliberately, and there
// is a test that reads this file's own imports and fails if one appears. The
// strongest available form of "it never unpublishes" is that the capability is
// not in the module.

/**
 * Load the configuration overrides (AC-05).
 *
 * An empty table means "use the defaults", so a fresh database and a configured
 * one behave identically and there is no seed step to forget.
 */
export async function loadModePolicyOverrides(): Promise<ModePolicyOverrides> {
  const rows = await db.select().from(contentModePolicies);
  const overrides: ModePolicyOverrides = {};

  for (const row of rows) {
    if (!isContentMode(row.mode)) continue;
    const entry: NonNullable<ModePolicyOverrides[ContentMode]> = {};
    if (row.ttlDays !== null) entry.ttlDays = row.ttlDays;
    if (row.qaDepth !== null) entry.qaDepth = row.qaDepth;
    // Note: a row may raise this but never lower it past the floor --
    // `resolveModePolicy` clamps, so passing it through here is safe (AC-10).
    if (row.minEvidenceLevel !== null) entry.minEvidenceLevel = row.minEvidenceLevel;
    if (row.slaHours !== null) entry.slaHours = row.slaHours;
    overrides[row.mode] = entry;
  }

  return overrides;
}

export interface RefreshSweepResult {
  readonly scanned: number;
  readonly marked: number;
  readonly unchanged: number;
  readonly byState: Readonly<Record<RefreshState, number>>;
}

/**
 * Re-derive every article's refresh state and write the projection.
 *
 * The projection is written unconditionally when it differs, and also when the
 * policy version that produced it has moved: a row derived under an older
 * version is not evidence about the current one. That is the same rule
 * P1-R06 applies to `hash_contract_version` -- comparing two values produced
 * under different contracts is a coincidence, not a comparison.
 */
export async function sweepRefreshStates(now: Date = new Date()): Promise<RefreshSweepResult> {
  const overrides = await loadModePolicyOverrides();
  const rows = await db.select().from(articleContentModes);

  const byState: Record<RefreshState, number> = {
    FRESH: 0,
    REFRESH_REQUIRED: 0,
    UNKNOWN: 0,
  };
  let marked = 0;
  let unchanged = 0;

  for (const row of rows) {
    if (!isContentMode(row.contentMode)) {
      // A mode Postgres accepted but this build does not know is a deployment
      // skew, not a data problem. Do not guess, do not overwrite.
      continue;
    }

    const derived = deriveModeState(
      row.contentMode,
      row.freshnessAnchorAt,
      now,
      [],
      overrides,
    );

    byState[derived.refreshState] += 1;

    const projectionIsCurrent =
      row.refreshState === derived.refreshState &&
      row.policyVersionAtDerivation === MODE_POLICY_VERSION;

    if (projectionIsCurrent) {
      unchanged += 1;
      continue;
    }

    await applyRefreshAction(row.id, row.wpPostId, derived.refreshState, derived.refreshAction, {
      previous: row.refreshState,
      previousPolicyVersion: row.policyVersionAtDerivation,
      derivedAt: now,
    });
    marked += 1;
  }

  return { scanned: rows.length, marked, unchanged, byState };
}

interface MarkContext {
  readonly previous: RefreshState;
  readonly previousPolicyVersion: string | null;
  readonly derivedAt: Date;
}

/**
 * The single write path, and it writes three columns.
 *
 * `action` is a `RefreshAction`, whose union contains no unpublish and no edit
 * (see the policy module). It is accepted here so the audit row records the
 * decision that was taken, and so this function cannot be called with an
 * intention the vocabulary cannot express.
 */
async function applyRefreshAction(
  id: string,
  wpPostId: number,
  state: RefreshState,
  action: RefreshAction,
  ctx: MarkContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(articleContentModes)
      .set({
        refreshState: state,
        refreshStateDerivedAt: ctx.derivedAt,
        policyVersionAtDerivation: MODE_POLICY_VERSION,
        updatedAt: ctx.derivedAt,
      })
      .where(eq(articleContentModes.id, id));

    await tx.insert(auditEvents).values({
      actorType: "system",
      actorId: "content-refresh-worker",
      action: "content.refresh.mark",
      entityType: "article_content_mode",
      entityId: id,
      beforeJson: {
        refresh_state: ctx.previous,
        policy_version: ctx.previousPolicyVersion,
      },
      afterJson: {
        refresh_state: state,
        refresh_action: action,
        policy_version: MODE_POLICY_VERSION,
        wp_post_id: wpPostId,
      },
    });
  });
}

/**
 * AC-02 at the write boundary.
 *
 * The column is NOT NULL with no default, so the database already refuses a
 * missing mode. This refuses it one layer earlier and with a message that says
 * what went wrong, because "null value in column content_mode" is a true but
 * unhelpful thing to read at the end of a job.
 */
export async function assignArticleContentMode(input: {
  wpPostId: number;
  contentMode: ContentMode;
  setBy: string;
  reason?: string;
  freshnessAnchorAt?: Date | null;
  commissionedAt?: Date | null;
  publishedAt?: Date | null;
}): Promise<{ id: string }> {
  if (!isContentMode(input.contentMode)) {
    throw new Error(
      `content mode is required and must be one of the five modes; got ${String(input.contentMode)}`,
    );
  }
  if (!input.setBy.trim()) {
    throw new Error("mode_set_by is required: a mode nobody chose is a mode nobody owns");
  }

  const now = new Date();
  const [row] = await db
    .insert(articleContentModes)
    .values({
      wpPostId: input.wpPostId,
      contentMode: input.contentMode,
      modeSetAt: now,
      modeSetBy: input.setBy,
      modeReason: input.reason ?? null,
      freshnessAnchorAt: input.freshnessAnchorAt ?? null,
      commissionedAt: input.commissionedAt ?? null,
      publishedAt: input.publishedAt ?? null,
      // Deliberately left at UNKNOWN. The sweep derives it; guessing here
      // would put an unverified FRESH into the table at insert time.
      refreshState: "UNKNOWN",
    })
    .onConflictDoUpdate({
      target: articleContentModes.wpPostId,
      set: {
        contentMode: input.contentMode,
        modeSetAt: now,
        modeSetBy: input.setBy,
        modeReason: input.reason ?? null,
        // AC-07: a mode change invalidates the projection. Nothing derived
        // survives it -- the stored TTL problem is avoided by there being no
        // stored TTL, and the projection is reset rather than left behind.
        refreshState: "UNKNOWN",
        refreshStateDerivedAt: null,
        policyVersionAtDerivation: null,
        updatedAt: now,
      },
    })
    .returning({ id: articleContentModes.id });

  if (!row) throw new Error("assignArticleContentMode wrote no row");
  return { id: row.id };
}
