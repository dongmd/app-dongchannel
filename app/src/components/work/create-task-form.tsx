"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, explain, newKey } from "./api";

interface Props { projects: { id: string; name: string }[]; assistants: { id: string; name: string; connection_state: string; dispatch_enabled: boolean }[] }

export function CreateTaskForm({ projects, assistants }: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey); // one key per form instance: a double click re-sends the SAME key (server returns already_processed)
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setMsg(null);
    const r = await api("POST", "/api/v1/tasks", { project_id: f.get("project_id"), assignee_id: f.get("assignee_id"), title: f.get("title"), description: f.get("description") || undefined, expected_output: f.get("expected_output") || undefined }, key);
    setBusy(false);
    if (!r.ok) { setMsg({ kind: "err", text: explain(r) }); return; }
    setMsg({ kind: "ok", text: `Đã tạo ${r.data.task.code} (${r.data.task.status})${r.data.already_processed ? " — yêu cầu lặp, không tạo thêm" : ""}` });
    router.push(`/work/${r.data.task.id}`);
  }
  const field = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-muted/5 p-4" aria-label="Giao việc mới">
      <h2 className="text-sm font-semibold">Giao việc mới</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">Dự án
          <select name="project_id" required className={field}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">Giao cho trợ lý
          <select name="assignee_id" required className={field}>
            {assistants.map((a) => <option key={a.id} value={a.id}>{a.name}{a.dispatch_enabled ? "" : " (chưa bật giao việc)"}</option>)}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">Tiêu đề
        <input name="title" required minLength={3} maxLength={200} className={field} placeholder="Soạn 3 mẫu quảng cáo cho Test offer US" />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground">Mô tả
        <textarea name="description" rows={3} className={field} />
      </label>
      <label className="block space-y-1 text-xs text-muted-foreground">Đầu ra mong đợi
        <input name="expected_output" className={field} />
      </label>
      <div className="flex items-center gap-3">
        <button disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-ring">{busy ? "Đang gửi…" : "Giao việc"}</button>
        {msg && <p role="status" className={msg.kind === "ok" ? "text-sm text-primary" : "text-sm text-destructive"}>{msg.text}</p>}
      </div>
    </form>
  );
}
