"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, FolderKanban, MessageCircle, Plus, Send, Video } from "lucide-react";

import {
  affiliateResults,
  approvalsHref,
  hermesLabel,
  openTasks,
  pendingCounts,
  pendingItems,
  projectStage,
  projectSummary,
  taskLatest,
  telegramRecent,
  VIDEO_LABEL,
  youtubeSummary,
  type CurrencyResult,
  type DashFilter,
  type PendingItem,
} from "@/lib/lumi/selectors";
import { VIDEO_STATUSES, type Video as VideoRecord, type VideoStatus } from "@/lib/lumi/types";
import { Avatar } from "./avatar";
import { ProjectModal, ResultsModal } from "./dashboard-forms";
import { useLumi } from "./lumi-provider";
import { Empty, fmtTime, LumiLink, StatusBadge, NewOutputBadge } from "./ui";

const KIND_LABEL = { output: "Đầu ra công việc", memory: "Đề xuất ghi nhớ", action: "Hành động bên ngoài" } as const;
const KIND_TONE = { output: "amber", memory: "purple", action: "red" } as const;

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("vi-VN", { style: "currency", currency, maximumFractionDigits: currency === "VND" ? 0 : 2 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}
/** Giá trị cho ô datetime-local theo giờ địa phương của trình duyệt. */
const localInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fmtDay = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
const fmtStamp = (iso: string) => new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });

export function DashboardView() {
  const { state, openNewTask } = useLumi();
  const [pid, setPid] = useState("");
  const [mid, setMid] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);

  // Khôi phục bộ lọc từ URL để tải lại trang vẫn giữ nguyên phạm vi.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setPid(sp.get("p") ?? "");
    setMid(sp.get("m") ?? "");
  }, []);
  const sync = (p: string, m: string) => {
    const sp = new URLSearchParams();
    if (p) sp.set("p", p);
    if (m) sp.set("m", m);
    const q = sp.toString();
    window.history.replaceState(null, "", q ? `?${q}` : window.location.pathname);
  };

  const projects = state.projects.filter((p) => p.status === "active");
  const bots = state.members.filter((m) => m.kind === "bot" && m.status === "active");
  // Bộ lọc không còn khớp (dự án hoặc trợ lý đã bị lưu trữ) thì coi như "tất cả".
  const f: DashFilter = {
    ...(projects.some((p) => p.id === pid) ? { projectId: pid } : {}),
    ...(state.members.some((m) => m.id === mid && m.status === "active") ? { memberId: mid } : {}),
  };
  const filtered = Boolean(f.projectId || f.memberId);
  const all = pendingCounts(state);
  const scoped = pendingCounts(state, f.projectId, f.memberId);
  const connected = bots.filter((b) => b.hermes === "connected").length;
  const waiting = state.tasks.filter((t) => t.waitingConnection && t.status !== "done").length;
  const hour = new Date().getHours();
  const greet = hour < 11 ? "Chào buổi sáng" : hour < 18 ? "Chào buổi chiều" : "Chào buổi tối";

  return (
    <div className="l-grid" style={{ gap: 18 }} data-testid="dashboard">
      <header className="l-row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>{greet}, {state.mode === "db" ? (state.real?.email.split("@")[0] ?? "bạn") : "Dong"}</h1>
          <p className="muted small" style={{ margin: "4px 0 0" }} data-testid="dash-meta">
            Hôm nay · {new Date().toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "numeric" })} · Chờ duyệt toàn bộ: <strong style={{ color: "var(--l-text)" }}>{all.total} mục</strong>
            {` (${all.output} đầu ra + ${all.memory} ghi nhớ + ${all.action} hành động)`}
          </p>
          <p className="muted small" style={{ margin: "2px 0 0" }}>
            {state.mode === "db" ? `Trợ lý: ${connected}/${bots.length} đã bật giao việc${waiting > 0 ? ` · ${waiting} việc chờ trợ lý` : ""} · dữ liệu thật trong PostgreSQL` : `Trợ lý: ${connected}/${bots.length} đã kết nối Hermes (mô phỏng)${waiting > 0 ? ` · ${waiting} việc chờ kết nối trợ lý` : ""} · dữ liệu preview là mô phỏng`}
          </p>
        </div>
        <button className="l-btn primary l-dash-new" onClick={() => openNewTask(f.projectId ? { projectId: f.projectId } : {})}><Plus size={16} /> Việc mới</button>
      </header>

      <div className="l-row" role="group" aria-label="Bộ lọc dashboard" data-testid="dash-filters">
        <label className="l-row small muted" style={{ gap: 6 }}>
          Dự án
          <select className="l-select" style={{ width: "auto", minHeight: 34, padding: "3px 8px" }} value={f.projectId ?? ""} onChange={(e) => { setPid(e.target.value); sync(e.target.value, mid); }} aria-label="Lọc theo dự án">
            <option value="">Tất cả dự án</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="l-row small muted" style={{ gap: 6 }}>
          Trợ lý
          <select className="l-select" style={{ width: "auto", minHeight: 34, padding: "3px 8px" }} value={f.memberId ?? ""} onChange={(e) => { setMid(e.target.value); sync(pid, e.target.value); }} aria-label="Lọc theo trợ lý">
            <option value="">Tất cả trợ lý</option>
            {bots.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        {filtered && (
          <>
            <span className="l-badge amber" data-testid="dash-scope">Đang lọc: {scoped.total} / {all.total} mục chờ duyệt</span>
            <button className="l-btn ghost sm" onClick={() => { setPid(""); setMid(""); sync("", ""); }}>Bỏ lọc</button>
          </>
        )}
      </div>

      <div className="l-dash-top">
        <NeedsMe f={f} />
        <RunningProjects f={f} onAddProject={() => setProjectOpen(true)} />
      </div>
      {!state.mode && (
        <div className="l-dash-results">
          <AffiliateCard f={f} />
          <YoutubeCard f={f} />
        </div>
      )}
      <TelegramRecent f={f} />
      <ProjectModal open={projectOpen} onClose={() => setProjectOpen(false)} />
    </div>
  );
}

