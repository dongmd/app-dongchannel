import type { OfferStatus } from "@/lib/db/schema/aff";
import { OFFER_STATUS_LABELS } from "@/lib/aff/offers";
import { cn } from "@/lib/utils";

const TONE: Record<OfferStatus, string> = {
  NEW: "bg-muted text-muted-foreground",
  RESEARCHING: "bg-primary/10 text-primary",
  WATCHLIST: "bg-primary/15 text-primary",
  APPROVED_FOR_TEST: "bg-primary/20 text-primary",
  TESTING: "bg-amber-500/15 text-amber-500",
  ITERATE: "bg-amber-500/20 text-amber-500",
  SCALE: "bg-primary/25 text-primary",
  STOP: "bg-destructive/15 text-destructive",
};

export function OfferStatusBadge({ status }: { status: OfferStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONE[status],
      )}
      aria-label={`Trạng thái offer: ${OFFER_STATUS_LABELS[status]}`}
    >
      {OFFER_STATUS_LABELS[status]}
    </span>
  );
}
