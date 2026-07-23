"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowRight } from "lucide-react";
import type { VideoStatus } from "@/lib/db/schema/youtube";
import { VIDEO_STATUS_LABELS } from "@/lib/youtube/labels";
import { cn } from "@/lib/utils";

interface Props {
  videoId: string;
  currentStatus: VideoStatus;
  allowed: VideoStatus[];
  currentPublishUrl: string | null;
}

export function VideoTransitionButtons({ videoId, currentStatus, allowed, currentPublishUrl }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<VideoStatus | null>(null);
  const [publishUrl, setPublishUrl] = useState(currentPublishUrl ?? "");
  const [reason, setReason] = useState("");

  const needsUrl = confirming === "PUBLISHED";

  async function submit(to: VideoStatus) {
    setMsg(null);
    const payload: Record<string, string | undefined> = { toStatus: to };
    if (reason.trim()) payload["reason"] = reason.trim();
    if (to === "PUBLISHED") {
      if (!publishUrl.trim()) {
        setMsg({ type: "error", text: "Cần publish URL để chuyển PUBLISHED." });
        return;
      }
      payload["publishUrl"] = publishUrl.trim();
    }
    try {
      const res = await fetch(`/api/v1/youtube/videos/${videoId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      aria-labelledby="video-transition-heading"
      className="space-y-3 rounded-lg border border-border bg-muted/10 p-4"
    >
      <h2 id="video-transition-heading" className="text-sm font-medium">
        Chuyển trạng thái
      </h2>

      {confirming && needsUrl ? (
        <div className="space-y-2">
          <label className="block text-xs text-muted-foreground">
            Publish URL (bắt buộc — YouTube video URL)
          </label>
          <input
            type="url"
            value={publishUrl}
            onChange={(e) => setPublishUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <label className="block text-xs text-muted-foreground">Ghi chú (optional)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={2000}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => submit("PUBLISHED")}
              disabled={pending}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              {pending ? "…" : "Xác nhận PUBLISHED"}
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
                if (to === "PUBLISHED") setConfirming("PUBLISHED");
                else void submit(to);
              }}
              disabled={pending}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm text-primary transition-colors hover:bg-primary/20 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50",
              )}
            >
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
              {VIDEO_STATUS_LABELS[to]}
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
