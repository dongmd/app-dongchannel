"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, MessageCircleWarning, X } from "lucide-react";
import type { TaskStatus } from "@/lib/db/schema/tasks";
import { cn } from "@/lib/utils";

// AC01/AC02/AC04/AC07 — 3 button, disable nếu status ngoài IMPORTED/WAITING_REVIEW,
// disable với VIEWER (canReview=false), reason textarea cho revision/reject.

type Action = "approve" | "request_revision" | "reject";

const ACTION_PATH: Record<Action, string> = {
  approve: "approve",
  request_revision: "request-revision",
  reject: "reject",
};

interface Props {
  taskId: string;
  status: TaskStatus;
  updatedAt: string; // ISO — dùng cho If-Unmodified-Since
  canReview: boolean; // OWNER/ADMIN
}

export function ReviewActions({ taskId, status, updatedAt, canReview }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeForm, setActiveForm] = useState<"revision" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const inReviewableState = status === "IMPORTED" || status === "WAITING_REVIEW";
  const disabled = !canReview || !inReviewableState || pending;

  async function submit(action: Action) {
    if (disabled) return;
    if (action !== "approve" && reason.trim().length < 3) {
      setMsg({ type: "error", text: "Cần lý do ít nhất 3 ký tự." });
      return;
    }
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/tasks/${taskId}/${ACTION_PATH[action]}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // AC05 — optimistic lock. Truyền ISO exact tồn tại DB.
          "If-Unmodified-Since": new Date(updatedAt).toUTCString(),
        },
        body: JSON.stringify(action === "approve" ? {} : { reason: reason.trim() }),
      });
      const body = (await res.json()) as {
        data: { code: string; status: string } | null;
        error: { code: string; message: string } | null;
      };
      if (!res.ok || body.error) {
        setMsg({ type: "error", text: body.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setMsg({
        type: "success",
        text: `${body.data?.code ?? "Task"} → ${body.data?.status ?? action}`,
      });
      setActiveForm(null);
      setReason("");
      startTransition(() => router.refresh());
    } catch (err) {
      setMsg({ type: "error", text: (err as Error).message });
    }
  }

  if (!canReview) {
    return (
      <div className="rounded-lg border border-border bg-muted/10 p-4 text-sm text-muted-foreground">
        Bạn không có quyền review nhiệm vụ. Chỉ OWNER/ADMIN thao tác được.
      </div>
    );
  }

  if (!inReviewableState) {
    return (
      <div className="rounded-lg border border-border bg-muted/10 p-4 text-sm text-muted-foreground">
        Nhiệm vụ đã ở trạng thái <strong>{status}</strong> — không thể review lại.
      </div>
    );
  }

  return (
    <section
      aria-labelledby="review-heading"
      className="space-y-3 rounded-lg border border-border bg-muted/10 p-4"
    >
      <h2 id="review-heading" className="text-sm font-medium">
        Review nhiệm vụ
      </h2>

      {activeForm ? (
        <div className="space-y-2">
          <label className="block text-xs text-muted-foreground">
            Lý do {activeForm === "revision" ? "yêu cầu sửa" : "từ chối"} (bắt buộc)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={
              activeForm === "revision"
                ? "VD: Thiếu commission cho offer #2, verify lại nguồn."
                : "VD: Kết quả không match mission, bot hiểu sai yêu cầu."
            }
            className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => submit(activeForm === "revision" ? "request_revision" : "reject")}
              disabled={pending}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50",
                activeForm === "revision" ? "bg-amber-500" : "bg-destructive",
              )}
            >
              {pending ? "Đang gửi…" : "Xác nhận"}
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveForm(null);
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
          <button
            type="button"
            onClick={() => submit("approve")}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Duyệt
          </button>
          <button
            type="button"
            onClick={() => setActiveForm("revision")}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-500 hover:bg-amber-500/20 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <MessageCircleWarning className="h-3.5 w-3.5" aria-hidden="true" />
            Yêu cầu sửa
          </button>
          <button
            type="button"
            onClick={() => setActiveForm("reject")}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Từ chối
          </button>
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

      <p className="text-[11px] text-muted-foreground">
        Retry (khi task FAILED) sẽ có ở DC-015 cùng SSE.
      </p>
    </section>
  );
}
