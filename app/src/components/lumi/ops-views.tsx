"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/**
 * Đợt 6 screens: Routine (RTN, EXE-02), Ý tưởng (CNV-03), Mẫu việc (SKL), Cài đặt (ADM-06), Tìm kiếm (SRC-01), Soát kiến thức (KNW-08).
 * Anything unbuilt or unmeasured says so on the screen; nothing here grants a permission or a budget.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Lightbulb, LayoutTemplate, Search, Settings, ClipboardCheck } from "lucide-react";

import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull, LumiLink } from "./ui";

function useGet<T = any>(path: string, every = 10000) {
  const [d, setD] = useState<T | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await lumiApi<T>(path); if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error)); }, [path]);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, every); return () => clearInterval(t); }, [load, every]);
  return { d, err, load };
}
function useRole() { const { state } = useLumi(); const role = state.real?.role; return { role, isOwner: role === "OWNER", canWrite: role === "OWNER" || role === "ADMIN", live: state.mode === "db" }; }
function useProjects() { const { state } = useLumi(); return state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name })); }
function useAssistants() {
  const [a, setA] = useState<any[]>([]);
  useEffect(() => { void lumiApi("/api/v1/lumi/assistants").then((r) => { if (r.ok) setA((r.data.assistants as any[]).filter((x) => x.status === "ACTIVE")); }); }, []);
  return a;
}
const Need = () => <Empty>Màn này cần chế độ dữ liệu thật (đăng nhập).</Empty>;
const Head = ({ icon, title, note }: { icon: React.ReactNode; title: string; note: string }) => (
  <div><h1 className="l-row" style={{ gap: 8 }}>{icon} {title}</h1><p className="muted" style={{ margin: "4px 0 0" }}>{note}</p></div>
);
const missingText = (e: any) => errText(e);

