"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/**
 * IMP-03 (ORG-03, ORG-05, ORG-07, OFC-03): appointments, verified skills + execution level, evaluation and business cases.
 * Everything here is OWNER-only to change; every other role reads. An appointment says WHO ANSWERS FOR a function — it never grants authority.
 */
import { useCallback, useEffect, useState } from "react";

import { EXEC_LEVELS } from "@/lib/lumi-m1/levels";
import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull } from "./ui";

export type RosterView = "appointments" | "skills" | "evaluation";
const DEPARTMENTS = Array.from({ length: 12 }, (_, i) => `DEP-${String(i + 1).padStart(2, "0")}`);
const SKILL_STATE: Record<string, string> = { UNVERIFIED: "Chưa kiểm chứng", VERIFIED: "Đã kiểm chứng", MONITORED: "Đang theo dõi" };

function useRoster() {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await lumiApi("/api/v1/lumi/roster");
    if (r.ok) { setData(r.data); setErr(null); } else setErr(errText(r.error));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { data, err, load };
}

export function RosterPanel({ view, assistants, isOwner, onChanged }: { view: RosterView; assistants: any[]; isOwner: boolean; onChanged: () => void }) {
  const { toast, state } = useLumi();
  const { data, err, load } = useRoster();
  const active = assistants.filter((a) => a.status === "ACTIVE");
  const projects = state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }));
  async function act(path: string, body: unknown, okMsg: string, key?: string) {
    const r = await lumiApi(path, { method: "POST", body, key });
    toast(r.ok ? okMsg : `Không thực hiện được: ${errText(r.error)}`);
    if (r.ok) { void load(); onChanged(); }
    return r;
  }
  if (err) return <div className="l-note" role="alert" data-testid="roster-error">Không tải được: {err} <button className="l-btn sm" onClick={() => void load()}>Thử lại</button></div>;
  if (!data) return <p className="muted" data-testid="roster-loading">Đang tải…</p>;
  if (view === "appointments") return <Appointments data={data} active={active} projects={projects} isOwner={isOwner} act={act} />;
  if (view === "skills") return <Skills data={data} active={active} isOwner={isOwner} act={act} />;
  const role = state.real?.role;
  return <Evaluation data={data} isOwner={isOwner} canPropose={role === "OWNER" || role === "ADMIN"} act={act} />;
}

type Act = (path: string, body: unknown, okMsg: string, key?: string) => Promise<{ ok: boolean }>;

