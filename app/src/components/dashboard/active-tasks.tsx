import Link from "next/link";
import { Activity, ChevronRight } from "lucide-react";
import type { ActiveTaskItem } from "@/lib/dashboard/summary";
import { cn } from "@/lib/utils";

export function ActiveTasks({ items }: { items: ActiveTaskItem[] }) {
  return (
    <section
      aria-labelledby="active-tasks-heading"
      className="rounded-lg border border-border bg-muted/10 p-4"
    >
      <h2
        id="active-tasks-heading"
        className="mb-3 flex items-center gap-2 text-sm font-medium"
      >
        <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Bot đang hoạt động
        <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {items.length}
        </span>
      </h2>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Không có nhiệm vụ đang chạy.
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href as never}
                className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 animate-pulse rounded-full",
                      item.status === "running" ? "bg-primary" : "bg-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-xs text-muted-foreground">{item.code}</span>
                  <span className="truncate">{item.title}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {item.currentStep ?? item.status}
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
