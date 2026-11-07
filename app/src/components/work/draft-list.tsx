"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, explain } from "./api";

interface Draft { id: string; raw_text: string; missing: string[]; expires_at: string; actor_ref: string; assistant_name: string | null }

/** Drafts created from Telegram (via the bot's tasks_intake tool). Only a signed-in person can confirm: this is the human gate. */
export function DraftList({ drafts }: { drafts: Draft[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (drafts.length === 0) return null;
  async function confirm(id: string) {
    setBusy(true); setMsg(null);
    const r = await api("POST", `/api/v1/tasks/intake/${id}/confirm`, {});
    setBusy(false);
    setMsg(r.ok ? `Đã xác nhận → ${r.data.task.code}${r.data.already_processed ? " (đã xác nhận trước đó, không tạo thêm)" : ""}` : explain(r));
    router.refresh();
  }
  return (
    <section className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4" aria-label="Bản nháp chờ xác nhận">
      <h2 className="text-sm font-semibold">Bản nháp chờ xác nhận ({drafts.length})</h2>
      <p className="text-xs text-muted-foreground">Bot chỉ tạo được bản nháp. Chưa có việc nào cho tới khi bạn bấm Xác nhận.</p>
      <ul className="divide-y divide-border text-sm">
        {drafts.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0 flex-1">
              <span className="font-mono text-xs text-muted-foreground">OK {d.id.slice(0, 8)}</span> · {d.raw_text}
              {d.missing.length > 0 && <span className="ml-2 text-destructive">thiếu: {d.missing.join(", ")}</span>}
            </span>
            <button disabled={busy || d.missing.length > 0} onClick={() => confirm(d.id)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-ring">Xác nhận</button>
          </li>
        ))}
      </ul>
      {msg && <p role="status" className="text-xs text-muted-foreground">{msg}</p>}
    </section>
  );
}
