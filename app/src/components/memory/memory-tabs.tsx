"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import type { MemoryTab } from "@/lib/memory/list";

interface TabDef {
  id: MemoryTab;
  label: string;
  badge?: number;
}

export function MemoryTabs({ current, pendingCount }: { current: MemoryTab; pendingCount: number }) {
  const pathname = usePathname();
  const params = useSearchParams();

  const tabs: TabDef[] = [
    { id: "pending", label: "Chờ duyệt", badge: pendingCount || undefined },
    { id: "user_profile", label: "User Profile" },
    { id: "decision", label: "Decision Log" },
    { id: "playbook", label: "Playbook" },
  ];

  function hrefFor(id: MemoryTab): string {
    const search = new URLSearchParams(params.toString());
    if (id === "pending") search.delete("tab");
    else search.set("tab", id);
    const qs = search.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <nav aria-label="Nhóm memory" className="flex flex-wrap gap-1 border-b border-border">
      {tabs.map((t) => {
        const active = t.id === current;
        return (
          <Link
            key={t.id}
            href={hrefFor(t.id) as never}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.badge ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                {t.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
