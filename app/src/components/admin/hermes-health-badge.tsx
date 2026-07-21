"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CircleAlert, RefreshCcw } from "lucide-react";
import type { HermesHealthLevel, HermesStatus } from "@/lib/hermes/status";
import { cn } from "@/lib/utils";

// AC03 — badge tự refetch mỗi 60s (server cache 30s + in-flight dedup → tối đa 1 hit thật/30s).
// Level map từ gateway_running/state của Hermes (BR10), không suy đoán từ latency.
// Chữ + icon + màu → PRD nguyên tắc "không dùng màu đơn độc để diễn đạt status".

const LABELS: Record<HermesHealthLevel, string> = {
  ok: "Hoạt động",
  impaired: "Gián đoạn",
  down: "Mất kết nối",
};

const STYLES: Record<HermesHealthLevel, string> = {
  ok: "border-primary/40 bg-primary/10 text-primary",
  impaired: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  down: "border-destructive/40 bg-destructive/10 text-destructive",
};

const ICONS: Record<HermesHealthLevel, typeof CheckCircle2> = {
  ok: CheckCircle2,
  impaired: CircleAlert,
  down: AlertCircle,
};

export function HermesHealthBadge({ initial }: { initial: HermesStatus }) {
  const [status, setStatus] = useState<HermesStatus>(initial);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/hermes-status", { cache: "no-store" });
      const body = (await res.json()) as { data: HermesStatus | null };
      if (body.data) setStatus(body.data);
    } catch {
      // giữ status cũ, badge không đổi
    } finally {
      setLoading(false);
    }
  }

  const Icon = ICONS[status.level];
  const details: string[] = [];
  if (status.ms !== undefined) details.push(`${status.ms}ms`);
  if (status.version) details.push(`v${status.version}`);
  if (status.gatewayState) details.push(`gateway: ${status.gatewayState}`);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2 text-sm",
        STYLES[status.level],
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <div className="flex flex-col leading-tight">
        <span className="font-medium">Hermes: {LABELS[status.level]}</span>
        <span className="text-xs opacity-80">
          {details.length > 0 ? `${details.join(" · ")} · ` : ""}
          check {new Date(status.checkedAt).toLocaleTimeString("vi-VN")}
        </span>
        {status.error ? <span className="text-xs opacity-80">{status.error}</span> : null}
      </div>
      <button
        type="button"
        onClick={refresh}
        disabled={loading}
        aria-label="Kiểm tra lại"
        className="ml-auto rounded p-1 hover:bg-background/40 disabled:opacity-50"
      >
        <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden="true" />
      </button>
    </div>
  );
}
