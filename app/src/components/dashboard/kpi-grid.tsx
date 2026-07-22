import { AlertTriangle, CheckCircle2, Clock, Play } from "lucide-react";
import type { KpiCounts } from "@/lib/dashboard/summary";
import { cn } from "@/lib/utils";

// AC03/AC08 — 4 KPI card compact. Số 0 hiển thị màu nhạt để phân biệt "chưa có" vs "0 thực sự".
// AC08 — không có card kỹ thuật token/cost ở vị trí ưu tiên.
const KPIS: {
  key: keyof KpiCounts;
  label: string;
  icon: typeof Clock;
  tone: "primary" | "warning" | "destructive";
}[] = [
  { key: "pendingReview", label: "Chờ duyệt", icon: Clock, tone: "primary" },
  { key: "running", label: "Đang chạy", icon: Play, tone: "primary" },
  { key: "alerts", label: "Cảnh báo", icon: AlertTriangle, tone: "destructive" },
  { key: "activeTests", label: "Test đang active", icon: CheckCircle2, tone: "primary" },
];

const TONE_STYLES: Record<"primary" | "warning" | "destructive", string> = {
  primary: "text-primary",
  warning: "text-amber-500",
  destructive: "text-destructive",
};

export function KpiGrid({ counts }: { counts: KpiCounts }) {
  return (
    <section
      aria-label="Chỉ số tổng quan"
      className="grid grid-cols-2 gap-3 md:grid-cols-4"
    >
      {KPIS.map(({ key, label, icon: Icon, tone }) => {
        const value = counts[key];
        const isZero = value === 0;
        return (
          <div
            key={key}
            className="rounded-lg border border-border bg-muted/10 p-4"
            aria-label={`${label}: ${value}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              <Icon
                className={cn("h-4 w-4", isZero ? "text-muted-foreground/40" : TONE_STYLES[tone])}
                aria-hidden="true"
              />
            </div>
            <div
              className={cn(
                "mt-2 font-mono text-3xl font-semibold",
                isZero ? "text-muted-foreground/40" : "text-foreground",
              )}
            >
              {value}
            </div>
          </div>
        );
      })}
    </section>
  );
}
