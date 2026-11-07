"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */

import { useCallback, useEffect, useState } from "react";
import { Plus, ShieldCheck, Users } from "lucide-react";

import { COMPANY_FUNCTIONS, DECISION_LEAD, CAPABILITY_STAGE, STAGE_RESPONSIBILITIES, assistantStates, derivePermissionLevels, whyCannotTakeWork } from "@/lib/lumi/org";
import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { AuthorityDialog } from "./authority-dialog";
import { RosterPanel } from "./roster-panel";
import { Empty, fmtFull, Modal } from "./ui";

const TOOL_LABEL: Record<string, string> = {
  "knowledge.context": "Đọc việc được giao (knowledge_context)", "outputs.submit": "Nộp đầu ra (outputs_submit)", "tasks.intake": "Nhận giao việc (tasks_intake)",
  "plan.submit.version": "Nộp phiên bản kế hoạch (plan_submit_version)", web: "Tìm/đọc web (chỉ đọc)", skills: "Đọc skill nghiệp vụ",
};
const TOOL_KEYS = Object.keys(TOOL_LABEL);
type Tab = "staff" | "map" | "duties" | "appointments" | "skills" | "evaluation";

export function OrgView() {
  const { state } = useLumi();
  return state.mode !== "db" ? <Empty>Màn Tổ chức cần chế độ dữ liệu thật (đăng nhập). Ở chế độ xem trước, dùng mục Văn phòng.</Empty> : <OrgInner />;
}

