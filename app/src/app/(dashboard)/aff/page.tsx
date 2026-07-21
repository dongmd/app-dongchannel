export default function AffPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">AFF Research</h1>
        <p className="text-sm text-muted-foreground">
          Markets · Offers · Angles · Tests & Results (sẽ có ở DC-011).
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Chưa có offer nào. Gửi mission AFF-* cho AFF Bot để bắt đầu research.
      </div>
    </div>
  );
}
