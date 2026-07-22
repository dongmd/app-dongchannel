"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, useEffect } from "react";
import { Search, X } from "lucide-react";

// AC03 — search title contains. Debounce 300ms để không thrash router.
export function TaskSearchInput({ initial }: { initial: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(initial);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const t = setTimeout(() => {
      if (value === initial) return;
      const search = new URLSearchParams(params.toString());
      if (value.trim()) search.set("q", value.trim());
      else search.delete("q");
      search.delete("cursor");
      const qs = search.toString();
      startTransition(() => router.push(`${pathname}${qs ? `?${qs}` : ""}` as never));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="relative w-full max-w-sm">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Tìm theo tiêu đề…"
        aria-label="Tìm nhiệm vụ theo tiêu đề"
        className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {value ? (
        <button
          type="button"
          onClick={() => setValue("")}
          aria-label="Xoá tìm kiếm"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