// ───────────────────────── Routine
const KIND: Record<string, string> = { NOTIFY: "Thông báo (không gọi AI, không phát sinh chi phí AI)", CREATE_TASK: "Tạo việc (mỗi lần chạy một việc có mã, qua vòng đời việc thường)" };
const RES: Record<string, string> = { DONE: "Xong", FAILED: "Lỗi", STOPPED: "Dừng", CAP: "Chạm giới hạn", SKIPPED: "Bỏ qua (lỡ mốc)" };
const TRG: Record<string, string> = { SCHEDULE: "Theo lịch", CATCHUP: "Chạy bù", MANUAL: "Thủ công" };
const WD = ["", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật"];

export function RoutinesView() {
  const { live, isOwner, canWrite } = useRole();
  return live ? <RoutinesInner isOwner={isOwner} canWrite={canWrite} /> : <Need />;
}
function RoutinesInner({ isOwner, canWrite }: { isOwner: boolean; canWrite: boolean }) {
  const { toast } = useLumi();
  const { d, err, load } = useGet<any>("/api/v1/lumi/routines");
  const projects = useProjects(); const assistants = useAssistants();
  const [adding, setAdding] = useState(false);
  const empty = { name: "", kind: "NOTIFY", sched: "WEEKDAYS", time: "07:30", weekday: "1", tz: "Asia/Ho_Chi_Minh", project: "", assignee: "", title: "", message: "", max: "1", deadline: "60", scan: false };
  const [f, setF] = useState<any>(empty); const set = (k: string, v: string) => setF((p: any) => ({ ...p, [k]: v }));
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const body: any = { name: f.name, kind: f.kind, schedule_kind: f.sched, time_of_day: f.time, timezone: f.tz, weekday: f.sched === "WEEKLY" ? Number(f.weekday) : undefined, max_runs_per_day: Number(f.max) };
    if (f.kind === "NOTIFY") body.message = f.message; else { body.title = f.title; body.project_id = f.project || undefined; body.assignee_id = f.assignee || undefined; body.deadline_minutes = Number(f.deadline); if (f.scan) body.purpose = "OPPORTUNITY_SCAN"; }
    const r = await lumiApi("/api/v1/lumi/routines", { method: "POST", body });
    toast(r.ok ? "Đã tạo routine (đang TẮT; bật là quyết định của Chủ)." : `Không thực hiện được: ${missingText(r.error)}`);
    if (r.ok) { setAdding(false); setF(empty); void load(); }
  }
  const act = async (path: string, body: any, ok: string) => { const r = await lumiApi(path, { method: "POST", body }); toast(r.ok ? ok : `Không thực hiện được: ${missingText(r.error)}`); void load(); };
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="routines-view">
      <Head icon={<CalendarClock size={22} />} title="Routine" note="Lịch lặp tạo việc hoặc gửi thông báo. Mỗi mốc lịch chỉ chạy một lần; lỗi liên tiếp quá ngưỡng thì dừng và báo Chủ một lần; không bao giờ tự duyệt hay tự cấp ngân sách." />
      <div className="l-banner" role="note"><strong>Giới hạn bắt buộc trước khi bật (EXE-02).</strong><span>Routine tạo việc cần: số lần chạy tối đa mỗi ngày, hạn thời gian mỗi lần, dự án và bot đã kết nối thật, bật giao việc, có mức thực thi và công cụ. Thiếu một thứ thì không bật được. Bản này chưa có loại «thực thi tự dispatch riêng»: việc tạo ra đi theo đường giao việc thường và chịu trần chi phí/số lượt như mọi việc khác.</span></div>
      <div className="l-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span data-testid="paused-state" className={`l-badge ${d.paused ? "red" : ""}`}>{d.paused ? "ĐANG TẠM DỪNG TẤT CẢ (loại tạo việc)" : "Đang hoạt động"}</span>
        {isOwner && <button className="l-btn sm" onClick={() => void act("/api/v1/lumi/routines/pause", { paused: !d.paused }, d.paused ? "Đã bỏ tạm dừng." : "Đã tạm dừng mọi routine tạo việc.")} data-testid="pause-all">{d.paused ? "Bỏ tạm dừng tất cả" : "Tạm dừng tất cả"}</button>}
        {canWrite && !adding && <button className="l-btn primary" onClick={() => setAdding(true)} data-testid="rt-add">Tạo routine</button>}
      </div>
      {adding && (
        <form className="l-card l-grid" style={{ gap: 8 }} onSubmit={create} data-testid="rt-form">
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="l-label" style={{ flex: 1, minWidth: 200 }}>Tên<input className="l-input" value={f.name} onChange={(e) => set("name", e.target.value)} required data-testid="rt-name" /></label>
            <label className="l-label">Loại<select className="l-input" value={f.kind} onChange={(e) => set("kind", e.target.value)} data-testid="rt-kind"><option value="NOTIFY">Thông báo</option><option value="CREATE_TASK">Tạo việc</option></select></label>
          </div>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="l-label">Lịch<select className="l-input" value={f.sched} onChange={(e) => set("sched", e.target.value)} data-testid="rt-sched"><option value="DAILY">Hằng ngày</option><option value="WEEKDAYS">Thứ 2–6</option><option value="WEEKLY">Hằng tuần</option></select></label>
            {f.sched === "WEEKLY" && <label className="l-label">Thứ<select className="l-input" value={f.weekday} onChange={(e) => set("weekday", e.target.value)} data-testid="rt-weekday">{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{WD[n]}</option>)}</select></label>}
            <label className="l-label">Giờ<input className="l-input" type="time" value={f.time} onChange={(e) => set("time", e.target.value)} required data-testid="rt-time" /></label>
            <label className="l-label">Múi giờ<select className="l-input" value={f.tz} onChange={(e) => set("tz", e.target.value)} data-testid="rt-tz">{["Asia/Ho_Chi_Minh", "Asia/Bangkok", "Asia/Tokyo", "UTC", "Europe/London", "America/New_York"].map((z) => <option key={z}>{z}</option>)}</select></label>
            <label className="l-label" style={{ width: 130 }}>Tối đa lần/ngày<input className="l-input" inputMode="numeric" value={f.max} onChange={(e) => set("max", e.target.value)} data-testid="rt-max" /></label>
          </div>
          {f.kind === "NOTIFY" ? <label className="l-label">Nội dung thông báo<input className="l-input" value={f.message} onChange={(e) => set("message", e.target.value)} required data-testid="rt-message" /></label> : (
            <div className="l-grid" style={{ gap: 8 }}>
              <label className="l-label">Tiêu đề việc (dùng {"{date}"} cho ngày)<input className="l-input" value={f.title} onChange={(e) => set("title", e.target.value)} required data-testid="rt-title" /></label>
              <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <label className="l-label">Dự án<select className="l-input" value={f.project} onChange={(e) => set("project", e.target.value)} data-testid="rt-project"><option value="">— chọn —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <label className="l-label">Giao cho bot<select className="l-input" value={f.assignee} onChange={(e) => set("assignee", e.target.value)} data-testid="rt-assignee"><option value="">— chọn —</option>{assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <label className="small" style={{ alignSelf: "center" }}><input type="checkbox" checked={f.scan} onChange={(e) => setF((p: any) => ({ ...p, scan: e.target.checked }))} data-testid="rt-scan" /> Lịch tự tìm cơ hội (dùng quỹ chuẩn bị, hết quỹ thì dừng)</label>
                <label className="l-label" style={{ width: 150 }}>Hạn mỗi lần (phút)<input className="l-input" inputMode="numeric" value={f.deadline} onChange={(e) => set("deadline", e.target.value)} data-testid="rt-deadline" /></label>
              </div>
            </div>
          )}
          <div className="l-row" style={{ gap: 8 }}><button className="l-btn primary" data-testid="rt-submit">Tạo (đang tắt)</button><button type="button" className="l-btn" onClick={() => setAdding(false)}>Hủy</button></div>
        </form>
      )}
      {(d.routines as any[]).length === 0 ? <Empty>Chưa có routine nào.</Empty> : (d.routines as any[]).map((r) => (
        <section key={r.id} className="l-card" data-testid={`rt-${r.code}`} data-enabled={r.enabled ? "1" : "0"}>
          <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
            <strong>{r.code} · {r.name}</strong>
            <span className={`l-badge ${r.enabled ? "purple" : r.alerted ? "red" : ""}`}>{r.enabled ? "ĐANG BẬT" : r.alerted ? "ĐÃ DỪNG VÌ LỖI" : "Tắt"}</span>
          </div>
          <div className="small muted" data-testid={`rt-sched-${r.code}`}>{r.schedule_text} · {KIND[r.kind]}{r.project_name ? ` · ${r.project_name}` : ""}{r.assignee_name ? ` · bot ${r.assignee_name}` : ""} · tối đa {r.max_runs_per_day ?? "—"} lần/ngày{r.deadline_minutes ? ` · hạn ${r.deadline_minutes} phút` : ""}</div>
          <div className="small">Lần chạy kế tiếp: {r.enabled && r.next_run_at ? fmtFull(r.next_run_at) : "—"}{r.consecutive_failures > 0 ? ` · lỗi liên tiếp ${r.consecutive_failures}` : ""}</div>
          {r.alerted && <div className="l-note" role="alert" data-testid={`rt-alert-${r.code}`}>Đã báo Chủ: lỗi liên tiếp quá ngưỡng, routine đã dừng. Lỗi gần nhất: {r.last_error}</div>}
          <div className="l-row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {isOwner && <button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/routines/${r.id}/enabled`, { enabled: !r.enabled }, r.enabled ? "Đã tắt." : "Đã bật.")} data-testid={`rt-toggle-${r.code}`}>{r.enabled ? "Tắt" : "Bật"}</button>}
            {canWrite && <button className="l-btn sm" onClick={() => void act(`/api/v1/lumi/routines/${r.id}/run`, {}, "Đã chạy một lần (tính vào giới hạn ngày).")} data-testid={`rt-run-${r.code}`}>Chạy ngay</button>}
            {canWrite && <select className="l-input" style={{ width: 190 }} value={r.timezone} onChange={(e) => void act(`/api/v1/lumi/routines/${r.id}`, { timezone: e.target.value }, "Đã đổi múi giờ; lần chạy kế tiếp được tính lại.")} data-testid={`rt-tzchange-${r.code}`}>{["Asia/Ho_Chi_Minh", "Asia/Bangkok", "Asia/Tokyo", "UTC", "Europe/London", "America/New_York"].map((z) => <option key={z}>{z}</option>)}</select>}
          </div>
          {(r.runs as any[]).length > 0 && (
            <details style={{ marginTop: 6 }} data-testid={`rt-history-${r.code}`}><summary className="small">Lịch sử lần chạy ({(r.runs as any[]).length} gần nhất)</summary>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(r.runs as any[]).map((x) => <li key={x.id}>{fmtFull(x.scheduled_for)} · {TRG[x.trigger]} · {RES[x.result]}{x.task_code ? ` · việc ${x.task_code}` : ""}{x.error ? ` · ${x.error}` : ""}</li>)}</ul>
            </details>
          )}
        </section>
      ))}
      <h3 style={{ margin: "8px 0 0" }}>Routine hệ thống (chỉ đọc)</h3>
      {(d.system as any[]).map((s) => <div key={s.name} className="l-card small" data-testid="rt-system"><strong>{s.name}</strong> · {s.schedule_text} · thông báo, không gọi model · <span className="muted">{s.note}</span></div>)}
    </div>
  );
}

