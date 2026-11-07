"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */

import { useCallback, useEffect, useState } from "react";
import { ScrollText } from "lucide-react";

import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull, Modal } from "./ui";

const KIND: Record<string, "money" | "int" | "text"> = { prepare_fund: "money", max_loss: "money", owner_hourly_rate: "money", report_cadence_days: "int", proposal_ttl_days: "int", meeting_cap: "int", currency: "text" };
const HINT: Record<string, string> = {
  prepare_fund: "Số tiền tối đa bot được dùng ở giai đoạn chuẩn bị (kèm đơn vị tiền).", max_loss: "Mức lỗ tối đa bạn chấp nhận.", owner_hourly_rate: "Đơn giá thời gian của bạn (nếu muốn tính vào chi phí).",
  report_cadence_days: "Số ngày giữa hai báo cáo (1–90).", proposal_ttl_days: "Sau bao nhiêu ngày một đề xuất dự án hết hạn kích hoạt (1–90). Chưa đặt = không hết hạn.", meeting_cap: "Số lần họp tối đa mỗi chu kỳ (0–50).", currency: "Đơn vị tiền chính, ví dụ USD.",
};
const show = (key: string, v: any) => (KIND[key] === "money" ? `${v.amount} ${v.currency}` : String(v));

/** CMP-03: operating policies the OWNER sets. No default exists: a policy that is not set says so, and a step that needs it is refused with the reason. */
export function PoliciesPanel() {
  const { state, toast } = useLumi();
  const isOwner = state.real?.role === "OWNER";
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const load = useCallback(async () => {
    const r = await lumiApi("/api/v1/lumi/policies");
    if (r.ok && r.data) { setData(r.data); setErr(null); } else setErr(errText(r.error));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const cur = (k: string) => (data?.current ?? []).find((c: any) => c.key === k && c.scope === "COMPANY");
  return (
    <section className="l-card" data-testid="policies-panel">
      <h2 className="l-row" style={{ gap: 8, margin: "0 0 4px" }}><ScrollText size={18} /> Chính sách vận hành do Chủ đặt</h2>
      <p className="small muted" style={{ margin: "0 0 8px" }}>Không có giá trị mặc định: chưa đặt thì hiện «chưa đặt», và bước nào cần chính sách đó sẽ bị chặn kèm lý do. Mỗi lần đổi là một phiên bản có người đặt và thời điểm.</p>
      {err && <div className="l-note" role="alert">Không tải được: {err} <button className="l-btn sm" onClick={() => void load()}>Thử lại</button></div>}
      {!data && !err ? <p className="muted">Đang tải…</p> : data && (
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th align="left">Chính sách</th><th align="left">Giá trị hiện hành</th><th align="left">Phiên bản</th><th /></tr></thead>
          <tbody>
            {data.keys.map((k: any) => {
              const c = cur(k.key);
              return (
                <tr key={k.key} data-testid={`policy-${k.key}`}>
                  <td>{k.label}<div className="small muted">{HINT[k.key]}</div></td>
                  <td>{c ? <strong>{show(k.key, c.value)}</strong> : <span className="l-badge amber">chưa đặt</span>}</td>
                  <td className="small">{c ? <>v{c.version} · {c.set_by.replace(/^web:/, "")} · {fmtFull(c.set_at)}</> : "—"}</td>
                  <td align="right">{isOwner && <button className="l-btn sm" onClick={() => setEdit(k.key)} data-testid={`policy-edit-${k.key}`}>{c ? "Đổi" : "Đặt"}</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {data && <div style={{ marginTop: 8 }}><button className="l-btn sm" onClick={() => setShowHistory((v) => !v)} data-testid="policy-history-toggle">{showHistory ? "Ẩn lịch sử" : `Lịch sử thay đổi (${data.history.length})`}</button></div>}
      {showHistory && data && (data.history.length === 0 ? <Empty>Chưa có thay đổi nào.</Empty> : (
        <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }} data-testid="policy-history">
          {data.history.map((h: any) => <li key={`${h.key}-${h.scope}-${h.version}`}>{h.key} (v{h.version}, {h.scope}): {h.value === null ? "bỏ đặt" : show(h.key, h.value)} — {h.set_by.replace(/^web:/, "")}, {fmtFull(h.set_at)}{h.note ? ` — ${h.note}` : ""}</li>)}
        </ul>
      ))}
      <PolicyDialog pkey={edit} label={data?.keys.find((k: any) => k.key === edit)?.label} current={edit ? cur(edit) : null} onClose={() => setEdit(null)} onDone={(msg) => { toast(msg); setEdit(null); void load(); }} />
    </section>
  );
}

function PolicyDialog({ pkey, label, current, onClose, onDone }: { pkey: string | null; label?: string; current: any; onClose: () => void; onDone: (m: string) => void }) {
  const [a, setA] = useState(""); const [c, setC] = useState(""); const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [key, setKey] = useState("");
  const kind = pkey ? KIND[pkey] : "text";
  useEffect(() => {
    if (!pkey) return;
    setErr(null); setBusy(false); setNote(""); setKey(newKey());
    const v = current?.value;
    if (kind === "money") { setA(v ? String(v.amount) : ""); setC(v ? v.currency : ""); } else { setA(v !== undefined && v !== null ? String(v) : ""); setC(""); }
  }, [pkey]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(unset: boolean) {
    if (busy || !pkey) return; setBusy(true); setErr(null);
    let value: any = null;
    if (!unset) value = kind === "money" ? { amount: Number(a), currency: c.trim().toUpperCase() } : kind === "int" ? Number(a) : a.trim().toUpperCase();
    const r = await lumiApi("/api/v1/lumi/policies", { method: "POST", key, body: { key: pkey, value, note: note || undefined } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.error)); return; }
    onDone(unset ? "Đã bỏ đặt chính sách." : r.data?.already_processed ? "Giá trị không đổi, không tạo phiên bản mới." : `Đã lưu phiên bản ${r.data?.version}.`);
  }
  return (
    <Modal open={pkey !== null} onClose={onClose} title={`${current ? "Đổi" : "Đặt"}: ${label ?? ""}`}>
      <form className="l-grid" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); void save(false); }} data-testid="policy-form">
        {kind === "money" && <div className="l-row" style={{ gap: 8 }}><label className="l-label" style={{ flex: 1 }}>Số tiền<input className="l-input" type="number" min={0} step="any" value={a} onChange={(e) => setA(e.target.value)} required data-testid="pf-amount" /></label><label className="l-label" style={{ width: 120 }}>Tiền tệ<input className="l-input" value={c} onChange={(e) => setC(e.target.value)} required maxLength={5} data-testid="pf-currency" /></label></div>}
        {kind === "int" && <label className="l-label">Giá trị (số nguyên)<input className="l-input" type="number" step={1} value={a} onChange={(e) => setA(e.target.value)} required data-testid="pf-int" /></label>}
        {kind === "text" && <label className="l-label">Giá trị<input className="l-input" value={a} onChange={(e) => setA(e.target.value)} required maxLength={5} data-testid="pf-text" /></label>}
        <label className="l-label">Ghi chú (tùy chọn)<input className="l-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
        {err && <div className="l-note" role="alert" data-testid="pf-error">{err}</div>}
        <div className="l-row" style={{ justifyContent: "space-between", gap: 8 }}>
          <div>{current && <button type="button" className="l-btn danger" disabled={busy} onClick={() => void save(true)} data-testid="pf-unset">Bỏ đặt</button>}</div>
          <div className="l-row" style={{ gap: 8 }}><button type="button" className="l-btn" onClick={onClose}>Hủy</button><button className="l-btn primary" disabled={busy} data-testid="pf-save">Lưu phiên bản mới</button></div>
        </div>
      </form>
    </Modal>
  );
}