function Appointments({ data, active, projects, isOwner, act }: { data: any; active: any[]; projects: { id: string; name: string }[]; isOwner: boolean; act: Act }) {
  const [role, setRole] = useState({ name: "", department: "" });
  const [ap, setAp] = useState({ roleId: "", assistantId: "", scope: "COMPANY", scopeRef: "", note: "" });
  const [ending, setEnding] = useState<{ id: string; reason: string } | null>(null);
  const [moving, setMoving] = useState<{ id: string; to: string; tasks: boolean } | null>(null);
  const roles = (data.roles as any[]).filter((r) => r.status === "ACTIVE");
  const rows = data.appointments as any[];
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="org-appointments">
      <div className="l-banner" role="note"><strong>Bổ nhiệm = ai chịu trách nhiệm chức năng nào.</strong><span>Một trợ lý có thể kiêm nhiều vai và một vai có thể có nhiều người. Bổ nhiệm <strong>không cấp thêm quyền</strong>: công cụ, giấy ủy quyền và mức quyền vẫn do Chủ đặt riêng.</span></div>
      {isOwner && (
        <section className="l-card">
          <h3 style={{ margin: "0 0 6px" }}>Vai trò</h3>
          <form className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="role-form" onSubmit={async (e) => { e.preventDefault(); const r = await act("/api/v1/lumi/roles", { name: role.name, department: role.department || undefined }, "Đã tạo vai trò."); if (r.ok) setRole({ name: "", department: "" }); }}>
            <label className="l-label" style={{ flex: 2, minWidth: 180 }}>Tên vai trò<input className="l-input" value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} minLength={2} maxLength={80} required data-testid="role-name" /></label>
            <label className="l-label" style={{ minWidth: 130 }}>Phòng ban (tùy chọn)<select className="l-input" value={role.department} onChange={(e) => setRole({ ...role, department: e.target.value })}><option value="">— không —</option>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select></label>
            <button className="l-btn primary" data-testid="role-submit">Tạo vai trò</button>
          </form>
        </section>
      )}
      <section className="l-card">
        <h3 style={{ margin: "0 0 6px" }}>Danh sách vai trò ({roles.length})</h3>
        {roles.length === 0 ? <Empty>Chưa có vai trò nào.</Empty> : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid="role-list">
            {roles.map((r) => <li key={r.id} data-testid={`role-${r.code}`}><strong>{r.name}</strong> <span className="muted">({r.code}{r.department ? ` · ${r.department}` : ""})</span>
              {isOwner && !rows.some((a) => a.role_id === r.id && a.state === "ACTIVE") && <button className="l-btn sm" style={{ marginLeft: 8 }} onClick={() => void act(`/api/v1/lumi/roles/${r.id}/archive`, {}, "Đã lưu trữ vai trò.")}>Lưu trữ</button>}</li>)}
          </ul>
        )}
      </section>
      {isOwner && roles.length > 0 && (
        <section className="l-card">
          <h3 style={{ margin: "0 0 6px" }}>Bổ nhiệm</h3>
          <form className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="appointment-form"
            onSubmit={async (e) => { e.preventDefault(); const r = await act("/api/v1/lumi/appointments", { role_id: ap.roleId, assistant_id: ap.assistantId, scope: ap.scope, scope_ref: ap.scope === "COMPANY" ? undefined : ap.scopeRef, note: ap.note || undefined }, "Đã bổ nhiệm."); if (r.ok) setAp({ ...ap, note: "" }); }}>
            <label className="l-label" style={{ minWidth: 160 }}>Vai trò<select className="l-input" value={ap.roleId} onChange={(e) => setAp({ ...ap, roleId: e.target.value })} required data-testid="ap-role"><option value="">— chọn —</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label className="l-label" style={{ minWidth: 160 }}>Trợ lý<select className="l-input" value={ap.assistantId} onChange={(e) => setAp({ ...ap, assistantId: e.target.value })} required data-testid="ap-assistant"><option value="">— chọn —</option>{active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <label className="l-label" style={{ minWidth: 130 }}>Phạm vi<select className="l-input" value={ap.scope} onChange={(e) => setAp({ ...ap, scope: e.target.value, scopeRef: "" })} data-testid="ap-scope"><option value="COMPANY">Toàn công ty</option><option value="PROJECT">Một dự án</option></select></label>
            {ap.scope === "PROJECT" && <label className="l-label" style={{ minWidth: 160 }}>Dự án<select className="l-input" value={ap.scopeRef} onChange={(e) => setAp({ ...ap, scopeRef: e.target.value })} required data-testid="ap-project"><option value="">— chọn —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
            <label className="l-label" style={{ flex: 1, minWidth: 160 }}>Ghi chú bàn giao<input className="l-input" value={ap.note} onChange={(e) => setAp({ ...ap, note: e.target.value })} maxLength={1000} /></label>
            <button className="l-btn primary" data-testid="ap-submit">Bổ nhiệm</button>
          </form>
        </section>
      )}
      <section className="l-card">
        <h3 style={{ margin: "0 0 6px" }}>Bổ nhiệm hiện có</h3>
        {rows.length === 0 ? <Empty>Chưa có bổ nhiệm nào.</Empty> : (
          <div style={{ overflowX: "auto" }}>
            <table className="l-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }} data-testid="appointment-table">
              <thead><tr><th align="left">Vai trò</th><th align="left">Người giữ vai</th><th align="left">Phạm vi</th><th align="left">Trạng thái</th><th align="left">Từ</th><th /></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} data-testid={`appointment-${a.role_code}-${a.assistant_slug}-${a.state}`}>
                    <td>{a.role_name}</td><td>{a.assistant_name}</td><td className="small">{a.scope === "COMPANY" ? "Toàn công ty" : `${a.scope === "PROJECT" ? "Dự án" : "Kế hoạch"}: ${a.scope_label ?? "?"}`}</td>
                    <td>{a.state === "ACTIVE" ? <span className="l-badge green">đang giữ</span> : <span className="l-badge">đã kết thúc{a.end_reason ? ` · ${a.end_reason}` : ""}</span>}</td>
                    <td className="small">{fmtFull(a.effective_from)}</td>
                    <td>{isOwner && a.state === "ACTIVE" && (
                      <span className="l-row" style={{ gap: 6 }}>
                        <button className="l-btn sm" onClick={() => setMoving({ id: a.id, to: "", tasks: false })} data-testid={`transfer-${a.role_code}-${a.assistant_slug}`}>Chuyển vai</button>
                        <button className="l-btn sm danger" onClick={() => setEnding({ id: a.id, reason: "" })} data-testid={`end-${a.role_code}-${a.assistant_slug}`}>Kết thúc</button>
                      </span>)}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        )}
        {ending && (
          <form className="l-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="end-form" onSubmit={async (e) => { e.preventDefault(); const r = await act(`/api/v1/lumi/appointments/${ending.id}/end`, { reason: ending.reason }, "Đã kết thúc bổ nhiệm."); if (r.ok) setEnding(null); }}>
            <label className="l-label" style={{ flex: 1, minWidth: 200 }}>Lý do kết thúc<input className="l-input" value={ending.reason} onChange={(e) => setEnding({ ...ending, reason: e.target.value })} minLength={3} required data-testid="end-reason" /></label>
            <button className="l-btn danger" data-testid="end-confirm">Xác nhận kết thúc</button><button type="button" className="l-btn" onClick={() => setEnding(null)}>Hủy</button>
          </form>
        )}
        {moving && (
          <form className="l-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="transfer-form" onSubmit={async (e) => { e.preventDefault(); const r = await act(`/api/v1/lumi/appointments/${moving.id}/transfer`, { to_assistant_id: moving.to, move_open_tasks: moving.tasks }, "Đã chuyển vai."); if (r.ok) setMoving(null); }}>
            <label className="l-label" style={{ minWidth: 200 }}>Chuyển cho<select className="l-input" value={moving.to} onChange={(e) => setMoving({ ...moving, to: e.target.value })} required data-testid="transfer-to"><option value="">— chọn —</option>{active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <label className="small l-row" style={{ gap: 6 }}><input type="checkbox" checked={moving.tasks} onChange={(e) => setMoving({ ...moving, tasks: e.target.checked })} /> Chuyển cả việc mở chưa chạy của vai này</label>
            <button className="l-btn primary" data-testid="transfer-confirm">Xác nhận chuyển</button><button type="button" className="l-btn" onClick={() => setMoving(null)}>Hủy</button>
            <div className="small muted" style={{ flexBasis: "100%" }}>Hệ thống từ chối nếu người đang giữ vai còn lượt chạy dở. Quyền của người nhận vai không thay đổi.</div>
          </form>
        )}
      </section>
    </div>
  );
}

