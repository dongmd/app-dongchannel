"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { errText, lumiApi } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Modal } from "./ui";

/** PRJ-01: edit name/goal and archive a project (OWNER, real-data mode). The project list refreshes by the provider's polling. */
export function ProjectAdmin({ projectId, name, goal }: { projectId: string; name: string; goal?: string }) {
  const { state, toast } = useLumi();
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(name); const [g, setG] = useState(goal ?? "");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  useEffect(() => { if (open) { setN(name); setG(goal ?? ""); setErr(null); setBusy(false); setConfirmArchive(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.mode !== "db" || state.real?.role !== "OWNER") return null;
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null);
    const r = await lumiApi(`/api/v1/lumi/projects/${projectId}`, { method: "PATCH", body: { name: n, goal: g } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.error)); return; }
    toast("Đã lưu dự án."); setOpen(false);
  }
  async function archive() {
    if (busy) return; setBusy(true); setErr(null);
    const r = await lumiApi(`/api/v1/lumi/projects/${projectId}/archive`, { method: "POST", body: {} });
    setBusy(false);
    if (!r.ok) {
      const d = r.error?.details;
      setErr(r.error?.code === "PROJECT_BUSY" ? `Chưa lưu trữ được: còn ${d?.open_tasks ?? 0} việc mở${d?.live_plans?.length ? `, kế hoạch ${d.live_plans.join(", ")}` : ""}${d?.active_goals?.length ? `, mục tiêu ${d.active_goals.join(", ")}` : ""}. Xử lý xong rồi lưu trữ.` : errText(r.error));
      return;
    }
    toast("Đã lưu trữ dự án."); setOpen(false);
    window.location.assign("/lumi/projects");
  }
  return (
    <>
      <button className="l-btn sm" onClick={() => setOpen(true)} data-testid="project-edit-open"><Pencil size={13} /> Sửa / lưu trữ</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Sửa dự án">
        <form className="l-grid" style={{ gap: 10 }} onSubmit={save} data-testid="project-edit-form">
          <label className="l-label">Tên dự án<input className="l-input" value={n} onChange={(e) => setN(e.target.value)} required minLength={3} maxLength={100} data-testid="pe-name" /></label>
          <label className="l-label">Mục tiêu<textarea className="l-textarea" rows={3} value={g} onChange={(e) => setG(e.target.value)} maxLength={1000} data-testid="pe-goal" /></label>
          {err && <div className="l-note" role="alert" data-testid="pe-error">{err}</div>}
          <div className="l-row" style={{ justifyContent: "space-between", gap: 8 }}>
            {confirmArchive
              ? <span className="l-row" style={{ gap: 6 }}><span className="small">Lưu trữ dự án này? Tên và lịch sử được giữ lại.</span><button type="button" className="l-btn danger sm" disabled={busy} onClick={() => void archive()} data-testid="pe-archive-confirm">Xác nhận</button><button type="button" className="l-btn sm" onClick={() => setConfirmArchive(false)}>Không</button></span>
              : <button type="button" className="l-btn danger" onClick={() => setConfirmArchive(true)} data-testid="pe-archive">Lưu trữ dự án</button>}
            <span className="l-row" style={{ gap: 8 }}><button type="button" className="l-btn" onClick={() => setOpen(false)}>Hủy</button><button className="l-btn primary" disabled={busy} data-testid="pe-save">Lưu</button></span>
          </div>
        </form>
      </Modal>
    </>
  );
}
