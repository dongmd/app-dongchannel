"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** Đợt 8 (nhóm 1) screens: Công suất & chuyển giao (ORG-06) + đổi trưởng kế hoạch (PLN-01), Quỹ (PLN-04, tab trong Tài chính), Đồ thị kiến thức + mâu thuẫn + kiểm liên kết (KNW-10/08). */
import { useCallback, useEffect, useState } from "react";
import { Gauge, Network } from "lucide-react";

import { errText, lumiApi } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull, LumiLink } from "./ui";

function useGet<T = any>(path: string, every = 12000) {
  const [d, setD] = useState<T | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await lumiApi<T>(path); if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error)); }, [path]);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, every); return () => clearInterval(t); }, [load, every]);
  return { d, err, load };
}
const fmt = (n: number | null | undefined, d = 4) => (n === null || n === undefined ? "chưa biết" : Number(n).toLocaleString("vi-VN", { maximumFractionDigits: d }));
const PSTATE: Record<string, string> = { DRAFTING: "Đang lập", NEEDS_REVISION: "Cần sửa", EXECUTING: "Đang thực hiện", PAUSED_ADJUSTMENT: "Tạm dừng chờ điều chỉnh", DEFERRED: "Hoãn", PENDING_APPROVAL: "Chờ duyệt" };