function Skills({ data, active, isOwner, act }: { data: any; active: any[]; isOwner: boolean; act: Act }) {
  const [f, setF] = useState({ assistantId: "", skill: "", state: "VERIFIED", evidence: "", environment: "", limits: "" });
  const [lv, setLv] = useState<Record<string, string>>({});
  const skills = data.skills as any[];
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="org-skills">
      <div className="l-banner" role="note"><strong>Năng lực chỉ là «đã kiểm chứng» khi có bằng chứng.</strong><span>Ghi bằng chứng test, môi trường đánh giá và giới hạn. «Chưa kiểm chứng» là mặc định: bot chưa kiểm chứng không được chọn làm bên nhận việc cần kỹ năng đó.</span></div>
      <section className="l-card">
        <h3 style={{ margin: "0 0 6px" }}>Mức quyền thực thi</h3>
        <p className="small muted" style={{ marginTop: 0 }}>Mức là <strong>trần</strong> cho danh sách công cụ và việc bot được tự khởi tạo. Mặc định 0. Đổi mức được ghi nhật ký; không đổi giấy ủy quyền.</p>
        <div className="l-grid" style={{ gap: 8 }}>
          {active.map((a) => {
            const cur = a.execution_level ?? 0; const sel = lv[a.id] ?? String(cur);
            return (
              <div key={a.id} className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }} data-testid={`level-row-${a.slug}`}>
                <strong style={{ minWidth: 140 }}>{a.name}</strong>
                <span className="l-badge" data-testid={`level-now-${a.slug}`}>Mức {cur} · {EXEC_LEVELS[cur]?.label}</span>
                {isOwner && <>
                  <select className="l-input" style={{ width: 240 }} value={sel} onChange={(e) => setLv({ ...lv, [a.id]: e.target.value })} data-testid={`level-select-${a.slug}`}>{EXEC_LEVELS.map((l) => <option key={l.level} value={l.level}>Mức {l.level} · {l.label}</option>)}</select>
                  <button className="l-btn sm" disabled={sel === String(cur)} onClick={() => void act(`/api/v1/lumi/assistants/${a.id}/level`, { level: Number(sel) }, `Đã đặt mức ${sel}.`)} data-testid={`level-save-${a.slug}`}>Lưu mức</button>
                </>}
                <span className="small muted" style={{ flexBasis: "100%" }}>{EXEC_LEVELS[Number(sel)]?.note}</span>
              </div>
            );
          })}
        </div>
      </section>
      {isOwner && (
        <section className="l-card">
          <h3 style={{ margin: "0 0 6px" }}>Ghi năng lực</h3>
          <form className="l-grid" style={{ gap: 8 }} data-testid="skill-form" onSubmit={async (e) => { e.preventDefault(); const r = await act(`/api/v1/lumi/assistants/${f.assistantId}/skills`, { skill: f.skill, state: f.state, evidence: f.evidence || undefined, environment: f.environment || undefined, limits: f.limits || undefined }, "Đã ghi năng lực."); if (r.ok) setF({ ...f, skill: "", evidence: "", environment: "", limits: "" }); }}>
            <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="l-label" style={{ minWidth: 160 }}>Trợ lý<select className="l-input" value={f.assistantId} onChange={(e) => setF({ ...f, assistantId: e.target.value })} required data-testid="sk-assistant"><option value="">— chọn —</option>{active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label className="l-label" style={{ flex: 1, minWidth: 160 }}>Năng lực<input className="l-input" value={f.skill} onChange={(e) => setF({ ...f, skill: e.target.value })} minLength={2} maxLength={80} required data-testid="sk-name" /></label>
              <label className="l-label" style={{ minWidth: 160 }}>Trạng thái<select className="l-input" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} data-testid="sk-state">{Object.entries(SKILL_STATE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            </div>
            {f.state !== "UNVERIFIED" && <>
              <label className="l-label">Bằng chứng (tối thiểu 10 ký tự)<textarea className="l-textarea" rows={2} value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} data-testid="sk-evidence" /></label>
              <label className="l-label">Môi trường đánh giá<input className="l-input" value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })} data-testid="sk-env" /></label>
            </>}
            <label className="l-label">Giới hạn đã biết (tùy chọn)<input className="l-input" value={f.limits} onChange={(e) => setF({ ...f, limits: e.target.value })} maxLength={500} /></label>
            <div><button className="l-btn primary" data-testid="sk-submit">Lưu năng lực</button></div>
          </form>
        </section>
      )}
      <section className="l-card">
        <h3 style={{ margin: "0 0 6px" }}>Năng lực đã ghi ({skills.length})</h3>
        {skills.length === 0 ? <Empty>Chưa ghi năng lực nào: mọi kỹ năng hiện là «chưa kiểm chứng».</Empty> : (
          <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }} data-testid="skill-table">
            <thead><tr><th align="left">Trợ lý</th><th align="left">Năng lực</th><th align="left">Trạng thái</th><th align="left">Bằng chứng / môi trường</th></tr></thead>
            <tbody>{skills.map((s) => (
              <tr key={s.id} data-testid={`skill-${s.assistant_slug}-${String(s.skill).toLowerCase()}`}>
                <td>{s.assistant_name}</td><td>{s.skill}</td><td><span className={`l-badge ${s.state === "VERIFIED" ? "green" : ""}`}>{SKILL_STATE[s.state]}</span></td>
                <td className="small">{s.evidence ?? "—"}{s.environment ? <div className="muted">Môi trường: {s.environment}{s.assessed_at ? ` · ${fmtFull(s.assessed_at)}` : ""}</div> : null}{s.limits ? <div className="muted">Giới hạn: {s.limits}</div> : null}</td>
              </tr>))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Evaluation({ data, isOwner, canPropose, act }: { data: any; isOwner: boolean; canPropose: boolean; act: Act }) {
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const [days, setDays] = useState("30");
  const [ev, setEv] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bc, setBc] = useState({ title: "", work_needed: "", volume: "", extra_cost: "", owner_time_saved: "", trial_criteria: "", stop_condition: "", alternatives: "" });
  const [key, setKey] = useState(newKey());
  const run = useCallback(async () => {
    const to = new Date(); const from = new Date(to.getTime() - Number(days) * 86400_000);
    const r = await lumiApi("/api/v1/lumi/evaluation", { method: "POST", body: { from: from.toISOString(), to: to.toISOString() } });
    if (r.ok) { setEv(r.data); setErr(null); } else setErr(errText(r.error));
  }, [days]);
  useEffect(() => { void run(); }, [run]);
  const cases = data.cases as any[];
  const f = (k: keyof typeof bc, label: string, area = false) => (
    <label className="l-label">{label}{area ? <textarea className="l-textarea" rows={2} value={bc[k]} onChange={(e) => setBc({ ...bc, [k]: e.target.value })} data-testid={`bc-${k}`} /> : <input className="l-input" value={bc[k]} onChange={(e) => setBc({ ...bc, [k]: e.target.value })} data-testid={`bc-${k}`} />}</label>
  );
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="org-evaluation">
      <section className="l-card">
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Đánh giá nhân viên AI</h3>
          <select className="l-input" style={{ width: 150 }} value={days} onChange={(e) => setDays(e.target.value)} data-testid="ev-period"><option value="7">7 ngày</option><option value="30">30 ngày</option><option value="90">90 ngày</option></select>
          <button className="l-btn sm" onClick={() => void run()}>Tải lại</button>
        </div>
        {err && <div className="l-note" role="alert">{err}</div>}
        {ev && (
          <>
            <div className="l-banner" role="note" style={{ marginTop: 8 }} data-testid="ev-notes"><strong>Đọc kỹ trước khi kết luận.</strong><span>{(ev.notes as string[]).join(" ")}</span></div>
            <div style={{ overflowX: "auto" }}>
              <table className="l-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 760, marginTop: 8 }} data-testid="ev-table">
                <thead><tr><th align="left">Trợ lý</th><th align="left">Vai</th><th align="right">Việc nhận</th><th align="right">Xong</th><th align="right">Đạt ngay lần đầu</th><th align="right">Vòng sửa</th><th align="right">Lượt chạy (lỗi)</th><th align="right">Bàn giao gửi/nhận/từ chối</th><th align="right">Chủ phải can thiệp</th><th align="right">Chờ duyệt TB</th></tr></thead>
                <tbody>{(ev.staff as any[]).map((s) => (
                  <tr key={s.id} data-testid={`ev-${s.slug}`}>
                    <td>{s.name}</td><td className="small">{(s.roles as string[]).join(", ") || "—"}</td>
                    <td align="right">{s.tasks_created}</td><td align="right">{s.tasks_completed}</td>
                    <td align="right">{s.first_pass_rate === null ? "chưa có" : `${Math.round(s.first_pass_rate * 100)}% (${s.first_pass}/${s.tasks_completed})`}</td>
                    <td align="right">{s.revision_rounds}</td><td align="right">{s.runs} ({s.runs_failed})</td>
                    <td align="right">{s.handoffs_sent}/{s.handoffs_received}/{s.handoffs_rejected}</td><td align="right">{s.owner_interventions}</td>
                    <td align="right">{s.avg_review_wait_hours === null ? "chưa có" : `${s.avg_review_wait_hours} giờ`}</td>
                  </tr>))}</tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>Chi phí AI theo lượt: <strong>chưa đo</strong> nên không hiển thị cột chi phí. Không xếp hạng, không đề xuất giữ/gộp/tách/dừng từ các số đếm này.</p>
          </>
        )}
      </section>
      <section className="l-card">
        <h3 style={{ margin: "0 0 6px" }}>Business case thêm nhân viên AI</h3>
        <p className="small muted" style={{ marginTop: 0 }}>Một nhân viên AI mới chỉ nên thêm khi có công việc cụ thể, khối lượng, chi phí, tiêu chí thử và điều kiện dừng. Bot không tự tạo nhân viên; duyệt ở đây <strong>không tự tạo hồ sơ</strong> (bạn tạo ở tab Nhân viên AI).</p>
        {canPropose ? (
          <form className="l-grid" style={{ gap: 8 }} data-testid="bc-form" onSubmit={async (e) => { e.preventDefault(); const r = await act("/api/v1/lumi/bot-cases", { ...bc, alternatives: bc.alternatives || undefined }, "Đã lập business case.", key); if (r.ok) { setBc({ title: "", work_needed: "", volume: "", extra_cost: "", owner_time_saved: "", trial_criteria: "", stop_condition: "", alternatives: "" }); setKey(newKey()); } }}>
            {f("title", "Tiêu đề")}{f("work_needed", "Việc cần làm", true)}{f("volume", "Khối lượng (ví dụ số video/tuần)")}{f("extra_cost", "Chi phí thêm (ghi «chưa biết» nếu chưa đo)")}{f("owner_time_saved", "Thời gian Chủ tiết kiệm (ước tính)")}{f("trial_criteria", "Tiêu chí thử", true)}{f("stop_condition", "Điều kiện dừng", true)}{f("alternatives", "Phương án khác đã cân nhắc (tùy chọn)")}
            <div><button className="l-btn primary" data-testid="bc-submit">Lập business case</button></div>
          </form>
        ) : <p className="small muted">Chỉ OWNER/ADMIN lập business case.</p>}
        {cases.length > 0 && (
          <div className="l-grid" style={{ gap: 8, marginTop: 10 }} data-testid="bc-list">
            {cases.map((c) => (
              <div key={c.id} className="l-card" data-testid={`bc-${c.code}`}>
                <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong>{c.code} · {c.title}</strong><span className={`l-badge ${c.state === "APPROVED" ? "green" : c.state === "REJECTED" ? "red" : "amber"}`}>{c.state === "PROPOSED" ? "chờ Chủ quyết định" : c.state === "APPROVED" ? "đã duyệt" : "từ chối"}</span></div>
                <div className="small">Việc: {c.work_needed} · Khối lượng: {c.volume} · Chi phí thêm: {c.extra_cost}</div>
                <div className="small muted">Tiêu chí thử: {c.trial_criteria} · Dừng khi: {c.stop_condition}</div>
                {isOwner && c.state === "PROPOSED" && (
                  <div className="l-row" style={{ gap: 6, marginTop: 6 }}>
                    <button className="l-btn sm primary" onClick={() => void act(`/api/v1/lumi/bot-cases/${c.id}/decide`, { decision: "APPROVE" }, "Đã duyệt business case.")} data-testid={`bc-approve-${c.code}`}>Duyệt</button>
                    <button className="l-btn sm danger" onClick={() => setRejecting({ id: c.id, note: "" })} data-testid={`bc-reject-${c.code}`}>Từ chối</button>
                  </div>)}
                {isOwner && rejecting !== null && rejecting.id === c.id && <RejectForm note={rejecting.note} onNote={(note) => setRejecting({ id: c.id, note })} onSubmit={async (note) => { const r = await act(`/api/v1/lumi/bot-cases/${c.id}/decide`, { decision: "REJECT", note }, "Đã từ chối."); if (r.ok) setRejecting(null); }} />}
              </div>))}
          </div>
        )}
      </section>
    </div>
  );
}

function RejectForm({ note, onNote, onSubmit }: { note: string; onNote: (v: string) => void; onSubmit: (note: string) => Promise<void> }) {
  return (
    <form className="l-row" style={{ gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); void onSubmit(note); }}>
      <input className="l-input" placeholder="Lý do từ chối (bắt buộc)" value={note} onChange={(e) => onNote(e.target.value)} minLength={3} required data-testid="bc-reject-note" />
      <button className="l-btn sm danger" data-testid="bc-reject-confirm">Xác nhận từ chối</button>
    </form>
  );
}
