"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */

import { useCallback, useEffect, useState } from "react";
import { Plus, Target } from "lucide-react";

import { GOAL_RESULT_LABEL, PLAN_STATUS_LABEL, PLAN_TONE, errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtTime, LumiLink, Modal } from "./ui";

type Overview = { goals: any[]; projects: { id: string; name: string }[]; assistants: { id: string; slug: string; name: string; ready: boolean }[]; flags: { plans_enabled: boolean; m1_enabled: boolean }; config: { max_tasks: number | null; version_ttl_hours: number | null } };

export function CompanyView() {
  const { state, toast } = useLumi();
  const isOwner = state.real?.role === "OWNER";
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [planFor, setPlanFor] = useState<any | null>(null);
  const [closing, setClosing] = useState<any | null>(null);

  const load = useCallback(async () => {
    const r = await lumiApi<Overview>("/api/v1/lumi/goals");
    if (r.ok && r.data) { setData(r.data); setErr(null); } else setErr(errText(r.error));
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function togglePlans(on: boolean) {
    const r = await lumiApi("/api/v1/lumi/flags", { method: "POST", body: { key: "plans_enabled", value: on } });
    if (!r.ok) toast(`Không đổi được: ${errText(r.error)}`);
    else { toast(on ? "Đã bật tính năng kế hoạch." : "Đã tắt tính năng kế hoạch (dữ liệu giữ nguyên)."); void load(); }
  }

  return (
    <div className="l-grid" style={{ gap: 16 }} data-testid="company-view">
      <div>
        <h1 className="l-row" style={{ gap: 8 }}><Target size={22} /> Tổng quan công ty</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Mục tiêu kinh doanh và kế hoạch. Bot lập Plan &amp; Cost, bạn duyệt một lần; trong phạm vi đã duyệt bot tự thực hiện. Hoàn tất việc, hoàn tất kế hoạch và đạt mục tiêu kinh doanh là ba việc khác nhau.
        </p>
      </div>
      <div className="l-banner" role="note" data-testid="company-honesty">
        <strong>Giới hạn hiện tại.</strong>
        <span>{state.real?.hermesMode}. Chi phí AI chưa đo theo lượt; trần ngân sách chỉ giới hạn các khoản được ghi vào sổ, không thay hạn mức ở nhà cung cấp. Chưa có hành động bên ngoài, chưa có doanh thu. Nội dung kế hoạch do bot lập, chưa được kiểm chứng sự thật.</span>
      </div>
      {loading && <p className="muted" data-testid="company-loading">Đang tải…</p>}
      {err && <div className="l-note" role="alert" data-testid="company-error">Không tải được: {err} <button className="l-btn sm" onClick={() => void load()}>Thử lại</button></div>}
      {data && !data.flags.plans_enabled && (
        <div className="l-note" data-testid="plans-off">
          <strong>Tính năng kế hoạch đang TẮT.</strong> {data.flags.m1_enabled ? "" : "Luồng M1 cũng đang tắt. "}
          {data.config.max_tasks === null ? "Chưa cấu hình LUMI_PLAN_MAX_TASKS trên máy chủ nên chưa bật được. " : ""}
          {isOwner && <button className="l-btn sm primary" onClick={() => void togglePlans(true)} data-testid="plans-enable">Bật tính năng kế hoạch</button>}
        </div>
      )}
      {data?.flags.plans_enabled && isOwner && (
        <div className="l-row"><button className="l-btn primary" onClick={() => setCreating(true)} data-testid="goal-create-open"><Plus size={15} /> Tạo mục tiêu</button>
          <button className="l-btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => void togglePlans(false)}>Tắt tính năng kế hoạch</button></div>
      )}
      {data && data.goals.length === 0 && <Empty>Chưa có mục tiêu nào. {data.flags.plans_enabled ? (isOwner ? "Bấm «Tạo mục tiêu» để bắt đầu." : "") : "Bật tính năng kế hoạch để tạo mục tiêu."}</Empty>}
      {data?.goals.map((g) => {
        const plan = g.plan;
        const live = plan && !["REJECTED", "CANCELLED", "DONE", "PARTIAL_DONE"].includes(plan.status);
        return (
          <section key={g.id} className="l-card" data-testid={`goal-${g.code}`}>
            <div className="l-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <strong>{g.code}</strong> · {g.title} {g.status === "CLOSED" ? <span className="l-badge green">Đã đóng: {GOAL_RESULT_LABEL[g.result] ?? g.result}</span> : <span className="l-badge blue">Đang theo đuổi</span>}
                <div className="small muted">Dự án: {g.project_name} · tạo {fmtTime(g.created_at)}</div>
              </div>
              {plan && <LumiLink href={`/lumi/plans/${plan.id}`} className="l-chiplink">{plan.code} · <span className={`l-badge ${PLAN_TONE[plan.status] ?? ""}`}>{PLAN_STATUS_LABEL[plan.status] ?? plan.status}</span></LumiLink>}
            </div>
            <p style={{ margin: "8px 0" }}>{g.outcome}</p>
            {g.max_loss !== null && <p className="small muted">Mức lỗ tối đa: {Number(g.max_loss).toLocaleString("vi-VN")} {g.currency}</p>}
            {g.close_note && <p className="small muted">Ghi chú đóng: {g.close_note}</p>}
            {isOwner && g.status === "ACTIVE" && (
              <div className="l-row" style={{ gap: 8 }}>
                {!live && <button className="l-btn sm primary" onClick={() => setPlanFor(g)} data-testid={`plan-request-${g.code}`}>Yêu cầu bot lập kế hoạch</button>}
                {!live && <button className="l-btn sm" onClick={() => setClosing(g)} data-testid={`goal-close-${g.code}`}>Đóng mục tiêu</button>}
                {live && <span className="small muted">Mục tiêu chỉ đóng được khi kế hoạch đã kết thúc hoặc bị hủy.</span>}
              </div>
            )}
          </section>
        );
      })}
      {data && <GoalForm open={creating} onClose={() => setCreating(false)} data={data} onDone={() => { setCreating(false); void load(); }} />}
      {data && <PlanForm goal={planFor} onClose={() => setPlanFor(null)} data={data} onDone={() => { setPlanFor(null); void load(); }} />}
      <CloseForm goal={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); void load(); }} />
    </div>
  );
}

