import "server-only";
import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  affiliateNetworks,
  affiliatePrograms,
  angles,
  markets,
  type AffiliateProgramRow,
  type OfferConfidence,
  type OfferStatus,
} from "@/lib/db/schema/aff";
import { auditEvents } from "@/lib/db/schema/audit";
import { allowedTransitionsGraph, nextStatuses, OFFER_STATUS_LABELS } from "./labels";
import { claimTtlDays } from "@/lib/content/content-mode-policy";

// Re-export labels + nextStatuses cho server callers (backwards compat).
// Client components import trực tiếp từ ./labels.
export { OFFER_STATUS_LABELS, nextStatuses };

const ALLOWED_TRANSITIONS = allowedTransitionsGraph();

export interface OfferListItem {
  id: string;
  name: string;
  network: string | null;
  status: OfferStatus;
  confidence: OfferConfidence;
  commissionType: string;
  commissionValue: number | null;
  commissionUnit: string | null;
  cookieDays: number | null;
  marketName: string | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
}

export interface ListOffersInput {
  status?: OfferStatus | "all";
  q?: string;
  limit?: number;
}

export async function listOffers(input: ListOffersInput = {}): Promise<OfferListItem[]> {
  const limit = Math.min(input.limit ?? 50, 200);
  const whereClauses: ReturnType<typeof eq>[] = [];
  if (input.status && input.status !== "all") {
    whereClauses.push(eq(affiliatePrograms.status, input.status));
  }
  if (input.q && input.q.trim().length > 0) {
    whereClauses.push(ilike(affiliatePrograms.name, `%${input.q.trim()}%`));
  }

  const rows = await db
    .select({
      id: affiliatePrograms.id,
      name: affiliatePrograms.name,
      // Was a free-text column on `offers`; now the network's display name.
      network: affiliateNetworks.name,
      status: affiliatePrograms.status,
      confidence: affiliatePrograms.confidence,
      commissionType: affiliatePrograms.payoutType,
      commissionValue: affiliatePrograms.payoutValue,
      commissionUnit: affiliatePrograms.payoutUnit,
      cookieDays: affiliatePrograms.cookieDurationDays,
      marketName: markets.name,
      lastVerifiedAt: affiliatePrograms.lastVerifiedAt,
      updatedAt: affiliatePrograms.updatedAt,
    })
    .from(affiliatePrograms)
    .leftJoin(markets, eq(affiliatePrograms.marketId, markets.id))
    .leftJoin(affiliateNetworks, eq(affiliatePrograms.networkId, affiliateNetworks.id))
    .where(whereClauses.length > 0 ? and(...whereClauses) : undefined)
    .orderBy(desc(affiliatePrograms.updatedAt))
    .limit(limit);
  return rows;
}

export async function countOffersByStatus(): Promise<Record<OfferStatus, number>> {
  const rows = await db
    .select({ status: affiliatePrograms.status, id: affiliatePrograms.id })
    .from(affiliatePrograms);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts as Record<OfferStatus, number>;
}

export interface OfferDetail extends AffiliateProgramRow {
  marketName: string | null;
  networkName: string | null;
  anglesList: {
    id: string;
    audienceLabel: string | null;
    painPoint: string | null;
    status: string;
  }[];
}

export async function getOfferDetail(id: string): Promise<OfferDetail | null> {
  const [row] = await db
    .select({
      offer: affiliatePrograms,
      marketName: markets.name,
      networkName: affiliateNetworks.name,
    })
    .from(affiliatePrograms)
    .leftJoin(markets, eq(affiliatePrograms.marketId, markets.id))
    .leftJoin(affiliateNetworks, eq(affiliatePrograms.networkId, affiliateNetworks.id))
    .where(eq(affiliatePrograms.id, id))
    .limit(1);
  if (!row) return null;
  const anglesList = await db
    .select({
      id: angles.id,
      audienceLabel: angles.audienceLabel,
      painPoint: angles.painPoint,
      status: angles.status,
    })
    .from(angles)
    .where(eq(angles.offerId, id))
    .orderBy(desc(angles.updatedAt));
  return { ...row.offer, marketName: row.marketName, networkName: row.networkName, anglesList };
}

