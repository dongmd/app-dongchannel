export default function TasksPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Công việc</h1>
        <p className="text-sm text-muted-foreground">
          Danh sách nhiệm vụ từ Telegram và dashboard (sẽ có ở DC-007).
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Chưa có nhiệm vụ nào — hãy gửi yêu cầu cho AFF Bot hoặc YouTube Bot trên Telegram.
      </div>
    </div>
  );
}
