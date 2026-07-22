import { AffTabs } from "@/components/aff/aff-tabs";

export default function AffResultsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">AFF · Tests & Results</h1>
        <p className="text-sm text-muted-foreground">
          Impressions/clicks/leads/sales/commission/profit theo offer + angle + period. Form nhập sẽ có ở DC-014.
        </p>
      </header>
      <AffTabs />
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Results UI chưa xây. Schema `affiliate_results` đã sẵn để DC-014 chỉ cần render + form.
      </div>
    </div>
  );
}
