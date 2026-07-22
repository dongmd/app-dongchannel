import { AffTabs } from "@/components/aff/aff-tabs";

export default function AffAnglesPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">AFF · Angles</h1>
        <p className="text-sm text-muted-foreground">
          Pain point · Desire · Big idea · Promise · Mechanism. Editor sẽ có ở DC-011c.
        </p>
      </header>
      <AffTabs />
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Angles UI chưa xây. Angles của mỗi offer đang hiện ở phần dưới trang detail offer.
      </div>
    </div>
  );
}
