"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import type { StatusGroup } from "@/lib/tasks/list";

interface TabDef {
  id: StatusGroup;
  label: string;
}
const TABS: TabDef[] = [
  { id: "all", label: "Tất cả" },
  { id: "pending_review", label: "Chờ duyệt" },
  { id: "running", label: "Đang chạy" },
  { id: "alerts", label: "Cảnh báo" },
  { id: "completed", label: "Hoàn thành" },
];

// AC02 — status tabs. Đổi tab preserve các query khác (profile, q).
// Cursor bị reset khi đổi tab (query mới → cursor cũ vô nghĩa).
export function TaskFilterTabs({ current }: { current: StatusGroup }) {
  const pathname = usePathname();
  const params = useSearchParams();

  function hrefFor(id: StatusGroup): string {
    const search = new URLSearchParams(params.toString());
    if (id === "all") search.delete("status");
    else search.set("status", id);
    search.delete("cursor");
    const qs = search.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <nav aria-label="Lọc theo trạng thái" className="flex flex-wrap gap-1 border-b border-border">
      {TABS.map((t) => {
        const active = t.id === current;
        return (
          <Link
            key={t.id}
            href={hrefFor(t.id) as never}
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-b-2 px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