// ───────────── A. Cần tôi xử lý ─────────────
/** DSH-02: how many priority items each group shows before "Xem tất cả". A display preference of this browser, not a business policy. */
const PRIORITY_KEY = "lumi.dash.priorityN";
const PRIORITY_CHOICES = [3, 5, 10];
function usePriorityN(): [number, (n: number) => void] {
  const [n, setN] = useState(3);
  useEffect(() => { try { const v = Number(localStorage.getItem(PRIORITY_KEY)); if (PRIORITY_CHOICES.includes(v)) setN(v); } catch { /* private mode: keep the default */ } }, []);
  return [n, (v) => { setN(v); try { localStorage.setItem(PRIORITY_KEY, String(v)); } catch { /* ignore */ } }];
}

/** DSH-08: every block says where its numbers come from, for which period, when they were refreshed, and warns when they may be stale. */
function SourceNote({ kind }: { kind: "live" | "results" }) {
  const { state, sync } = useLumi();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(t); }, []);
  const age = Math.round((Date.now() - sync.lastOkAt) / 1000);
  const stale = sync.failing || age > 20;
  const db = state.mode === "db";
  const src = db ? (kind === "live" ? "đếm trực tiếp từ PostgreSQL (đo)" : "chưa nối dữ liệu quảng cáo/kênh thật — không có số nào ở đây là đo thật") : kind === "live" ? "dữ liệu mô phỏng (preview)" : "nhập tay, mô phỏng";
  const period = kind === "live" ? "tại lúc cập nhật" : db ? "—" : "theo bộ lọc khoảng ngày";
  return (
    <p className="small muted" style={{ margin: "8px 0 0" }} data-testid="source-note">
      Nguồn: {src} · Kỳ: {period} · Cập nhật {new Date(sync.lastOkAt).toLocaleTimeString("vi-VN")}
      {stale && <span className="l-badge amber" style={{ marginLeft: 6 }} data-testid="stale-warning">Số liệu có thể đã cũ: {sync.failing ? "mất kết nối tới máy chủ" : `${age} giây chưa làm mới`}</span>}
    </p>
  );
}

