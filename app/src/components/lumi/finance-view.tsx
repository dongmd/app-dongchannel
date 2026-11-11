"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/**
 * Tài chính (CST-01/02, ECO-02/04, MOS-03). Four books kept APART and never added into a "profit": ads cost, commission, sponsor (all typed by a person with a stated source),
 * and AI cost (measured). Pipeline is not money received. Experiments fix their stop/scale criteria BEFORE data; one conversion never recommends scaling.
 */
import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";

import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull } from "./ui";

type Tab = "limits" | "money" | "experiments";
const LEDGER: Record<string, string> = { ADS_COST: "Chi phí quảng cáo", COMMISSION: "Hoa hồng", SPONSOR: "Tài trợ" };
const MSTATE: Record<string, string> = { RECORDED: "Đã ghi nhận", CONFIRMED: "Đã xác nhận", PAID: "ĐÃ TRẢ (tiền đã nhận)", REVERSED: "Đảo/hoàn", PIPELINE: "Pipeline (chưa phải tiền thu)" };
const ESTATE: Record<string, string> = { DRAFT: "Nháp (chưa chốt tiêu chí)", LOCKED: "Đã chốt, đang chạy", STOPPED: "ĐÃ DỪNG", SCALE_PROPOSED: "Đề xuất mở rộng (chờ Chủ)", INSUFFICIENT: "Chưa đủ bằng chứng", COMPLETED: "Đã quyết định" };
const SCOPE: Record<string, string> = { DAY_GLOBAL: "Mỗi ngày, toàn công ty", DAY_ASSISTANT: "Mỗi ngày, một bot", PROJECT_TOTAL: "Tổng cho một dự án", RUN: "Một lượt chạy" };
const fmt = (n: number | null | undefined, d = 4) => (n === null || n === undefined ? "chưa biết" : Number(n).toLocaleString("vi-VN", { maximumFractionDigits: d }));

export function FinanceView() {
  const { state } = useLumi();
  return state.mode !== "db" ? <Empty>Màn Tài chính cần chế độ dữ liệu thật (đăng nhập).</Empty> : <Inner />;
}

function Inner() {
  const { state } = useLumi();
  const role = state.real?.role; const isOwner = role === "OWNER"; const canWrite = role === "OWNER" || role === "ADMIN";
  const [tab, setTab] = useState<Tab>("limits");
  const projects = state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }));
  return (
    <div className="l-grid" style={{ gap: 14 }} data-testid="finance-view">
      <div>
        <h1 className="l-row" style={{ gap: 8 }}><Wallet size={22} /> Tài chính</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Bốn sổ <strong>tách riêng, không cộng thành lợi nhuận</strong>: chi phí quảng cáo, hoa hồng, tài trợ (người nhập, nêu nguồn) và chi phí AI (đo thật). Hợp đồng đã ký là «pipeline», không phải tiền thu. Chưa có nguồn thì «chưa có dữ liệu», không tự điền.</p>
      </div>
      <div className="l-tabs" role="tablist" aria-label="Tài chính">
        {([["limits", "Chi phí AI & giới hạn"], ["money", "Sổ tiền"], ["experiments", "Thử nghiệm"]] as [Tab, string][]).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`fin-tab-${k}`}>{l}</button>)}
      </div>
      {tab === "limits" && <Limits isOwner={isOwner} projects={projects} />}
      {tab === "money" && <Money canWrite={canWrite} projects={projects} />}
      {tab === "experiments" && <Experiments canWrite={canWrite} isOwner={isOwner} projects={projects} />}
    </div>
  );
}

function useApi<T = any>(path: string, method: "GET" | "POST" = "GET", body?: unknown, every = 8000) {
  const [d, setD] = useState<T | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await lumiApi<T>(path, { method, body }); if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error)); }, [path, method, JSON.stringify(body ?? null)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, every); return () => clearInterval(t); }, [load, every]);
  return { d, err, load };
}