function GoalForm({ open, onClose, data, onDone }: { open: boolean; onClose: () => void; data: Overview; onDone: () => void }) {
  const { toast } = useLumi();
  const [title, setTitle] = useState(""); const [outcome, setOutcome] = useState(""); const [projectId, setProjectId] = useState("");
  const [maxLoss, setMaxLoss] = useState(""); const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [key, setKey] = useState("");
  useEffect(() => { if (open) { setTitle(""); setOutcome(""); setMaxLoss(""); setErr(null); setBusy(false); setKey(newKey()); setProjectId(data.projects[0]?.id ?? ""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null);
    const r = await lumiApi("/api/v1/lumi/goals", { method: "POST", key, body: { title, outcome, project_id: projectId, ...(maxLoss.trim() ? { max_loss: Number(maxLoss), currency } : {}) } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.error)); return; }
    toast(r.data?.already_processed ? "Mục tiêu này đã được tạo trước đó." : `Đã tạo mục tiêu ${r.data?.goal?.code ?? ""}.`);
    onDone();
  }
  return (
    <Modal open={open} onClose={onClose} title="Tạo mục tiêu kinh doanh">
      <form onSubmit={submit} className="l-grid" style={{ gap: 10 }}>
        <label className="l-label">Tên mục tiêu<input className="l-input" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={200} data-testid="goal-title" /></label>
        <label className="l-label">Kết quả mong muốn<textarea className="l-textarea" value={outcome} onChange={(e) => setOutcome(e.target.value)} required rows={3} data-testid="goal-outcome" /></label>
        <label className="l-label">Dự án<select className="l-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} required data-testid="goal-project">{data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="l-row" style={{ gap: 8 }}>
          <label className="l-label" style={{ flex: 1 }}>Mức lỗ tối đa (tùy chọn)<input className="l-input" type="number" min={0} step="any" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} data-testid="goal-maxloss" /></label>
          <label className="l-label" style={{ width: 110 }}>Tiền tệ<input className="l-input" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={5} /></label>
        </div>
        <p className="small muted">Hệ thống không tự đặt doanh thu hay ROI mục tiêu thay bạn. Để trống mức lỗ nếu bạn chưa quyết.</p>
        {err && <div className="l-note" role="alert" data-testid="goal-error">{err}</div>}
        <div className="l-row" style={{ justifyContent: "flex-end" }}><button type="button" className="l-btn" onClick={onClose}>Hủy</button><button className="l-btn primary" disabled={busy || data.projects.length === 0} data-testid="goal-submit">Tạo mục tiêu</button></div>
        {data.projects.length === 0 && <p className="small muted">Chưa có dự án đang hoạt động; hãy tạo dự án trước.</p>}
      </form>
    </Modal>
  );
}

