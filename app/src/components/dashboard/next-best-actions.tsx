import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { NextBestAction } from "@/lib/dashboard/summary";

export function NextBestActions({ actions }: { actions: NextBestAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section
      aria-labelledby="nba-heading"
      className="rounded-lg border border-primary/40 bg-primary/5 p-4"
    >
      <h2
        id="nba-heading"
        className="mb-3 flex items-center gap-2 text-sm font-medium text-primary"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        Hành động đề xuất
      </h2>
      <ul className="space-y-2">
        {actions.map((action) => {
          const isExternal = action.href.startsWith("http");
          const content = (
            <>
              <span className="block text-sm font-medium">{action.title}</span>
              <span className="block text-xs text-muted-foreground">{action.reason}</span>
            </>
          );
          return (
            <li key={action.id}>
              {isExternal ? (
                <a
                  href={action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-md px-3 py-2 hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {content}
                </a>
              ) : (
                <Link
                  href={action.href as never}
                  className="block rounded-md px-3 py-2 hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