function NeedsMe({ f }: { f: DashFilter }) {
  const { state } = useLumi();
  const items = pendingItems(state, f);
  const c = pendingCounts(state, f.projectId, f.memberId);
  const [priN, setPriN] = usePriorityN();
  const groups = (["output", "memory", "action"] as const).map((k) => ({ k, rows: items.filter((i) => i.kind === k).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) }));
  return (
    <section className="l-card l-dash-a" aria-labelledby="da-h" data-testid="block-needs-me">
      <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <h2 id="da-h" className="l-row" style={{ gap: 8 }}><AlertCircle size={18} /> Cần tôi xử lý</h2>
        <LumiLink href={approvalsHref(c.output ? "output" : c.memory ? "memory" : "action", f.projectId)} className="l-chiplink amber" title={`${c.total} mục = ${c.output} đầu ra + ${c.memory} ghi nhớ + ${c.action} hành động`} data-testid="needs-total">
          {c.total} mục
        </LumiLink>
      </div>
      {!f.projectId && !f.memberId && (state.real?.plansPending?.length ?? 0) > 0 && (
        <div className="l-note" style={{ marginBottom: 8 }} data-testid="dash-plans-pending">
          <strong>{state.real!.plansPending!.length} kế hoạch chờ bạn duyệt:</strong>{" "}
          {state.real!.plansPending!.map((p) => <LumiLink key={p.planId} href={`/lumi/plans/${p.planId}`} className="l-chiplink amber">{p.code} v{p.version}</LumiLink>)}
        </div>
      )}
      <label className="small l-row" style={{ gap: 6, margin: "0 0 6px" }}>Hiện tối đa
        <select className="l-select" style={{ width: "auto", padding: "2px 6px" }} value={priN} onChange={(e) => setPriN(Number(e.target.value))} data-testid="dash-priority-n" aria-label="Số mục ưu tiên mỗi nhóm">{PRIORITY_CHOICES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        mục mỗi nhóm (mới nhất trước)</label>
      {c.total === 0 ? (
        <div className="l-row" style={{ color: "var(--l-green)", padding: "8px 0" }}><CheckCircle2 size={18} /> Không có gì chờ bạn quyết{f.projectId || f.memberId ? " trong phạm vi đang lọc" : ""}.</div>
      ) : (
        groups.map(({ k, rows }) => (
          <div key={k} style={{ marginTop: 10 }} data-testid={`needs-${k}`}>
            <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
              <span className="l-row" style={{ gap: 6 }}>
                <span className={`l-badge ${KIND_TONE[k]}`}>{KIND_LABEL[k]}</span>
                <span className="small muted">{rows.length} mục</span>
              </span>
              {rows.length > 0 && <LumiLink href={approvalsHref(k, f.projectId)} className="small muted">Mở danh sách <ArrowRight size={11} style={{ display: "inline" }} /></LumiLink>}
            </div>
            {rows.length === 0 ? (
              <div className="small muted" style={{ padding: "2px 0 4px" }}>Không có.</div>
            ) : (
              <>
                {rows.slice(0, priN).map((it) => <PendingRow key={it.key} it={it} />)}
                {rows.length > priN && <LumiLink href={approvalsHref(k, f.projectId)} className="l-btn sm" data-testid={`see-all-${k}`}>Xem tất cả ({rows.length}) <ArrowRight size={11} style={{ display: "inline" }} /></LumiLink>}
              </>
            )}
            {k === "action" && rows.length > 0 && <div className="small muted" style={{ marginTop: 2 }}>Duyệt nội dung quảng cáo và cho phép chạy quảng cáo là hai quyết định độc lập.</div>}
          </div>
        ))
      )}
      <SourceNote kind="live" />
    </section>
  );
}

function PendingRow({ it }: { it: PendingItem }) {
  return (
    <div className="l-pend" data-testid="pending-row" data-kind={it.kind}>
      <div style={{ minWidth: 0 }}>
        <div className="small muted">{it.kind === "output" && <NewOutputBadge />} {it.projectName} · {it.assistant} · {fmtTime(it.at)}</div>
        <div className="l-clamp2" style={{ fontWeight: 650 }} title={it.title}>{it.title}</div>
        <div className="small">{it.waiting}</div>
      </div>
      <LumiLink href={it.href} className="l-btn sm primary wrap l-pend-btn" data-testid="pending-cta">{it.cta}</LumiLink>
    </div>
  );
}

