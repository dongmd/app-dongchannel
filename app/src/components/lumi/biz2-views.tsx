"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/** Đợt 8 (nhóm 2): màn «Kinh doanh» — chiến dịch affiliate + số liệu theo kỳ nhập tay (AFF-02/03/05/06), video + hiệu suất theo cửa sổ + chiến lược (YTB-02/04), offer (chỉ đọc, thao tác chuyển trạng thái ở màn AFF cũ). */
import { useCallback, useEffect, useState } from "react";
import { Briefcase } from "lucide-react";

import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull, LumiLink } from "./ui";

function useGet<T = any>(path: string, every = 12000) {
  const [d, setD] = useState<T | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await lumiApi<T>(path); if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error)); }, [path]);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, every); return () => clearInterval(t); }, [load, every]);
  return { d, err, load };
}
const fmt = (n: number | null | undefined, dg = 2) => (n === null || n === undefined ? "chưa có" : Number(n).toLocaleString("vi-VN", { maximumFractionDigits: dg }));
const CST: Record<string, string> = { PLANNED: "Dự kiến", ACTIVE: "ĐANG CHẠY", PAUSED: "Tạm dừng", ENDED: "Đã kết thúc" };
const NEXT: Record<string, string[]> = { PLANNED: ["ACTIVE", "ENDED"], ACTIVE: ["PAUSED", "ENDED"], PAUSED: ["ACTIVE", "ENDED"], ENDED: [] };
const VST: Record<string, string> = { IDEA: "Ý tưởng", VALIDATING: "Kiểm chứng", APPROVED: "Đã duyệt", SCRIPTING: "Viết kịch bản", PRODUCING: "Sản xuất", SCHEDULED: "Đã lên lịch", PUBLISHED: "Đã đăng", REVIEWED: "Đã đánh giá" };

export function BusinessView() {
  const { state } = useLumi();
  const [tab, setTab] = useState<"campaigns" | "youtube" | "offers">("campaigns");
  if (state.mode !== "db") return <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
  const role = state.real?.role; const isOwner = role === "OWNER"; const canWrite = isOwner || role === "ADMIN";
  const projects = state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }));
  return (
    <div className="l-grid" style={{ gap: 14 }} data-testid="business-view">
      <div><h1 className="l-row" style={{ gap: 8 }}><Briefcase size={22} /> Kinh doanh</h1><p className="muted" style={{ margin: "4px 0 0" }}>Chiến dịch affiliate, video YouTube và offer. Số liệu do người nhập kèm nguồn (chưa nối tự động mạng affiliate/YouTube/GA4); không cộng khác tiền tệ; không có chỉ số lợi nhuận; chưa có dữ liệu thì ghi «chưa có». Money OS và thao tác chuyển trạng thái offer/video vẫn ở màn cũ (menu «Chức năng cũ»).</p></div>
      <div className="l-tabs" role="tablist" aria-label="Kinh doanh">
        {([["campaigns", "Chiến dịch & số liệu"], ["youtube", "YouTube"], ["offers", "Offer (chỉ đọc)"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`biz-tab-${k}`}>{l}</button>)}
      </div>
      {tab === "campaigns" && <Campaigns isOwner={isOwner} canWrite={canWrite} projects={projects} />}
      {tab === "youtube" && <YouTube isOwner={isOwner} canWrite={canWrite} projects={projects} />}
      {tab === "offers" && <Offers />}
    </div>
  );
}