function PlanForm({ goal, onClose, data, onDone }: { goal: any | null; onClose: () => void; data: Overview; onDone: () => void }) {
  const { toast } = useLumi();
  const ready = data.assistants.filter((a) => a.ready);
  const [lead, setLead] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [key, setKey] = useState("");
  useEffect(() => { if (goal) { setLead(ready[0]?.id ?? ""); setErr(null); setBusy(false); setKey(newKey()); } }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy || !goal) return; setBusy(true); setErr(null);
    const r = await lumiApi("/api/v1/lumi/plans", { method: "POST", key, body: { goal_id: goal.id, lead_assistant_id: lead } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.error)); return; }
    toast(`Đã giao ${r.data?.plan?.code ?? "kế hoạch"} cho bot lập Plan & Cost.`);
    onDone();
  }
  return (
    <Modal open={goal !== null} onClose={onClose} title={`Yêu cầu bot lập kế hoạch — ${goal?.code ?? ""}`}>
      <form onSubmit={submit} className="l-grid" style={{ gap: 10 }}>
        <p className="muted">Bot trưởng kế hoạch sẽ nghiên cứu và nộp một Plan &amp; Cost có phiên bản. Chưa có gì được thực hiện hay chi tiêu cho tới khi bạn duyệt. Lượt lập kế hoạch này là một lần chạy bot (chi phí AI chưa đo).</p>
        {ready.length === 0 ? <div className="l-note" data-testid="no-ready-assistant">Chưa có trợ lý nào sẵn sàng (đã kết nối và bật giao việc). Kết nối và bật trợ lý trước khi yêu cầu lập kế hoạch.</div> : (
          <label className="l-label">Bot trưởng kế hoạch<select className="l-select" value={lead} onChange={(e) => setLead(e.target.value)} data-testid="plan-lead">{ready.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        )}
        {err && <div className="l-note" role="alert" data-testid="plan-create-error">{err}</div>}
        <div className="l-row" style={{ justifyContent: "flex-end" }}><button type="button" className="l-btn" onClick={onClose}>Hủy</button><button className="l-btn primary" disabled={busy || ready.length === 0} data-testid="plan-create-submit">Giao lập kế hoạch</button></div>
      </form>
    </Modal>
  );
}

function CloseForm({ goal, onClose, onDone }: { goal: any | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useLumi();
  const [result, setResult] = useState("INSUFFICIENT_DATA"); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (goal) { setResult("INSUFFICIENT_DATA"); setNote(""); setErr(null); setBusy(false); } }, [goal]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy || !goal) return; setBusy(true); setErr(null);
    const r = await lumiApi(`/api/v1/lumi/goals/${goal.id}/close`, { method: "POST", body: { result, note } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.error)); return; }
    toast("Đã đóng mục tiêu."); onDone();
  }
  return (
    <Modal open={goal !== null} onClose={onClose} title={`Đóng mục tiêu ${goal?.code ?? ""}`}>
      <form onSubmit={submit} className="l-grid" style={{ gap: 10 }}>
        <p className="muted">Chỉ bạn quyết định mục tiêu kinh doanh có đạt hay không; hệ thống không tự kết luận. Nếu chọn «Đạt» hoặc «Không đạt», hãy ghi bằng chứng (tối thiểu 10 ký tự).</p>
        <label className="l-label">Kết quả<select className="l-select" value={result} onChange={(e) => setResult(e.target.value)} data-testid="goal-result">{Object.entries(GOAL_RESULT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="l-label">Ghi chú / bằng chứng<textarea className="l-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="goal-close-note" /></label>
        {err && <div className="l-note" role="alert">{err}</div>}
        <div className="l-row" style={{ justifyContent: "flex-end" }}><button type="button" className="l-btn" onClick={onClose}>Hủy</button><button className="l-btn primary" disabled={busy} data-testid="goal-close-submit">Đóng mục tiêu</button></div>
      </form>
    </Modal>
  );
}
