"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/youtube/videos", label: "Videos", match: (p: string) => p === "/youtube" || p.startsWith("/youtube/videos") },
  { href: "/youtube/ideas", label: "Ideas", match: (p: string) => p.startsWith("/youtube/ideas") },
  { href: "/youtube/production", label: "Production", match: (p: string) => p.startsWith("/youtube/production") },
  { href: "/youtube/performance", label: "Performance", match: (p: string) => p.startsWith("/youtube/performance") },
  { href: "/youtube/niches", label: "Niches", match: (p: string) => p.startsWith("/youtube/niches") },
];

export function YoutubeTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="YouTube sub-nav" className="flex flex-wrap gap-1 border-b border-border">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href as never}
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