function Campaigns({ isOwner, canWrite, projects }: { isOwner: boolean; canWrite: boolean; projects: { id: string; name: string }[] }) {
  const { toast } = useLumi();
  const { d, err, load } = useGet<any>("/api/v1/lumi/campaigns"); const offers = useGet<any>("/api/v1/lumi/offers-overview", 60000);
  const [f, setF] = useState({ project: "", name: "", network: "", offer: "", cap: "" });
  const [m, setM] = useState<Record<string, any>>({});
  const act = async (path: string, body: any, ok: string, key?: string) => { const r = await lumiApi<any>(path, { method: "POST", body, key }); toast(r.ok ? ok : `Không thực hiện được: ${errText(r.error)}`); void load(); return r; };
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="biz-campaigns">
      <div className="l-banner" role="note"><strong>Trần chi.</strong><span>Chiến dịch có trần chi: chi lũy kế chạm trần thì <strong>tự dừng</strong> và chỉ chạy lại khi Chủ nâng trần (quyết định mới, có lịch sử). Không có trần mặc định toàn hệ thống. Chạy chiến dịch (chi tiền) là quyết định của Chủ.</span></div>
      {canWrite && (
        <form className="l-card l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="campaign-form" onSubmit={async (e) => { e.preventDefault(); const r = await act("/api/v1/lumi/campaigns", { project_id: f.project, name: f.name, network: f.network || undefined, offer_id: f.offer || undefined, cap_amount: f.cap ? Number(f.cap) : undefined }, "Đã tạo chiến dịch (trạng thái Dự kiến)."); if (r.ok) setF({ ...f, name: "", cap: "" }); }}>
          <label className="l-label">Dự án<select className="l-input" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} required data-testid="cf-project"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="l-label" style={{ flex: 1, minWidth: 180 }}>Tên chiến dịch<input className="l-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required data-testid="cf-name" /></label>
          <label className="l-label">Mạng<input className="l-input" style={{ width: 110 }} value={f.network} onChange={(e) => setF({ ...f, network: e.target.value })} data-testid="cf-network" /></label>
          <label className="l-label">Offer<select className="l-input" value={f.offer} onChange={(e) => setF({ ...f, offer: e.target.value })} data-testid="cf-offer"><option value="">— không —</option>{(offers.d?.offers ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <label className="l-label" style={{ width: 110 }}>Trần chi (USD)<input className="l-input" inputMode="decimal" value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} data-testid="cf-cap" /></label>
          <button className="l-btn primary" data-testid="cf-submit">Tạo chiến dịch</button>
        </form>
      )}
      {(d.campaigns as any[]).length === 0 ? <Empty>Chưa có chiến dịch nào.</Empty> : (d.campaigns as any[]).map((c) => {
        const x = m[c.id] ?? { start: "", end: "", spend: "", clicks: "", conv: "", rev: "", source: "" }; const setX = (k: string, v: string) => setM({ ...m, [c.id]: { ...x, [k]: v } });
        return (
          <section key={c.id} className="l-card" data-testid={`camp-${c.name}`} data-state={c.state}>
            <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{c.code} · {c.name}</strong><span className={`l-badge ${c.state === "ACTIVE" ? "purple" : c.state === "PAUSED" ? "amber" : ""}`}>{CST[c.state]}</span></div>
            <div className="small muted">{c.project_name}{c.offer_name ? ` · offer ${c.offer_name}` : ""}{c.network ? ` · ${c.network}` : ""} · trần chi {c.cap_amount === null ? "không đặt" : `${fmt(c.cap_amount)} ${c.currency}`} · đã chi (số nhập) {fmt(c.spent_in_currency)} {c.currency}</div>
            {c.pause_reason && c.state === "PAUSED" && <div className="l-note" role="alert" data-testid={`camp-pause-${c.name}`}>{c.pause_reason}</div>}
            {!c.has_data ? <div className="small muted" data-testid={`camp-empty-${c.name}`}>Chưa có dữ liệu.</div> : (c.totals as any[]).map((t) => <div key={t.currency} className="small" data-testid={`camp-total-${c.name}-${t.currency}`}><strong>{t.currency}</strong>: chi {fmt(t.spend)} · click {fmt(t.clicks, 0)} · chuyển đổi {fmt(t.conversions, 0)} · doanh thu/hoa hồng {fmt(t.revenue)} · CPC {fmt(t.cpc, 4)} · chi/chuyển đổi {fmt(t.cost_per_conversion)}</div>)}
            <div className="l-row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {(NEXT[c.state] ?? []).filter((to) => to !== "ACTIVE" || isOwner).map((to) => <button key={to} className="l-btn sm" onClick={() => { let reason: string | undefined; if (to !== "ACTIVE") { reason = window.prompt("Lý do:") ?? ""; if (reason.trim().length < 3) return; } void act(`/api/v1/lumi/campaigns/${c.id}/transition`, { to, reason }, `Đã chuyển: ${CST[to]}.`); }} data-testid={`camp-to-${to}-${c.name}`}>→ {CST[to]}</button>)}
              {isOwner && c.state !== "ENDED" && <button className="l-btn sm" onClick={() => { const v = window.prompt("Trần chi mới (USD; bỏ trống = không đặt trần):"); if (v === null) return; const reason = window.prompt("Lý do đổi trần:") ?? ""; if (reason.trim().length >= 3) void act(`/api/v1/lumi/campaigns/${c.id}/cap`, { cap_amount: v === "" ? null : Number(v), reason }, "Đã đổi trần chi."); }} data-testid={`camp-cap-${c.name}`}>Đổi trần chi</button>}
            </div>
            {canWrite && (
              <details style={{ marginTop: 6 }}><summary className="small">Ghi số liệu theo kỳ (nguồn bắt buộc)</summary>
                <form className="l-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "flex-end" }} data-testid={`metric-form-${c.name}`} onSubmit={async (e) => { e.preventDefault(); const num = (v: string) => (v === "" ? undefined : Number(v)); const r = await act(`/api/v1/lumi/campaigns/${c.id}/metrics`, { period_start: x.start, period_end: x.end, spend: num(x.spend), clicks: num(x.clicks), conversions: num(x.conv), revenue: num(x.rev), source: x.source }, "Đã ghi số liệu.", newKey()); if (r.ok) setM({ ...m, [c.id]: { ...x, spend: "", clicks: "", conv: "", rev: "" } }); }}>
                  <label className="small">Từ<input className="l-input" type="date" value={x.start} onChange={(e) => setX("start", e.target.value)} required data-testid={`mt-start-${c.name}`} /></label>
                  <label className="small">Đến<input className="l-input" type="date" value={x.end} onChange={(e) => setX("end", e.target.value)} required data-testid={`mt-end-${c.name}`} /></label>
                  {([["spend", "Chi"], ["clicks", "Click"], ["conv", "Chuyển đổi"], ["rev", "Doanh thu"]] as const).map(([k, l]) => <label key={k} className="small" style={{ width: 90 }}>{l}<input className="l-input" inputMode="decimal" value={x[k]} onChange={(e) => setX(k, e.target.value)} data-testid={`mt-${k}-${c.name}`} /></label>)}
                  <label className="small" style={{ flex: 1, minWidth: 180 }}>Nguồn số liệu<input className="l-input" value={x.source} onChange={(e) => setX("source", e.target.value)} required placeholder="vd: Bảng điều khiển Ads, báo cáo mạng tuần 45" data-testid={`mt-source-${c.name}`} /></label>
                  <button className="l-btn sm primary" data-testid={`mt-go-${c.name}`}>Ghi</button>
                </form>
              </details>
            )}
            {(c.rows as any[]).length > 0 && <details style={{ marginTop: 4 }}><summary className="small">Các kỳ đã ghi ({(c.rows as any[]).length})</summary><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(c.rows as any[]).map((r, i) => <li key={i}>{r.ps} → {r.pe}: chi {fmt(r.spend)}, click {fmt(r.clicks, 0)}, chuyển đổi {fmt(r.conversions, 0)}, doanh thu {fmt(r.revenue)} {r.currency} — nguồn: {r.source} ({r.recorded_by}, {fmtFull(r.recorded_at)})</li>)}</ul></details>}
          </section>
        );
      })}
    </div>
  );
}

