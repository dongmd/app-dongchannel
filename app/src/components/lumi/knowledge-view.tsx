"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */
/**
 * Kho kiến thức (KNW-01..07, 11..14; CMP-01). Source → note → decision → rule, with scope, versions, who changed what, and traceability to the tasks that used each version.
 * A bot only proposes; only the OWNER approves. A rule here is an INSTRUCTION to bots, never a permission or a budget.
 */
import { useCallback, useEffect, useState } from "react";
import { BookOpen, Plus } from "lucide-react";

import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull } from "./ui";

const KIND: Record<string, string> = { NOTE: "Ghi chú", DECISION: "Quyết định", RULE: "Quy tắc" };
const SCOPE: Record<string, string> = { COMPANY: "Công ty", AREA: "Mảng", PROJECT: "Dự án", PERSONAL: "Cá nhân" };
const STATUS: Record<string, string> = { PROPOSED: "Chờ duyệt", ACTIVE: "Đang hiệu lực", REJECTED: "Đã bác bỏ", SUPERSEDED: "Đã thay thế", ARCHIVED: "Đã lưu trữ" };
const VSTATE: Record<string, string> = { PROPOSED: "chờ duyệt", APPROVED: "đã duyệt", REJECTED: "bị bác bỏ", SUPERSEDED: "đã được thay", WITHDRAWN: "đã rút" };
const TONE: Record<string, string> = { PROPOSED: "amber", ACTIVE: "green", REJECTED: "red", SUPERSEDED: "", ARCHIVED: "" };
const AREAS = ["AFFILIATE", "YOUTUBE", "WEBSITE", "OTHER"];

export function KnowledgeView() {
  const { state } = useLumi();
  return state.mode !== "db" ? <Empty>Kho kiến thức cần chế độ dữ liệu thật (đăng nhập).</Empty> : <Inner />;
}

function Inner() {
  const { state, toast } = useLumi();
  const role = state.real?.role;
  const canWrite = role === "OWNER" || role === "ADMIN";
  const isOwner = role === "OWNER";
  const [q, setQ] = useState(""); const [scope, setScope] = useState(""); const [kind, setKind] = useState(""); const [status, setStatus] = useState("");
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const r = await lumiApi("/api/v1/lumi/knowledge/search", { method: "POST", body: { q, scope: scope || undefined, kind: kind || undefined, status: status || undefined } });
    if (r.ok) { setItems(r.data.items); setErr(null); } else setErr(errText(r.error));
  }, [q, scope, kind, status]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 250); // typing in the search box does not hit the server on every key
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 6000); return () => clearInterval(t); }, [load]);

  return (
    <div className="l-grid" style={{ gap: 14 }} data-testid="knowledge-view">
      <div>
        <h1 className="l-row" style={{ gap: 8 }}><BookOpen size={22} /> Kiến thức</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Nguồn → ghi chú → quyết định → quy tắc. Mỗi mục có phạm vi, phiên bản và nguồn. Bot chỉ <strong>đề xuất</strong>; chỉ Chủ duyệt. Quy tắc là <strong>chỉ dẫn</strong> cho bot, không phải quyền hành động hay ngân sách.</p>
      </div>
      <div className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="l-label" style={{ flex: 2, minWidth: 200 }}>Tìm (không cần dấu)<input className="l-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="vd: tieu de ngan" data-testid="kn-q" /></label>
        <label className="l-label" style={{ minWidth: 130 }}>Phạm vi<select className="l-input" value={scope} onChange={(e) => setScope(e.target.value)} data-testid="kn-scope"><option value="">Tất cả</option>{Object.entries(SCOPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="l-label" style={{ minWidth: 130 }}>Loại<select className="l-input" value={kind} onChange={(e) => setKind(e.target.value)} data-testid="kn-kind"><option value="">Tất cả</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="l-label" style={{ minWidth: 150 }}>Trạng thái<select className="l-input" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="kn-status"><option value="">Tất cả</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {canWrite && <button className="l-btn primary" onClick={() => setAdding(true)} data-testid="kn-add"><Plus size={15} /> Đề xuất mục mới</button>}
      </div>
      {err && <div className="l-note" role="alert" data-testid="kn-error">Không tải được: {err}</div>}
      {items === null ? <p className="muted">Đang tải…</p> : items.length === 0 ? <Empty>Chưa có mục kiến thức nào khớp.</Empty> : (
        <div className="l-grid" style={{ gap: 8 }} data-testid="kn-list">
          {items.map((i) => (
            <button key={i.id} className="l-card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setSel(i.id)} data-testid={`kn-row-${i.code}`}>
              <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}>
                <strong>{i.code}</strong><span className="l-badge">{KIND[i.kind]}</span><span className="l-badge">{SCOPE[i.scope]}{i.scope === "AREA" ? `: ${i.scope_ref}` : ""}</span>
                <span className={`l-badge ${TONE[i.status] ?? ""}`}>{STATUS[i.status]}</span>
                {i.approved_version && i.current_version > i.approved_version && <span className="l-badge amber">bản {i.current_version} chờ duyệt</span>}
              </div>
              <div style={{ fontWeight: 650, marginTop: 4 }}>{i.title}</div>
              <div className="small muted" style={{ marginTop: 2 }}>{String(i.content).slice(0, 180)}{String(i.content).length > 180 ? "…" : ""}</div>
              <div className="small muted" style={{ marginTop: 4 }}>{(i.sources as any[]).length} nguồn · {i.tasks_used} việc đã dùng · cập nhật {fmtFull(i.updated_at)}</div>
            </button>
          ))}
        </div>
      )}
      {sel && <Detail id={sel} isOwner={isOwner} canWrite={canWrite} onClose={() => setSel(null)} onChanged={() => void load()} toast={toast} />}
      {adding && <ProposeForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} projects={state.projects.filter((p) => p.status === "active").map((p) => ({ id: p.uuid ?? p.id, name: p.name }))} toast={toast} />}
    </div>
  );
}

