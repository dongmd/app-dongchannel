"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/**
 * Họp bất đồng bộ (MTG-01..03, 05..09). A meeting is an exception with a stated reason: each party gets the question and a deadline and submits a structured
 * contribution; the chair writes ONE versioned note whose lines point to the original contributions. The APP classifies every conclusion (record / internal inside the
 * approved plan / proposal for the owner); a conclusion never widens money or permission. Silence is not agreement.
 */
import { useCallback, useEffect, useState } from "react";
import { MessagesSquare, Plus } from "lucide-react";

import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull } from "./ui";

const REASON: Record<string, string> = { CROSS_ROLE: "Quyết định chéo vai trò / bất đồng", JOINT_PLAN: "Nhiều bot cùng góp một Plan & Cost", MILESTONE: "Mốc / đánh giá sau thử nghiệm", OWNER: "Chủ yêu cầu" };
const ROLE: Record<string, string> = { CHAIR: "Chủ trì", REQUIRED_EXPERT: "Chuyên gia bắt buộc", CONTRIBUTOR: "Đóng góp", OBSERVER: "Quan sát", OWNER_OPTIONAL: "Chủ (tùy chọn)" };
const OUTCOME: Record<string, string> = { PENDING: "đang diễn ra", DECIDED: "đã kết luận", PARTIAL: "kết luận một phần", ESCALATED: "đã chuyển Chủ", NO_DECISION: "không có quyết định", NOT_CONCLUDED: "chưa kết luận (chạm giới hạn)" };
const CKIND: Record<string, string> = { RECORD: "Ghi nhận", INTERNAL: "Quyết định nội bộ trong biên", PROPOSAL: "Đề xuất cần Chủ duyệt" };
const CSTATE: Record<string, string> = { RECORDED: "đã ghi", APPLIED: "đã áp dụng", PENDING_OWNER: "chờ Chủ", APPROVED: "Chủ đã đồng ý", REJECTED: "Chủ từ chối", BLOCKED: "bị chặn" };
const ASTATE: Record<string, string> = { PENDING_ACCEPT: "chờ PIC nhận", ACCEPTED: "PIC đã nhận", DECLINED: "PIC từ chối", AWAITING_OWNER: "chờ Chủ" };

export function MeetingsView() {
  const { state } = useLumi();
  return state.mode !== "db" ? <Empty>Họp cần chế độ dữ liệu thật (đăng nhập).</Empty> : <Inner />;
}

function Inner() {
  const { state, toast } = useLumi();
  const role = state.real?.role; const isOwner = role === "OWNER";
  const [data, setData] = useState<{ meetings: any[]; proposals: any[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const load = useCallback(async () => {
    const r = await lumiApi("/api/v1/lumi/meetings");
    if (r.ok) { setData(r.data); setErr(null); } else setErr(errText(r.error));
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 6000); return () => clearInterval(t); }, [load]);
  return (
    <div className="l-grid" style={{ gap: 14 }} data-testid="meetings-view">
      <div>
        <h1 className="l-row" style={{ gap: 8 }}><MessagesSquare size={22} /> Họp</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Họp là <strong>ngoại lệ có lý do</strong>, không phải bước mặc định: việc có một người phụ trách rõ đi thẳng bàn giao. Họp bất đồng bộ: mỗi bên nộp đóng góp có cấu trúc, chủ trì tổng hợp một biên bản có phiên bản. <strong>Kết luận không tự mở rộng ngân sách hay quyền</strong>; im lặng không phải đồng ý.</p>
      </div>
      {isOwner && <div><button className="l-btn primary" onClick={() => setOpening(true)} data-testid="mt-open"><Plus size={15} /> Mở cuộc họp</button></div>}
      {err && <div className="l-note" role="alert">Không tải được: {err}</div>}
      {opening && <OpenForm onClose={() => setOpening(false)} onDone={(code) => { setOpening(false); void load(); setSel(code); }} toast={toast} />}
      {data === null ? <p className="muted">Đang tải…</p> : data.meetings.length === 0 ? <Empty>Chưa có cuộc họp nào.</Empty> : (
        <div className="l-grid" style={{ gap: 8 }} data-testid="mt-list">
          {data.meetings.map((m) => (
            <button key={m.id} className="l-card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setSel(m.code)} data-testid={`mt-row-${m.code}`}>
              <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}><strong>{m.code}</strong><span className={`l-badge ${m.state === "OPEN" ? "purple" : ""}`}>{m.state === "OPEN" ? "đang mở" : m.state === "CLOSED" ? "đã đóng" : "đã hủy"}</span><span className="l-badge">{OUTCOME[m.outcome]}</span>{m.pending_owner > 0 && <span className="l-badge amber">{m.pending_owner} chờ Chủ</span>}</div>
              <div style={{ fontWeight: 650, marginTop: 4 }}>{m.title}</div>
              <div className="small muted">Chủ trì {m.chair_name}{m.plan_code ? ` · ${m.plan_code}` : ""} · hạn {fmtFull(m.closes_at)} · {m.contributions} đóng góp · {m.runs_used}/{m.max_runs} lượt</div>
            </button>
          ))}
        </div>
      )}
      {sel && <Detail code={sel} isOwner={isOwner} onClose={() => setSel(null)} onChanged={() => void load()} toast={toast} />}
    </div>
  );
}

