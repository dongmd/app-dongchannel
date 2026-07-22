"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { HermesHealthLevel, HermesStatus } from "@/lib/hermes/status";
import { cn } from "@/lib/utils";

// AC04 — compact indicator ở header (dot + text). Click mở /admin.
// Poll cùng endpoint /api/v1/admin/hermes-status (server cache 30s → chỉ 1 hit thật/30s dù nhiều tab).
// V1 chỉ visible cho user đã đăng nhập (do trong header của dashboard layout).

const LABELS: Record<HermesHealthLevel, string> = {
  ok: "Hoạt động",
  impaired: "Gián đoạn",
  down: "Mất kết nối",
};

const DOT_STYLES: Record<HermesHealthLevel, string> = {
  ok: "bg-primary",
  impaired: "bg-amber-500",
  down: "bg-destructive",
};

const TEXT_STYLES: Record<HermesHealthLevel, string> = {
  ok: "text-muted-foreground",
  impaired: "text-amber-500",
  down: "text-destructive",
};

export function HeaderStatusIndicator() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchStatus() {
      try {
        const res = await fetch("/api/v1/admin/hermes-status", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { data: HermesStatus | null };
        if (!cancelled && body.data) setStatus(body.data);
      } catch {
        // giữ trạng thái cũ
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    fetchStatus();
    const id = setInterval(fetchStatus, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!loaded && !status) {
    return (
      <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
        <span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden="true" />
        Đang tải…
      </span>
    );
  }

  if (!status) return null;

  return (
    <Link
      href="/admin"
      aria-label={`Trạng thái Hermes: ${LABELS[status.level]} — mở trang quản trị`}
      className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring md:inline-flex"
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", DOT_STYLES[status.level])}
        aria-hidden="true"
      />
      <span className={TEXT_STYLES[status.level]}>Hermes: {LABELS[status.level]}</span>
    </Link>
  );
}
