import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AffTabs } from "@/components/aff/aff-tabs";
import { NewOfferForm } from "@/components/aff/new-offer-form";

export default function NewOfferPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href="/aff/offers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        AFF Offers
      </Link>

      <AffTabs />

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Thêm offer mới</h1>
        <p className="text-sm text-muted-foreground">
          Tạo offer ở trạng thái NEW. Chuyển pipeline sau khi verify thêm thông tin.
        </p>
      </header>

      <NewOfferForm />
    </div>
  );
}
