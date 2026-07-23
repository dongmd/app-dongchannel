// Client-safe constants — pipeline labels + transition graph.
// KHÔNG import server-only. Client components (transition buttons, status badge)
// import trực tiếp từ đây thay vì lib/aff/offers.ts (server-only).
import type { OfferStatus } from "@/lib/db/schema/aff";

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  NEW: "Mới",
  RESEARCHING: "Đang nghiên cứu",
  WATCHLIST: "Watchlist",
  APPROVED_FOR_TEST: "Duyệt test",
  TESTING: "Đang test",
  ITERATE: "Iterate",
  SCALE: "Scale",
  STOP: "Dừng",
};

const ALLOWED_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  NEW: ["RESEARCHING", "STOP"],
  RESEARCHING: ["WATCHLIST", "STOP", "NEW"],
  WATCHLIST: ["APPROVED_FOR_TEST", "STOP", "RESEARCHING"],
  APPROVED_FOR_TEST: ["TESTING", "STOP", "WATCHLIST"],
  TESTING: ["ITERATE", "SCALE", "STOP"],
  ITERATE: ["TESTING", "SCALE", "STOP"],
  SCALE: ["ITERATE", "STOP"],
  STOP: [],
};

export function nextStatuses(current: OfferStatus): OfferStatus[] {
  return ALLOWED_TRANSITIONS[current] ?? [];
}

export function allowedTransitionsGraph(): Record<OfferStatus, OfferStatus[]> {
  return ALLOWED_TRANSITIONS;
}
