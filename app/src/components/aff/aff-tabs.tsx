"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/aff/offers", label: "Offers", match: (p: string) => p === "/aff" || p.startsWith("/aff/offers") },
  { href: "/aff/markets", label: "Markets", match: (p: string) => p.startsWith("/aff/markets") },
  { href: "/aff/angles", label: "Angles", match: (p: string) => p.startsWith("/aff/angles") },
  { href: "/aff/results", label: "Tests & Results", match: (p: string) => p.startsWith("/aff/results") },
];

export function AffTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="AFF sub-nav" className="flex flex-wrap gap-1 border-b border-border">
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