// ───────────── B. Dự án đang chạy ─────────────
function RunningProjects({ f, onAddProject }: { f: DashFilter; onAddProject: () => void }) {
  const { state } = useLumi();
  const [showAll, setShowAll] = useState(false);
  const [moreProjects, setMoreProjects] = useState(false);
  const allList = state.projects.filter((p) => p.status === "active" && (!f.projectId || p.id === f.projectId) && (!f.memberId || state.members.find((m) => m.id === f.memberId)?.projectIds.includes(p.id)));
  // Nhiều dự án: chỉ hiện 4 dự án cần chú ý nhất (có mục chờ tôi trước), còn lại gập lại.
  const ranked = [...allList].sort((a, b) => pendingCounts(state, b.id).total - pendingCounts(state, a.id).total);
  const list = moreProjects ? ranked : ranked.slice(0, 4);
  const open = openTasks(state, f);
  const shown = showAll ? open : open.slice(0, 6);
  return (
    <section className="l-card l-dash-b" aria-labelledby="db-h" data-testid="block-projects">
      <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 id="db-h" className="l-row" style={{ gap: 8 }}><FolderKanban size={18} /> Dự án đang chạy</h2>
        <button className="l-btn sm" onClick={onAddProject}><Plus size={14} /> Thêm dự án</button>
      </div>
      {allList.length === 0 ? (
        <Empty>{state.projects.length === 0 ? "Chưa có dự án nào. Thêm dự án đầu tiên để Dashboard bắt đầu theo dõi." : "Không có dự án nào khớp bộ lọc."}</Empty>
      ) : (
        <div className="l-grid" style={{ gap: 10 }}>
          {list.map((p) => {
            const sum = projectSummary(state, p.id);
            const stage = projectStage(state, p.id);
            const c = pendingCounts(state, p.id);
            const lead = sum.next ? state.members.find((m) => m.id === sum.next!.ownerId) : undefined;
            return (
              <article key={p.id} className="l-proj" data-project={p.id}>
                <div className="l-row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                  <LumiLink href={`/lumi/projects/${p.id}`} style={{ minWidth: 0 }}><strong className="l-clamp2" style={{ fontSize: "1.02rem" }}>{p.name}</strong></LumiLink>
                  <span className="l-badge blue">{p.area}</span>
                </div>
                <div className="small" data-testid="stage-now"><span className="muted">Đang ở:</span> <strong>{stage.now}</strong></div>
                <div className="small" data-testid="stage-next"><span className="muted">Tiếp theo:</span> {stage.next ?? "Chưa có việc kế tiếp"}</div>
                <div className="small"><span className="muted">Quyết định gần nhất:</span> {sum.decision ? <LumiLink href={`/lumi/memory?id=${sum.decision.id}`} className="l-chiplink">{sum.decision.text}</LumiLink> : "chưa có"}</div>
                <div className="l-row small" style={{ gap: 6 }}>
                  <span className="muted">Phụ trách:</span>
                  {lead ? <><Avatar avatar={lead.avatar} size={20} /> {lead.name}</> : <span>PM {sum.pm?.name ?? "chưa có"}</span>}
                  <span className="muted">· PM {sum.pm?.name ?? "chưa có"}</span>
                </div>
                <div className="l-row" style={{ gap: 4 }}>
                  {c.total > 0 ? (
                    <>
                      <LumiLink href={approvalsHref(c.output ? "output" : c.memory ? "memory" : "action", p.id)} className="l-chiplink amber" title={`${c.output} đầu ra + ${c.memory} ghi nhớ + ${c.action} hành động`}>{c.total} chờ tôi</LumiLink>
                      {c.output > 0 && <LumiLink href={approvalsHref("output", p.id)} className="l-chiplink">{c.output} đầu ra</LumiLink>}
                      {c.memory > 0 && <LumiLink href={approvalsHref("memory", p.id)} className="l-chiplink">{c.memory} ghi nhớ</LumiLink>}
                      {c.action > 0 && <LumiLink href={approvalsHref("action", p.id)} className="l-chiplink">{c.action} hành động</LumiLink>}
                    </>
                  ) : <span className="small muted">Không có gì chờ tôi</span>}
                </div>
              </article>
            );
          })}
          {ranked.length > 4 && <button className="l-btn ghost sm" onClick={() => setMoreProjects((v) => !v)}>{moreProjects ? "Thu gọn danh sách dự án" : `Hiện thêm ${ranked.length - 4} dự án`}</button>}
        </div>
      )}

      <div className="l-row" style={{ justifyContent: "space-between", margin: "14px 0 6px" }}>
        <h3>Việc mở ({open.length})</h3>
        <span className="small muted">{f.projectId || f.memberId ? "theo bộ lọc" : "tất cả dự án"}</span>
      </div>
      {open.length === 0 ? (
        <Empty>Không có việc mở{f.projectId || f.memberId ? " trong phạm vi đang lọc" : ""}.</Empty>
      ) : (
        <div className="l-grid" style={{ gap: 6 }} data-testid="open-tasks">
          {shown.map((t) => (
            <LumiLink key={t.id} href={`/lumi/projects/${t.projectId}?task=${t.id}`} className="l-opentask" data-task={t.id}>
              <span className="l-badge">{t.id}</span>
              <span className="l-clamp2" style={{ minWidth: 0, flex: 1 }} title={t.title}>{t.title}</span>
              <StatusBadge status={t.status} />
              <span className="small muted l-opentask-meta">{state.projects.find((p) => p.id === t.projectId)?.name} · {t.ownerName} · {taskLatest(state, t)}</span>
            </LumiLink>
          ))}
          {open.length > 6 && <button className="l-btn ghost sm" onClick={() => setShowAll((v) => !v)}>{showAll ? "Thu gọn" : `Hiện thêm ${open.length - 6} việc`}</button>}
        </div>
      )}
      <SourceNote kind="live" />
    </section>
  );
}

