"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function NewVideoForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = {
      workingTitle: fd.get("workingTitle")?.toString().trim() ?? "",
      hook: fd.get("hook")?.toString().trim() || null,
      outline: fd.get("outline")?.toString().trim() || null,
      // nicheId/offerId defer form — user gán sau từ detail (V1.1 sẽ có dropdown)
    };
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/youtube/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as {
        data: { id: string } | null;
        error: { message: string } | null;
      };
      if (!res.ok || body.error) {
        setMsg({ type: "error", text: body.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      if (body.data?.id) {
        router.push(`/youtube/videos/${body.data.id}`);
        router.refresh();
      } else {
        setMsg({ type: "success", text: "Đã tạo" });
      }
    } catch (err) {
      setMsg({ type: "error", text: (err as Error).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border bg-muted/10 p-4">
      <div className="space-y-1">
        <label htmlFor="workingTitle" className="block text-xs font-medium text-muted-foreground">
          Working title *
        </label>
        <input
          id="workingTitle"
          name="workingTitle"
          type="text"
          required
          minLength={2}
          maxLength={300}
          placeholder="VD: 10 công cụ AI thay đổi cách bạn học 2026"
          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="hook" className="block text-xs font-medium text-muted-foreground">
          Hook (câu mở đầu)
        </label>
        <textarea
          id="hook"
          name="hook"
          rows={2}
          maxLength={2000}
          placeholder="VD: 90% người không biết ChatGPT có thể làm việc này…"
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="outline" className="block text-xs font-medium text-muted-foreground">
          Outline
        </label>
        <textarea
          id="outline"
          name="outline"
          rows={5}
          maxLength={10000}
          placeholder="1. Intro (hook)&#10;2. Vấn đề&#10;3. Giải pháp 1…&#10;4. Giải pháp 2…&#10;5. CTA"
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <p className="text-[11px] text-muted-foreground">
        Niche + Offer liên kết sẽ gán ở detail (V1.1 sẽ có dropdown ngay tại form).
      </p>

      {msg ? (
        <div
          role="status"
          className={cn(
            "rounded-md px-3 py-2 text-xs",
            msg.type === "success" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
          )}
        >
          {msg.text}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {pending ? "Đang tạo…" : "Tạo video"}
        </button>
      </div>
    </form>
  );
}