function ProposeForm({ onClose, onDone, projects, toast }: { onClose: () => void; onDone: () => void; projects: { id: string; name: string }[]; toast: (m: string) => void }) {
  const [f, setF] = useState({ kind: "RULE", scope: "COMPANY", scopeRef: "", title: "", content: "", reason: "", manual: false, srcTitle: "", srcRef: "" });
  const [err, setErr] = useState<string | null>(null); const [warn, setWarn] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setErr(null);
    const body: any = { kind: f.kind, scope: f.scope, scope_ref: f.scope === "COMPANY" || f.scope === "PERSONAL" ? undefined : f.scopeRef, title: f.title, content: f.content, reason: f.reason || undefined, manual_entry: f.manual };
    if (f.srcTitle.trim()) body.sources = [{ title: f.srcTitle, kind: f.srcRef.startsWith("http") ? "URL" : "NOTE", ref: f.srcRef || undefined }];
    const r = await lumiApi("/api/v1/lumi/knowledge", { method: "POST", body, key: newKey() });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.error)); return; }
    toast(`Đã ghi đề xuất ${r.data.item.code} (chờ duyệt).`);
    if ((r.data.warnings as string[]).length) { setWarn(r.data.warnings); return; }
    onDone();
  }
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  return (
    <section className="l-card" data-testid="kn-form">
      <h3 style={{ marginTop: 0 }}>Đề xuất mục kiến thức mới</h3>
      <form onSubmit={submit} className="l-grid" style={{ gap: 8 }}>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="l-label">Loại<select className="l-input" value={f.kind} onChange={(e) => set("kind", e.target.value)} data-testid="kf-kind">{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="l-label">Phạm vi<select className="l-input" value={f.scope} onChange={(e) => set("scope", e.target.value)} data-testid="kf-scope">{Object.entries(SCOPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {f.scope === "AREA" && <label className="l-label">Mảng<select className="l-input" value={f.scopeRef} onChange={(e) => set("scopeRef", e.target.value)} required>{[""].concat(AREAS).map((a) => <option key={a} value={a}>{a || "— chọn —"}</option>)}</select></label>}
          {f.scope === "PROJECT" && <label className="l-label">Dự án<select className="l-input" value={f.scopeRef} onChange={(e) => set("scopeRef", e.target.value)} required data-testid="kf-project"><option value="">— chọn —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        </div>
        <label className="l-label">Tiêu đề<input className="l-input" value={f.title} onChange={(e) => set("title", e.target.value)} minLength={3} maxLength={200} required data-testid="kf-title" /></label>
        <label className="l-label">Nội dung<textarea className="l-textarea" rows={3} value={f.content} onChange={(e) => set("content", e.target.value)} required maxLength={8000} data-testid="kf-content" /></label>
        <label className="l-label">Lý do (≥ 10 ký tự; quyết định bắt buộc)<input className="l-input" value={f.reason} onChange={(e) => set("reason", e.target.value)} data-testid="kf-reason" /></label>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="l-label" style={{ flex: 1, minWidth: 160 }}>Nguồn (tên)<input className="l-input" value={f.srcTitle} onChange={(e) => set("srcTitle", e.target.value)} data-testid="kf-src-title" /></label>
          <label className="l-label" style={{ flex: 1, minWidth: 160 }}>Liên kết / tham chiếu<input className="l-input" value={f.srcRef} onChange={(e) => set("srcRef", e.target.value)} /></label>
        </div>
        <label className="small l-row" style={{ gap: 6 }}><input type="checkbox" checked={f.manual} onChange={(e) => set("manual", e.target.checked)} /> Nhập tay (tôi tự chịu trách nhiệm, không có nguồn)</label>
        {err && <div className="l-note" role="alert" data-testid="kf-error">{err}</div>}
        {warn.length > 0 && <div className="l-note" data-testid="kf-warn">{warn.map((w, i) => <div key={i}>{w}</div>)}<button type="button" className="l-btn sm" onClick={onDone}>Đã hiểu</button></div>}
        <div className="l-row" style={{ gap: 8, justifyContent: "flex-end" }}><button type="button" className="l-btn" onClick={onClose}>Hủy</button><button className="l-btn primary" disabled={busy} data-testid="kf-submit">Gửi đề xuất</button></div>
      </form>
    </section>
  );
}

function Detail({ id, isOwner, canWrite, onClose, onChanged, toast }: { id: string; isOwner: boolean; canWrite: boolean; onClose: () => void; onChanged: () => void; toast: (m: string) => void }) {
  const [d, setD] = useState<any | null>(null); const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState(""); const [edit, setEdit] = useState<string | null>(null); const [sup, setSup] = useState("");
  const [diff, setDiff] = useState<any | null>(null); const [actives, setActives] = useState<any[]>([]);
  const load = useCallback(async () => {
    const r = await lumiApi(`/api/v1/lumi/knowledge/${id}`);
    if (r.ok) { setD(r.data); setErr(null); } else setErr(errText(r.error));
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!d || !isOwner) return;
    void lumiApi("/api/v1/lumi/knowledge/search", { method: "POST", body: { status: "ACTIVE", scope: d.item.scope } }).then((r) => { if (r.ok) setActives((r.data.items as any[]).filter((x) => x.id !== id && (x.scope_ref ?? null) === (d.item.scope_ref ?? null))); });
  }, [d?.item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(path: string, body: any, ok: string) {
    const r = await lumiApi(`/api/v1/lumi/knowledge/${id}/${path}`, { method: "POST", body });
    toast(r.ok ? ok : `Không thực hiện được: ${errText(r.error)}`);
    if (r.ok) { setReason(""); setEdit(null); setSup(""); setDiff(null); void load(); onChanged(); }
    return r;
  }
  if (err) return <div className="l-note" role="alert">{err} <button className="l-btn sm" onClick={onClose}>Đóng</button></div>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const it = d.item; const vs = d.versions as any[];
  const pending = vs.find((v) => v.version === it.current_version && v.state === "PROPOSED");
  return (
    <section className="l-card" data-testid="kn-detail" data-code={it.code}>
      <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{it.code} · {KIND[it.kind]} · {SCOPE[it.scope]}{it.scope === "AREA" ? `: ${it.scope_ref}` : ""} <span className={`l-badge ${TONE[it.status] ?? ""}`} data-testid="kn-detail-status">{STATUS[it.status]}</span></h3>
        <button className="l-btn sm" onClick={onClose}>Đóng</button>
      </div>
      {(d.supersedes_chain as any[]).length > 1 && <div className="small muted" data-testid="kn-chain">Chuỗi thay thế: {(d.supersedes_chain as any[]).map((c) => `${c.code} (${STATUS[c.status]})`).join(" ← ")}</div>}
      {isOwner && pending && (
        <div className="l-card" style={{ marginTop: 8 }} data-testid="kn-review">
          <strong>Bản {pending.version} đang chờ duyệt</strong>
          {pending.sources.length === 0 && !(pending.reason ?? "").trim() && !pending.manual_entry && <div className="l-note" data-testid="kn-nosource">Chưa có nguồn hoặc lý do xác định: không duyệt được.</div>}
          {actives.length > 0 && <label className="l-label">Thay thế mục đang hiệu lực (nếu mục này thay mục cũ)<select className="l-input" value={sup} onChange={(e) => setSup(e.target.value)} data-testid="kn-supersede"><option value="">— không thay —</option>{actives.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.title}</option>)}</select></label>}
          {edit !== null && <label className="l-label">Sửa nội dung trước khi duyệt (bản đề xuất gốc vẫn được giữ trong lịch sử)<textarea className="l-textarea" rows={3} value={edit} onChange={(e) => setEdit(e.target.value)} data-testid="kn-edit" /></label>}
          <div className="l-row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            <button className="l-btn sm primary" onClick={() => void act("decide", { version: pending.version, decision: "APPROVE", supersede_item_id: sup || undefined, edit: edit !== null ? { content: edit } : undefined }, "Đã duyệt.")} data-testid="kn-approve">{edit !== null ? "Duyệt bản đã sửa" : "Duyệt"}</button>
            <button className="l-btn sm" onClick={() => setEdit(edit === null ? pending.content : null)} data-testid="kn-edit-toggle">{edit === null ? "Sửa rồi duyệt" : "Bỏ sửa"}</button>
            <input className="l-input" style={{ width: 220 }} placeholder="Lý do bác bỏ (≥ 3 ký tự)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="kn-reject-reason" />
            <button className="l-btn sm danger" onClick={() => void act("decide", { version: pending.version, decision: "REJECT", reason }, "Đã bác bỏ.")} data-testid="kn-reject">Bác bỏ</button>
          </div>
        </div>
      )}
      <h4 style={{ margin: "12px 0 4px" }}>Các phiên bản</h4>
      {vs.map((v) => (
        <div key={v.version} className="l-card" style={{ marginBottom: 6 }} data-testid={`kn-version-${v.version}`} data-state={v.state}>
          <div className="l-row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "space-between" }}>
            <strong>Bản {v.version} · {VSTATE[v.state]}{it.approved_version === v.version ? " · ĐANG ÁP DỤNG" : ""}</strong>
            <span className="small muted">{v.created_by} · {v.channel} · {fmtFull(v.created_at)}{v.decided_by ? ` · quyết định bởi ${v.decided_by}` : ""}</span>
          </div>
          <div style={{ fontWeight: 650 }}>{v.title}</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{v.content}</div>
          {v.reason && <div className="small muted">Lý do: {v.reason}</div>}
          {v.decision_reason && <div className="small muted">Lý do quyết định: {v.decision_reason}</div>}
          {(v.unsupported as string[]).length > 0 && <div className="small" style={{ color: "#e0a33a" }}>Phần chưa có nguồn: {(v.unsupported as string[]).join("; ")}</div>}
          <div className="small muted">{(v.sources as any[]).length === 0 ? (v.manual_entry ? "Nhập tay, không nguồn" : "Chưa có nguồn") : (v.sources as any[]).map((s) => `${s.code}: ${s.title}${s.kind === "BOT_CITED" ? " (bot nêu, chưa kiểm chứng)" : ""}`).join(" · ")}</div>
          <div className="l-row" style={{ gap: 6, marginTop: 4 }}>
            {v.version !== it.current_version && <button className="l-btn sm" onClick={async () => { const r = await lumiApi(`/api/v1/lumi/knowledge/${id}/compare`, { method: "POST", body: { a: v.version, b: it.current_version } }); if (r.ok) setDiff({ a: v.version, b: it.current_version, diff: r.data.diff }); }} data-testid={`kn-compare-${v.version}`}>So với bản {it.current_version}</button>}
            {canWrite && v.version !== it.current_version && it.status !== "ARCHIVED" && it.status !== "SUPERSEDED" && <button className="l-btn sm" onClick={() => void act("restore", { version: v.version }, "Đã tạo bản mới từ bản cũ (cần duyệt).")} data-testid={`kn-restore-${v.version}`}>Khôi phục thành bản mới</button>}
          </div>
        </div>
      ))}
      {diff && <div className="l-card" data-testid="kn-diff"><strong>So sánh bản {diff.a} → bản {diff.b}</strong>{(diff.diff as any[]).map((l, i) => <div key={i} className="small" style={{ color: l.type === "add" ? "#3aa76d" : l.type === "del" ? "#d9534f" : "inherit" }}>{l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}{l.text}</div>)}</div>}
      {canWrite && it.status !== "ARCHIVED" && it.status !== "SUPERSEDED" && (
        <ReviseBox id={id} toast={toast} onDone={() => { void load(); onChanged(); }} />
      )}
      <h4 style={{ margin: "12px 0 4px" }}>Việc đã dùng mục này</h4>
      {(d.used_by as any[]).length === 0 ? <p className="small muted" data-testid="kn-unused">Chưa có việc nào nạp mục này.</p> : (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid="kn-usedby">{(d.used_by as any[]).map((u, i) => <li key={i}>bản {u.version}: {u.task_code} (lượt {u.attempt_no}) {u.task_title}{it.approved_version && u.version < it.approved_version ? " · quy tắc đã đổi sau khi việc này chạy" : ""}</li>)}</ul>
      )}
      {(d.reads as any[]).length > 0 && <details style={{ marginTop: 8 }}><summary className="small">Nhật ký đọc của bot ({(d.reads as any[]).length})</summary><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(d.reads as any[]).map((r, i) => <li key={i}>{r.slug} · bản {r.version} · {r.via} · {fmtFull(r.at)}</li>)}</ul></details>}
      {isOwner && it.status === "ACTIVE" && (
        <div className="l-row" style={{ gap: 6, marginTop: 10 }}>
          <input className="l-input" style={{ width: 240 }} placeholder="Lý do lưu trữ" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="kn-archive-reason" />
          <button className="l-btn sm danger" onClick={() => void act("archive", { reason }, "Đã lưu trữ (không xóa; liên kết cũ vẫn mở được).")} data-testid="kn-archive">Lưu trữ</button>
        </div>
      )}
    </section>
  );
}

function ReviseBox({ id, onDone, toast }: { id: string; onDone: () => void; toast: (m: string) => void }) {
  const [open, setOpen] = useState(false); const [content, setContent] = useState(""); const [why, setWhy] = useState("");
  if (!open) return <div style={{ marginTop: 8 }}><button className="l-btn sm" onClick={() => setOpen(true)} data-testid="kn-revise-open">Sửa (tạo phiên bản mới)</button></div>;
  return (
    <form className="l-grid" style={{ gap: 6, marginTop: 8 }} data-testid="kn-revise-form" onSubmit={async (e) => {
      e.preventDefault();
      const r = await lumiApi(`/api/v1/lumi/knowledge/${id}/revise`, { method: "POST", body: { content, reason: why || undefined } });
      toast(r.ok ? "Đã tạo phiên bản mới (chờ duyệt; bản cũ vẫn áp dụng cho tới khi duyệt)." : `Không thực hiện được: ${errText(r.error)}`);
      if (r.ok) { setOpen(false); setContent(""); setWhy(""); onDone(); }
    }}>
      <textarea className="l-textarea" rows={3} placeholder="Nội dung mới" value={content} onChange={(e) => setContent(e.target.value)} required minLength={3} data-testid="kn-revise-content" />
      <input className="l-input" placeholder="Lý do sửa" value={why} onChange={(e) => setWhy(e.target.value)} />
      <div className="l-row" style={{ gap: 6 }}><button className="l-btn sm primary" data-testid="kn-revise-submit">Tạo phiên bản mới</button><button type="button" className="l-btn sm" onClick={() => setOpen(false)}>Hủy</button></div>
    </form>
  );
}
