import { computeDashboardSummary } from "@/lib/dashboard/summary";
import { getProfileFilter } from "@/lib/profiles/server";
import { PROFILE_LABELS } from "@/lib/profiles/types";
import { KpiGrid } from "@/components/dashboard/kpi-grid";
import { DecisionInbox } from "@/components/dashboard/decision-inbox";
import { ActiveTasks } from "@/components/dashboard/active-tasks";
import { NextBestActions } from "@/components/dashboard/next-best-actions";
import { SystemHealthAlert } from "@/components/dashboard/system-health-alert";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OverviewPage({ searchParams }: Props) {
  const profile = await getProfileFilter(searchParams);
  const summary = await computeDashboardSummary(profile);
  const profileLabel = PROFILE_LABELS[profile];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Tổng quan</h1>
          <p className="text-sm text-muted-foreground">
            Việc cần xử lý trong 5 giây sau khi mở dashboard (PRD mục 3.1).
          </p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground"
          title={`Đang lọc theo ${profileLabel.long}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Profile: <strong className="text-foreground">{profileLabel.short}</strong>
        </span>
      </header>

      <SystemHealthAlert hermes={summary.hermes} />

      <KpiGrid counts={summary.kpi} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DecisionInbox items={summary.decisionInbox} />
        <ActiveTasks items={summary.activeTasks} />
      </div>

      <NextBestActions actions={summary.nextBestActions} />

      <footer className="text-xs text-muted-foreground">
        Cập nhật {new Date(summary.generatedAt).toLocaleTimeString("vi-VN")} · cache 30s ·{" "}
        <span className="font-mono">tasks/memory sẽ có ở DC-006/010</span>
      </footer>
    </div>
  );
}