function OpenForm({ onClose, onDone, toast }: { onClose: () => void; onDone: (code: string) => void; toast: (m: string) => void }) {
  const [assistants, setAssistants] = useState<any[]>([]); const [plans, setPlans] = useState<any[]>([]);
  const dflt = () => new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 16);
  const [f, setF] = useState<any>({ title: "", question: "", reason: "JOINT_PLAN", planId: "", chair: "", backup: "", closes: dflt(), rounds: "1", runs: "6", cost: "", endCond: "Đủ đóng góp hoặc hết hạn", inputRef: "", inputVersion: "1", parts: {} as Record<string, { on: boolean; role: string; exp: string }> });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [key] = useState(newKey());
  useEffect(() => {
    void lumiApi("/api/v1/lumi/assistants").then((r) => { if (r.ok) setAssistants((r.data.assistants as any[]).filter((a) => a.status === "ACTIVE")); });
    void lumiApi("/api/v1/lumi/goals").then((r) => { if (r.ok) setPlans((r.data.goals as any[]).map((g) => g.plan).filter(Boolean)); });
  }, []);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const setPart = (id: string, patch: any) => setF((p: any) => ({ ...p, parts: { ...p.parts, [id]: { on: false, role: "CONTRIBUTOR", exp: "", ...p.parts[id], ...patch } } }));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null);
    const participants = Object.entries(f.parts as Record<string, any>).filter(([id, p]) => p.on && id !== f.chair).map(([id, p]) => ({ assistant_id: id, role: p.role, expertise: p.role === "REQUIRED_EXPERT" ? p.exp : undefined }));
    const r = await lumiApi("/api/v1/lumi/meetings", { method: "POST", key, body: {
      title: f.title, question: f.question, reason: f.reason, plan_id: f.planId || undefined, chair_assistant_id: f.chair, backup_chair_assistant_id: f.backup || undefined, closes_at: new Date(f.closes).toISOString(),
      max_rounds: Number(f.rounds), max_runs: Number(f.runs), max_cost: f.cost.trim() ? Number(f.cost) : undefined, currency: f.cost.trim() ? "USD" : undefined, end_conditions: f.endCond,
      inputs: [{ kind: "PLAN_VERSION", ref: f.inputRef, version: Number(f.inputVersion) }], participants,
    } });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.code === "USE_HANDOFF" ? "Chỉ một bot phát biểu: việc có một người phụ trách rõ đi thẳng bàn giao (mở việc → «Bàn giao»), không họp." : r.error?.code === "POLICY_NOT_SET" ? "Chưa đặt «trần số lần họp» ở Công ty → Chính sách." : errText(r.error)); return; }
    toast(`Đã mở cuộc họp ${r.data.meeting.code}; mỗi bot phát biểu nhận một việc đóng góp.`);
    onDone(r.data.meeting.code);
  }
  return (
    <section className="l-card" data-testid="mt-form">
      <h3 style={{ marginTop: 0 }}>Mở cuộc họp bất đồng bộ</h3>
      <form onSubmit={submit} className="l-grid" style={{ gap: 8 }}>
        <label className="l-label">Tiêu đề<input className="l-input" value={f.title} onChange={(e) => set("title", e.target.value)} required minLength={3} data-testid="mf-title" /></label>
        <label className="l-label">Câu hỏi cần trả lời<textarea className="l-textarea" rows={2} value={f.question} onChange={(e) => set("question", e.target.value)} required data-testid="mf-question" /></label>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="l-label" style={{ minWidth: 220 }}>Lý do họp<select className="l-input" value={f.reason} onChange={(e) => set("reason", e.target.value)} data-testid="mf-reason">{Object.entries(REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="l-label" style={{ minWidth: 200 }}>Kế hoạch<select className="l-input" value={f.planId} onChange={(e) => { const p = plans.find((x) => x.id === e.target.value); setF((q: any) => ({ ...q, planId: e.target.value, inputRef: p?.code ?? "", inputVersion: String(p?.approved_version ?? p?.current_version ?? 1) })); }} data-testid="mf-plan"><option value="">— không —</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.code} ({p.status})</option>)}</select></label>
          <label className="l-label" style={{ minWidth: 200 }}>Chủ trì<select className="l-input" value={f.chair} onChange={(e) => set("chair", e.target.value)} required data-testid="mf-chair"><option value="">— chọn —</option>{assistants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="l-label" style={{ minWidth: 200 }}>Chủ trì dự phòng<select className="l-input" value={f.backup} onChange={(e) => set("backup", e.target.value)}><option value="">— không —</option>{assistants.filter((a) => a.id !== f.chair).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        </div>
        <fieldset style={{ border: "1px solid var(--l-border)", borderRadius: 8, padding: 8 }}>
          <legend className="small">Thành phần (chủ trì tự động có mặt)</legend>
          {assistants.filter((a) => a.id !== f.chair).map((a) => {
            const p = f.parts[a.id] ?? { on: false, role: "CONTRIBUTOR", exp: "" };
            return (
              <div key={a.id} className="l-row" style={{ gap: 8, flexWrap: "wrap", margin: "2px 0" }}>
                <label className="small l-row" style={{ gap: 6, minWidth: 160 }}><input type="checkbox" checked={p.on} onChange={(e) => setPart(a.id, { on: e.target.checked })} data-testid={`mf-part-${a.slug}`} /> {a.name}</label>
                <select className="l-input" style={{ width: 190 }} value={p.role} onChange={(e) => setPart(a.id, { role: e.target.value })} data-testid={`mf-role-${a.slug}`}>{["CONTRIBUTOR", "REQUIRED_EXPERT", "OBSERVER"].map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select>
                {p.role === "REQUIRED_EXPERT" && <input className="l-input" style={{ width: 180 }} placeholder="Chuyên môn bắt buộc" value={p.exp} onChange={(e) => setPart(a.id, { exp: e.target.value })} data-testid={`mf-exp-${a.slug}`} />}
              </div>
            );
          })}
        </fieldset>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="l-label">Hạn đóng<input className="l-input" type="datetime-local" value={f.closes} onChange={(e) => set("closes", e.target.value)} required data-testid="mf-closes" /></label>
          <label className="l-label" style={{ width: 110 }}>Số vòng (1–5)<input className="l-input" inputMode="numeric" value={f.rounds} onChange={(e) => set("rounds", e.target.value)} required /></label>
          <label className="l-label" style={{ width: 140 }}>Tối đa số lượt chạy<input className="l-input" inputMode="numeric" value={f.runs} onChange={(e) => set("runs", e.target.value)} required data-testid="mf-runs" /></label>
          <label className="l-label" style={{ width: 150 }}>Trần chi phí USD (tùy chọn)<input className="l-input" inputMode="decimal" value={f.cost} onChange={(e) => set("cost", e.target.value)} /></label>
        </div>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="l-label" style={{ flex: 1, minWidth: 200 }}>Đầu vào có phiên bản: mã kế hoạch<input className="l-input" value={f.inputRef} onChange={(e) => set("inputRef", e.target.value)} required placeholder="vd PL-002" data-testid="mf-input-ref" /></label>
          <label className="l-label" style={{ width: 110 }}>Phiên bản<input className="l-input" inputMode="numeric" value={f.inputVersion} onChange={(e) => set("inputVersion", e.target.value)} required /></label>
        </div>
        <label className="l-label">Điều kiện kết thúc<input className="l-input" value={f.endCond} onChange={(e) => set("endCond", e.target.value)} required /></label>
        {err && <div className="l-note" role="alert" data-testid="mf-error">{err}</div>}
        <div className="l-row" style={{ gap: 8, justifyContent: "flex-end" }}><button type="button" className="l-btn" onClick={onClose}>Hủy</button><button className="l-btn primary" disabled={busy} data-testid="mf-submit">Mở họp</button></div>
      </form>
    </section>
  );
}

function Detail({ code, isOwner, onClose, onChanged, toast }: { code: string; isOwner: boolean; onClose: () => void; onChanged: () => void; toast: (m: string) => void }) {
  const [d, setD] = useState<any | null>(null); const [err, setErr] = useState<string | null>(null);
  const [say, setSay] = useState({ stance: "", evidence: "" }); const [why, setWhy] = useState("");
  const load = useCallback(async () => {
    const r = await lumiApi(`/api/v1/lumi/meetings/${code}`);
    if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error));
  }, [code]);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 6000); return () => clearInterval(t); }, [load]);
  async function post(path: string, body: any, ok: string) {
    const r = await lumiApi(path, { method: "POST", body });
    toast(r.ok ? ok : `Không thực hiện được: ${errText(r.error)}`);
    if (r.ok) { void load(); onChanged(); }
    return r;
  }
  if (err) return <div className="l-note" role="alert">{err} <button className="l-btn sm" onClick={onClose}>Đóng</button></div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const m = d.meeting; const contrib = d.contributions as any[];
  const idxOf = new Map<string, number>(contrib.map((c, i) => [c.id, i + 1]));
  const ownerPart = (d.participants as any[]).find((p) => p.role === "OWNER_OPTIONAL");
  return (
    <section className="l-card" data-testid="mt-detail" data-code={m.code}>
      <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{m.code} · {m.title} <span className="l-badge">{OUTCOME[m.outcome]}</span> {m.inputs_changed && <span className="l-badge amber">đầu vào đã đổi</span>}</h3>
        <button className="l-btn sm" onClick={onClose}>Đóng</button>
      </div>
      <p style={{ margin: "6px 0" }}><strong>Câu hỏi:</strong> {m.question}</p>
      <div className="small muted">Lý do: {REASON[m.reason]} · chủ trì {m.chair_name}{m.chair_switched ? " (đã chuyển sang chủ trì dự phòng)" : ""} · hạn {fmtFull(m.closes_at)} · {m.runs_used}/{m.max_runs} lượt · tối đa {m.max_rounds} vòng · điều kiện kết thúc: {m.end_conditions}</div>
      <div className="small muted">Đầu vào: {(m.inputs as any[]).map((i) => i.label).join("; ")}</div>
      <div className="small" data-testid="mt-cost">Chi phí AI đã <strong>đo</strong>: {Number(d.cost.measured).toFixed(4)} USD{m.max_cost !== null ? ` / trần ${m.max_cost} ${m.currency}` : ""} · {d.cost.unknown_runs} lượt <strong>chưa biết</strong> (không phải 0). {m.close_reason ? `Đóng: ${m.close_reason}` : ""}</div>

      <h4 style={{ margin: "10px 0 4px" }}>Thành phần</h4>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid="mt-participants">{(d.participants as any[]).map((p) => <li key={p.id}>{p.name ?? "Chủ"} · {ROLE[p.role]}{p.expertise ? ` (${p.expertise})` : ""} · {p.state === "CONTRIBUTED" ? "đã đóng góp" : p.state === "ABSENT" ? "VẮNG (không phải đồng ý)" : "chưa đóng góp"}{p.task_code ? ` · việc ${p.task_code}` : ""}</li>)}</ul>
      {(d.coverage as any[]).length > 0 && <div className="small" data-testid="mt-coverage" style={{ marginTop: 4 }}>Ý kiến chuyên môn bắt buộc: {(d.coverage as any[]).map((c) => `${c.expertise} ${c.satisfied ? "✓ đủ" : !c.present ? "✗ chưa có" : "✗ có mặt nhưng năng lực chưa kiểm chứng"}`).join(" · ")}</div>}

      <h4 style={{ margin: "10px 0 4px" }}>Đóng góp gốc ({contrib.length})</h4>
      {contrib.length === 0 ? <p className="small muted">Chưa có đóng góp nào.</p> : contrib.map((c, i) => (
        <div key={c.id} className="l-card" style={{ marginBottom: 4 }} data-testid={`mt-contrib-${i + 1}`}>
          <div className="small"><strong>#{i + 1} {c.who}</strong> · vòng {c.round} · {ROLE[c.role]} {c.late && <span className="l-badge amber">MUỘN</span>}</div>
          <div>{c.stance}</div>
          {[["Bằng chứng", c.evidence], ["Rủi ro", c.risks], ["Ước tính", c.estimate], ["Phản đối", c.objection], ["Đề xuất", c.proposal]].filter(([, v]) => v).map(([k, v]) => <div key={k as string} className="small muted">{k}: {v as string}</div>)}
        </div>
      ))}
      {isOwner && ownerPart && m.state === "OPEN" && (
        <form className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }} data-testid="mt-owner-say" onSubmit={async (e) => { e.preventDefault(); const r = await post(`/api/v1/lumi/meetings/${m.code}/contribute`, { stance: say.stance, evidence: say.evidence || undefined }, "Đã ghi đóng góp của Chủ."); if (r.ok) setSay({ stance: "", evidence: "" }); }}>
          <input className="l-input" style={{ flex: 2, minWidth: 220 }} placeholder="Ý kiến của Chủ (lập trường)" value={say.stance} onChange={(e) => setSay({ ...say, stance: e.target.value })} required minLength={3} data-testid="mt-say-stance" />
          <input className="l-input" style={{ flex: 1, minWidth: 160 }} placeholder="Bằng chứng" value={say.evidence} onChange={(e) => setSay({ ...say, evidence: e.target.value })} />
          <button className="l-btn sm primary" data-testid="mt-say-submit">Gửi đóng góp</button>
        </form>
      )}

      <h4 style={{ margin: "10px 0 4px" }}>Biên bản</h4>
      {(d.notes as any[]).length === 0 ? <p className="small muted" data-testid="mt-no-note">Chưa có biên bản.</p> : (d.notes as any[]).map((n) => (
        <div key={n.version} className="l-card" data-testid={`mt-note-${n.version}`}>
          <div className="small"><strong>Phiên bản {n.version}</strong> · {n.created_by} · {fmtFull(n.created_at)} {n.self_checked && <span className="l-badge amber" data-testid="mt-self-checked">chủ trì tự kiểm tra (tổng hợp phần lớn ý của chính mình)</span>}</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{n.summary}</div>
          <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>{(n.lines as any[]).map((l, i) => <li key={i}>{l.text} <span className="muted">(nguồn: đóng góp {(l.contribution_ids as string[]).map((id) => `#${idxOf.get(id) ?? "?"}`).join(", ")})</span></li>)}</ul>
        </div>
      ))}

      <h4 style={{ margin: "10px 0 4px" }}>Kết luận (do hệ thống phân loại)</h4>
      {(d.conclusions as any[]).length === 0 ? <p className="small muted">Chưa có kết luận.</p> : (d.conclusions as any[]).map((c) => (
        <div key={c.id} className="l-card" style={{ marginBottom: 4 }} data-testid={`mt-concl-${c.idx}`} data-state={c.state} data-kind={c.kind}>
          <div className="small l-row" style={{ gap: 6, flexWrap: "wrap" }}><strong>{c.type}</strong><span className="l-badge">{CKIND[c.kind]}</span><span className={`l-badge ${c.state === "PENDING_OWNER" ? "amber" : c.state === "BLOCKED" ? "red" : ""}`}>{CSTATE[c.state]}</span></div>
          <div>{c.text}</div>
          <div className="small muted">{c.reason}</div>
          {isOwner && c.state === "PENDING_OWNER" && (
            <div className="l-row" style={{ gap: 6, marginTop: 4 }}>
              <button className="l-btn sm primary" onClick={() => void post(`/api/v1/lumi/meeting-conclusions/${c.id}`, { decision: "APPROVE" }, "Đã ghi nhận đồng ý (thay đổi thật phải làm riêng).")} data-testid={`mt-approve-${c.idx}`}>Đồng ý ghi nhận</button>
              <button className="l-btn sm danger" onClick={() => void post(`/api/v1/lumi/meeting-conclusions/${c.id}`, { decision: "REJECT" }, "Đã từ chối đề xuất.")} data-testid={`mt-reject-${c.idx}`}>Từ chối</button>
            </div>
          )}
        </div>
      ))}
      {(d.actions as any[]).length > 0 && (<>
        <h4 style={{ margin: "10px 0 4px" }}>Nhiệm vụ sau họp</h4>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid="mt-actions">{(d.actions as any[]).map((a) => <li key={a.id}>{a.title} · PIC {a.pic_name} · hạn {fmtFull(a.due_at)} · {ASTATE[a.state]}{a.task_code ? ` · việc ${a.task_code}` : ""}{a.decline_reason ? ` · lý do từ chối: ${a.decline_reason}` : ""}</li>)}</ul>
      </>)}
      {isOwner && m.state === "OPEN" && (
        <form className="l-row" style={{ gap: 6, marginTop: 10 }} onSubmit={async (e) => { e.preventDefault(); await post(`/api/v1/lumi/meetings/${m.code}/close`, { reason: why }, "Đã đóng cuộc họp (không kết luận)."); setWhy(""); }}>
          <input className="l-input" style={{ width: 260 }} placeholder="Lý do đóng họp" value={why} onChange={(e) => setWhy(e.target.value)} minLength={3} required data-testid="mt-close-reason" />
          <button className="l-btn sm danger" data-testid="mt-close">Đóng họp</button>
        </form>
      )}
    </section>
  );
}
