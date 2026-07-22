import { AffTabs } from "@/components/aff/aff-tabs";

export default function AffMarketsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">AFF · Markets</h1>
        <p className="text-sm text-muted-foreground">
          Quản lý thị trường (health/pet/finance/…). Sẽ có ở follow-up story DC-011b.
        </p>
      </header>
      <AffTabs />
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Markets UI chưa xây. Trong lúc chờ, gán market cho offer qua field <code className="font-mono text-xs">market_id</code>.
      </div>
    </div>
  );
}