function Limits({ isOwner, projects }: { isOwner: boolean; projects: { id: string; name: string }[] }) {
  const { toast } = useLumi();
  const { d, err, load } = useApi<any>("/api/v1/lumi/cost/limits");
  const [f, setF] = useState({ scope: "DAY_GLOBAL", ref: "", amount: "", warn: "0.8" });
  const [assistants, setAssistants] = useState<any[]>([]);
  useEffect(() => { void lumiApi("/api/v1/lumi/assistants").then((r) => { if (r.ok) setAssistants((r.data.assistants as any[]).filter((a) => a.status === "ACTIVE")); }); }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await lumiApi("/api/v1/lumi/cost/limits", { method: "POST", body: { scope: f.scope, scope_ref: f.ref || undefined, amount: Number(f.amount), warn_ratio: Number(f.warn) } });
    toast(r.ok ? "Đã đặt giới hạn." : `Không thực hiện được: ${errText(r.error)}`); if (r.ok) { setF({ ...f, amount: "" }); void load(); }
  }
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="fin-limits">
      <div className="l-banner" role="note"><strong>Giới hạn chỉ ép được trên chi phí ĐO THẬT.</strong><span>Lượt chưa đo chi phí (khóa dùng chung, chồng lượt, bản mô phỏng) <strong>không được tính vào trần</strong>; với chúng, trần số lượt của hồ sơ bot vẫn là phanh. Chi phí đo trễ khoảng một phút sau mỗi lượt. Chạm trần: lượt MỚI bị từ chối, lượt đang chạy không bị giết (dùng «Dừng khẩn cấp» ở Quản trị). Giới hạn không bao giờ tự xin thêm.</span></div>
      {isOwner && (
        <form className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={save} data-testid="limit-form">
          <label className="l-label">Phạm vi<select className="l-input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, ref: "" })} data-testid="lm-scope">{Object.entries(SCOPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {f.scope === "DAY_ASSISTANT" && <label className="l-label">Bot<select className="l-input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} required data-testid="lm-ref"><option value="">— chọn —</option>{assistants.map((a) => <option key={a.id} value={a.slug}>{a.name}</option>)}</select></label>}
          {f.scope === "PROJECT_TOTAL" && <label className="l-label">Dự án<select className="l-input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} required data-testid="lm-ref"><option value="">— chọn —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          <label className="l-label" style={{ width: 130 }}>Trần (USD)<input className="l-input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required data-testid="lm-amount" /></label>
          <label className="l-label" style={{ width: 130 }}>Cảnh báo ở (0–1)<input className="l-input" inputMode="decimal" value={f.warn} onChange={(e) => setF({ ...f, warn: e.target.value })} /></label>
          <button className="l-btn primary" data-testid="lm-save">Đặt giới hạn</button>
        </form>
      )}
      {(d.limits as any[]).length === 0 ? <Empty>Chưa đặt giới hạn chi phí nào.</Empty> : (
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }} data-testid="limit-table">
          <thead><tr><th align="left">Phạm vi</th><th align="left">Đối tượng</th><th align="right">Trần</th><th align="right">Đã dùng (đo thật)</th><th align="left">Đặt bởi</th><th /></tr></thead>
          <tbody>{(d.limits as any[]).map((l) => (
            <tr key={l.id} data-testid={`limit-${l.scope}`} data-over={l.ratio !== null && l.ratio >= 1 ? "1" : "0"}>
              <td>{SCOPE[l.scope]}</td><td>{l.assistant_name ?? l.project_name ?? "—"}</td><td align="right">{fmt(l.amount)} USD</td>
              <td align="right">{l.spent_measured === null ? "kiểm sau từng lượt" : `${fmt(l.spent_measured)} (${Math.round((l.ratio ?? 0) * 100)}%)`}{l.ratio !== null && l.ratio >= 1 ? <span className="l-badge red" style={{ marginLeft: 6 }}>ĐÃ CHẠM TRẦN</span> : l.ratio !== null && l.ratio >= l.warn_ratio ? <span className="l-badge amber" style={{ marginLeft: 6 }}>gần trần</span> : null}</td>
              <td className="small">{l.set_by} · {fmtFull(l.set_at)}</td>
              <td>{isOwner && <button className="l-btn sm danger" onClick={async () => { const r = await lumiApi(`/api/v1/lumi/cost/limits/${l.id}/remove`, { method: "POST", body: {} }); toast(r.ok ? "Đã gỡ giới hạn (lịch sử giữ)." : errText(r.error)); void load(); }} data-testid={`limit-remove-${l.scope}`}>Gỡ</button>}</td>
            </tr>))}</tbody>
        </table>
      )}
      <h3 style={{ margin: "8px 0 0" }}>Chi phí AI đo thật theo bot</h3>
      <p className="small muted" style={{ marginTop: 0 }}>{d.summary.note}</p>
      <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }} data-testid="cost-by-bot">
        <thead><tr><th align="left">Bot</th><th align="right">Lượt</th><th align="right">Đo được</th><th align="right">Chưa biết</th><th align="right">Chi phí đo được (USD)</th></tr></thead>
        <tbody>{(d.summary.assistants as any[]).map((a) => <tr key={a.slug}><td>{a.name}</td><td align="right">{a.runs_total}</td><td align="right">{a.runs_measured}</td><td align="right">{a.runs_unknown}</td><td align="right">{fmt(a.measured_amount)}{a.runs_unknown > 0 ? " + chưa biết" : ""}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Money({ canWrite, projects }: { canWrite: boolean; projects: { id: string; name: string }[] }) {
  const { toast } = useLumi();
  const [pid, setPid] = useState("");
  const { d, err, load } = useApi<any>("/api/v1/lumi/money/overview", "POST", pid ? { project_id: pid } : {});
  const [f, setF] = useState({ project: "", ledger: "COMMISSION", state: "RECORDED", amount: "", currency: "USD", source: "", note: "", start: "", end: "" });
  const starts: Record<string, string[]> = { ADS_COST: ["RECORDED"], COMMISSION: ["RECORDED", "CONFIRMED", "PAID"], SPONSOR: ["PIPELINE", "RECORDED", "CONFIRMED", "PAID"] };
  const [key, setKey] = useState(newKey());
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await lumiApi("/api/v1/lumi/money", { method: "POST", key, body: { project_id: f.project, ledger: f.ledger, state: f.state, amount: Number(f.amount), currency: f.currency, source: f.source, note: f.note || undefined, period_start: f.start || undefined, period_end: f.end || undefined } });
    toast(r.ok ? "Đã ghi sổ." : `Không thực hiện được: ${errText(r.error)}`);
    if (r.ok) { setF({ ...f, amount: "", note: "" }); setKey(newKey()); void load(); }
  }
  const NEXT: Record<string, string[]> = { PIPELINE: ["RECORDED", "CONFIRMED", "PAID", "REVERSED"], RECORDED: ["CONFIRMED", "PAID", "REVERSED"], CONFIRMED: ["PAID", "REVERSED"], PAID: ["REVERSED"], REVERSED: [] };
  async function adjust(id: string, to: string, ledger: string) {
    const note = to === "REVERSED" ? window.prompt("Lý do đảo/hoàn:") ?? "" : "";
    const r = await lumiApi(`/api/v1/lumi/money/${id}/adjust`, { method: "POST", key: newKey(), body: { to_state: to, note: note || undefined } });
    toast(r.ok ? "Đã ghi điều chỉnh (số cũ được giữ)." : `Không thực hiện được: ${errText(r.error)}`); void load(); void ledger;
  }
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const s = d.summary;
  const card = (ledger: string) => (
    <section key={ledger} className="l-card" data-testid={`book-${ledger}`}>
      <h3 style={{ margin: "0 0 4px" }}>{LEDGER[ledger]}</h3>
      {(s.ledgers[ledger] as any[]).length === 0 ? <p className="muted small" data-testid={`book-${ledger}-empty`}>chưa có dữ liệu</p> : (s.ledgers[ledger] as any[]).map((c) => (
        <div key={c.currency} className="small" data-testid={`book-${ledger}-${c.currency}`}><strong>{c.currency}</strong>: {ledger === "ADS_COST" ? <>đã ghi {fmt(c.RECORDED, 2)}{c.REVERSED ? ` · đảo ${fmt(c.REVERSED, 2)}` : ""}</> : <>đã trả <strong>{fmt(c.PAID, 2)}</strong> · xác nhận {fmt(c.CONFIRMED, 2)} · ghi nhận {fmt(c.RECORDED, 2)}{ledger === "SPONSOR" ? ` · pipeline ${fmt(c.PIPELINE, 2)} (chưa là tiền thu)` : ""}{c.REVERSED ? ` · đảo ${fmt(c.REVERSED, 2)}` : ""}</>}</div>
      ))}
    </section>
  );
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="fin-money">
      <div className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label className="small l-row" style={{ gap: 6 }}>Dự án<select className="l-input" value={pid} onChange={(e) => setPid(e.target.value)} data-testid="mn-filter"><option value="">Tất cả</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <span className="small muted">Cập nhật: {s.updated_at ? fmtFull(s.updated_at) : "chưa có dữ liệu"}</span>
      </div>
      <div className="l-banner" role="note" data-testid="mn-note"><strong>Đọc kỹ.</strong><span>{s.note}</span></div>
      <div className="l-grid" style={{ gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {["ADS_COST", "COMMISSION", "SPONSOR"].map(card)}
        <section className="l-card" data-testid="book-AI"><h3 style={{ margin: "0 0 4px" }}>Chi phí AI (đo thật)</h3><div className="small"><strong>USD</strong>: {fmt(s.ai_cost.measured)} đã đo · {s.ai_cost.unknown_runs} lượt <strong>chưa biết</strong> (không phải 0)</div></section>
      </div>
      {canWrite && (
        <form className="l-card l-grid" style={{ gap: 8 }} onSubmit={save} data-testid="money-form">
          <strong>Ghi một khoản (bạn nhập, nêu nguồn)</strong>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="l-label">Dự án<select className="l-input" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} required data-testid="mf-project"><option value="">— chọn —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="l-label">Sổ<select className="l-input" value={f.ledger} onChange={(e) => setF({ ...f, ledger: e.target.value, state: starts[e.target.value]![0]! })} data-testid="mf-ledger">{Object.entries(LEDGER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="l-label">Trạng thái<select className="l-input" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} data-testid="mf-state">{starts[f.ledger]!.map((x) => <option key={x} value={x}>{MSTATE[x]}</option>)}</select></label>
            <label className="l-label" style={{ width: 120 }}>Số tiền<input className="l-input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required data-testid="mf-amount" /></label>
            <label className="l-label" style={{ width: 90 }}>Tiền tệ<input className="l-input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} required /></label>
          </div>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="l-label" style={{ flex: 1, minWidth: 220 }}>Nguồn số liệu (bắt buộc)<input className="l-input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} required minLength={2} placeholder="vd: Sao kê mạng lưới tháng 10" data-testid="mf-source" /></label>
            <label className="l-label">Từ ngày<input className="l-input" type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
            <label className="l-label">Đến ngày<input className="l-input" type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label>
          </div>
          <div><button className="l-btn primary" data-testid="mf-submit">Ghi sổ</button></div>
        </form>
      )}
      <h3 style={{ margin: "4px 0 0" }}>Các khoản đã ghi</h3>
      {(d.entries as any[]).length === 0 ? <Empty>Chưa có khoản nào.</Empty> : (
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }} data-testid="money-table">
          <thead><tr><th align="left">Sổ</th><th align="left">Dự án</th><th align="left">Trạng thái hiện hành</th><th align="right">Số tiền</th><th align="left">Nguồn / lịch sử</th><th /></tr></thead>
          <tbody>{(d.entries as any[]).map((e) => (
            <tr key={e.id} data-testid={`money-${e.ledger}-${e.state}`}>
              <td>{LEDGER[e.ledger]}</td><td>{e.project_name}</td><td>{MSTATE[e.state]}</td><td align="right">{fmt(e.amount, 2)} {e.currency}</td>
              <td className="small">{e.source}{(e.history as any[]).length > 0 ? ` · ${(e.history as any[]).map((h) => `${MSTATE[h.state]}${h.note ? ` (${h.note})` : ""}`).join(" → ")}` : ""}</td>
              <td>{canWrite && (e.ledger === "ADS_COST" ? ["REVERSED"] : NEXT[e.state] ?? []).filter(() => e.state !== "REVERSED").slice(0, 3).map((to: string) => <button key={to} className="l-btn sm" style={{ marginRight: 4 }} onClick={() => void adjust(e.root_id ?? e.id, to, e.ledger)} data-testid={`adj-${e.state}-${to}`}>→ {MSTATE[to]?.split(" ")[0]}</button>)}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

function Experiments({ canWrite, isOwner, projects }: { canWrite: boolean; isOwner: boolean; projects: { id: string; name: string }[] }) {
  const { toast } = useLumi();
  const { d, err, load } = useApi<any>("/api/v1/lumi/experiments");
  const [adding, setAdding] = useState(false);
  const empty = { project: "", title: "", hypothesis: "", baseline: "", unit: "USD/chuyển đổi", source: "", days: "14", sample: "5", cap: "", loss: "", currency: "USD", stop: "", scale: "", target: "", stopNoConv: "", evaluator: "Chủ" };
  const [f, setF] = useState<any>(empty);
  const [res, setRes] = useState<Record<string, any>>({});
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await lumiApi("/api/v1/lumi/experiments", { method: "POST", body: { project_id: f.project, title: f.title, hypothesis: f.hypothesis, baseline: f.baseline, metric_unit: f.unit, metric_source: f.source, observation_days: Number(f.days), min_sample: Number(f.sample), cap_amount: Number(f.cap), max_loss: Number(f.loss), currency: f.currency, stop_condition: f.stop, scale_condition: f.scale, target_metric_min: f.target ? Number(f.target) : undefined, stop_spend_no_conversion: f.stopNoConv ? Number(f.stopNoConv) : undefined, evaluator: f.evaluator } });
    toast(r.ok ? "Đã tạo bản nháp. Chốt tiêu chí trước khi chạy." : `Không thực hiện được: ${errText(r.error)}`);
    if (r.ok) { setAdding(false); setF(empty); void load(); }
  }
  async function post(path: string, body: any, ok: string) { const r = await lumiApi(path, { method: "POST", body }); toast(r.ok ? ok : `Không thực hiện được: ${errText(r.error)}`); void load(); return r; }
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const set = (k: string, v: string) => setF((p: any) => ({ ...p, [k]: v }));
  const field = (k: string, label: string, ph = "", w?: number) => <label className="l-label" style={w ? { width: w } : { flex: 1, minWidth: 180 }}>{label}<input className="l-input" value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={ph} data-testid={`ex-${k}`} /></label>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="fin-experiments">
      <div className="l-banner" role="note"><strong>Tiêu chí chốt TRƯỚC khi chạy.</strong><span>Giả thuyết, đo bằng gì, trần chi, mức lỗ tối đa, điều kiện dừng và scale được chốt rồi không sửa được. Chạm trần/ngưỡng thì dừng nhánh. Kết quả tốt <strong>không tự cấp thêm ngân sách</strong> và một chuyển đổi không bao giờ đủ để đề xuất mở rộng.</span></div>
      {canWrite && !adding && <div><button className="l-btn primary" onClick={() => setAdding(true)} data-testid="ex-add">Tạo thử nghiệm</button></div>}
      {adding && (
        <form className="l-card l-grid" style={{ gap: 8 }} onSubmit={create} data-testid="ex-form">
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="l-label">Dự án<select className="l-input" value={f.project} onChange={(e) => set("project", e.target.value)} required data-testid="ex-project"><option value="">— chọn —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            {field("title", "Tên thử nghiệm")}
          </div>
          {field("hypothesis", "Giả thuyết")}{field("baseline", "Baseline (hiện tại là bao nhiêu)")}
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>{field("unit", "Đơn vị đo")}{field("source", "Nguồn số liệu")}{field("days", "Số ngày quan sát", "", 120)}{field("sample", "Mẫu tối thiểu (chuyển đổi)", "", 150)}</div>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>{field("cap", "Trần chi", "", 110)}{field("loss", "Mức lỗ tối đa", "", 120)}{field("currency", "Tiền tệ", "", 90)}{field("target", "Chỉ số mục tiêu (≥)", "", 150)}{field("stopNoConv", "Dừng nếu chi ≥ … mà 0 chuyển đổi", "", 220)}</div>
          {field("stop", "Điều kiện dừng (lời)")}{field("scale", "Điều kiện scale (lời)")}{field("evaluator", "Người đánh giá")}
          <div className="l-row" style={{ gap: 8 }}><button className="l-btn primary" data-testid="ex-submit">Tạo bản nháp</button><button type="button" className="l-btn" onClick={() => setAdding(false)}>Hủy</button></div>
        </form>
      )}
      {(d.experiments as any[]).length === 0 ? <Empty>Chưa có thử nghiệm nào.</Empty> : (d.experiments as any[]).map((e) => (
        <section key={e.id} className="l-card" data-testid={`ex-${e.code}`} data-state={e.state}>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}><strong>{e.code} · {e.title}</strong><span className={`l-badge ${e.state === "STOPPED" ? "red" : e.state === "SCALE_PROPOSED" ? "amber" : e.state === "LOCKED" ? "purple" : ""}`}>{ESTATE[e.state]}</span></div>
          <div className="small muted">{e.project_name} · giả thuyết: {e.hypothesis} · baseline: {e.baseline} · đo: {e.metric_unit} ({e.metric_source}) · trần {fmt(e.cap_amount, 2)} {e.currency} · lỗ tối đa {fmt(e.max_loss, 2)} · mẫu tối thiểu {e.min_sample} · {e.observation_days} ngày · người đánh giá {e.evaluator}</div>
          <div className="small">Dừng khi: {e.stop_condition} · Scale khi: {e.scale_condition}</div>
          {e.verdict && <div className="small" data-testid={`ex-verdict-${e.code}`}><strong>Kết luận hiện tại:</strong> {e.verdict.verdict === "INSUFFICIENT_EVIDENCE" ? "CHƯA ĐỦ BẰNG CHỨNG" : e.verdict.verdict === "RUNNING" ? "chưa có kết quả" : e.verdict.verdict === "STOP" ? "DỪNG" : "ứng viên mở rộng (chỉ là đề xuất)"} · chi {fmt(e.verdict.spend, 2)} · {e.verdict.conversions} chuyển đổi · {e.verdict.days_observed} ngày có số · {(e.verdict.reasons as string[]).join(" ")}</div>}
          {e.decision_note && <div className="small muted">Quyết định: {e.decision_note}</div>}
          {isOwner && e.state === "DRAFT" && <button className="l-btn sm primary" style={{ marginTop: 6 }} onClick={() => void post(`/api/v1/lumi/experiments/${e.id}/lock`, {}, "Đã chốt tiêu chí; không sửa được nữa.")} data-testid={`ex-lock-${e.code}`}>Chốt tiêu chí (không sửa được nữa)</button>}
          {canWrite && e.state === "LOCKED" && (
            <form className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }} data-testid={`ex-result-form-${e.code}`} onSubmit={async (ev) => { ev.preventDefault(); const r = res[e.id] ?? {}; const x = await post(`/api/v1/lumi/experiments/${e.id}/results`, { observed_on: r.day, spend: Number(r.spend), conversions: Number(r.conv), metric_value: r.metric ? Number(r.metric) : undefined }, "Đã ghi kết quả."); if (x.ok) setRes({ ...res, [e.id]: {} }); }}>
              <input className="l-input" type="date" style={{ width: 150 }} value={res[e.id]?.day ?? ""} onChange={(ev) => setRes({ ...res, [e.id]: { ...res[e.id], day: ev.target.value } })} required data-testid={`rs-day-${e.code}`} />
              <input className="l-input" style={{ width: 100 }} placeholder="Chi" inputMode="decimal" value={res[e.id]?.spend ?? ""} onChange={(ev) => setRes({ ...res, [e.id]: { ...res[e.id], spend: ev.target.value } })} required data-testid={`rs-spend-${e.code}`} />
              <input className="l-input" style={{ width: 120 }} placeholder="Chuyển đổi" inputMode="numeric" value={res[e.id]?.conv ?? ""} onChange={(ev) => setRes({ ...res, [e.id]: { ...res[e.id], conv: ev.target.value } })} required data-testid={`rs-conv-${e.code}`} />
              <input className="l-input" style={{ width: 120 }} placeholder="Chỉ số" inputMode="decimal" value={res[e.id]?.metric ?? ""} onChange={(ev) => setRes({ ...res, [e.id]: { ...res[e.id], metric: ev.target.value } })} data-testid={`rs-metric-${e.code}`} />
              <button className="l-btn sm" data-testid={`rs-submit-${e.code}`}>Ghi kết quả</button>
              {isOwner && <button type="button" className="l-btn sm" onClick={() => { const note = window.prompt("Lý do đóng thử nghiệm:") ?? ""; if (note.trim().length >= 3) void post(`/api/v1/lumi/experiments/${e.id}/decide`, { decision: "CLOSE", note }, "Đã đóng."); }}>Đóng (hết kỳ)</button>}
            </form>
          )}
          {isOwner && e.state === "SCALE_PROPOSED" && <div className="l-row" style={{ gap: 6, marginTop: 6 }}><button className="l-btn sm primary" onClick={() => void post(`/api/v1/lumi/experiments/${e.id}/decide`, { decision: "APPROVE_SCALE", note: "Chủ đồng ý hướng mở rộng" }, "Đã ghi nhận (ngân sách phải cấp riêng).")} data-testid={`ex-approve-${e.code}`}>Đồng ý hướng mở rộng (không cấp ngân sách)</button><button className="l-btn sm danger" onClick={() => void post(`/api/v1/lumi/experiments/${e.id}/decide`, { decision: "REJECT", note: "Chủ không mở rộng" }, "Đã từ chối.")}>Không mở rộng</button></div>}
          {(e.results as any[]).length > 0 && <details style={{ marginTop: 6 }}><summary className="small">Kết quả đã ghi ({(e.results as any[]).length})</summary><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(e.results as any[]).map((r, i) => <li key={i}>{r.observed_on}: chi {fmt(r.spend, 2)}, {r.conversions} chuyển đổi{r.metric_value !== null ? `, chỉ số ${r.metric_value}` : ""}</li>)}</ul></details>}
        </section>
      ))}
    </div>
  );
}
