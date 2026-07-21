export default function MemoryPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Trí nhớ</h1>
        <p className="text-sm text-muted-foreground">
          Chờ duyệt · User Profile · Decision Log · Playbook (sẽ có ở DC-010).
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Chưa có memory proposal nào. Sau khi bot chạy task, proposal sẽ hiện ở đây chờ duyệt.
      </div>
    </div>
  );
}
