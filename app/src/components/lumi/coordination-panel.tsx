"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/**
 * IMP-03 (PRJ-07, PLN-05, PLN-06, OFC-05): what this task waits for, what waits for it, handoffs between bots (always through the app),
 * the required skill, and "cần kiểm lại" after an upstream task was reopened. Writes: OWNER/ADMIN (some OWNER only); VIEWER reads.
 */
import { useCallback, useEffect, useState } from "react";

import { errText, lumiApi, newKey, TASK_STATUS_LABEL } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { fmtFull } from "./ui";

const HO_STATE: Record<string, string> = { PROPOSED: "Đã đề nghị", ACCEPTED: "Bên nhận đã nhận", REJECTED: "Bên nhận từ chối", NEEDS_INFO: "Bên nhận cần thêm thông tin", ESCALATED: "Chuyển Chủ quyết định", CANCELLED: "Đã hủy" };
const SKILL_LABEL: Record<string, string> = { UNVERIFIED: "chưa kiểm chứng", VERIFIED: "đã kiểm chứng", MONITORED: "đang theo dõi" };

export function CoordinationPanel({ uuid, projectId, status, role }: { uuid: string; projectId: string; status: string; role: "OWNER" | "ADMIN" | "VIEWER" }) {
  const { state, toast } = useLumi();
  const [d, setD] = useState<any | null>(null);
  const [assistants, setAssistants] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [depPick, setDepPick] = useState("");
  const [ho, setHo] = useState({ to: "", title: "", request: "", skill: "" });
  const [hoKey, setHoKey] = useState(newKey());
  const [hoErr, setHoErr] = useState<any | null>(null);
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const canWrite = role !== "VIEWER";
  const isOwner = role === "OWNER";

  const load = useCallback(async () => {
    const r = await lumiApi(`/api/v1/tasks/${uuid}/coordination`);
    if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error));
  }, [uuid]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { void lumiApi("/api/v1/lumi/assistants").then((r) => { if (r.ok) setAssistants((r.data.assistants as any[]).filter((a) => a.status === "ACTIVE")); }); }, []);

  async function act(path: string, body: unknown, okMsg: string, key?: string) {
    const r = await lumiApi(path, { method: "POST", body, key });
    toast(r.ok ? okMsg : `Không thực hiện được: ${errText(r.error)}`);
    if (r.ok) void load();
    return r;
  }
  if (err) return <div className="l-note" role="alert" data-testid="coord-error">Không tải được phụ thuộc/bàn giao: {err}</div>;
  if (!d) return null;

  const have = new Set((d.deps as any[]).map((x) => x.id));
  const candidates = state.tasks.filter((t) => t.projectId === projectId && t.real?.uuid && t.real.uuid !== uuid && !have.has(t.real.uuid));
  const stale = (d.deps as any[]).some((x) => x.stale);
  const nothing = d.deps.length === 0 && d.dependents.length === 0 && d.handoffs.length === 0 && !d.role && !d.required_skill;

  return (
    <div className="l-card" style={{ marginBottom: 12 }} data-testid="coord-panel">
      <div className="l-label" style={{ marginTop: 0 }}>Phụ thuộc &amp; bàn giao</div>
      <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {d.role && <span className="l-badge" data-testid="coord-role">Vai: {d.role.name}</span>}
        {d.required_skill && <span className={`l-badge ${d.skill_state === "VERIFIED" ? "green" : "amber"}`} data-testid="coord-skill">Cần kỹ năng: {d.required_skill} ({SKILL_LABEL[d.skill_state] ?? d.skill_state})</span>}
        {stale && <span className="l-badge amber" data-testid="coord-recheck">Cần kiểm lại: đầu vào phía trên đã đổi</span>}
      </div>
      {nothing && <p className="small muted" style={{ margin: "6px 0 0" }} data-testid="coord-empty">Việc này chưa có phụ thuộc hay bàn giao.</p>}

      {d.deps.length > 0 && (
        <div data-testid="coord-deps">
          <div className="l-label">Việc này chờ ({d.deps.length})</div>
          {(d.deps as any[]).map((x) => (
            <div key={x.id} className="small l-row" style={{ gap: 8, flexWrap: "wrap" }} data-testid={`dep-${x.code}`}>
              <strong>{x.code}</strong><span>{x.title}</span><span className="l-badge">{TASK_STATUS_LABEL[x.status] ?? x.status}</span>
              <span className="muted">{x.consumed_version ? `đã dùng đầu ra bản ${x.consumed_version}` : "chưa có đầu ra được duyệt"}{x.stale ? " · ĐỔI SAU KHI DÙNG" : ""}</span>
              {canWrite && <button className="l-btn sm" onClick={() => void act(`/api/v1/tasks/${uuid}/dependencies/remove`, { depends_on_task_id: x.id }, "Đã bỏ phụ thuộc.")} data-testid={`dep-remove-${x.code}`}>Bỏ</button>}
            </div>))}
        </div>
      )}
      {d.dependents.length > 0 && (
        <div data-testid="coord-dependents">
          <div className="l-label">Đang chờ việc này ({d.dependents.length})</div>
          {(d.dependents as any[]).map((x) => <div key={x.id} className="small" data-testid={`dependent-${x.code}`}><strong>{x.code}</strong> {x.title} · {TASK_STATUS_LABEL[x.status] ?? x.status}{x.stale ? " · cần kiểm lại" : ""}</div>)}
        </div>
      )}

      {canWrite && candidates.length > 0 && (
        <form className="l-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }} data-testid="dep-form" onSubmit={async (e) => { e.preventDefault(); const r = await act(`/api/v1/tasks/${uuid}/dependencies`, { depends_on_task_id: depPick }, "Đã thêm phụ thuộc."); if (r.ok) setDepPick(""); }}>
          <select className="l-select" value={depPick} onChange={(e) => setDepPick(e.target.value)} required aria-label="Việc phải xong trước" data-testid="dep-pick" style={{ flex: 1, minWidth: 180 }}>
            <option value="">Chờ việc nào xong trước…</option>
            {candidates.map((t) => <option key={t.id} value={t.real!.uuid}>{t.id} · {t.title}</option>)}
          </select>
          <button className="l-btn sm" data-testid="dep-add">Thêm phụ thuộc</button>
        </form>
      )}

      {d.handoffs.length > 0 && (
        <div data-testid="coord-handoffs">
          <div className="l-label">Bàn giao ({d.handoffs.length})</div>
          {(d.handoffs as any[]).map((h) => (
            <div key={h.id} className="l-card" style={{ marginTop: 6 }} data-testid={`handoff-${h.code}`}>
              <div className="l-row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
                <strong>{h.code}: {h.from_name ?? "Chủ"} → {h.to_name}</strong>
                <span className={`l-badge ${h.state === "ACCEPTED" ? "green" : ["REJECTED", "ESCALATED", "NEEDS_INFO"].includes(h.state) ? "amber" : ""}`} data-testid={`handoff-state-${h.code}`}>{HO_STATE[h.state] ?? h.state}</span>
              </div>
              <div className="small muted">Độ sâu {h.depth} · vòng hỏi {h.round}{h.reason ? ` · ${h.reason}` : ""}</div>
              {(h.events as any[]).length > 0 && <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>{(h.events as any[]).map((e, i) => <li key={i}>{fmtFull(e.at)} · {e.type}{e.text ? `: ${e.text}` : ""}</li>)}</ul>}
              {isOwner && ["NEEDS_INFO", "ESCALATED"].includes(h.state) && (
                <form className="l-row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }} onSubmit={async (e) => { e.preventDefault(); const r = await act(`/api/v1/lumi/handoffs/${h.id}/answer`, { text: answer[h.id] ?? "" }, "Đã gửi thông tin; việc nhận được giải phóng lại."); if (r.ok) setAnswer({ ...answer, [h.id]: "" }); }}>
                  <input className="l-input" style={{ flex: 1, minWidth: 180 }} placeholder="Thông tin bổ sung / quyết định của Chủ" value={answer[h.id] ?? ""} onChange={(e) => setAnswer({ ...answer, [h.id]: e.target.value })} minLength={3} required data-testid={`handoff-answer-${h.code}`} />
                  <button className="l-btn sm primary" data-testid={`handoff-answer-send-${h.code}`}>Trả lời bên nhận</button>
                </form>)}
              {canWrite && ["PROPOSED", "REJECTED", "NEEDS_INFO", "ESCALATED"].includes(h.state) && h.new_task_id === uuid && (
                <button className="l-btn sm danger" style={{ marginTop: 6 }} onClick={() => { const r = reason.trim(); if (r.length < 3) { toast("Nhập lý do (≥ 3 ký tự) ở ô «Lý do» bên dưới trước."); return; } void act(`/api/v1/lumi/handoffs/${h.id}/cancel`, { reason: r }, "Đã hủy bàn giao."); }} data-testid={`handoff-cancel-${h.code}`}>Hủy bàn giao</button>)}
            </div>))}
        </div>
      )}

      {canWrite && (
        <form className="l-grid" style={{ gap: 6, marginTop: 10 }} data-testid="handoff-form" onSubmit={async (e) => {
          e.preventDefault(); setHoErr(null);
          const r = await act(`/api/v1/tasks/${uuid}/handoffs`, { to_assistant_id: ho.to, title: ho.title, request: ho.request, required_skill: ho.skill || undefined }, "Đã tạo bàn giao; việc nhận chờ đầu ra của việc này được duyệt.", hoKey);
          if (r.ok) { setHo({ to: "", title: "", request: "", skill: "" }); setHoKey(newKey()); } else setHoErr(r.error);
        }}>
          <div className="l-label" style={{ marginTop: 4 }}>Bàn giao một phần việc cho trợ lý khác (qua ứng dụng)</div>
          <select className="l-select" value={ho.to} onChange={(e) => setHo({ ...ho, to: e.target.value })} required aria-label="Bên nhận" data-testid="ho-to"><option value="">Bên nhận…</option>{assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <input className="l-input" placeholder="Tiêu đề việc nhận" value={ho.title} onChange={(e) => setHo({ ...ho, title: e.target.value })} minLength={3} maxLength={200} required data-testid="ho-title" />
          <textarea className="l-textarea" rows={2} placeholder="Yêu cầu cho bên nhận" value={ho.request} onChange={(e) => setHo({ ...ho, request: e.target.value })} minLength={3} required data-testid="ho-request" />
          <input className="l-input" placeholder="Kỹ năng bên nhận cần (tùy chọn)" value={ho.skill} onChange={(e) => setHo({ ...ho, skill: e.target.value })} data-testid="ho-skill" />
          {hoErr && (
            <div className="l-note" role="alert" data-testid="ho-error">
              {hoErr.code === "CHECK_FAILED" && Array.isArray(hoErr.details?.reasons)
                ? <><strong>Chưa bàn giao được (chưa tạo gì):</strong><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{(hoErr.details.reasons as any[]).map((x) => <li key={x.code} data-testid={`ho-reason-${x.code}`}>{x.text} <span className="muted">Gợi ý: {x.suggestion}</span></li>)}</ul></>
                : errText(hoErr)}
            </div>)}
          <div><button className="l-btn sm primary" data-testid="ho-submit">Tạo bàn giao</button></div>
        </form>
      )}

      {canWrite && (
        <div style={{ marginTop: 10 }}>
          <input className="l-input" placeholder="Lý do (dùng cho «Hủy bàn giao» và «Mở lại việc»)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="coord-reason" />
          <div className="l-row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {isOwner && status === "COMPLETED" && <button className="l-btn sm" onClick={() => { if (reason.trim().length < 3) { toast("Nhập lý do (≥ 3 ký tự)."); return; } void act(`/api/v1/tasks/${uuid}/reopen`, { reason: reason.trim() }, "Đã mở lại việc; việc phía sau được giữ hoặc đánh dấu «cần kiểm lại»."); }} data-testid="task-reopen">Mở lại việc đã xong</button>}
            {isOwner && stale && <button className="l-btn sm" onClick={() => void act(`/api/v1/tasks/${uuid}/clear-recheck`, {}, "Đã đánh dấu đã kiểm lại.")} data-testid="clear-recheck">Đã kiểm lại với đầu vào mới</button>}
          </div>
        </div>
      )}
    </div>
  );
}