export function CapacityView() {
  const { state, toast } = useLumi();
  const isOwner = state.real?.role === "OWNER";
  const cap = useGet<any>("/api/v1/lumi/capacity"); const funds = useGet<any>("/api/v1/lumi/funds", 20000);
  const [cv, setCv] = useState<Record<string, string>>({});
  const [tf, setTf] = useState({ from: "", to: "", reason: "" });
  const [lead, setLead] = useState<Record<string, { to: string; reason: string }>>({});
  const act = async (path: string, body: any, ok: string) => { const r = await lumiApi<any>(path, { method: "POST", body }); toast(r.ok ? ok : `Không thực hiện được: ${errText(r.error)}`); void cap.load(); void funds.load(); return r; };
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  if (cap.err) return <div className="l-note" role="alert">{cap.err}</div>;
  if (!cap.d) return <p className="muted">Đang tải…</p>;
  const bots: any[] = cap.d.assistants;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="capacity-view">
      <div><h1 className="l-row" style={{ gap: 8 }}><Gauge size={22} /> Công suất &amp; chuyển giao</h1><p className="muted" style={{ margin: "4px 0 0" }}>Công suất là số việc đang mở tối đa của một trợ lý; đủ thì việc mới bị từ chối cho tới khi chuyển bớt hoặc nâng công suất. Chuyển giao chỉ chuyển việc chưa chạy (không bao giờ hai bot cùng thực thi một việc); lịch sử và chi phí giữ nguyên.</p></div>
      <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th align="left">Trợ lý</th><th align="right">Đang mở</th><th align="right">Chuyển được</th><th align="left">Công suất</th><th align="left">Giao việc</th></tr></thead>
        <tbody>{bots.map((b) => (
          <tr key={b.id} data-testid={`cap-${b.slug}`}>
            <td>{b.name}</td><td align="right" data-testid={`cap-open-${b.slug}`}>{b.open_tasks}</td><td align="right">{b.movable}</td>
            <td>{b.capacity ?? "không giới hạn"}{isOwner && <span className="l-row" style={{ gap: 4, display: "inline-flex", marginLeft: 8 }}><input className="l-input" style={{ width: 70 }} inputMode="numeric" value={cv[b.id] ?? ""} onChange={(e) => setCv({ ...cv, [b.id]: e.target.value })} placeholder="1–50" data-testid={`cap-input-${b.slug}`} /><button className="l-btn sm" onClick={() => void act(`/api/v1/lumi/capacity/${b.id}`, { capacity: cv[b.id] === "" || cv[b.id] === undefined ? null : Number(cv[b.id]) }, "Đã đặt công suất.")} data-testid={`cap-save-${b.slug}`}>Lưu</button></span>}</td>
            <td>{b.dispatch_paused ? <span className="l-badge red">Đang tạm dừng</span> : "Hoạt động"}{isOwner && <button className="l-btn sm" style={{ marginLeft: 8 }} onClick={() => void act(`/api/v1/lumi/capacity/${b.id}/pause`, { paused: !b.dispatch_paused }, b.dispatch_paused ? "Đã tiếp tục." : "Đã tạm dừng giao việc.")} data-testid={`cap-pause-${b.slug}`}>{b.dispatch_paused ? "Tiếp tục" : "Tạm dừng"}</button>}</td>
          </tr>))}</tbody>
      </table>
      {isOwner && (
        <form className="l-card l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="transfer-form" onSubmit={async (e) => { e.preventDefault(); const r = await act("/api/v1/lumi/capacity/transfer", { from_id: tf.from, to_id: tf.to, reason: tf.reason }, "Đã chuyển giao."); if (r.ok) toast(`Chuyển ${r.data.moved.length} việc${r.data.skipped.length ? `, bỏ qua ${r.data.skipped.length}: ${r.data.skipped[0]}` : ""}.`); }}>
          <label className="l-label">Từ<select className="l-input" value={tf.from} onChange={(e) => setTf({ ...tf, from: e.target.value })} required data-testid="tf-from"><option value="">—</option>{bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="l-label">Sang<select className="l-input" value={tf.to} onChange={(e) => setTf({ ...tf, to: e.target.value })} required data-testid="tf-to"><option value="">—</option>{bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="l-label" style={{ flex: 1, minWidth: 200 }}>Lý do<input className="l-input" value={tf.reason} onChange={(e) => setTf({ ...tf, reason: e.target.value })} required data-testid="tf-reason" /></label>
          <button className="l-btn primary" data-testid="tf-go">Chuyển mọi việc chưa chạy</button>
        </form>
      )}
      {(cap.d.transfers as any[]).length > 0 && <details><summary className="small">Lịch sử chuyển giao ({(cap.d.transfers as any[]).length} gần nhất)</summary><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(cap.d.transfers as any[]).map((t, i) => <li key={i}>{fmtFull(t.at)} · {t.code}: {t.from_slug} → {t.to_slug} · {t.reason}</li>)}</ul></details>}
      <h2 style={{ margin: "8px 0 0", fontSize: "1.05rem" }}>Trưởng kế hoạch</h2>
      <p className="small muted" style={{ marginTop: 0 }}>Đổi trưởng kế hoạch giữ nguyên việc đang chạy và lịch sử; không đổi được khi kế hoạch đang chờ duyệt. Trưởng mới phải thuộc dự án và đã kiểm tra kết nối thật.</p>
      {!funds.d ? null : (funds.d.plans as any[]).length === 0 ? <Empty>Chưa có kế hoạch đang chạy.</Empty> : (funds.d.plans as any[]).map((p) => {
        const l = lead[p.plan_id] ?? { to: "", reason: "" }; const cur = bots.find((b) => b.id === p.lead_assistant_id);
        return (
          <section key={p.plan_id} className="l-card" data-testid={`plan-${p.code}`}>
            <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{p.code} · {p.title}</strong><span className="small muted">{PSTATE[p.status] ?? p.status} · trưởng hiện tại: <span data-testid={`lead-${p.code}`}>{cur?.name ?? "—"}</span></span></div>
            {isOwner && (
              <div className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                <select className="l-input" style={{ width: 180 }} value={l.to} onChange={(e) => setLead({ ...lead, [p.plan_id]: { ...l, to: e.target.value } })} data-testid={`lead-to-${p.code}`}><option value="">Trưởng mới…</option>{bots.filter((b) => b.id !== p.lead_assistant_id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                <input className="l-input" style={{ flex: 1, minWidth: 180 }} placeholder="Lý do" value={l.reason} onChange={(e) => setLead({ ...lead, [p.plan_id]: { ...l, reason: e.target.value } })} data-testid={`lead-reason-${p.code}`} />
                <button className="l-btn sm" onClick={() => void act(`/api/v1/lumi/plans/${p.plan_id}/lead`, { new_lead_id: l.to, reason: l.reason }, "Đã đổi trưởng kế hoạch.")} data-testid={`lead-go-${p.code}`}>Đổi trưởng</button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function FundsPanel({ assistants }: { assistants: { id: string; name: string }[] }) {
  const { toast } = useLumi(); const { state } = useLumi(); const isOwner = state.real?.role === "OWNER";
  const { d, err, load } = useGet<any>("/api/v1/lumi/funds", 15000);
  const [f, setF] = useState({ scope: "COMPANY", assistant: "", amount: "", start: "", end: "" });
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="fin-funds">
      <div className="l-banner" role="note"><strong>Quỹ chuẩn bị và khả dụng.</strong><span>{d.note}</span></div>
      {isOwner && (
        <form className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="fund-form" onSubmit={async (e) => { e.preventDefault(); const r = await lumiApi("/api/v1/lumi/funds", { method: "POST", body: { scope: f.scope, assistant_id: f.scope === "ASSISTANT" ? f.assistant : undefined, amount: Number(f.amount), period_start: f.start, period_end: f.end } }); toast(r.ok ? "Đã đặt quỹ (bản cũ được giữ)." : `Không thực hiện được: ${errText(r.error)}`); if (r.ok) { setF({ ...f, amount: "" }); void load(); } }}>
          <label className="l-label">Phạm vi<select className="l-input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} data-testid="fd-scope"><option value="COMPANY">Toàn công ty</option><option value="ASSISTANT">Một trợ lý</option></select></label>
          {f.scope === "ASSISTANT" && <label className="l-label">Trợ lý<select className="l-input" value={f.assistant} onChange={(e) => setF({ ...f, assistant: e.target.value })} required data-testid="fd-assistant"><option value="">—</option>{assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
          <label className="l-label" style={{ width: 110 }}>Số tiền (USD)<input className="l-input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required data-testid="fd-amount" /></label>
          <label className="l-label">Từ ngày<input className="l-input" type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required data-testid="fd-start" /></label>
          <label className="l-label">Đến ngày<input className="l-input" type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} required data-testid="fd-end" /></label>
          <button className="l-btn primary" data-testid="fd-save">Đặt quỹ chuẩn bị</button>
        </form>
      )}
      {(d.prep as any[]).length === 0 ? <Empty>Chưa đặt quỹ chuẩn bị nào.</Empty> : (
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }} data-testid="fund-table">
          <thead><tr><th align="left">Phạm vi</th><th align="right">Quỹ</th><th align="right">Đã chi (đo thật)</th><th align="right">Khả dụng</th><th align="left">Kỳ</th></tr></thead>
          <tbody>{(d.prep as any[]).map((p) => <tr key={p.id} data-testid={`fund-${p.scope}`} data-over={p.over ? "1" : "0"}><td>{p.scope === "COMPANY" ? "Toàn công ty" : p.assistant_name}</td><td align="right">{fmt(p.amount, 2)} {p.currency}</td><td align="right">{fmt(p.spent_measured)}{p.unknown_runs > 0 ? <span className="muted"> + {p.unknown_runs} lượt chưa biết</span> : null}{p.over ? <span className="l-badge red" style={{ marginLeft: 6 }}>VƯỢT QUỸ</span> : null}</td><td align="right">{fmt(p.available, 2)}</td><td className="small">{String(p.period_start).slice(0, 10)} → {String(p.period_end).slice(0, 10)}</td></tr>)}</tbody>
        </table>
      )}
      <h3 style={{ margin: "4px 0 0" }}>Quỹ thực thi theo kế hoạch</h3>
      {(d.plans as any[]).length === 0 ? <Empty>Chưa có kế hoạch được duyệt.</Empty> : (
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }} data-testid="plan-funds">
          <thead><tr><th align="left">Kế hoạch</th><th align="right">Trần</th><th align="right">Thực tế</th><th align="right">Cam kết</th><th align="right">Dự phòng</th><th align="right">Khả dụng</th></tr></thead>
          <tbody>{(d.plans as any[]).map((p) => <tr key={p.plan_id}><td>{p.code} · {p.title}</td><td align="right">{fmt(p.ceiling, 2)} {p.currency}</td><td align="right">{fmt(p.actual, 2)}{p.unknown_count > 0 ? <span className="muted"> + {p.unknown_count} chưa biết</span> : null}</td><td align="right">{fmt(p.committed, 2)}</td><td align="right">{fmt(p.reserve, 2)}</td><td align="right">{fmt(p.available, 2)}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

export function KnowledgeGraphView() {
  const { state, toast } = useLumi(); const canWrite = state.real?.role === "OWNER" || state.real?.role === "ADMIN";
  const g = useGet<any>("/api/v1/lumi/knowledge-graph", 30000); const c = useGet<any>("/api/v1/lumi/knowledge-conflicts", 30000); const l = useGet<any>("/api/v1/lumi/knowledge-links", 30000);
  const [busy, setBusy] = useState(false);
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  if (g.err) return <div className="l-note" role="alert">{g.err}</div>;
  if (!g.d) return <p className="muted">Đang tải…</p>;
  const nodes: any[] = g.d.nodes; const edges: any[] = g.d.edges;
  const W = 640, H = 380; const items = nodes.filter((n) => n.type === "ITEM"); const srcs = nodes.filter((n) => n.type === "SOURCE");
  const pos = new Map<string, { x: number; y: number }>();
  items.forEach((n, i) => pos.set(n.id, { x: 40 + (i % 6) * ((W - 80) / 5), y: 50 + Math.floor(i / 6) * 70 }));
  srcs.forEach((n, i) => pos.set(n.id, { x: 40 + (i % 6) * ((W - 80) / 5), y: H - 50 - Math.floor(i / 6) * 60 }));
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="graph-view">
      <div><h1 className="l-row" style={{ gap: 8 }}><Network size={22} /> Đồ thị kiến thức</h1><p className="muted" style={{ margin: "4px 0 0" }}>{g.d.note}</p><p className="small"><LumiLink href="/lumi/knowledge"><u>← Về Kiến thức</u></LumiLink></p></div>
      {nodes.length === 0 ? <Empty>Chưa có mục kiến thức nào.</Empty> : (
        <div style={{ overflowX: "auto" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, maxHeight: 460, background: "var(--l-surface, transparent)" }} role="img" aria-label="Đồ thị kiến thức" data-testid="graph-svg">
            {edges.map((e, i) => { const a = pos.get(e.from), b = pos.get(e.to); return a && b ? <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.rel === "SUPERSEDES" ? "#e0a030" : "#8884"} strokeWidth={1.5} strokeDasharray={e.rel === "SUPERSEDES" ? "5 3" : undefined} /> : null; })}
            {nodes.map((n) => { const p = pos.get(n.id); if (!p) return null; return <g key={n.id} data-testid={`gn-${n.code}`}><circle cx={p.x} cy={p.y} r={n.type === "SOURCE" ? 7 : 11} fill={n.type === "SOURCE" ? "#6a9" : n.status === "ACTIVE" ? "#7a6cf0" : "#999"} /><text x={p.x} y={p.y + (n.type === "SOURCE" ? 20 : 25)} textAnchor="middle" fontSize="9" fill="currentColor">{n.code}</text><title>{n.label}</title></g>; })}
          </svg>
        </div>
      )}
      <p className="small muted">Tím = mục hiệu lực · xám = chờ duyệt/đã thay · xanh nhỏ = nguồn · nét đứt vàng = «thay thế».</p>
      <section className="l-card" data-testid="conflicts"><h3 style={{ margin: "0 0 4px" }}>Mâu thuẫn có thể có</h3><p className="small muted" style={{ marginTop: 0 }}>{c.d?.note}</p>
        {!c.d ? null : (c.d.conflicts as any[]).length === 0 ? <p className="small">Không phát hiện.</p> : (c.d.conflicts as any[]).map((x, i) => <div key={i} className="small" data-testid="conflict-row">«{x.title}» ({x.kind}): {(x.items as any[]).map((it) => `${it.code} (${it.scope})`).join(" ≠ ")}</div>)}</section>
      <section className="l-card" data-testid="linkcheck"><h3 style={{ margin: "0 0 4px" }}>Kiểm liên kết nguồn</h3><p className="small muted" style={{ marginTop: 0 }}>Chỉ gọi tới địa chỉ công khai http/https (chặn địa chỉ nội bộ), không theo chuyển hướng, tối đa 20 nguồn mỗi lần. Kết quả được lưu.</p>
        {canWrite && <button className="l-btn sm primary" disabled={busy} onClick={async () => { setBusy(true); const r = await lumiApi<any>("/api/v1/lumi/knowledge-links", { method: "POST", body: {} }); setBusy(false); toast(r.ok ? `Đã kiểm ${r.data.checked} nguồn.` : `Không thực hiện được: ${errText(r.error)}`); void l.load(); }} data-testid="link-check-go">Kiểm liên kết ngay</button>}
        {!l.d || (l.d.checks as any[]).length === 0 ? <p className="small muted">Chưa kiểm lần nào.</p> : (l.d.checks as any[]).map((x) => <div key={x.source_id} className="small" data-testid={`lc-${x.code}`} data-ok={x.ok ? "1" : "0"}>{x.ok ? "✔" : "✖"} {x.code} · {x.title} · {x.status ?? x.reason} · {fmtFull(x.checked_at)}</div>)}</section>
    </div>
  );
}

// ───────────────────────── MTG-04 họp theo lượt
const TM_OUT: Record<string, string> = { CONCLUDED: "ĐÃ CÓ KẾT LUẬN (chờ Chủ, chưa có hiệu lực)", NOT_CONCLUDED: "CHƯA KẾT LUẬN" };
export function TurnMeetingsView() {
  const { state, toast } = useLumi(); const isOwner = state.real?.role === "OWNER";
  const { d, err, load } = useGet<any>("/api/v1/lumi/turn-meetings", 8000);
  const projects = state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }));
  const bots = (state.real?.assistants ?? []).filter((a) => a.connection_state === "VERIFIED" && a.dispatch_enabled);
  const [f, setF] = useState({ title: "", question: "", project: "", speakers: [] as string[], turns: "6", cost: "1", hours: "24" });
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="turn-meetings-view">
      <div><h1>Họp theo lượt</h1><p className="muted" style={{ margin: "4px 0 0" }}>{d.note}</p><p className="small"><LumiLink href="/lumi/meetings"><u>← Họp bất đồng bộ</u></LumiLink></p></div>
      <div className="l-banner" role="note"><strong>Chỉ dùng khi họp bất đồng bộ không đủ.</strong><span>Mỗi lượt là một lần chạy bot có phí. Cần trần chi phí đo thật và hạn giờ trước khi mở. Chưa chạy thật với hai bot: kiểm bằng bot giả có nhãn; số đo chi phí họp thật chưa có.</span></div>
      {isOwner && (
        <form className="l-card l-grid" style={{ gap: 8 }} data-testid="tm-form" onSubmit={async (e) => { e.preventDefault(); const r = await lumiApi<any>("/api/v1/lumi/turn-meetings", { method: "POST", body: { title: f.title, question: f.question, project_id: f.project, speaker_ids: f.speakers, max_turns: Number(f.turns), max_cost: Number(f.cost), closes_at: new Date(Date.now() + Number(f.hours) * 3600_000).toISOString() } }); toast(r.ok ? `Đã mở họp ${r.data.meeting.code}.` : `Không thực hiện được: ${errText(r.error)}`); if (r.ok) { setF({ ...f, title: "", question: "", speakers: [] }); void load(); } }}>
          <label className="l-label">Tiêu đề<input className="l-input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required data-testid="tm-title" /></label>
          <label className="l-label">Câu hỏi cần trả lời<input className="l-input" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} required data-testid="tm-question" /></label>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="l-label">Dự án<select className="l-input" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} required data-testid="tm-project"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="l-label" style={{ width: 100 }}>Số lượt tối đa<input className="l-input" inputMode="numeric" value={f.turns} onChange={(e) => setF({ ...f, turns: e.target.value })} data-testid="tm-turns" /></label>
            <label className="l-label" style={{ width: 130 }}>Trần chi phí (USD)<input className="l-input" inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} data-testid="tm-cost" /></label>
            <label className="l-label" style={{ width: 110 }}>Hạn (giờ)<input className="l-input" inputMode="numeric" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} data-testid="tm-hours" /></label>
          </div>
          <fieldset className="small"><legend>Người phát biểu, theo thứ tự bấm chọn (2–6)</legend>{bots.map((b) => <label key={b.id} style={{ marginRight: 10 }}><input type="checkbox" checked={f.speakers.includes(b.id)} onChange={(e) => setF({ ...f, speakers: e.target.checked ? [...f.speakers, b.id] : f.speakers.filter((x) => x !== b.id) })} data-testid={`tm-sp-${b.slug}`} /> {b.slug}{f.speakers.includes(b.id) ? ` (${f.speakers.indexOf(b.id) + 1})` : ""}</label>)}</fieldset>
          <div><button className="l-btn primary" data-testid="tm-submit">Mở họp theo lượt</button></div>
        </form>
      )}
      {(d.meetings as any[]).length === 0 ? <Empty>Chưa có cuộc họp theo lượt nào.</Empty> : (d.meetings as any[]).map((m) => (
        <section key={m.id} className="l-card" data-testid={`tm-${m.code}`} data-state={m.state}>
          <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{m.code} · {m.title}</strong><span className="l-badge">{m.state === "OPEN" ? "ĐANG HỌP" : TM_OUT[m.outcome]}</span></div>
          <div className="small muted">{m.project_name} · tối đa {m.max_turns} lượt · trần {m.max_cost === null ? "—" : `${m.max_cost} USD`} · đã chi (đo thật) {Number(m.cost_measured).toFixed(4)}{m.unknown_runs > 0 ? ` + ${m.unknown_runs} lượt chưa biết` : ""} · hạn {fmtFull(m.closes_at)}</div>
          {m.stop_note && <div className="small" data-testid={`tm-stop-${m.code}`}>Dừng vì: {m.stop_note}</div>}
          <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>{(m.entries as any[]).map((e) => <li key={e.turn_no}>#{e.turn_no} {e.assistant_name}: {e.state === "DONE" ? `${e.stance}${e.agrees ? " (đồng ý)" : ""}${e.new_position ? "" : " (không có gì mới)"}` : e.state === "PENDING" ? "đang chờ bot" : "bỏ qua"}</li>)}</ul>
          {isOwner && m.state === "OPEN" && <button className="l-btn sm danger" onClick={() => { const reason = window.prompt("Lý do đóng họp:") ?? ""; if (reason.trim().length >= 3) void lumiApi(`/api/v1/lumi/turn-meetings/${m.code}/close`, { method: "POST", body: { reason } }).then((r) => { toast(r.ok ? "Đã đóng họp." : errText(r.error)); void load(); }); }} data-testid={`tm-close-${m.code}`}>Đóng họp</button>}
        </section>
      ))}
    </div>
  );
}

// ───────────────────────── Nội dung: pipeline ba cổng (AGT-06/08/10/11)
const AST: Record<string, string> = { DRAFT: "Nháp", QA_PENDING: "Chờ QA", QA_FAILED: "QA không đạt", QA_PASSED: "QA đạt (chờ Chủ duyệt)", OWNER_APPROVED: "Chủ đã duyệt (chờ đăng)", PUBLISHED: "ĐÃ ĐĂNG (đích giả)", REJECTED: "Đã bác" };
export function ContentView() {
  const { state, toast } = useLumi();
  const role = state.real?.role; const isOwner = role === "OWNER"; const canWrite = isOwner || role === "ADMIN";
  const { d, err, load } = useGet<any>("/api/v1/lumi/articles", 10000);
  const projects = state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }));
  const [f, setF] = useState({ project: "", title: "", body: "", ai: "Bài có sự hỗ trợ của AI và đã được người kiểm tra.", aff: false, affText: "" });
  const [cl, setCl] = useState<Record<string, { text: string; level: string; src: string; op: boolean }>>({});
  const act = async (path: string, body: any, ok: string) => { const r = await lumiApi<any>(path, { method: "POST", body }); toast(r.ok ? ok : `Không thực hiện được: ${errText(r.error)}${r.error?.details?.problems ? " — " + (r.error.details.problems as any[]).map((p) => p.text).join("; ") : ""}`); void load(); return r; };
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="content-view">
      <div><h1>Nội dung (ba cổng)</h1><p className="muted" style={{ margin: "4px 0 0" }}>Cổng 1: QA do người KHÁC tác giả; cổng 2: Chủ duyệt đúng phiên bản; cổng 3: xuất bản kiểm lại danh sách kiểm. Mệnh đề nêu như sự thật cần mức bằng chứng ≥ {d.min_fact_level} và có nguồn; E0/E1 phải ghi là ý kiến. Bài có AI hỗ trợ hoặc liên kết affiliate bắt buộc có câu khai báo.</p></div>
      <div className="l-banner" role="note" data-testid="content-label"><strong>ADAPTER GIẢ.</strong><span>{d.label} Đăng ở đây không đưa bài lên website thật.</span></div>
      {canWrite && (
        <form className="l-card l-grid" style={{ gap: 8 }} data-testid="article-form" onSubmit={async (e) => { e.preventDefault(); const r = await act("/api/v1/lumi/articles", { project_id: f.project, title: f.title, body: f.body, ai_assisted: true, ai_disclosure: f.ai, has_affiliate_links: f.aff, affiliate_disclosure: f.aff ? f.affText : undefined }, "Đã tạo bài nháp."); if (r.ok) setF({ ...f, title: "", body: "" }); }}>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}><label className="l-label">Dự án<select className="l-input" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} required data-testid="af-project"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="l-label" style={{ flex: 1, minWidth: 200 }}>Tiêu đề<input className="l-input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required data-testid="af-title" /></label></div>
          <label className="l-label">Nội dung<textarea className="l-input" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required data-testid="af-body" /></label>
          <label className="l-label">Câu khai báo AI<input className="l-input" value={f.ai} onChange={(e) => setF({ ...f, ai: e.target.value })} data-testid="af-ai" /></label>
          <label className="small"><input type="checkbox" checked={f.aff} onChange={(e) => setF({ ...f, aff: e.target.checked })} data-testid="af-aff" /> Có liên kết affiliate</label>
          {f.aff && <label className="l-label">Câu công khai affiliate<input className="l-input" value={f.affText} onChange={(e) => setF({ ...f, affText: e.target.value })} data-testid="af-afftext" /></label>}
          <div><button className="l-btn primary" data-testid="af-submit">Tạo bài nháp</button></div>
        </form>
      )}
      {(d.articles as any[]).length === 0 ? <Empty>Chưa có bài nào.</Empty> : (d.articles as any[]).map((a) => {
        const c = cl[a.id] ?? { text: "", level: "E3", src: "", op: false };
        return (
          <section key={a.id} className="l-card" data-testid={`art-${a.code}`} data-state={a.state}>
            <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{a.code} · {a.title} (v{a.current_version})</strong><span className="l-badge">{AST[a.state]}</span></div>
            <div className="small muted">{a.project_name}{a.qa_by ? ` · QA: ${a.qa_by}` : ""}{a.approved_by ? ` · duyệt: ${a.approved_by} (v${a.approved_version})` : ""}{a.publish_ref ? ` · ${a.publish_ref} (đích giả)` : ""}</div>
            <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }} data-testid={`claims-${a.code}`}>{(a.claims as any[]).map((x, i) => <li key={i}>{x.text} — <strong>{x.evidence_level}</strong> {x.is_opinion ? "(ý kiến)" : x.source_ref ? `(nguồn: ${x.source_ref})` : ""}</li>)}</ul>
            {(a.problems as any[]).length > 0 && ["DRAFT", "QA_PENDING", "QA_FAILED"].includes(a.state) && <div className="l-note" data-testid={`problems-${a.code}`}>Chưa đạt danh sách kiểm: {(a.problems as any[]).map((p) => p.text).join(" · ")}</div>}
            {a.qa_notes && <div className="small muted">Ghi chú: {a.qa_notes}</div>}
            {canWrite && ["DRAFT", "QA_FAILED", "QA_PENDING"].includes(a.state) && (
              <div className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                <input className="l-input" style={{ flex: 1, minWidth: 180 }} placeholder="Mệnh đề (một ý nêu như sự thật hoặc ý kiến)" value={c.text} onChange={(e) => setCl({ ...cl, [a.id]: { ...c, text: e.target.value } })} data-testid={`cl-text-${a.code}`} />
                <select className="l-input" style={{ width: 90 }} value={c.level} onChange={(e) => setCl({ ...cl, [a.id]: { ...c, level: e.target.value } })} data-testid={`cl-level-${a.code}`}>{["E0", "E1", "E2", "E3", "E4"].map((x) => <option key={x}>{x}</option>)}</select>
                <input className="l-input" style={{ width: 150 }} placeholder="Nguồn" value={c.src} onChange={(e) => setCl({ ...cl, [a.id]: { ...c, src: e.target.value } })} data-testid={`cl-src-${a.code}`} />
                <label className="small"><input type="checkbox" checked={c.op} onChange={(e) => setCl({ ...cl, [a.id]: { ...c, op: e.target.checked } })} data-testid={`cl-op-${a.code}`} /> ý kiến</label>
                <button className="l-btn sm" onClick={() => void act(`/api/v1/lumi/articles/${a.id}/claims`, { claims: [...(a.claims as any[]), { text: c.text, evidence_level: c.level, source_ref: c.src || undefined, is_opinion: c.op }].map((x: any) => ({ text: x.text, evidence_level: x.evidence_level, source_ref: x.source_ref || undefined, is_opinion: x.is_opinion })) }, "Đã lưu mệnh đề.").then((r) => { if (r.ok) setCl({ ...cl, [a.id]: { ...c, text: "", src: "" } }); })} data-testid={`cl-add-${a.code}`}>Thêm mệnh đề</button>
              </div>
            )}
            <div className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {canWrite && ["DRAFT", "QA_FAILED"].includes(a.state) && <button className="l-btn sm" onClick={() => void act(`/api/v1/lumi/articles/${a.id}/qa-submit`, {}, "Đã gửi QA.")} data-testid={`art-qa-submit-${a.code}`}>Gửi QA</button>}
              {canWrite && a.state === "QA_PENDING" && <><button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/articles/${a.id}/qa`, { decision: "PASS" }, "QA đạt.")} data-testid={`art-qa-pass-${a.code}`}>QA: đạt</button><button className="l-btn sm" onClick={() => { const notes = window.prompt("Lý do không đạt:") ?? ""; if (notes.trim().length >= 3) void act(`/api/v1/lumi/articles/${a.id}/qa`, { decision: "FAIL", notes }, "Đã ghi QA không đạt."); }} data-testid={`art-qa-fail-${a.code}`}>QA: không đạt</button></>}
              {isOwner && a.state === "QA_PASSED" && <button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/articles/${a.id}/approve`, { version: a.current_version }, "Đã duyệt phiên bản này.")} data-testid={`art-approve-${a.code}`}>Duyệt v{a.current_version}</button>}
              {isOwner && a.state === "OWNER_APPROVED" && <button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/articles/${a.id}/publish`, {}, "Đã đăng lên đích GIẢ.")} data-testid={`art-publish-${a.code}`}>Đăng (đích giả)</button>}
              {isOwner && !["PUBLISHED", "REJECTED"].includes(a.state) && <button className="l-btn sm danger" onClick={() => { const reason = window.prompt("Lý do bác bài:") ?? ""; if (reason.trim().length >= 3) void act(`/api/v1/lumi/articles/${a.id}/reject`, { reason }, "Đã bác bài."); }} data-testid={`art-reject-${a.code}`}>Bác</button>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
