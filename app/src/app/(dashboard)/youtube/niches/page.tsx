import { YoutubeTabs } from "@/components/youtube/youtube-tabs";

export default function NichesPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">YouTube · Niches</h1>
        <p className="text-sm text-muted-foreground">
          Quản lý niche (demand/monetization/copyright risk score). Editor sẽ có ở DC-012b.
        </p>
      </header>
      <YoutubeTabs />
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Niches UI chưa xây. Schema `niches` đã sẵn — trong lúc chờ, INSERT qua SQL rồi gán qua field{" "}
        <code className="font-mono text-xs">niche_id</code> ở detail video.
      </div>
    </div>
  );
}
