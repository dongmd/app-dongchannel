import Link from "next/link";
import { ChevronRight, Inbox } from "lucide-react";
import type { DecisionInboxItem } from "@/lib/dashboard/summary";
import { PROFILE_LABELS } from "@/lib/profiles/types";
import { cn } from "@/lib/utils";

// AC02 — click item mở đúng task/record nguồn (href đã có sẵn từ aggregator).
export function DecisionInbox({ items }: { items: DecisionInboxItem[] }) {
  return (
    <section
      aria-labelledby="decision-inbox-heading"
      className="rounded-lg border border-border bg-muted/10 p-4"
    >
      <h2
        id="decision-inbox-heading"
        className="mb-3 flex items-center gap-2 text-sm font-medium"
      >
        <Inbox className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Việc cần quyết định
        <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {items.length}
        </span>
      </h2>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Không có việc chờ duyệt. Khi bot hoàn thành nhiệm vụ, output sẽ hiện ở đây.
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
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      item.priority === "high"
                        ? "bg-destructive"
                        : item.priority === "normal"
                          ? "bg-primary"
                          : "bg-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.title}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {PROFILE_LABELS[item.profile].short}
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