// ───────────────────────── Ý tưởng
const IST: Record<string, string> = { NEW: "Mới", CLASSIFIED: "Đã phân loại (chờ Chủ nhận)", ACCEPTED: "Đã nhận", DISCARDED: "Đã bỏ" };
const ICL: Record<string, string> = { NOTE: "Ghi chú", SOURCE: "Nguồn", TASK: "Nhiệm vụ" };
export function IdeasView() { const { live } = useRole(); return live ? <IdeasInner /> : <Need />; }
function IdeasInner() {
  const { toast } = useLumi(); const { isOwner, canWrite } = useRole();
  const { d, err, load } = useGet<any>("/api/v1/lumi/ideas");
  const projects = useProjects(); const assistants = useAssistants();
  const [f, setF] = useState({ title: "", body: "", link: "" });
  const [cl, setCl] = useState<Record<string, any>>({});
  const act = async (path: string, body: any, ok: string) => { const r = await lumiApi(path, { method: "POST", body }); toast(r.ok ? ok : `Không thực hiện được: ${missingText(r.error)}`); void load(); return r; };
  async function add(e: React.FormEvent) { e.preventDefault(); const r = await act("/api/v1/lumi/ideas", { title: f.title, body: f.body || undefined, link: f.link || undefined }, "Đã nhận ý tưởng."); if (r.ok) setF({ title: "", body: "", link: "" }); }
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="ideas-view">
      <Head icon={<Lightbulb size={22} />} title="Hộp thư ý tưởng" note="Ném ý tưởng vào đây (văn bản hoặc liên kết). Phân loại thành ghi chú, nguồn hoặc nhiệm vụ; Chủ nhận thì mới thành đề xuất kiến thức (chờ duyệt) hoặc việc thật. Không tự sửa kiến thức đã có. Chưa có nhận từ Telegram và tệp đính kèm." />
      {canWrite && (
        <form className="l-card l-grid" style={{ gap: 8 }} onSubmit={add} data-testid="idea-form">
          <label className="l-label">Tiêu đề<input className="l-input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required data-testid="id-title" /></label>
          <label className="l-label">Nội dung<textarea className="l-input" rows={2} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} data-testid="id-body" /></label>
          <label className="l-label">Liên kết (tùy chọn)<input className="l-input" value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://" data-testid="id-link" /></label>
          <div><button className="l-btn primary" data-testid="id-submit">Gửi vào hộp thư</button></div>
        </form>
      )}
      {(d.ideas as any[]).length === 0 ? <Empty>Hộp thư trống.</Empty> : (d.ideas as any[]).map((i) => {
        const c = cl[i.id] ?? { cls: "NOTE", project: "", assignee: "" };
        const setC = (k: string, v: string) => setCl({ ...cl, [i.id]: { ...c, [k]: v } });
        return (
          <section key={i.id} className="l-card" data-testid={`idea-${i.code}`} data-status={i.status}>
            <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{i.code} · {i.title}</strong><span className="l-badge">{IST[i.status]}{i.class ? ` · ${ICL[i.class]}` : ""}</span></div>
            {i.body && <div className="small">{i.body}</div>}{i.link && <div className="small"><a href={i.link} target="_blank" rel="noreferrer noopener">{i.link}</a></div>}
            {i.result_ref && <div className="small" data-testid={`idea-ref-${i.code}`}>Đã tạo: {i.result_ref}</div>}
            {i.decision_note && <div className="small muted">{i.decision_note}</div>}
            {canWrite && (i.status === "NEW" || i.status === "CLASSIFIED") && (
              <div className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
                <select className="l-input" style={{ width: 130 }} value={c.cls} onChange={(e) => setC("cls", e.target.value)} data-testid={`idea-cls-${i.code}`}><option value="NOTE">Ghi chú</option><option value="SOURCE">Nguồn</option><option value="TASK">Nhiệm vụ</option></select>
                <select className="l-input" style={{ width: 170 }} value={c.project} onChange={(e) => setC("project", e.target.value)} data-testid={`idea-project-${i.code}`}><option value="">Dự án…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                {c.cls === "TASK" && <select className="l-input" style={{ width: 150 }} value={c.assignee} onChange={(e) => setC("assignee", e.target.value)} data-testid={`idea-assignee-${i.code}`}><option value="">Bot…</option>{assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
                <button className="l-btn sm" onClick={() => void act(`/api/v1/lumi/ideas/${i.id}/classify`, { class: c.cls, project_id: c.project || undefined, assignee_id: c.assignee || undefined }, "Đã phân loại.")} data-testid={`idea-classify-${i.code}`}>Phân loại</button>
                <button className="l-btn sm danger" onClick={() => { const reason = window.prompt("Lý do bỏ:") ?? ""; if (reason.trim().length >= 3) void act(`/api/v1/lumi/ideas/${i.id}/discard`, { reason }, "Đã bỏ."); }} data-testid={`idea-discard-${i.code}`}>Bỏ</button>
              </div>
            )}
            {isOwner && i.status === "CLASSIFIED" && <div style={{ marginTop: 6 }}><button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/ideas/${i.id}/accept`, {}, "Đã nhận.")} data-testid={`idea-accept-${i.code}`}>Nhận ({ICL[i.class]} → {i.class === "TASK" ? "tạo việc" : "đề xuất kiến thức chờ duyệt"})</button></div>}
          </section>
        );
      })}
    </div>
  );
}

// ───────────────────────── Mẫu việc
const VST: Record<string, string> = { PROPOSED: "Chờ duyệt", APPROVED: "ĐANG DÙNG", REJECTED: "Đã từ chối", SUPERSEDED: "Đã thay", EXPIRED: "Hết hạn (không ai quyết định)" };
export function TemplatesView() { const { live } = useRole(); return live ? <TemplatesInner /> : <Need />; }
function TemplatesInner() {
  const { toast } = useLumi(); const { isOwner, canWrite } = useRole();
  const { d, err, load } = useGet<any>("/api/v1/lumi/templates");
  const projects = useProjects(); const assistants = useAssistants();
  const empty = { name: "", description: "", when: "", steps: "", inputs: "", outputs: "", title: "", assignee: "", allowed: [] as string[] };
  const [adding, setAdding] = useState(false); const [f, setF] = useState<any>(empty); const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const [use, setUse] = useState<Record<string, any>>({});
  const body = (x: any) => ({ description: x.description, when_to_use: x.when, steps: x.steps, inputs: x.inputs, outputs: x.outputs, default_title: x.title, default_assignee_id: x.assignee || undefined, allowed_assistant_ids: x.allowed });
  const act = async (path: string, b: any, ok: string, key?: string) => { const r = await lumiApi<any>(path, { method: "POST", body: b, key }); toast(r.ok ? ok : `Không thực hiện được: ${missingText(r.error)}`); void load(); return r; };
  async function create(e: React.FormEvent) { e.preventDefault(); const r = await act("/api/v1/lumi/templates", { name: f.name, ...body(f) }, "Đã tạo mẫu (bản 1 chờ Chủ duyệt)."); if (r.ok) { setAdding(false); setF(empty); } }
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const fld = (k: string, label: string, ta = false) => <label className="l-label">{label}{ta ? <textarea className="l-input" rows={2} value={f[k]} onChange={(e) => set(k, e.target.value)} data-testid={`tp-${k}`} /> : <input className="l-input" value={f[k]} onChange={(e) => set(k, e.target.value)} data-testid={`tp-${k}`} />}</label>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="templates-view">
      <Head icon={<LayoutTemplate size={22} />} title="Mẫu công việc" note="Mỗi phiên bản bất biến; mẫu chỉ có hiệu lực khi Chủ duyệt; bản đề xuất mới không thay bản đang dùng cho tới khi được duyệt (không ai quyết định thì hết hạn). Việc tạo từ mẫu ghi mẫu và phiên bản đã dùng. Chưa có «skill» cho bot tự nạp: đây là mẫu việc cho người tạo việc." />
      {canWrite && !adding && <div><button className="l-btn primary" onClick={() => setAdding(true)} data-testid="tp-add">Tạo mẫu</button></div>}
      {adding && (
        <form className="l-card l-grid" style={{ gap: 8 }} onSubmit={create} data-testid="tp-form">
          {fld("name", "Tên mẫu")}{fld("description", "Mô tả", true)}{fld("when", "Khi nào dùng")}{fld("steps", "Các bước", true)}{fld("inputs", "Đầu vào")}{fld("outputs", "Đầu ra")}{fld("title", "Tiêu đề việc mặc định")}
          <label className="l-label">Bot mặc định<select className="l-input" value={f.assignee} onChange={(e) => set("assignee", e.target.value)} data-testid="tp-assignee"><option value="">— không —</option>{assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <fieldset className="small"><legend>Bot được phép dùng (bỏ trống = mọi bot)</legend>{assistants.map((a) => <label key={a.id} style={{ marginRight: 10 }}><input type="checkbox" checked={f.allowed.includes(a.id)} onChange={(e) => set("allowed", e.target.checked ? [...f.allowed, a.id] : f.allowed.filter((x: string) => x !== a.id))} data-testid={`tp-allow-${a.slug}`} /> {a.name}</label>)}</fieldset>
          <div className="l-row" style={{ gap: 8 }}><button className="l-btn primary" data-testid="tp-submit">Tạo</button><button type="button" className="l-btn" onClick={() => setAdding(false)}>Hủy</button></div>
        </form>
      )}
      {(d.templates as any[]).length === 0 ? <Empty>Chưa có mẫu nào.</Empty> : (d.templates as any[]).map((t) => {
        const u = use[t.id] ?? { project: "", assignee: "" };
        return (
          <section key={t.id} className="l-card" data-testid={`tpl-${t.code}`}>
            <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{t.code} · {t.name}</strong><span className="small muted">{t.approved_version ? `đang dùng bản ${t.approved_version}` : "chưa có bản được duyệt"} · đã dùng {t.uses} lần</span></div>
            {(t.versions as any[]).map((v) => (
              <div key={v.version} className="small" style={{ marginTop: 6 }} data-testid={`tpl-${t.code}-v${v.version}`} data-state={v.state}>
                <strong>Bản {v.version}</strong> · {VST[v.state]} · {v.description} · dùng khi: {v.when_to_use}
                {(v.warnings as string[]).map((w, i) => <div key={i} className="l-note" data-testid={`tpl-warn-${t.code}-v${v.version}`}>⚠ {w}</div>)}
                {isOwner && v.state === "PROPOSED" && <span style={{ marginLeft: 8 }}><button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/templates/${t.id}/decide`, { version: v.version, decision: "APPROVE" }, "Đã duyệt.")} data-testid={`tpl-approve-${t.code}-v${v.version}`}>Duyệt</button> <button className="l-btn sm danger" onClick={() => { const note = window.prompt("Lý do từ chối:") ?? ""; if (note.trim().length >= 3) void act(`/api/v1/lumi/templates/${t.id}/decide`, { version: v.version, decision: "REJECT", note }, "Đã từ chối."); }}>Từ chối</button></span>}
                {canWrite && v.state !== "PROPOSED" && v.version !== t.approved_version && <button className="l-btn sm" style={{ marginLeft: 8 }} onClick={() => void act(`/api/v1/lumi/templates/${t.id}/restore`, { version: v.version }, "Đã tạo bản mới từ bản cũ (chờ duyệt).")} data-testid={`tpl-restore-${t.code}-v${v.version}`}>Khôi phục thành bản mới</button>}
              </div>
            ))}
            {canWrite && t.approved_version && (
              <div className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                <select className="l-input" style={{ width: 170 }} value={u.project} onChange={(e) => setUse({ ...use, [t.id]: { ...u, project: e.target.value } })} data-testid={`tpl-use-project-${t.code}`}><option value="">Dự án…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                <select className="l-input" style={{ width: 150 }} value={u.assignee} onChange={(e) => setUse({ ...use, [t.id]: { ...u, assignee: e.target.value } })} data-testid={`tpl-use-assignee-${t.code}`}><option value="">Bot mặc định</option>{assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                <button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/templates/${t.id}/use`, { project_id: u.project, assignee_id: u.assignee || undefined }, "Đã tạo việc từ mẫu.", newKey())} data-testid={`tpl-use-${t.code}`}>Tạo việc từ mẫu</button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ───────────────────────── Cài đặt
export function SettingsView() { const { live } = useRole(); return live ? <SettingsInner /> : <Need />; }
function SettingsInner() {
  const { toast } = useLumi(); const { isOwner } = useRole();
  const { d, err, load } = useGet<any>("/api/v1/lumi/settings", 30000);
  const [v, setV] = useState<Record<string, string>>({});
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="settings-view">
      <Head icon={<Settings size={22} />} title="Cài đặt" note={`${d.note} Mỗi lần đổi giữ lịch sử. Chỉ Chủ đổi được.`} />
      <div className="l-banner" role="note"><strong>Chưa đưa hết vào cài đặt.</strong><span>Các ngưỡng đang hiển thị ở đây đã được dùng thật. Một số ngưỡng cũ của màn Tổng quan (ví dụ số mục ưu tiên) vẫn đặt trong mã, chưa cấu hình được.</span></div>
      <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th align="left">Cài đặt</th><th align="right">Giá trị</th><th align="left">Khoảng cho phép</th><th align="left">Đặt bởi</th><th /></tr></thead>
        <tbody>{(d.settings as any[]).map((s) => (
          <tr key={s.key} data-testid={`setting-${s.key}`}>
            <td>{s.label}</td><td align="right" data-testid={`setting-value-${s.key}`}>{s.value} {s.unit}{s.is_default ? " (mặc định)" : ""}</td><td>{s.min}–{s.max}</td><td className="small">{s.set_by ? `${s.set_by} · ${fmtFull(s.set_at)}` : "—"}</td>
            <td>{isOwner && <span className="l-row" style={{ gap: 4 }}><input className="l-input" style={{ width: 80 }} inputMode="numeric" value={v[s.key] ?? ""} onChange={(e) => setV({ ...v, [s.key]: e.target.value })} data-testid={`setting-input-${s.key}`} /><button className="l-btn sm" onClick={async () => { const r = await lumiApi("/api/v1/lumi/settings", { method: "POST", body: { key: s.key, value: Number(v[s.key]) } }); toast(r.ok ? "Đã đổi." : `Không thực hiện được: ${missingText(r.error)}`); if (r.ok) { setV({ ...v, [s.key]: "" }); void load(); } }} data-testid={`setting-save-${s.key}`}>Lưu</button></span>}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

// ───────────────────────── Tìm kiếm
const plain = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
/** highlights the typed words (accent-insensitive) */
function Hl({ text, q }: { text: string; q: string }) {
  const terms = plain(q).split(/\s+/).filter(Boolean); const p = plain(text);
  const marks = new Array(text.length).fill(false);
  for (const t of terms) { let i = p.indexOf(t); while (i >= 0) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = p.indexOf(t, i + t.length); } }
  const out: React.ReactNode[] = []; let k = 0;
  while (k < text.length) { let j = k; while (j < text.length && marks[j] === marks[k]) j++; const seg = text.slice(k, j); out.push(marks[k] ? <mark key={k}>{seg}</mark> : <span key={k}>{seg}</span>); k = j; }
  return <>{out}</>;
}
export function SearchView() { const { live } = useRole(); return live ? <SearchInner /> : <Need />; }
function SearchInner() {
  const [q, setQ] = useState(""); const [types, setTypes] = useState<string[]>([]); const [res, setRes] = useState<any | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const r = await lumiApi<any>("/api/v1/lumi/search", { method: "POST", body: { q, types: types.length ? types : undefined } });
    setBusy(false); if (r.ok) setRes(r.data); else { setRes(null); setMsg(errText(r.error)); }
  }
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="search-view">
      <Head icon={<Search size={22} />} title="Tìm kiếm" note="Tìm xuyên việc, mục tiêu, kế hoạch, kiến thức, cuộc họp, trợ lý, dự án, ý tưởng, mẫu, thử nghiệm, routine. Không cần gõ dấu." />
      <form className="l-row" style={{ gap: 8 }} onSubmit={go} role="search"><input className="l-input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Từ khóa…" aria-label="Từ khóa tìm kiếm" data-testid="search-q" /><button className="l-btn primary" disabled={busy || q.trim().length === 0} data-testid="search-go">Tìm</button></form>
      <div className="small l-row" style={{ gap: 10, flexWrap: "wrap" }} data-testid="search-types">Chỉ tìm trong:{[["TASK", "Việc"], ["GOAL", "Mục tiêu"], ["PLAN", "Kế hoạch"], ["KNOWLEDGE", "Kiến thức"], ["MEETING", "Họp"], ["ASSISTANT", "Trợ lý"], ["PROJECT", "Dự án"], ["IDEA", "Ý tưởng"], ["TEMPLATE", "Mẫu"], ["EXPERIMENT", "Thử nghiệm"], ["ROUTINE", "Routine"]].map(([k, l]) => <label key={k}><input type="checkbox" checked={types.includes(k!)} onChange={(e) => setTypes(e.target.checked ? [...types, k!] : types.filter((x) => x !== k))} data-testid={`st-${k}`} /> {l}</label>)}</div>
      {msg && <div className="l-note" role="alert">{msg}</div>}
      {res && (res.total === 0 ? <Empty>Không có kết quả cho «{res.q}».</Empty> : (res.groups as any[]).map((g) => (
        <section key={g.type} className="l-card" data-testid={`search-group-${g.type}`}><h3 style={{ margin: "0 0 4px" }}>{g.label} ({g.items.length})</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{g.items.map((it: any) => <li key={it.code}><LumiLink href={it.href}><u>{it.code}</u></LumiLink> · <Hl text={it.title} q={q} />{it.sub ? <span className="muted"> · {it.sub}</span> : null}</li>)}</ul></section>
      )))}
      {res && <p className="small muted">{res.note}</p>}
    </div>
  );
}

// ───────────────────────── Soát kiến thức
export function KnowledgeReviewView() { const { live } = useRole(); return live ? <ReviewInner /> : <Need />; }
function ReviewInner() {
  const { toast } = useLumi(); const { canWrite } = useRole();
  const { d, err, load } = useGet<any>("/api/v1/lumi/knowledge-review", 30000);
  if (err) return <div className="l-note" role="alert">{err}</div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const FL: Record<string, string> = { NO_DATE: "Có số tiền/phần trăm nhưng thiếu «tính đến ngày…»", STALE: `Quá ${d.review_days} ngày chưa soát` };
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="review-view">
      <Head icon={<ClipboardCheck size={22} />} title="Soát kiến thức" note={d.note} />
      <p className="small"><LumiLink href="/lumi/knowledge"><u>← Về Kiến thức</u></LumiLink></p>
      {(d.items as any[]).length === 0 ? <Empty>Không có mục nào cần soát.</Empty> : (d.items as any[]).map((i) => (
        <section key={i.id} className="l-card" data-testid={`review-${i.code}`}>
          <strong>{i.code} · {i.title}</strong> <span className="small muted">({i.age_days} ngày kể từ lần duyệt/soát gần nhất)</span>
          <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>{(i.flags as string[]).map((x) => <li key={x} data-testid={`review-flag-${i.code}-${x}`}>{FL[x]}</li>)}</ul>
          {canWrite && <button className="l-btn sm" onClick={async () => { const r = await lumiApi(`/api/v1/lumi/knowledge-review/${i.id}/reviewed`, { method: "POST", body: { note: "Đã soát" } }); toast(r.ok ? "Đã đánh dấu soát." : `Không thực hiện được: ${missingText(r.error)}`); void load(); }} data-testid={`review-done-${i.code}`}>Đã soát</button>}
        </section>
      ))}
    </div>
  );
}
