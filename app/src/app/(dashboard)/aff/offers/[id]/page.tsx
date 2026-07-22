import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getOfferDetail, isStale, nextStatuses } from "@/lib/aff/offers";
import { authOptions } from "@/lib/auth/options";
import { AffTabs } from "@/components/aff/aff-tabs";
import { OfferStatusBadge } from "@/components/aff/offer-status-badge";
import { ConfidenceBadge } from "@/components/aff/confidence-badge";
import { OfferTransitionButtons } from "@/components/aff/offer-transition-buttons";

export default async function OfferDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [offer, session] = await Promise.all([getOfferDetail(id), getServerSession(authOptions)]);
  if (!offer) notFound();
  const canEdit = session?.user?.role === "OWNER" || session?.user?.role === "ADMIN";
  const next = nextStatuses(offer.status);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/aff/offers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        AFF Offers
      </Link>

      <AffTabs />

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <OfferStatusBadge status={offer.status} />
          <ConfidenceBadge confidence={offer.confidence} stale={isStale(offer.lastVerifiedAt)} />
          {offer.network ? (
            <span className="text-xs text-muted-foreground">Network: {offer.network}</span>
          ) : null}
          {offer.marketName ? (
            <span className="text-xs text-muted-foreground">Market: {offer.marketName}</span>
          ) : null}
        </div>
        <h1 className="text-2xl font-semibold">{offer.name}</h1>
        {offer.websiteUrl ? (
          <a
            href={offer.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {offer.websiteUrl}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : null}
      </header>

      {/* Transition buttons */}
      {canEdit && next.length > 0 ? (
        <OfferTransitionButtons offerId={offer.id} currentStatus={offer.status} allowed={next} />
      ) : null}

      <section
        aria-label="Chi tiết offer"
        className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-muted/10 p-4 text-sm md:grid-cols-4"
      >
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Commission</div>
          <div className="mt-1 font-mono text-xs">
            {offer.commissionType}
            {offer.commissionValue ? ` · ${offer.commissionValue}${offer.commissionUnit === "percent" ? "%" : offer.commissionUnit ?? ""}` : ""}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Cookie</div>
          <div className="mt-1 font-mono text-xs">
            {offer.cookieDays ? `${offer.cookieDays} ngày` : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Payout min</div>
          <div className="mt-1 font-mono text-xs">
            {offer.payoutThreshold ? `$${offer.payoutThreshold}` : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Countries</div>
          <div className="mt-1 font-mono text-xs">
            {offer.countries?.length ? offer.countries.join(", ") : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Verified lúc</div>
          <div className="mt-1 text-xs">
            {offer.lastVerifiedAt ? offer.lastVerifiedAt.toLocaleDateString("vi-VN") : "Chưa xác minh"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Tạo</div>
          <div className="mt-1 text-xs">{offer.createdAt.toLocaleDateString("vi-VN")}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Cập nhật</div>
          <div className="mt-1 text-xs">{offer.updatedAt.toLocaleString("vi-VN")}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Angles</div>
          <div className="mt-1 font-mono text-xs">{offer.anglesList.length}</div>
        </div>
      </section>

      {offer.notes ? (
        <section aria-labelledby="notes-heading" className="space-y-2">
          <h2 id="notes-heading" className="text-sm font-medium text-muted-foreground">
            Ghi chú
          </h2>
          <p className="whitespace-pre-wrap break-words text-sm">{offer.notes}</p>
        </section>
      ) : null}

      <section aria-labelledby="angles-heading" className="space-y-2">
        <h2 id="angles-heading" className="text-sm font-medium text-muted-foreground">
          Angles ({offer.anglesList.length})
        </h2>
        {offer.anglesList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            Chưa có angle nào. Angles tab UI + form sẽ có ở follow-up story.
          </div>
        ) : (
          <ul className="space-y-1">
            {offer.anglesList.map((a) => (
              <li
                key={a.id}
                className="rounded-md border border-border bg-muted/5 p-3 text-xs"
              >
                <div className="font-medium">{a.audienceLabel ?? "(chưa gán audience)"}</div>
                {a.painPoint ? (
                  <div className="mt-0.5 text-muted-foreground">Pain: {a.painPoint}</div>
                ) : null}
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  status: {a.status}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        Form nhập kết quả affiliate + Angles editor sẽ có ở DC-014 (Result forms).
      </div>
    </div>
  );
}

// Force dynamic rendering — session state per user.
export const dynamic = "force-dynamic";