// ───────────── C. Kết quả theo mảng ─────────────
function AffiliateCard({ f }: { f: DashFilter }) {
  const { state, dispatch } = useLumi();
  const [days, setDays] = useState(7);
  const [formOpen, setFormOpen] = useState(false);
  const now = useMemo(() => Date.now(), [state.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = affiliateResults(state, f, days, now);
  const pendingCampaign = state.actions.some((a) => a.status === "pending" && state.projects.find((p) => p.id === a.projectId)?.area === "Affiliate");
  return (
    <section className="l-card" aria-labelledby="dc-aff" data-testid="block-affiliate">
      <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <h2 id="dc-aff">Affiliate · kết quả quảng cáo</h2>
        <span className="l-badge amber" title="Số liệu trong preview do bạn nhập tay">Mô phỏng</span>
      </div>
      <div className="l-row" style={{ marginBottom: 8 }}>
        <label className="l-row small muted" style={{ gap: 6 }}>
          Kỳ
          <select className="l-select" style={{ width: "auto", minHeight: 32, padding: "3px 8px" }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Kỳ báo cáo">
            <option value={7}>7 ngày gần nhất</option>
            <option value={30}>30 ngày gần nhất</option>
          </select>
        </label>
        <button className="l-btn sm" onClick={() => setFormOpen(true)}>Nhập số liệu mô phỏng</button>
      </div>
      {r.state === "na" && <Empty>Dự án đang lọc không thuộc mảng Affiliate.</Empty>}
      {r.state === "none" && (
        <div data-testid="aff-none">
          <div className="l-metrics">
            <Metric label="Chi phí quảng cáo" value="Chưa có dữ liệu" muted />
            <Metric label="Hoa hồng ghi nhận" value="Chưa có dữ liệu" muted />
            <Metric label="Hoa hồng trừ chi phí quảng cáo" value="Chưa có dữ liệu" muted />
          </div>
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            Chưa có số liệu nào trong {days} ngày gần nhất{pendingCampaign ? ", và yêu cầu bật chiến dịch đang chờ bạn quyết nên chưa có chi phí thật" : ""}. «Chưa có dữ liệu» khác với 0.
          </p>
        </div>
      )}
      {r.state === "data" && (
        <div data-testid="aff-data">
          {r.byCurrency.map((c) => <CurrencyBlock key={c.currency} c={c} />)}
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            Hoa hồng trừ chi phí quảng cáo chưa tính các chi phí khác. Hoa hồng ghi nhận chưa phải hoa hồng đã xác nhận. Khác đơn vị tiền thì không cộng gộp.
          </p>
        </div>
      )}
      {r.state === "data" && (
        <details className="small" style={{ marginTop: 6 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>Các kỳ đã nhập ({state.adResults.length})</summary>
          {state.adResults.map((x) => (
            <div key={x.id} className="l-row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{state.projects.find((p) => p.id === x.projectId)?.name} · {fmtDay(x.periodStart)}–{fmtDay(x.periodEnd)} · {x.currency}</span>
              <button className="l-btn ghost sm" onClick={() => dispatch({ type: "results.remove", id: x.id })}>Xóa</button>
            </div>
          ))}
        </details>
      )}
      <ResultsModal open={formOpen} onClose={() => setFormOpen(false)} {...(f.projectId ? { defaultProjectId: f.projectId } : {})} />
      <SourceNote kind="results" />
    </section>
  );
}

function Metric({ label, value, muted, tone }: { label: string; value: string; muted?: boolean; tone?: "good" | "bad" }) {
  return (
    <div className="l-metric">
      <div className="small muted">{label}</div>
      <div className="l-metric-v" style={{ color: muted ? "var(--l-muted)" : tone === "good" ? "var(--l-green)" : tone === "bad" ? "var(--l-red)" : undefined, fontSize: muted ? "0.95rem" : undefined }}>{value}</div>
    </div>
  );
}

function CurrencyBlock({ c }: { c: CurrencyResult }) {
  return (
    <div style={{ marginBottom: 8 }} data-currency={c.currency}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Kỳ {fmtDay(c.periodStart)}–{fmtDay(c.periodEnd)} · {c.currency} · cập nhật {fmtStamp(c.updatedAt)} · mô phỏng
      </div>
      <div className="l-metrics">
        <Metric label="Chi phí quảng cáo" value={c.spend === null ? "Chưa có dữ liệu" : money(c.spend, c.currency)} muted={c.spend === null} />
        <Metric label="Hoa hồng ghi nhận" value={c.commission === null ? "Chưa có dữ liệu" : money(c.commission, c.currency)} muted={c.commission === null} />
        <Metric label="Hoa hồng trừ chi phí quảng cáo" value={c.net === null ? "Chưa đủ dữ liệu" : money(c.net, c.currency)} muted={c.net === null} tone={c.net === null ? undefined : c.net >= 0 ? "good" : "bad"} />
      </div>
    </div>
  );
}

function YoutubeCard({ f }: { f: DashFilter }) {
  const { state } = useLumi();
  const now = useMemo(() => Date.now(), [state.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const y = youtubeSummary(state, f, now);
  return (
    <section className="l-card" aria-labelledby="dc-yt" data-testid="block-youtube">
      <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <h2 id="dc-yt" className="l-row" style={{ gap: 8 }}><Video size={18} /> YouTube · sản xuất video</h2>
        <span className="l-badge amber" title="Danh sách video trong preview là dữ liệu mô phỏng">Mô phỏng</span>
      </div>
      {y.state === "na" && <Empty>Dự án đang lọc không thuộc mảng YouTube.</Empty>}
      {y.state === "ok" && (
        <>
          <div className="l-metrics">
            <Metric label="Video đang sản xuất" value={`${y.producing} video`} />
            <Metric label="Video chờ bạn duyệt" value={`${y.awaiting} video`} />
            <Metric label="Lịch đăng gần nhất" value={y.nextSchedule ? `${fmtStamp(y.nextSchedule.scheduledAt!)} · ${y.nextSchedule.title}` : "Chưa có lịch đăng"} muted={!y.nextSchedule} />
          </div>
          {y.videos.length === 0 ? (
            <p className="small muted" style={{ margin: "8px 0 0" }}>Chưa có video cụ thể nào. Gắn việc vào một video trong chi tiết việc để bắt đầu đếm.</p>
          ) : (
            <div className="l-grid" style={{ gap: 6, marginTop: 8 }} data-testid="video-list">
              {y.videos.map(({ video: v, tasks, awaiting }) => (
                <div key={v.id} className="l-videorow" data-video={v.id}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="l-clamp2" style={{ fontWeight: 650 }}>{v.title}</div>
                    <div className="small muted">{state.projects.find((p) => p.id === v.projectId)?.name} · {tasks} việc của video này{awaiting ? " · có đầu ra chờ duyệt" : ""}</div>
                  </div>
                  <VideoStatusEditor video={v} />
                </div>
              ))}
            </div>
          )}
          {y.unlinkedTasks > 0 && (
            <p className="small muted" style={{ margin: "8px 0 0" }} data-testid="yt-unlinked">
              {y.unlinkedTasks} việc mở chưa gắn video cụ thể nên không được đếm là video. Mở việc đó để gắn vào một video.
            </p>
          )}
          <p className="small muted" style={{ margin: "6px 0 0" }}>Đếm theo video: nhiều việc của cùng một video chỉ tính là một video.</p>
        </>
      )}
      <SourceNote kind="results" />
    </section>
  );
}

/** Đổi trạng thái video (mô phỏng). Chọn «Đã lên lịch» thì hiện ô ngày giờ đăng rồi mới lưu. */
function VideoStatusEditor({ video }: { video: VideoRecord }) {
  const { dispatch } = useLumi();
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState("");
  return (
    <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}>
      <select className="l-select" style={{ width: "auto", minHeight: 32, padding: "2px 6px" }} value={picking ? "scheduled" : video.status} aria-label={`Trạng thái video ${video.title}`}
        onChange={(e) => {
          const st = e.target.value as VideoStatus;
          if (st === "scheduled") {
            setPicking(true);
            setWhen(localInput(video.scheduledAt ? Date.parse(video.scheduledAt) : Date.now() + 3 * 86_400_000));
          } else {
            setPicking(false);
            void dispatch({ type: "video.update", id: video.id, status: st });
          }
        }}>
        {VIDEO_STATUSES.map((st) => <option key={st} value={st}>{VIDEO_LABEL[st]}</option>)}
      </select>
      {picking && (
        <>
          <input type="datetime-local" className="l-input" style={{ width: "auto", minHeight: 32, padding: "2px 6px" }} value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Ngày giờ đăng (mô phỏng)" />
          <button className="l-btn sm" disabled={!when} onClick={async () => { const r = await dispatch({ type: "video.update", id: video.id, status: "scheduled", scheduledAt: new Date(when).toISOString() }); if (r.ok) setPicking(false); }}>Lưu lịch</button>
          <button className="l-btn ghost sm" onClick={() => setPicking(false)}>Hủy</button>
        </>
      )}
    </div>
  );
}

// ───────────── D. Việc vừa giao qua Telegram ─────────────
function TelegramRecent({ f }: { f: DashFilter }) {
  const { state } = useLumi();
  const rows = telegramRecent(state, f, 6);
  return (
    <section className="l-card" aria-labelledby="dd-h" data-testid="block-telegram">
      <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 id="dd-h" className="l-row" style={{ gap: 8 }}><MessageCircle size={18} /> Việc vừa giao qua Telegram</h2>
        <span className="l-row" style={{ gap: 6 }}>
          <span className="l-badge amber" title={state.mode === "db" ? "Bot Telegram thử, nối với Hermes thật" : "Cuộc chat là trình mô phỏng, không phải Telegram thật"}>{state.mode === "db" ? "Telegram" : "Telegram mô phỏng"}</span>
          <LumiLink href="/lumi/telegram" className="l-btn sm"><Send size={14} /> {state.mode === "db" ? "Telegram & kết nối" : "Mở Telegram mô phỏng"}</LumiLink>
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty>Chưa có việc nào giao qua Telegram{f.projectId || f.memberId ? " trong phạm vi đang lọc" : ""}. {state.mode === "db" ? "Gửi «Giao việc: …» cho bot rồi xác nhận bản nháp ở trang Telegram & kết nối." : "Mở Telegram mô phỏng và gõ «Giao việc: …»."}</Empty>
      ) : (
        <div className="l-grid" style={{ gap: 6 }} data-testid="tg-recent">
          {rows.map(({ task: t, bot, at, projectName, latest }) => {
            const botMember = state.members.find((m) => m.profileKey === t.source.chat);
            return (
              <LumiLink key={t.id} href={`/lumi/projects/${t.projectId}?task=${t.id}`} className="l-tgrow" data-task={t.id}>
                <span className="small muted l-tgrow-time">{fmtTime(at)}</span>
                <span className="l-badge">{t.id}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="l-clamp2" style={{ fontWeight: 600, display: "-webkit-box" }} title={t.title}>{t.title}</span>
                  <span className="small muted">{bot}{botMember ? ` (${hermesLabel(botMember)})` : ""} · {projectName}</span>
                </span>
                <span className="l-badge amber" data-testid="tg-latest">{latest}</span>
              </LumiLink>
            );
          })}
        </div>
      )}
      <p className="small muted" style={{ margin: "8px 0 0" }}>Cùng bản ghi với Telegram và Kanban: duyệt hay yêu cầu sửa ở bất kỳ đâu đều cập nhật dòng này.</p>
      <SourceNote kind="live" />
    </section>
  );
}

