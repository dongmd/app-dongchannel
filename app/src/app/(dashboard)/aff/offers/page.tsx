import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { listOffers, isStale, OFFER_STATUS_LABELS } from "@/lib/aff/offers";
import { offerStatusEnum, type OfferStatus } from "@/lib/db/schema/aff";
import { AffTabs } from "@/components/aff/aff-tabs";
import { OfferStatusBadge } from "@/components/aff/offer-status-badge";
import { ConfidenceBadge } from "@/components/aff/confidence-badge";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const STATUS_VALUES = offerStatusEnum.enumValues as OfferStatus[];

function pickStatus(raw: unknown): OfferStatus | "all" {
  if (typeof raw !== "string") return "all";
  if ((STATUS_VALUES as string[]).includes(raw)) return raw as OfferStatus;
  return "all";
}

function formatCommission(offer: {
  commissionType: string;
  commissionValue: number | null;
  commissionUnit: string | null;
}): string {
  if (!offer.commissionValue) return offer.commissionType;
  const unit = offer.commissionUnit === "percent" ? "%" : `${offer.commissionUnit ?? ""}`;
  return `${offer.commissionType} ${offer.commissionValue}${unit}`;
}

export default async function AffOffersPage({ searchParams }: Props) {
  const sp = await searchParams;
  const status = pickStatus(sp["status"]);
  const q = typeof sp["q"] === "string" ? sp["q"] : undefined;

  const items = await listOffers({ status, q });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">AFF Research</h1>
          <p className="text-sm text-muted-foreground">
            Pipeline: NEW → RESEARCHING → WATCHLIST → APPROVED_FOR_TEST → TESTING → ITERATE/SCALE/STOP
          </p>
        </div>
        <Link
          href="/aff/offers/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Thêm offer
        </Link>
      </header>

      <AffTabs />

      {/* Status filter chip row */}
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Link
          href="/aff/offers"
          className={`rounded-full border px-3 py-1 transition-colors ${status === "all" ? "border-primary text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
        >
          Tất cả
        </Link>
        {STATUS_VALUES.map((s) => (
          <Link
            key={s}
            href={`/aff/offers?status=${s}`}
            className={`rounded-full border px-3 py-1 transition-colors ${status === s ? "border-primary text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
          >
            {OFFER_STATUS_LABELS[s]}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {status === "all" ? (
            <>
              Chưa có offer nào. Thêm bằng nút <strong>Thêm offer</strong> hoặc giao mission cho AFF
              Bot qua Telegram.
            </>
          ) : (
            <>
              Không có offer ở trạng thái <strong>{OFFER_STATUS_LABELS[status]}</strong>.{" "}
              <Link href="/aff/offers" className="text-primary hover:underline">
                Xem tất cả
              </Link>
            </>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/5">
          {items.map((o) => (
            <li key={o.id}>
              <Link
                href={`/aff/offers/${o.id}`}
                className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{o.name}</span>
                    {o.network ? (
                      <span className="text-xs text-muted-foreground">/ {o.network}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatCommission(o)}</span>
                    {o.cookieDays ? <span>· cookie {o.cookieDays}d</span> : null}
                    {o.marketName ? <span>· {o.marketName}</span> : null}
                  </div>
                </div>
                <ConfidenceBadge confidence={o.confidence} stale={isStale(o.lastVerifiedAt)} />
                <OfferStatusBadge status={o.status} />
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