export interface CreateOfferInput {
  name: string;
  websiteUrl?: string | null;
  network?: string | null;
  marketId?: string | null;
  commissionType: "CPA" | "REVSHARE" | "RECURRING" | "HYBRID" | "UNKNOWN";
  commissionValue?: number | null;
  commissionUnit?: string | null;
  cookieDays?: number | null;
  countries?: string[] | null;
  notes?: string | null;
  actorId: string;
  requestId: string;
}

export async function createOffer(input: CreateOfferInput): Promise<{
  ok: true;
  offer: AffiliateProgramRow;
} | { ok: false; code: string; message: string }> {
  if (input.name.trim().length < 2) {
    return { ok: false, code: "VALIDATION_ERROR", message: "Tên offer ≥ 2 ký tự." };
  }
  return await db.transaction(async (tx) => {
    try {
      const [inserted] = await tx
        .insert(affiliatePrograms)
        .values({
          name: input.name.trim(),
          programUrl: input.websiteUrl ?? null,
          marketId: input.marketId ?? null,
          payoutType: input.commissionType,
          payoutValue: input.commissionValue ?? null,
          payoutUnit: input.commissionUnit ?? null,
          cookieDurationDays: input.cookieDays ?? null,
          notes: input.notes ?? null,
          status: "NEW",
          confidence: "UNVERIFIED",
          // Permissions are NOT set here. A programme nobody has researched
          // must read UNKNOWN, which is the column default.
        })
        .returning();
      if (!inserted) return { ok: false, code: "CONFLICT", message: "Không tạo được" };

      await tx.insert(auditEvents).values({
        actorType: "user",
        actorId: input.actorId,
        action: "aff.offer.create",
        entityType: "offer",
        entityId: inserted.id,
        beforeJson: null,
        afterJson: { name: inserted.name, status: inserted.status },
        requestId: input.requestId,
      });
      return { ok: true, offer: inserted };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("affiliate_programs_merchant_name_uq")) {
        return { ok: false, code: "CONFLICT", message: "Offer trùng tên trong cùng merchant." };
      }
      throw err;
    }
  });
}

export interface TransitionInput {
  offerId: string;
  toStatus: OfferStatus;
  actorId: string;
  reason?: string;
  requestId: string;
}

export type TransitionResult =
  | { ok: true; offer: AffiliateProgramRow }
  | { ok: false; code: "NOT_FOUND" | "INVALID_TRANSITION"; message: string };

export async function transitionOffer(input: TransitionInput): Promise<TransitionResult> {
  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(affiliatePrograms)
      .where(eq(affiliatePrograms.id, input.offerId))
      .for("update")
      .limit(1);
    if (!current) return { ok: false, code: "NOT_FOUND", message: "Offer không tồn tại." };
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(input.toStatus)) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message: `Không chuyển được từ ${current.status} sang ${input.toStatus}.`,
      };
    }
    const now = new Date();
    const [updated] = await tx
      .update(affiliatePrograms)
      .set({ status: input.toStatus, updatedAt: now })
      .where(eq(affiliatePrograms.id, current.id))
      .returning();
    if (!updated) return { ok: false, code: "NOT_FOUND", message: "Update fail." };

    await tx.insert(auditEvents).values({
      actorType: "user",
      actorId: input.actorId,
      action: "aff.offer.transition",
      entityType: "offer",
      entityId: current.id,
      beforeJson: { status: current.status },
      afterJson: { status: updated.status, reason: input.reason ?? null },
      requestId: input.requestId,
    });
    return { ok: true, offer: updated };
  });
}

/**
 * P2-R05 / G-21 — the second hard-coded TTL in the codebase.
 *
 * This used to be `30 * 24 * 60 * 60 * 1000` written inline. The number is
 * unchanged; what changed is where it comes from. An offer's freshness is a
 * *claim* TTL — a payout figure goes stale on the payout figure's schedule, not
 * on a constant that happens to live in this file — so it now reads from
 * `claimTtlDays`, alongside every other claim type.
 *
 * `now` is a parameter so this is testable without waiting or mocking a clock.
 */
export function isStale(lastVerifiedAt: Date | null, now: Date = new Date()): boolean {
  // Never verified is not fresh. It is also not "stale" in the sense of
  // "was true, has aged" — but for a badge that means "do not rely on this",
  // failing closed is the only safe direction.
  if (!lastVerifiedAt) return true;
  const ttlMs = claimTtlDays("payout_value") * 24 * 60 * 60 * 1000;
  return now.getTime() - lastVerifiedAt.getTime() > ttlMs;
}
