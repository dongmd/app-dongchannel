import "server-only";
import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  angles,
  markets,
  offers,
  type OfferConfidence,
  type OfferRow,
  type OfferStatus,
} from "@/lib/db/schema/aff";
import { auditEvents } from "@/lib/db/schema/audit";
import { allowedTransitionsGraph, nextStatuses, OFFER_STATUS_LABELS } from "./labels";

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
    whereClauses.push(eq(offers.status, input.status));
  }
  if (input.q && input.q.trim().length > 0) {
    whereClauses.push(ilike(offers.name, `%${input.q.trim()}%`));
  }

  const rows = await db
    .select({
      id: offers.id,
      name: offers.name,
      network: offers.network,
      status: offers.status,
      confidence: offers.confidence,
      commissionType: offers.commissionType,
      commissionValue: offers.commissionValue,
      commissionUnit: offers.commissionUnit,
      cookieDays: offers.cookieDays,
      marketName: markets.name,
      lastVerifiedAt: offers.lastVerifiedAt,
      updatedAt: offers.updatedAt,
    })
    .from(offers)
    .leftJoin(markets, eq(offers.marketId, markets.id))
    .where(whereClauses.length > 0 ? and(...whereClauses) : undefined)
    .orderBy(desc(offers.updatedAt))
    .limit(limit);
  return rows;
}

export async function countOffersByStatus(): Promise<Record<OfferStatus, number>> {
  const rows = await db
    .select({ status: offers.status, id: offers.id })
    .from(offers);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts as Record<OfferStatus, number>;
}

export interface OfferDetail extends OfferRow {
  marketName: string | null;
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
      offer: offers,
      marketName: markets.name,
    })
    .from(offers)
    .leftJoin(markets, eq(offers.marketId, markets.id))
    .where(eq(offers.id, id))
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
  return { ...row.offer, marketName: row.marketName, anglesList };
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
  offer: OfferRow;
} | { ok: false; code: string; message: string }> {
  if (input.name.trim().length < 2) {
    return { ok: false, code: "VALIDATION_ERROR", message: "Tên offer ≥ 2 ký tự." };
  }
  return await db.transaction(async (tx) => {
    try {
      const [inserted] = await tx
        .insert(offers)
        .values({
          name: input.name.trim(),
          websiteUrl: input.websiteUrl ?? null,
          network: input.network ?? null,
          marketId: input.marketId ?? null,
          commissionType: input.commissionType,
          commissionValue: input.commissionValue ?? null,
          commissionUnit: input.commissionUnit ?? null,
          cookieDays: input.cookieDays ?? null,
          countries: input.countries ?? null,
          notes: input.notes ?? null,
          status: "NEW",
          confidence: "UNVERIFIED",
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
        afterJson: { name: inserted.name, network: inserted.network, status: inserted.status },
        requestId: input.requestId,
      });
      return { ok: true, offer: inserted };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("offers_market_name_uq")) {
        return { ok: false, code: "CONFLICT", message: "Offer trùng tên trong cùng market." };
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
  | { ok: true; offer: OfferRow }
  | { ok: false; code: "NOT_FOUND" | "INVALID_TRANSITION"; message: string };

export async function transitionOffer(input: TransitionInput): Promise<TransitionResult> {
  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(offers)
      .where(eq(offers.id, input.offerId))
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
      .update(offers)
      .set({ status: input.toStatus, updatedAt: now })
      .where(eq(offers.id, current.id))
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

export function isStale(lastVerifiedAt: Date | null): boolean {
  if (!lastVerifiedAt) return true;
  return Date.now() - lastVerifiedAt.getTime() > 30 * 24 * 60 * 60 * 1000;
}
