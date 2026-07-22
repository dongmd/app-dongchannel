"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowRight } from "lucide-react";
import type { OfferStatus } from "@/lib/db/schema/aff";
import { OFFER_STATUS_LABELS } from "@/lib/aff/offers";
import { cn } from "@/lib/utils";

interface Props {
  offerId: string;
  currentStatus: OfferStatus;
  allowed: OfferStatus[];
}

export function OfferTransitionButtons({ offerId, currentStatus, allowed }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<OfferStatus | null>(null);
  const [reason, setReason] = useState("");

  const stopRequiresReason = confirming === "STOP";

  async function submit(to: OfferStatus) {
    if (to === "STOP" && reason.trim().length < 3) {
      setMsg({ type: "error", text: "STOP cần lý do ≥3 ký tự." });
      return;
    }
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/aff/offers/${offerId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toStatus: to, reason: reason.trim() || undefined }),
      });
      const body = (await res.json()) as {
        data: { status: string } | null;
        error: { message: string } | null;
      };
      if (!res.ok || body.error) {
        setMsg({ type: "error", text: body.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setMsg({ type: "success", text: `${currentStatus} → ${body.data?.status ?? to}` });
      setConfirming(null);
      setReason("");
      startTransition(() => router.refresh());
    } catch (err) {
      setMsg({ type: "error", text: (err as Error).message });
    }
  }

  return (
    <section
      aria-labelledby="offer-transition-heading"
      className="space-y-3 rounded-lg border border-border bg-muted/10 p-4"
    >
      <h2 id="offer-transition-heading" className="text-sm font-medium">
        Chuyển trạng thái
      </h2>

      {confirming && stopRequiresReason ? (
        <div className="space-y-2">
          <label className="block text-xs text-muted-foreground">Lý do STOP (bắt buộc)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="VD: Cookie 1 ngày quá ngắn cho traffic FB, ROI âm sau test."
            className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => submit("STOP")}
              disabled={pending}
              className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground disabled:opacity-50"
            >
              {pending ? "…" : "Xác nhận STOP"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(null);
                setReason("");
                setMsg(null);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Huỷ
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {allowed.map((to) => (
            <button
              key={to}
              type="button"
              onClick={() => {
                if (to === "STOP") setConfirming("STOP");
                else void submit(to);
              }}
              disabled={pending}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50",
                to === "STOP"
                  ? "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20"
                  : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
              )}
            >
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
              {OFFER_STATUS_LABELS[to]}
            </button>
          ))}
        </div>
      )}

      {msg ? (
        <div
          role="status"
          className={cn(
            "rounded-md px-3 py-2 text-xs",
            msg.type === "success"
              ? "bg-primary/10 text-primary"
              : "bg-destructive/10 text-destructive",
          )}
        >
          {msg.text}
        </div>
      ) : null}
    </section>
  );
}
