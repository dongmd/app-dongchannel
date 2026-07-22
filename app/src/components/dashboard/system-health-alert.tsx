import Link from "next/link";
import { AlertCircle, CircleAlert } from "lucide-react";
import type { HermesStatus } from "@/lib/hermes/status";
import { cn } from "@/lib/utils";

// AC05 — chỉ hiện khi impaired/down. Bình thường không chiếm không gian.
export function SystemHealthAlert({ hermes }: { hermes: HermesStatus }) {
  if (hermes.level === "ok") return null;

  const isDown = hermes.level === "down";
  const Icon = isDown ? AlertCircle : CircleAlert;
  const label = isDown ? "Hermes mất kết nối" : "Hermes gián đoạn";

  return (
    <section
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4 text-sm",
        isDown
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-500",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-xs opacity-80">
          {hermes.error ?? "Kiểm tra `/admin` để xem chi tiết."}
        </div>
      </div>
      <Link
        href="/admin"
        className="shrink-0 rounded-md border border-current px-2.5 py-1 text-xs font-medium hover:bg-background/40 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Xem quản trị
      </Link>
    </section>
  );
}
