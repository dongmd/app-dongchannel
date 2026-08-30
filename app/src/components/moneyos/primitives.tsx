import Link from "next/link";
import type { Route } from "next";

import { EMPTY_REASONS, UNKNOWN } from "@/lib/moneyos/display-policy";

/**
 * P4-R11 — the shared pieces every AI Money OS surface uses.
 *
 * These exist so the honest cases are the EASY cases. An empty state that took
 * effort to write correctly would eventually be skipped; one component away, it
 * will not be.
 */

/**
 * `AC-08`. What a surface says when it genuinely has no rows.
 *
 * Three things, deliberately: what the surface is, **why** it is empty in terms
 * of the pipeline, and **what would fill it**. A bare "Chưa có dữ liệu" would be
 * true and useless — the reader cannot tell an empty table from a broken query,
 * and every one of these tables is empty in production right now.
 *
 * No sample row. No placeholder. Nothing that could be mistaken for data.
 */
export function EmptyState({ reasonKey }: { reasonKey: string }) {
  const r = EMPTY_REASONS[reasonKey];
  return (
    <div
      data-testid="empty-state"
      className="rounded-lg border border-dashed border-border px-6 py-10 text-center"
    >
      <p className="text-sm font-medium text-foreground">
        {r ? r.what : "Bề mặt này"} — chưa có dữ liệu
      </p>
      {r && (
        <>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{r.why}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            Sẽ có dữ liệu khi: <span className="font-mono">{r.filledBy}</span>
          </p>
        </>
      )}
      <p className="mt-4 text-xs text-muted-foreground/70">
        Bảng trống thật, không phải lỗi tải.
      </p>
    </div>
  );
}

/**
 * `AC-04`. A value the system does not have.
 *
 * Rendered as the word, in a muted style that is visibly not a number. The
 * failure this prevents is a missing score displayed as `0` and read as a low
 * score — and a dash or an empty cell reads the same way.
 */
export function Unknown() {
  return (
    <span data-testid="unknown" className="font-mono text-xs text-muted-foreground/70">
      {UNKNOWN}
    </span>
  );
}

/** Renders a value, or `UNKNOWN` when it is absent. */
export function Value({ children }: { children: string }) {
  return children === UNKNOWN ? <Unknown /> : <>{children}</>;
}

export function PageHeader({
  title,
  description,
  owner,
}: {
  title: string;
  description: string;
  owner?: string;
}) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
      {owner && (
        <p className="text-xs text-muted-foreground/70">
          Nguồn dữ liệu: <span className="font-mono">{owner}</span>
        </p>
      )}
    </header>
  );
}

export function Table({
  headers,
  children,
}: {
  headers: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-muted/40">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bad: "bg-red-500/10 text-red-600 dark:text-red-400",
  } as const;
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** One card on the Money OS index. The count is real, never a literal. */
export function SurfaceCard({
  href,
  title,
  description,
  count,
}: {
  href: Route;
  title: string;
  description: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-border p-4 transition-colors hover:border-foreground/30 hover:bg-muted/30"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{title}</span>
        <span
          className={`font-mono text-lg tabular-nums ${
            count === 0 ? "text-muted-foreground/50" : "text-foreground"
          }`}
        >
          {count}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </Link>
  );
}
