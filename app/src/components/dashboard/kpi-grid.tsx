import { AlertTriangle, CheckCircle2, Clock, Play } from "lucide-react";
import type { KpiCounts } from "@/lib/dashboard/summary";
import { cn } from "@/lib/utils";

// AC03/AC08 — 4 KPI card compact.
// AC08 — không có card kỹ thuật token/cost ở vị trí ưu tiên.
//
// P3-R08 AC-09 — "chưa có" và "0 thực sự" là hai giá trị khác nhau, không phải
// hai sắc độ của cùng một giá trị. Trước đây cả hai đều render `0` và chỉ khác
// độ mờ; màu không phải là giá trị, và screen reader vẫn đọc "0". Giá trị chưa
// đo được giờ render UNKNOWN.
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
        const isUnknown = value === null;
        const isZero = value === 0;
        const display = isUnknown ? "UNKNOWN" : String(value);
        return (
          <div
            key={key}
            className="rounded-lg border border-border bg-muted/10 p-4"
            aria-label={isUnknown ? `${label}: chưa có số liệu` : `${label}: ${value}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              <Icon
                className={cn(
                  "h-4 w-4",
                  isUnknown || isZero ? "text-muted-foreground/40" : TONE_STYLES[tone],
                )}
                aria-hidden="true"
              />
            </div>
            <div
              className={cn(
                "mt-2 font-mono font-semibold",
                isUnknown ? "text-sm tracking-wide text-muted-foreground" : "text-3xl",
                !isUnknown && isZero ? "text-muted-foreground/40" : "",
                !isUnknown && !isZero ? "text-foreground" : "",
              )}
            >
              {display}
            </div>
          </div>
        );
      })}
    </section>
  );
}
