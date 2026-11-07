"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, explain } from "./api";

interface A { id: string; name: string; slug: string; connection_state: string; dispatch_enabled: boolean; hermes_profile: string | null }
export function AssistantPanel({ assistants, role, emergencyStop, m1Enabled }: { assistants: A[]; role: string; emergencyStop: boolean; m1Enabled: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (role !== "OWNER") return null;
  async function call(fn: () => ReturnType<typeof api>) {
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false);
    setMsg(r.ok ? "Đã cập nhật" : explain(r));
    router.refresh();
  }
  const btn = "rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-60";
  return (
    <section className="space-y-3 rounded-lg border border-border bg-muted/5 p-4" aria-label="Trợ lý và công tắc">
      <h2 className="text-sm font-semibold">Trợ lý &amp; công tắc (OWNER)</h2>
      <div className="flex flex-wrap gap-2 text-xs">
        <button disabled={busy} className={btn} onClick={() => call(() => api("POST", "/api/v1/lumi/flags", { key: "m1_enabled", value: !m1Enabled }))}>Luồng M1: {m1Enabled ? "BẬT → tắt" : "TẮT → bật"}</button>
        <button disabled={busy} className={btn} onClick={() => call(() => api("POST", "/api/v1/lumi/flags", { key: "emergency_stop", value: !emergencyStop }))}>Dừng khẩn cấp: {emergencyStop ? "ĐANG DỪNG → mở" : "không → dừng"}</button>
      </div>
      <ul className="divide-y divide-border text-sm">
        {assistants.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{a.name} <span className="text-xs text-muted-foreground">({a.slug} · profile {a.hermes_profile ?? "—"} · kết nối {a.connection_state})</span></span>
            <button disabled={busy} className={btn} onClick={() => call(() => api("POST", `/api/v1/lumi/assistants/${a.id}/dispatch`, { enabled: !a.dispatch_enabled }))}>Giao việc: {a.dispatch_enabled ? "BẬT → tắt" : "TẮT → bật"}</button>
          </li>
        ))}
        {assistants.length === 0 && <li className="py-2 text-muted-foreground">Chưa có trợ lý (chạy scripts/lumi-m1-seed.ts trên CSDL thử).</li>}
      </ul>
      {msg && <p role="status" className="text-xs text-muted-foreground">{msg}</p>}
    </section>
  );
}
