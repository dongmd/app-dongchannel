"use client";

import { useEffect, useState } from "react";

import { CURRENCIES, type Currency } from "@/lib/lumi/types";
import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Modal } from "./ui";

/** Ngày theo giờ địa phương (YYYY-MM-DD). */
const ymd = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Nhập số liệu quảng cáo MÔ PHỎNG theo kỳ. Để trống một ô nghĩa là "chưa có dữ liệu", khác với 0. */
export function ResultsModal({ open, onClose, defaultProjectId }: { open: boolean; onClose: () => void; defaultProjectId?: string }) {
  const { state, dispatch, toast } = useLumi();
  const aff = state.projects.filter((p) => p.status === "active" && p.area === "Affiliate");
  const [projectId, setProjectId] = useState("");
  const [start, setStart] = useState(ymd(Date.now() - 6 * 86_400_000));
  const [end, setEnd] = useState(ymd(Date.now()));
  const [currency, setCurrency] = useState<Currency>("USD");
  const [spend, setSpend] = useState("");
  const [commission, setCommission] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId && aff.some((p) => p.id === defaultProjectId) ? defaultProjectId : (aff[0]?.id ?? ""));
    setStart(ymd(Date.now() - 6 * 86_400_000));
    setEnd(ymd(Date.now()));
    setSpend("");
    setCommission("");
    setNote("");
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const r = await dispatch({ type: "results.add", projectId, periodStart: start, periodEnd: end, currency, spend: num(spend), commissionReported: num(commission), note });
    setBusy(false);
    if (r.ok) {
      toast("Đã lưu số liệu mô phỏng.");
      onClose();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nhập số liệu quảng cáo (mô phỏng)">
      <p className="small muted" style={{ marginTop: 0 }}>
        Số bạn nhập ở đây chỉ để thử Dashboard, <strong>không phải số liệu thật</strong> từ Google Ads hay mạng affiliate. Để trống một ô nghĩa là «chưa có dữ liệu», khác với nhập 0.
      </p>
      <form onSubmit={submit}>
        <label className="l-label" htmlFor="rs-project">Dự án Affiliate</label>
        <select id="rs-project" className="l-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
          {aff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="l-grid cols2">
          <div>
            <label className="l-label" htmlFor="rs-start">Từ ngày</label>
            <input id="rs-start" type="date" className="l-input" value={start} onChange={(e) => setStart(e.target.value)} required />
          </div>
          <div>
            <label className="l-label" htmlFor="rs-end">Đến ngày</label>
            <input id="rs-end" type="date" className="l-input" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </div>
        </div>
        <label className="l-label" htmlFor="rs-cur">Đơn vị tiền (chi phí và hoa hồng cùng đơn vị)</label>
        <select id="rs-cur" className="l-select" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="l-grid cols2">
          <div>
            <label className="l-label" htmlFor="rs-spend">Chi phí quảng cáo</label>
            <input id="rs-spend" inputMode="decimal" className="l-input" value={spend} onChange={(e) => setSpend(e.target.value)} placeholder="Để trống = chưa có dữ liệu" />
          </div>
          <div>
            <label className="l-label" htmlFor="rs-comm">Hoa hồng ghi nhận</label>
            <input id="rs-comm" inputMode="decimal" className="l-input" value={commission} onChange={(e) => setCommission(e.target.value)} placeholder="Để trống = chưa có dữ liệu" />
          </div>
        </div>
        <label className="l-label" htmlFor="rs-note">Ghi chú</label>
        <input id="rs-note" className="l-input" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="l-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button type="button" className="l-btn" onClick={onClose}>Hủy</button>
          <button type="submit" className="l-btn primary" disabled={busy || !projectId}>Lưu số liệu mô phỏng</button>
        </div>
      </form>
    </Modal>
  );
}

/** Thêm dự án mới: Dashboard, Dự án và Văn phòng đọc từ cùng danh sách nên dự án mới hiện ngay. */
export function ProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch, toast } = useLumi();
  const real = state.mode === "db";
  const [name, setName] = useState("");
  const [area, setArea] = useState("Affiliate");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState("");
  useEffect(() => {
    if (!open) return;
    setName("");
    setArea("Affiliate");
    setGoal("");
    setBusy(false);
    setErr(null);
    setKey(newKey());
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    if (real) {
      // Real-data mode: the API is the only writer (OWNER only, unique name, idempotent on the key); the list refreshes by polling.
      const areaMap: Record<string, string> = { Affiliate: "AFFILIATE", YouTube: "YOUTUBE", Website: "WEBSITE", "Khác": "OTHER" };
      const r = await lumiApi("/api/v1/lumi/projects", { method: "POST", key, body: { name, area: areaMap[area] ?? "OTHER", goal } });
      setBusy(false);
      if (!r.ok) { setErr(errText(r.error)); return; }
      toast(`Đã thêm dự án ${name}.`);
      onClose();
      return;
    }
    const r = await dispatch({ type: "project.create", name, area, goal });
    setBusy(false);
    if (r.ok) {
      toast(`Đã thêm dự án ${name}. Thêm trợ lý vào dự án ở mục Văn phòng.`);
      onClose();
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Thêm dự án">
      <form onSubmit={submit}>
        <label className="l-label" htmlFor="pj-name">Tên dự án</label>
        <input id="pj-name" data-autofocus className="l-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Ví dụ: Test offer EU" />
        <label className="l-label" htmlFor="pj-area">Mảng</label>
        <select id="pj-area" className="l-select" value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="Affiliate">Affiliate</option>
          <option value="YouTube">YouTube</option>
          {real ? <option value="Website">Website</option> : null}
          <option value="Khác">Khác</option>
        </select>
        <label className="l-label" htmlFor="pj-goal">Mục tiêu</label>
        <textarea id="pj-goal" className="l-textarea" value={goal} onChange={(e) => setGoal(e.target.value)} />
        {err && <div className="l-note" role="alert" data-testid="pj-error" style={{ marginTop: 8 }}>{err}</div>}
        <div className="l-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button type="button" className="l-btn" onClick={onClose}>Hủy</button>
          <button type="submit" className="l-btn primary" disabled={busy || !name.trim()}>Thêm dự án</button>
        </div>
      </form>
    </Modal>
  );
}
