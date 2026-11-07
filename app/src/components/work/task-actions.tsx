"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, explain, newKey } from "./api";

interface Output { id: string; version: number; state: string; late: boolean }
interface Props { taskId: string; status: string; role: "OWNER" | "ADMIN" | "VIEWER"; current: Output | null; lateOutputs: Output[]; needsDecision: boolean }

export function TaskActions({ taskId, status, role, current, lateOutputs, needsDecision }: Props) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = role === "OWNER";
  const canManage = role === "OWNER" || role === "ADMIN";

  async function run(label: string, fn: () => ReturnType<typeof api>) {
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { setMsg({ kind: "err", text: explain(r) }); return; }
    setMsg({ kind: "ok", text: `${label}: xong${r.data?.already_processed ? " (đã xử lý trước đó, không làm lại)" : ""}` });
    router.refresh();
  }
  const decide = (decision: "APPROVE" | "REVISE" | "REJECT") => run(decision === "APPROVE" ? "Duyệt" : decision === "REVISE" ? "Yêu cầu sửa" : "Từ chối",
    () => api("POST", "/api/v1/approvals/decide", { kind: "OUTPUT", object_id: current!.id, object_version: current!.version, decision, reason: reason || undefined, channel: "WEB" }));
  const startRun = (mode: "RETRY" | "REVISION") => run(mode === "RETRY" ? "Giao lại" : "Giao sửa", () => api("POST", `/api/v1/tasks/${taskId}/runs`, { mode, expected_status: status, instruction: reason || undefined }, newKey()));
  const btn = "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-ring";
  const primary = "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-ring";

  if (role === "VIEWER") return <p className="text-sm text-muted-foreground">Bạn chỉ có quyền xem.</p>;
  const closed = ["COMPLETED", "CANCELLED"].includes(status);
  return (
    <section className="space-y-3 rounded-lg border border-border bg-muted/5 p-4" aria-label="Thao tác">
      <h2 className="text-sm font-semibold">Thao tác</h2>
      {needsDecision && <p className="text-sm text-amber-500">Việc này cần quyết định: lệnh giao có thể đã tới Hermes nhưng chưa xác nhận. App không tự gửi lại.</p>}
      <label className="block space-y-1 text-xs text-muted-foreground">Lý do / hướng dẫn (bắt buộc khi yêu cầu sửa hoặc từ chối)
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
      </label>
      <div className="flex flex-wrap gap-2">
        {status === "WAITING_REVIEW" && current && isOwner && (<>
          <button disabled={busy} onClick={() => decide("APPROVE")} className={primary}>Duyệt bản {current.version}</button>
          <button disabled={busy} onClick={() => decide("REVISE")} className={btn}>Yêu cầu sửa</button>
          <button disabled={busy} onClick={() => decide("REJECT")} className={btn}>Từ chối</button>
        </>)}
        {status === "WAITING_REVIEW" && !isOwner && <p className="text-sm text-muted-foreground">Chỉ OWNER được duyệt đầu ra.</p>}
        {status === "REVISION_REQUESTED" && canManage && <button disabled={busy} onClick={() => startRun("REVISION")} className={primary}>Giao bot sửa (bản mới)</button>}
        {["FAILED", "ON_HOLD"].includes(status) && canManage && <button disabled={busy} onClick={() => startRun("RETRY")} className={primary}>Giao lại (thử lại)</button>}
        {!closed && canManage && <button disabled={busy} onClick={() => run("Hủy việc", () => api("POST", `/api/v1/tasks/${taskId}/transition`, { to: "CANCELLED", expected_status: status, reason }))} className={btn}>Hủy việc</button>}
      </div>
      {lateOutputs.length > 0 && isOwner && (
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs font-semibold text-muted-foreground">Kết quả đến muộn (chưa được dùng)</h3>
          {lateOutputs.map((o) => (
            <div key={o.id} className="flex items-center gap-2 text-sm">
              <span>Bản {o.version}</span>
              <button disabled={busy} className={btn} onClick={() => run("Dùng kết quả muộn", () => api("POST", `/api/v1/tasks/${taskId}/outputs/${o.id}/adopt`, { expected_task_status: status }, newKey()))}>Dùng kết quả muộn</button>
              <button disabled={busy} className={btn} onClick={() => run("Bỏ kết quả muộn", () => api("POST", `/api/v1/tasks/${taskId}/outputs/${o.id}/discard`, {}))}>Bỏ</button>
            </div>
          ))}
        </div>
      )}
      {msg && <p role="status" className={msg.kind === "ok" ? "text-sm text-primary" : "text-sm text-destructive"}>{msg.text}</p>}
    </section>
  );
}
