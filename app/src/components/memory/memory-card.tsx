"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, X, FileText, Brain } from "lucide-react";
import type { MemoryListItem } from "@/lib/memory/list";
import { cn } from "@/lib/utils";

const CATEGORY_LABEL: Record<string, string> = {
  user_profile: "User Profile",
  decision: "Decision",
  playbook: "Playbook",
  fact: "Fact",
};

const SCOPE_LABEL: Record<string, string> = {
  shared: "Chung",
  aff: "AFF",
  yt: "YouTube",
};

function confidenceLabel(v: number | null): string {
  if (v === null) return "—";
  if (v >= 0.75) return "Cao";
  if (v >= 0.4) return "Trung bình";
  return "Thấp";
}

function confidenceTone(v: number | null): string {
  if (v === null) return "bg-muted text-muted-foreground";
  if (v >= 0.75) return "bg-primary/15 text-primary";
  if (v >= 0.4) return "bg-amber-500/15 text-amber-500";
  return "bg-destructive/15 text-destructive";
}

export function MemoryCard({
  entry,
  canReview,
}: {
  entry: MemoryListItem;
  canReview: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rejectMode, setRejectMode] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const isProposed = entry.status === "PROPOSED";

  async function act(action: "approve" | "reject") {
    if (action === "reject" && reason.trim().length < 3) {
      setMsg({ type: "error", text: "Cần lý do ≥3 ký tự" });
      return;
    }
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/memory/${entry.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "approve" ? {} : { reason: reason.trim() }),
      });
      const body = (await res.json()) as {
        data: { status: string } | null;
        error: { message: string } | null;
      };
      if (!res.ok || body.error) {
        setMsg({ type: "error", text: body.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setMsg({ type: "success", text: `→ ${body.data?.status ?? action}` });
      setRejectMode(false);
      setReason("");
      startTransition(() => router.refresh());
    } catch (err) {
      setMsg({ type: "error", text: (err as Error).message });
    }
  }

  return (
    <article className="rounded-lg border border-border bg-muted/5 p-4 text-sm">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">{entry.title}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {CATEGORY_LABEL[entry.category] ?? entry.category}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {SCOPE_LABEL[entry.profileScope] ?? entry.profileScope}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            confidenceTone(entry.confidence),
          )}
        >
          Confidence: {confidenceLabel(entry.confidence)}
        </span>
        {entry.manualEntry ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
            Manual
          </span>
        ) : null}
      </header>

      <p className="mb-3 whitespace-pre-wrap break-words leading-relaxed">
        {entry.content.length > 400 ? entry.content.slice(0, 400) + "…" : entry.content}
      </p>

      {entry.reasonText ? (
        <p className="mb-3 text-xs italic text-muted-foreground">
          Lý do: {entry.reasonText}
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {entry.sourceTaskCode ? (
          <Link
            href={`/tasks/${entry.sourceTaskId}` as never}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-accent"
          >
            <FileText className="h-3 w-3" aria-hidden="true" />
            {entry.sourceTaskCode}
          </Link>
        ) : null}
        <span>Tạo: {entry.createdAt.toLocaleString("vi-VN")}</span>
        {entry.approvedBy ? <span>Duyệt: {entry.approvedBy}</span> : null}
      </div>

      {isProposed && canReview ? (
        rejectMode ? (
          <div className="space-y-2">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Lý do từ chối…"
              className="w-full resize-y rounded-md border border-border bg-background p-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => act("reject")}
                disabled={pending}
                className="rounded-md bg-destructive px-3 py-1 text-xs text-destructive-foreground disabled:opacity-50"
              >
                {pending ? "…" : "Từ chối"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRejectMode(false);
                  setReason("");
                  setMsg(null);
                }}
                className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
              >
                Huỷ
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => act("approve")}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Duyệt
            </button>
            <button
              type="button"
              onClick={() => setRejectMode(true)}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1 text-xs text-destructive hover:bg-destructive/20 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Từ chối
            </button>
          </div>
        )
      ) : null}

      {msg ? (
        <div
          role="status"
          className={cn(
            "mt-2 rounded-md px-2 py-1 text-xs",
            msg.type === "success"
              ? "bg-primary/10 text-primary"
              : "bg-destructive/10 text-destructive",
          )}
        >
          {msg.text}
        </div>
      ) : null}
    </article>
  );
}