function YouTube({ isOwner, canWrite, projects }: { isOwner: boolean; canWrite: boolean; projects: { id: string; name: string }[] }) {
  const { toast } = useLumi();
  const v = useGet<any>("/api/v1/lumi/videos"); const s = useGet<any>("/api/v1/lumi/yt-strategy", 30000);
  const [p, setP] = useState<Record<string, any>>({});
  const [sf, setSf] = useState({ project: "", goal: "", uniq: "", breaks: "" });
  if (v.err) return <div className="l-note" role="alert">{v.err}</div>;
  if (!v.d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="biz-youtube">
      <p className="small muted" style={{ margin: 0 }}>{v.d.note} Tạo video và chuyển bước (tám bước) ở màn YouTube cũ: <LumiLink href="/youtube/videos"><u>mở YouTube (cũ)</u></LumiLink>.</p>
      <section className="l-card" data-testid="yt-strategy"><h3 style={{ margin: "0 0 4px" }}>Chiến lược kênh (có phiên bản)</h3>
        {!s.d || (s.d.strategies as any[]).length === 0 ? <p className="small muted">Chưa đặt chiến lược.</p> : (s.d.strategies as any[]).filter((x) => x.current).map((x) => <div key={x.id} className="small" data-testid={`ys-${x.project_name}`}><strong>{x.project_name}</strong> · bản {x.version} · mục tiêu: {x.channel_goal} · quy tắc độc đáo: {x.uniqueness_rules} · các «bản phá»: {x.pattern_breaks}</div>)}
        {isOwner && (
          <form className="l-grid" style={{ gap: 6, marginTop: 6 }} data-testid="strategy-form" onSubmit={async (e) => { e.preventDefault(); const r = await lumiApi("/api/v1/lumi/yt-strategy", { method: "POST", body: { project_id: sf.project, channel_goal: sf.goal, uniqueness_rules: sf.uniq, pattern_breaks: sf.breaks } }); toast(r.ok ? "Đã lưu bản chiến lược mới." : `Không thực hiện được: ${errText(r.error)}`); if (r.ok) { setSf({ ...sf, goal: "", uniq: "", breaks: "" }); void s.load(); } }}>
            <select className="l-input" value={sf.project} onChange={(e) => setSf({ ...sf, project: e.target.value })} required data-testid="sf-project"><option value="">Dự án…</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <input className="l-input" placeholder="Mục tiêu kênh" value={sf.goal} onChange={(e) => setSf({ ...sf, goal: e.target.value })} required data-testid="sf-goal" />
            <input className="l-input" placeholder="Quy tắc độc đáo" value={sf.uniq} onChange={(e) => setSf({ ...sf, uniq: e.target.value })} required data-testid="sf-uniq" />
            <input className="l-input" placeholder="Các bản phá (điều không được lặp lại)" value={sf.breaks} onChange={(e) => setSf({ ...sf, breaks: e.target.value })} required data-testid="sf-breaks" />
            <div><button className="l-btn sm primary" data-testid="sf-submit">Lưu phiên bản mới</button></div>
          </form>
        )}
      </section>
      {(v.d.videos as any[]).length === 0 ? <Empty>Chưa có video nào.</Empty> : (v.d.videos as any[]).map((x) => {
        const f = p[x.id] ?? { win: "7", at: "", views: "", ctr: "", src: "" }; const setF = (k: string, val: string) => setP({ ...p, [x.id]: { ...f, [k]: val } });
        return (
          <section key={x.id} className="l-card" data-testid={`vid-${x.working_title}`}>
            <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{x.title ?? x.working_title}</strong><span className="l-badge">{VST[x.status] ?? x.status}</span></div>
            <div className="small muted">{x.offer_name ? `offer ${x.offer_name} · ` : ""}{x.publish_url ?? "chưa có liên kết đăng"}</div>
            {(x.perf as any[]).length === 0 ? <div className="small muted">Chưa có số liệu hiệu suất.</div> : (x.perf as any[]).map((q) => <div key={q.window_days} className="small" data-testid={`perf-${x.working_title}-${q.window_days}`}>Cửa sổ {q.window_days} ngày (chụp {fmtFull(q.captured_at)}): xem {fmt(q.views, 0)} · hiển thị {fmt(q.impressions, 0)} · CTR {q.ctr === null ? "chưa có" : `${(q.ctr * 100).toFixed(2)}%`} · giữ chân 30s {q.retention_30s === null ? "chưa có" : `${(q.retention_30s * 100).toFixed(0)}%`} · nguồn: {q.source}</div>)}
            {canWrite && (
              <details style={{ marginTop: 4 }}><summary className="small">Ghi hiệu suất (nguồn bắt buộc)</summary>
                <form className="l-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={async (e) => { e.preventDefault(); const num = (z: string) => (z === "" ? undefined : Number(z)); const r = await lumiApi<any>(`/api/v1/lumi/videos/${x.id}/perf`, { method: "POST", key: newKey(), body: { window_days: Number(f.win), captured_at: new Date(f.at || Date.now()).toISOString(), views: num(f.views), ctr: num(f.ctr), source: f.src } }); toast(r.ok ? "Đã ghi hiệu suất." : `Không thực hiện được: ${errText(r.error)}`); if (r.ok) void v.load(); }}>
                  <label className="small">Cửa sổ<select className="l-input" value={f.win} onChange={(e) => setF("win", e.target.value)} data-testid={`pf-win-${x.working_title}`}>{[1, 7, 28, 90].map((n) => <option key={n} value={n}>{n} ngày</option>)}</select></label>
                  <label className="small">Lượt xem<input className="l-input" style={{ width: 100 }} inputMode="numeric" value={f.views} onChange={(e) => setF("views", e.target.value)} data-testid={`pf-views-${x.working_title}`} /></label>
                  <label className="small">CTR (0–1)<input className="l-input" style={{ width: 90 }} inputMode="decimal" value={f.ctr} onChange={(e) => setF("ctr", e.target.value)} data-testid={`pf-ctr-${x.working_title}`} /></label>
                  <label className="small" style={{ flex: 1, minWidth: 160 }}>Nguồn<input className="l-input" value={f.src} onChange={(e) => setF("src", e.target.value)} required data-testid={`pf-src-${x.working_title}`} /></label>
                  <button className="l-btn sm primary" data-testid={`pf-go-${x.working_title}`}>Ghi</button>
                </form>
              </details>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Offers() {
  const { d, err } = useGet<any>("/api/v1/lumi/offers-overview", 30000);
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 8 }} data-testid="biz-offers">
      <p className="small muted" style={{ margin: 0 }}>Danh sách offer của hệ cũ (chỉ đọc). Đổi trạng thái (có kiểm tra đồ thị và lý do STOP) ở <LumiLink href="/aff/offers"><u>màn AFF cũ</u></LumiLink>. Dữ liệu dễ đổi (hoa hồng, cookie, chính sách) cần nguồn và ngày xác minh.</p>
      {(d.offers as any[]).length === 0 ? <Empty>Chưa có offer nào.</Empty> : (
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th align="left">Offer</th><th align="left">Mạng</th><th align="left">Trạng thái</th><th align="left">Độ tin cậy</th><th align="left">Xác minh lần cuối</th></tr></thead>
          <tbody>{(d.offers as any[]).map((o) => <tr key={o.id}><td>{o.name}</td><td>{o.network ?? "—"}</td><td>{o.status}</td><td>{o.confidence}</td><td className="small">{o.last_verified_at ? fmtFull(o.last_verified_at) : "chưa xác minh"}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