function OrgInner() {
  const { state, toast } = useLumi();
  const isOwner = state.real?.role === "OWNER";
  const [tab, setTab] = useState<Tab>("staff");
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<any | "new" | null>(null);
  const [archiving, setArchiving] = useState<any | null>(null);
  const [authority, setAuthority] = useState<any | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const r = await lumiApi<{ assistants: any[] }>("/api/v1/lumi/assistants");
    if (r.ok && r.data) { setRows(r.data.assistants); setErr(null); } else setErr(errText(r.error));
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function act(path: string, body: unknown, okMsg: string, method: "POST" | "PATCH" = "POST", key?: string) {
    const r = await lumiApi(path, { method, body, key });
    toast(r.ok ? okMsg : `Không thực hiện được: ${errText(r.error)}`);
    if (r.ok) void load();
    return r;
  }
  const visible = (rows ?? []).filter((a) => showArchived || a.status === "ACTIVE");

  return (
    <div className="l-grid" style={{ gap: 14 }} data-testid="org-view">
      <div>
        <h1 className="l-row" style={{ gap: 8 }}><Users size={22} /> Tổ chức</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Nguồn hồ sơ nhân viên AI, vai trò và trách nhiệm. Văn phòng 2D/3D chỉ là cách xem cùng dữ liệu này. Không có bí mật nào hiển thị ở đây: token và khóa nằm trong profile Hermes, ngoài ứng dụng.</p>
      </div>
      <div className="l-tabs" role="tablist" aria-label="Tổ chức">
        {([["staff", "Nhân viên AI"], ["map", "Bản đồ chức năng"], ["duties", "Trách nhiệm & quyền"], ["appointments", "Bổ nhiệm"], ["skills", "Năng lực & mức quyền"], ["evaluation", "Đánh giá"]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`org-tab-${k}`}>{label}</button>
        ))}
      </div>
      {err && <div className="l-note" role="alert" data-testid="org-error">Không tải được: {err} <button className="l-btn sm" onClick={() => void load()}>Thử lại</button></div>}

      {tab === "staff" && (
        <>
          <div className="l-row" style={{ gap: 10, flexWrap: "wrap" }}>
            {isOwner ? <button className="l-btn primary" onClick={() => setEdit("new")} data-testid="assistant-new"><Plus size={15} /> Thêm nhân viên AI</button> : <span className="small muted">Chỉ OWNER thêm/sửa/lưu trữ nhân viên AI.</span>}
            <label className="small l-row" style={{ gap: 6 }}><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Hiện đã lưu trữ</label>
          </div>
          {rows === null ? <p className="muted" data-testid="org-loading">Đang tải…</p> : visible.length === 0 ? <Empty>Chưa có nhân viên AI nào. {isOwner ? "Bấm «Thêm nhân viên AI» để tạo hồ sơ (chưa kết nối, giao việc tắt)." : ""}</Empty> : (
            <div className="l-grid" style={{ gap: 10 }}>
              {visible.map((a) => <AssistantCard key={a.id} a={a} isOwner={isOwner} onEdit={() => setEdit(a)} onArchive={() => setArchiving(a)} onAuthority={() => setAuthority(a)}
                onVerify={() => act(`/api/v1/lumi/assistants/${a.id}/verify`, {}, "Đã gửi yêu cầu kiểm tra kết nối cho worker.")}
                onDispatch={(on) => act(`/api/v1/lumi/assistants/${a.id}/dispatch`, { enabled: on }, on ? "Đã bật giao việc." : "Đã tắt giao việc.")} />)}
            </div>
          )}
        </>
      )}

      {tab === "map" && <FunctionMap />}
      {tab === "duties" && <Duties rows={visible} />}
      {(tab === "appointments" || tab === "skills" || tab === "evaluation") && <RosterPanel view={tab} assistants={rows ?? []} isOwner={isOwner} onChanged={() => void load()} />}

      <AuthorityDialog a={authority ? (rows ?? []).find((x) => x.id === authority.id) ?? authority : null} projects={state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }))} onClose={() => setAuthority(null)} onChanged={() => void load()} />
      <AssistantForm target={edit} projects={state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }))} onClose={() => setEdit(null)}
        onSave={async (body, id, key) => {
          const r = id ? await act(`/api/v1/lumi/assistants/${id}`, body, "Đã lưu hồ sơ.", "PATCH") : await act("/api/v1/lumi/assistants", body, "Đã tạo hồ sơ (chưa kết nối, giao việc tắt).", "POST", key);
          if (r.ok) setEdit(null);
          return r;
        }} />
      <Modal open={archiving !== null} onClose={() => setArchiving(null)} title={`Lưu trữ ${archiving?.name ?? ""}`}>
        <div className="l-grid" style={{ gap: 10 }} data-testid="archive-dialog">
          <p style={{ margin: 0 }}>Hồ sơ được giữ lại cùng lịch sử (tên người phụ trách vẫn nằm trên việc cũ). <strong>Việc đang mở của trợ lý này chuyển về Chủ</strong> ({archiving?.open_tasks ?? 0} việc); lượt chưa gửi bị hủy; giao việc tắt. Không xóa dữ liệu nào.</p>
          {(archiving?.runs_in_flight ?? 0) > 0 && <div className="l-note" role="alert">Đang có {archiving.runs_in_flight} lượt chạy dở: hệ thống sẽ từ chối lưu trữ cho tới khi chúng kết thúc.</div>}
          <div className="l-row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="l-btn" onClick={() => setArchiving(null)}>Đóng</button>
            <button className="l-btn danger" data-testid="archive-confirm" onClick={async () => { const r = await act(`/api/v1/lumi/assistants/${archiving.id}/archive`, {}, "Đã lưu trữ; việc mở đã chuyển về Chủ."); if (r.ok) setArchiving(null); }}>Xác nhận lưu trữ</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function AssistantCard({ a, isOwner, onEdit, onArchive, onAuthority, onVerify, onDispatch }: { a: any; isOwner: boolean; onEdit: () => void; onArchive: () => void; onAuthority: () => void; onVerify: () => void; onDispatch: (on: boolean) => void }) {
  const st = assistantStates(a);
  const why = whyCannotTakeWork(a);
  const pending = a.verify_request && ["PENDING", "LEASED"].includes(a.verify_request.state);
  const pendingLong = pending && Date.now() - new Date(a.verify_request.created_at).getTime() > 2 * 60_000;
  const archived = a.status !== "ACTIVE";
  return (
    <section className="l-card" data-testid={`assistant-${a.slug}`}>
      <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div><strong>{a.name}</strong> <span className="small muted">({a.slug}) · {a.role_label}</span></div>
        <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className="l-badge" data-testid={`state-profile-${a.slug}`}>{st.profile}</span>
          <span className={`l-badge ${a.connection_state === "VERIFIED" ? "green" : a.connection_state === "FAILED" ? "red" : ""}`} data-testid={`state-conn-${a.slug}`}>{st.connection}</span>
          <span className={`l-badge ${a.dispatch_enabled ? "purple" : ""}`} data-testid={`state-exec-${a.slug}`}>{st.execution}</span>
        </div>
      </div>
      {a.description && <p className="small" style={{ margin: "6px 0" }}>{a.description}</p>}
      <dl className="small" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px", margin: "6px 0" }}>
        <dt className="muted">Profile Hermes</dt><dd>{a.hermes_profile ?? "chưa gắn"}</dd>
        <dt className="muted">Công cụ cho phép</dt><dd>{(a.tool_allowlist as string[]).join(", ")} <span className="muted">· chế độ {a.capability_mode}</span></dd>
        <dt className="muted">Mức quyền thực thi</dt><dd data-testid={`level-${a.slug}`}>Mức {a.execution_level ?? 0}</dd>
        <dt className="muted">Giới hạn</dt><dd>{a.max_runs_per_day} lượt/ngày · hạn {a.run_deadline_seconds}s/lượt · lỗi tối đa {a.max_run_failures} · thử lại gửi {a.max_transport_attempts} · vòng sửa {a.max_revision_rounds}</dd>
        <dt className="muted">Dự án</dt><dd>{(a.projects as any[]).map((p) => p.name).join(", ") || "chưa thuộc dự án nào"}</dd>
        <dt className="muted">Hoạt động</dt><dd>{a.runs_total} lượt chạy · {a.open_tasks} việc mở · {a.runs_in_flight} đang chạy</dd>
        <dt className="muted">Kiểm tra gần nhất</dt><dd>{a.connection_checked_at ? fmtFull(a.connection_checked_at) : "chưa kiểm"}{a.connection_error ? <span style={{ color: "var(--l-red, #c33)" }}> · {a.connection_error}</span> : null}</dd>
      </dl>
      {pending && <div className="l-note" data-testid={`verify-pending-${a.slug}`}>Đang chờ worker kiểm tra kết nối (yêu cầu lúc {fmtFull(a.verify_request.created_at)}).{pendingLong ? " Đã hơn 2 phút: có thể worker chưa phục vụ trợ lý này (cần khai báo trợ lý trong cấu hình worker)." : ""}</div>}
      {!archived && why && <div className="small muted" data-testid={`why-${a.slug}`}>Chưa nhận việc được: {why}</div>}
      {isOwner && !archived && (
        <div className="l-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button className="l-btn sm" onClick={onEdit} data-testid={`edit-${a.slug}`}>Sửa</button>
          <button className="l-btn sm" onClick={onAuthority} data-testid={`authority-${a.slug}`}>Quyền &amp; tự chủ</button>
          <button className="l-btn sm" onClick={onVerify} disabled={!a.hermes_profile || pending} data-testid={`verify-${a.slug}`} title={a.hermes_profile ? "" : "Gắn profile Hermes trước"}>Kiểm tra kết nối</button>
          <button className="l-btn sm" onClick={() => onDispatch(!a.dispatch_enabled)} disabled={!a.dispatch_enabled && a.connection_state !== "VERIFIED"} data-testid={`dispatch-${a.slug}`} title={a.connection_state !== "VERIFIED" ? "Cần kiểm tra kết nối thật thành công trước" : ""}>{a.dispatch_enabled ? "Tắt giao việc" : "Bật giao việc"}</button>
          <button className="l-btn sm danger" onClick={onArchive} data-testid={`archive-${a.slug}`}>Lưu trữ</button>
        </div>
      )}
    </section>
  );
}

