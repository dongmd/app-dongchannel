"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** Đợt 7 screens: Ma trận tự chủ (APR-07), Tích hợp (trạng thái sẵn sàng), Báo cáo kinh tế (ECO-05, dùng trong màn Tài chính). */
import { useCallback, useEffect, useState } from "react";
import { Plug, ShieldCheck } from "lucide-react";

import { errText, lumiApi } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull } from "./ui";

function useGet<T = any>(path: string, every = 15000) {
  const [d, setD] = useState<T | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await lumiApi<T>(path); if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error)); }, [path]);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, every); return () => clearInterval(t); }, [load, every]);
  return { d, err, load };
}

const MODE: Record<string, string> = { AUTO: "Tự động (không cần xin)", GRANT: "Cần giấy ủy quyền / duyệt", OFF: "Tắt (không bao giờ)" };

export function AutonomyView() {
  const { state, toast } = useLumi();
  const isOwner = state.real?.role === "OWNER";
  const { d, err, load } = useGet<any>("/api/v1/lumi/autonomy");
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="autonomy-view">
      <div><h1 className="l-row" style={{ gap: 8 }}><ShieldCheck size={22} /> Ma trận tự chủ</h1><p className="muted" style={{ margin: "4px 0 0" }}>{d.note}</p></div>
      <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th align="left">Hành động</th><th align="left">Mặc định</th><th align="left">Đang áp dụng</th><th align="left">Đặt bởi</th><th /></tr></thead>
        <tbody>{(d.matrix as any[]).map((m) => (
          <tr key={m.action_type} data-testid={`am-${m.action_type}`} data-mode={m.mode}>
            <td>{m.label}{m.risky ? <span className="l-badge amber" style={{ marginLeft: 6 }}>chi tiền/xuất bản/phá hủy</span> : null}</td>
            <td className="small">{MODE[m.default_mode]}</td>
            <td data-testid={`am-mode-${m.action_type}`}><strong>{MODE[m.mode]}</strong>{m.is_default ? " (mặc định)" : ""}</td>
            <td className="small">{m.set_by ? `${m.set_by} · ${fmtFull(m.set_at)}` : "—"}</td>
            <td>{isOwner && (
              <select className="l-input" style={{ width: 200 }} value="" aria-label={`Đổi quy tắc ${m.label}`} data-testid={`am-select-${m.action_type}`}
                onChange={async (e) => { if (!e.target.value) return; const r = await lumiApi("/api/v1/lumi/autonomy", { method: "POST", body: { action_type: m.action_type, mode: e.target.value } }); toast(r.ok ? "Đã đổi quy tắc." : `Không thực hiện được: ${errText(r.error)}`); void load(); }}>
                <option value="">Đổi thành…</option>
                {m.risky ? null : <option value="AUTO">Tự động</option>}<option value="GRANT">Cần ủy quyền / duyệt</option><option value="OFF">Tắt</option>
              </select>)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

const ST: Record<string, { t: string; cls: string }> = { READY: { t: "Sẵn sàng", cls: "purple" }, PARTIAL: { t: "Thiếu một phần", cls: "amber" }, MISSING: { t: "Chưa cấu hình", cls: "red" }, NOT_BUILT: { t: "Chưa có mã tích hợp", cls: "" } };
export function IntegrationsView() {
  const { state } = useLumi();
  const { d, err } = useGet<any>("/api/v1/lumi/integrations", 30000);
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="integrations-view">
      <div><h1 className="l-row" style={{ gap: 8 }}><Plug size={22} /> Tích hợp bên ngoài</h1><p className="muted" style={{ margin: "4px 0 0" }}>{d.note} Sẵn sàng {d.ready}/{d.total}.</p></div>
      {(d.items as any[]).map((i) => (
        <section key={i.key} className="l-card" data-testid={`int-${i.key}`} data-status={i.status}>
          <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{i.name}</strong><span className={`l-badge ${ST[i.status]!.cls}`}>{ST[i.status]!.t}</span></div>
          <div className="small">Mã PRD liên quan: {i.codes}</div>
          <div className="small">Bằng chứng: {i.evidence}</div>
          {i.missing?.length > 0 && <div className="small">Thiếu biến cấu hình: {(i.missing as string[]).join(", ")}</div>}
          <div className="small"><strong>Cần từ Chủ:</strong> {i.needs}</div>
          {i.note && <div className="small muted">{i.note}</div>}
        </section>
      ))}
    </div>
  );
}

const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function EconomyReport({ projects }: { projects: { id: string; name: string }[] }) {
  const [f, setF] = useState({ project: "", from: "", to: "" });
  const [d, setD] = useState<any | null>(null); const [msg, setMsg] = useState<string | null>(null);
  async function run(e?: React.FormEvent) {
    e?.preventDefault(); setMsg(null);
    const r = await lumiApi<any>("/api/v1/lumi/economy-report", { method: "POST", body: { project_id: f.project || undefined, from: f.from || undefined, to: f.to || undefined } });
    if (r.ok) setD(r.data); else { setD(null); setMsg(errText(r.error)); }
  }
  useEffect(() => { void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function download() {
    if (!d) return;
    const head = ["Sổ", "Dự án", "Trạng thái", "Số tiền", "Tiền tệ", "Từ ngày", "Đến ngày", "Nguồn", "Người nhập", "Thời điểm nhập"];
    const lines = [head.join(","), ...(d.rows as any[]).map((r) => [r.ledger, r.project, r.state, r.amount, r.currency, r.period_start, r.period_end, r.source, r.recorded_by, r.recorded_at].map(csvCell).join(","))];
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "bao-cao-kinh-te.csv"; a.click(); URL.revokeObjectURL(url);
  }
  const s = d?.summary;
  const fmt = (n: number) => Number(n).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="fin-report">
      <form className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={run}>
        <label className="l-label">Dự án<select className="l-input" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} data-testid="rp-project"><option value="">Toàn công ty</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="l-label">Từ ngày<input className="l-input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} data-testid="rp-from" /></label>
        <label className="l-label">Đến ngày<input className="l-input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} data-testid="rp-to" /></label>
        <button className="l-btn primary" data-testid="rp-run">Xem báo cáo</button>
        <button type="button" className="l-btn" onClick={download} disabled={!d || d.rows.length === 0} data-testid="rp-csv">Tải CSV</button>
      </form>
      {msg && <div className="l-note" role="alert">{msg}</div>}
      {d && (
        <>
          <div className="l-banner" role="note" data-testid="rp-note"><strong>Đối soát.</strong><span>{d.reconciliation.note} Có {d.reconciliation.provisional_rows} dòng tạm tính và {d.reconciliation.settled_rows} dòng đã xác nhận/đã trả. {s.note}</span></div>
          <div className="l-grid" style={{ gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            {(["COMMISSION", "SPONSOR", "ADS_COST"] as const).map((k) => (
              <section key={k} className="l-card" data-testid={`rp-${k}`}><h3 style={{ margin: "0 0 4px" }}>{k === "COMMISSION" ? "Hoa hồng" : k === "SPONSOR" ? "Tài trợ" : "Chi phí quảng cáo"}</h3>
                {(s.ledgers[k] as any[]).length === 0 ? <p className="muted small">chưa có dữ liệu</p> : (s.ledgers[k] as any[]).map((c) => <div key={c.currency} className="small"><strong>{c.currency}</strong>: ghi nhận {fmt(c.RECORDED)} · xác nhận {fmt(c.CONFIRMED)} · <strong>đã trả/thu {fmt(c.PAID)}</strong>{k === "SPONSOR" ? ` · pipeline ${fmt(c.PIPELINE)} (chưa là tiền thu)` : ""}{c.REVERSED ? ` · đảo ${fmt(c.REVERSED)}` : ""}</div>)}</section>
            ))}
            <section className="l-card" data-testid="rp-AI"><h3 style={{ margin: "0 0 4px" }}>Chi phí AI (đo thật)</h3><div className="small">USD {s.ai_cost.measured.toFixed(4)} đã đo · {s.ai_cost.unknown_runs} lượt chưa biết (không phải 0)</div></section>
          </div>
          <details><summary className="small">Công thức từng chỉ số</summary>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(d.formulas as any[]).map((x) => <li key={x.name}><strong>{x.name}</strong>: {x.formula}. <span className="muted">{x.note}</span></li>)}</ul></details>
          <p className="small muted">Báo cáo tạo lúc {fmtFull(d.generated_at)}. Không có chỉ số «lợi nhuận»: các sổ không được cộng trừ với nhau.</p>
        </>
      )}
    </div>
  );
}

// ───────────────────────── Cơ hội (MOS-04 chế độ dán trong app, MOS-05 chấm điểm, MOS-02 tuyến)
const DIM_LABEL: Record<string, string> = { audience_usefulness: "Hữu ích cho người đọc", search_opportunity: "Cơ hội tìm kiếm", topical_relevance: "Liên quan chủ đề", evidence_availability: "Có bằng chứng", internal_link_value: "Giá trị liên kết nội bộ", trend_freshness: "Độ mới của xu hướng", business_relevance: "Liên quan kinh doanh", affiliate_potential: "Tiềm năng affiliate", uniqueness: "Độc đáo", maintenance_cost: "Chi phí duy trì (trừ điểm)", risk: "Rủi ro (trừ điểm)" };
const KIND_LABEL: Record<string, string> = { AFFILIATE_PROGRAM: "Chương trình affiliate", PRODUCT: "Sản phẩm", KEYWORD: "Từ khóa", TREND: "Xu hướng", CONTENT_GAP: "Khoảng trống nội dung", YOUTUBE_NICHE: "Ngách YouTube", YOUTUBE_VIDEO: "Video YouTube", COMPETITOR_SIGNAL: "Đối thủ", OWNER_IDEA: "Ý tưởng của Chủ", OTHER: "Khác" };
const ROUTE_LABEL: Record<string, string> = { AFFILIATE_PROJECT: "Dự án affiliate", CONTENT_OPPORTUNITY: "Cơ hội nội dung", YOUTUBE_NICHE: "Ngách YouTube", WATCHLIST: "Theo dõi", NO_ACTION: "Không làm gì" };
const SSTATE: Record<string, string> = { NEW: "Mới", ROUTED: "Đã có tuyến", DUPLICATE: "Trùng", DISCARDED: "Đã bỏ" };

export function OpportunitiesView() {
  const { state, toast } = useLumi();
  const role = state.real?.role; const isOwner = role === "OWNER"; const canWrite = isOwner || role === "ADMIN";
  const { d, err, load } = useGet<any>("/api/v1/lumi/signals", 12000);
  const [f, setF] = useState({ kind: "OWNER_IDEA", title: "", url: "", summary: "" });
  const [sc, setSc] = useState<Record<string, Record<string, string>>>({});
  const [rt, setRt] = useState<Record<string, { type: string; reason: string }>>({});
  const act = async (path: string, body: any, ok: string) => { const r = await lumiApi<any>(path, { method: "POST", body }); toast(r.ok ? ok : `Không thực hiện được: ${errText(r.error)}`); void load(); return r; };
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="opportunities-view">
      <div><h1>Cơ hội</h1><p className="muted" style={{ margin: "4px 0 0" }}>{d.note}</p></div>
      {canWrite && (
        <form className="l-card l-grid" style={{ gap: 8 }} data-testid="sig-form" onSubmit={async (e) => { e.preventDefault(); const r = await lumiApi<any>("/api/v1/lumi/signals", { method: "POST", body: { kind: f.kind, title: f.title, url: f.url || undefined, summary: f.summary || undefined } }); toast(!r.ok ? `Không thực hiện được: ${errText(r.error)}` : r.data.duplicate ? "Trùng tín hiệu đã có: không lưu hai lần." : "Đã ghi tín hiệu."); if (r.ok) { setF({ ...f, title: "", url: "", summary: "" }); void load(); } }}>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="l-label">Loại<select className="l-input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} data-testid="sig-kind">{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="l-label" style={{ flex: 1, minWidth: 220 }}>Tên / từ khóa<input className="l-input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required data-testid="sig-title" /></label>
            <label className="l-label" style={{ flex: 1, minWidth: 220 }}>Liên kết (tùy chọn)<input className="l-input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://" data-testid="sig-url" /></label>
          </div>
          <label className="l-label">Ghi chú<input className="l-input" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} data-testid="sig-summary" /></label>
          <div><button className="l-btn primary" data-testid="sig-submit">Ghi tín hiệu</button></div>
        </form>
      )}
      {(d.signals as any[]).length === 0 ? <Empty>Chưa có tín hiệu nào được dán trong ứng dụng.</Empty> : (d.signals as any[]).map((s) => {
        const vals = sc[s.id] ?? {}; const r = rt[s.id] ?? { type: "WATCHLIST", reason: "" };
        const bd = s.score_breakdown;
        return (
          <section key={s.id} className="l-card" data-testid={`sig-${s.title}`} data-status={s.status}>
            <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{s.title}</strong><span className="l-badge">{KIND_LABEL[s.kind]} · {SSTATE[s.status]} · độ tin cậy: chưa rõ</span></div>
                        {s.summary && <div className="small">{s.summary}</div>}
            {bd ? (
              <details open style={{ marginTop: 6 }} data-testid={`sig-score-${s.title}`}><summary className="small"><strong>Điểm {Number(s.overall_score).toFixed(1)}/100</strong> · phiên bản chấm {s.scoring_version} · biết {bd.knownDimensions}/{bd.totalDimensions} tiêu chí</summary>
                <table className="l-table small" style={{ width: "100%", borderCollapse: "collapse" }}><tbody>{(bd.contributions as any[]).map((c) => <tr key={c.dimension}><td>{DIM_LABEL[c.dimension]}</td><td align="right">{c.known ? `${c.input}` : "chưa biết"}</td><td align="right">{c.contribution > 0 ? "+" : ""}{c.contribution}</td><td className="muted">{c.reason ?? ""}</td></tr>)}</tbody></table>
                <div className="small muted">Tổng các thành phần = {bd.rawScore} (đã đối chiếu: {bd.reconciles ? "khớp" : "LỆCH"}). Tiêu chí chưa biết đóng góp 0 và không được coi là điểm cao.</div></details>
            ) : <div className="small muted">Chưa chấm điểm.</div>}
            {canWrite && s.status !== "DUPLICATE" && (
              <details style={{ marginTop: 6 }}><summary className="small">Chấm điểm (nhập 0–1; bỏ trống = chưa biết)</summary>
                <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}>{(d.dimensions as string[]).map((k) => <label key={k} className="small" style={{ width: 150 }}>{DIM_LABEL[k]}<input className="l-input" inputMode="decimal" value={vals[k] ?? ""} onChange={(e) => setSc({ ...sc, [s.id]: { ...vals, [k]: e.target.value } })} data-testid={`sc-${k}-${s.title}`} /></label>)}</div>
                <div className="l-row" style={{ gap: 6, marginTop: 4 }}><input className="l-input" style={{ flex: 1 }} placeholder="Lý do trừ điểm rủi ro (bắt buộc nếu có rủi ro)" value={vals.__risk ?? ""} onChange={(e) => setSc({ ...sc, [s.id]: { ...vals, __risk: e.target.value } })} data-testid={`sc-reason-${s.title}`} />
                  <button className="l-btn sm primary" data-testid={`sc-go-${s.title}`} onClick={() => { const values: Record<string, number> = {}; for (const k of d.dimensions as string[]) if (vals[k] !== undefined && vals[k] !== "") values[k] = Number(vals[k]); void act(`/api/v1/lumi/signals/${s.id}/score`, { values, penalty_reasons: vals.__risk ? { risk: vals.__risk, maintenance_cost: vals.__risk } : undefined }, "Đã chấm điểm."); }}>Chấm</button></div></details>
            )}
            <div className="small" style={{ marginTop: 6 }}><strong>Tuyến:</strong> {(s.routes as any[]).length === 0 ? "chưa có" : (s.routes as any[]).map((x) => <span key={x.id} style={{ marginRight: 8 }} data-testid={`route-${x.status}-${x.route_type}`}>{ROUTE_LABEL[x.route_type]} ({x.status === "PROPOSED" ? "đề xuất" : x.status === "ACCEPTED" ? "đã chấp nhận" : "đã từ chối"}){isOwner && x.status === "PROPOSED" ? <> <button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/signal-routes/${x.id}/decide`, { decision: "ACCEPT" }, "Đã chấp nhận hướng (không phải duyệt chi tiền).")} data-testid={`route-accept-${x.route_type}`}>Chấp nhận</button></> : null}</span>)}</div>
            {canWrite && s.status !== "DUPLICATE" && s.status !== "DISCARDED" && (
              <div className="l-row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <select className="l-input" style={{ width: 190 }} value={r.type} onChange={(e) => setRt({ ...rt, [s.id]: { ...r, type: e.target.value } })} data-testid={`rt-type-${s.title}`}>{Object.entries(ROUTE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <input className="l-input" style={{ flex: 1, minWidth: 180 }} placeholder="Lý do chọn tuyến" value={r.reason} onChange={(e) => setRt({ ...rt, [s.id]: { ...r, reason: e.target.value } })} data-testid={`rt-reason-${s.title}`} />
                <button className="l-btn sm" onClick={() => void act(`/api/v1/lumi/signals/${s.id}/routes`, { route_type: r.type, reason: r.reason }, "Đã đề xuất tuyến.")} data-testid={`rt-go-${s.title}`}>Đề xuất tuyến</button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
