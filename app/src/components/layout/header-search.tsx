"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";
import { Search } from "lucide-react";

// AC06 — header search submit → /search?q=... (giữ profile hiện tại).
export function HeaderSearch() {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState("");

  useEffect(() => {
    // Đồng bộ initial khi đang ở /search — user sửa được ngay.
    const qFromUrl = params.get("q");
    if (qFromUrl) setValue(qFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    const target = new URLSearchParams();
    target.set("q", q);
    // Preserve profile
    const profile = params.get("profile");
    if (profile) target.set("profile", profile);
    router.push(`/search?${target.toString()}`);
  }

  return (
    <form
      onSubmit={submit}
      role="search"
      className="flex flex-1 items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring"
    >
      <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Tìm task, offer, video, memory…"
        aria-label="Tìm kiếm toàn cục"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </form>
  );
}