function FunctionMap() {
  return (
    <section className="l-card" data-testid="org-map">
      <p className="small muted" style={{ marginTop: 0 }}>Mười hai chức năng là <strong>dữ liệu khai báo</strong>, không phải mười hai bot. Phân công dưới đây là <strong>đề xuất ban đầu</strong> (chưa được Chủ xác nhận từng dòng). Chức năng «chưa kích hoạt» không có hồ sơ bot; đầu mối quyết định: {DECISION_LEAD}.</p>
      <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th align="left">Mã</th><th align="left">Chức năng</th><th align="left">Đảm nhận</th><th align="left">Trạng thái</th></tr></thead>
        <tbody>
          {COMPANY_FUNCTIONS.map((f) => (
            <tr key={f.code} data-testid={`fn-${f.code}`}>
              <td>{f.code}</td><td>{f.name}</td><td>{f.holder}{f.note ? <div className="small muted">{f.note}</div> : null}</td>
              <td>{f.inactive ? <span className="l-badge amber">chưa kích hoạt · quyết định: {DECISION_LEAD}</span> : <span className="l-badge">đề xuất</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Duties({ rows }: { rows: any[] }) {
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="org-duties">
      <div className="l-banner" role="note"><strong>Chỉ đọc.</strong><span>Giai đoạn năng lực hiện tại: {CAPABILITY_STAGE}. Q0–Q4 là <strong>nhãn dẫn xuất</strong> từ cấu hình thật, không phải cột hay enum quyền mới.</span></div>
      {rows.length === 0 ? <Empty>Chưa có nhân viên AI để hiển thị mức quyền.</Empty> : rows.map((a) => (
        <section key={a.id} className="l-card" data-testid={`duty-${a.slug}`}>
          <div className="l-row" style={{ gap: 8 }}><ShieldCheck size={16} /><strong>{a.name}</strong><span className="small muted">({a.slug})</span></div>
          <table className="l-table" style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
            <thead><tr><th align="left">Mức</th><th align="left">Hiện</th><th align="left">Dẫn xuất từ cấu hình thật</th><th align="left">Nơi ép</th></tr></thead>
            <tbody>
              {derivePermissionLevels(a).map((p) => (
                <tr key={p.level} data-testid={`q-${a.slug}-${p.level}`}>
                  <td><strong>{p.level}</strong> {p.title}</td>
                  <td>{p.active ? <span className="l-badge green">đang có</span> : <span className="l-badge">không</span>}</td>
                  <td className="small">{p.basis}<div className="muted">{p.caveat}</div></td>
                  <td className="small">{p.enforcement}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <section className="l-card">
        <h3 style={{ margin: "0 0 6px" }}>Trách nhiệm theo giai đoạn dự án (S1–S6)</h3>
        <div style={{ overflowX: "auto" }}>
          <table className="l-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }} data-testid="org-stages">
            <thead><tr><th align="left">Giai đoạn</th><th align="left">AFF (thương mại)</th><th align="left">YT (nội dung/kênh)</th><th align="left">Trưởng kế hoạch</th><th align="left">Quyền</th></tr></thead>
            <tbody>
              {STAGE_RESPONSIBILITIES.map((r) => (
                <tr key={r.stage} data-testid={`stage-${r.stage}`}><td><strong>{r.stage}</strong> {r.name}</td><td className="small">{r.aff}</td><td className="small">{r.yt}</td><td className="small">{r.lead}</td><td className="small">{r.level}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AssistantForm({ target, projects, onClose, onSave }: { target: any | "new" | null; projects: { id: string; name: string }[]; onClose: () => void; onSave: (body: any, id: string | null, key: string) => Promise<any> }) {
  const creating = target === "new";
  const a = target && target !== "new" ? target : null;
  const [f, setF] = useState<any>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  useEffect(() => {
    if (!target) return;
    setErr(null); setBusy(false); setKey(newKey());
    setF(a ? {
      name: a.name, slug: a.slug, role_label: a.role_label, description: a.description ?? "", avatar: a.avatar ?? "", hermes_profile: a.hermes_profile ?? "", tools: a.tool_allowlist,
      runs: String(a.max_runs_per_day ?? ""), deadline: String(a.run_deadline_seconds ?? ""), ack: String(a.ack_deadline_seconds ?? ""), fails: String(a.max_run_failures ?? ""), transport: String(a.max_transport_attempts ?? ""), rev: String(a.max_revision_rounds ?? ""),
      projects: (a.projects as any[]).map((p) => p.id),
    } : { name: "", slug: "", role_label: "", description: "", avatar: "", hermes_profile: "", tools: ["knowledge.context", "outputs.submit"], runs: "", deadline: "", ack: "", fails: "", transport: "", rev: "", projects: [] });
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null);
    const body: any = {
      name: f.name, role_label: f.role_label, description: f.description, avatar: f.avatar, hermes_profile: f.hermes_profile, tool_allowlist: f.tools, project_ids: f.projects,
      limits: { max_runs_per_day: num(f.runs), run_deadline_seconds: num(f.deadline), ack_deadline_seconds: num(f.ack), max_run_failures: num(f.fails), max_transport_attempts: num(f.transport), max_revision_rounds: num(f.rev) },
    };
    if (creating) body.slug = f.slug;
    const r = await onSave(body, a?.id ?? null, key);
    setBusy(false);
    if (!r.ok) setErr(errText(r.error));
  }
  const lim = (label: string, k: string, ph: string) => <label className="l-label" style={{ flex: 1, minWidth: 130 }}>{label}<input className="l-input" inputMode="numeric" value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} placeholder={ph} required data-testid={`af-${k}`} /></label>;
  return (
    <Modal open={target !== null} onClose={onClose} title={creating ? "Thêm nhân viên AI" : `Sửa ${a?.name ?? ""}`} wide>
      <form onSubmit={submit} className="l-grid" style={{ gap: 10 }} data-testid="assistant-form">
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="l-label" style={{ flex: 2, minWidth: 180 }}>Tên<input className="l-input" value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} required minLength={2} maxLength={80} data-testid="af-name" /></label>
          <label className="l-label" style={{ flex: 1, minWidth: 140 }}>Mã (slug){creating ? null : <span className="muted"> · không đổi</span>}<input className="l-input" value={f.slug ?? ""} onChange={(e) => set("slug", e.target.value)} disabled={!creating} required pattern="[a-z][a-z0-9-]{1,30}" title="chữ thường, số, gạch ngang; bắt đầu bằng chữ" data-testid="af-slug" /></label>
          <label className="l-label" style={{ width: 90 }}>Avatar<input className="l-input" value={f.avatar ?? ""} onChange={(e) => set("avatar", e.target.value)} maxLength={16} placeholder="🤖" /></label>
        </div>
        <label className="l-label">Vai trò / chuyên môn<input className="l-input" value={f.role_label ?? ""} onChange={(e) => set("role_label", e.target.value)} required minLength={2} maxLength={80} data-testid="af-role" /></label>
        <label className="l-label">Mô tả<textarea className="l-textarea" rows={2} value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} maxLength={1000} /></label>
        <label className="l-label">Profile Hermes (tên profile; để trống nếu chưa gắn) <span className="muted">· không nhập token ở đây — token/khóa nằm trong profile Hermes</span>
          <input className="l-input" value={f.hermes_profile ?? ""} onChange={(e) => set("hermes_profile", e.target.value)} pattern="[a-z0-9][a-z0-9_-]{0,40}" data-testid="af-profile" /></label>
        <fieldset style={{ border: "1px solid var(--l-border)", borderRadius: 8, padding: 8 }}>
          <legend className="small">Công cụ được phép (chế độ RESTRICTED: profile Hermes chỉ được bật đúng các công cụ này)</legend>
          {TOOL_KEYS.map((t) => <label key={t} className="small l-row" style={{ gap: 6 }}><input type="checkbox" checked={(f.tools ?? []).includes(t)} onChange={(e) => set("tools", e.target.checked ? [...(f.tools ?? []), t] : (f.tools ?? []).filter((x: string) => x !== t))} data-testid={`af-tool-${t}`} /> {TOOL_LABEL[t]}</label>)}
        </fieldset>
        <div className="small muted">Giới hạn chạy: không có số mặc định — bạn nhập từng giá trị (ví dụ gợi ý hiện ở ô trống).</div>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {lim("Số lượt/ngày (1–1000)", "runs", "vd 8")}{lim("Hạn mỗi lượt, giây (30–3600)", "deadline", "vd 600")}{lim("Hạn nhận lệnh, giây (10–600)", "ack", "vd 60")}
        </div>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {lim("Lỗi tối đa (1–10)", "fails", "vd 1")}{lim("Lần gửi lại tối đa (1–5)", "transport", "vd 1")}{lim("Vòng sửa tối đa (0–10)", "rev", "vd 1")}
        </div>
        {projects.length > 0 && (
          <fieldset style={{ border: "1px solid var(--l-border)", borderRadius: 8, padding: 8 }}>
            <legend className="small">Dự án tham gia</legend>
            {projects.map((p) => <label key={p.id} className="small l-row" style={{ gap: 6 }}><input type="checkbox" checked={(f.projects ?? []).includes(p.id)} onChange={(e) => set("projects", e.target.checked ? [...(f.projects ?? []), p.id] : (f.projects ?? []).filter((x: string) => x !== p.id))} /> {p.name}</label>)}
          </fieldset>
        )}
        {!creating && <p className="small muted" style={{ margin: 0 }}>Đổi profile hoặc danh sách công cụ sẽ <strong>đặt lại trạng thái «đã kết nối»</strong> và tắt giao việc cho tới khi kiểm tra lại.</p>}
        {err && <div className="l-note" role="alert" data-testid="af-error">{err}</div>}
        <div className="l-row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="l-btn" onClick={onClose}>Hủy</button>
          <button className="l-btn primary" disabled={busy} data-testid="af-submit">{creating ? "Tạo hồ sơ" : "Lưu"}</button>
        </div>
      </form>
    </Modal>
  );
}
