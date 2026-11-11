"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- change-proposal rows are rendered field by field */

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import { outputOfTask, ownerLabel, pendingBreakdown, pendingCounts, project, SCOPE_LABEL } from "@/lib/lumi/selectors";
import type { Memory, MemoryScope } from "@/lib/lumi/types";
import { errText, lumiApi } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtTime, LumiLink, NewOutputBadge } from "./ui";

type Tab = "memory" | "output" | "action" | "plan" | "change" | "kmeet";

export function ApprovalsView() {
  const { state } = useLumi();
  const sp = useSearchParams();
  const initial = (["memory", "output", "action", "plan", "change", "kmeet"] as const).find((t) => t === sp.get("tab")) ?? "memory";
  const [tab, setTab] = useState<Tab>(initial);
  const [pid, setPid] = useState(sp.get("project") ?? "");
  const focusId = sp.get("id");
  const all = pendingCounts(state);
  const c = pendingCounts(state, pid || undefined);
  const pname = pid ? project(state, pid)?.name : undefined;

  return (
    <div className="l-grid" style={{ gap: 16 }}>
      <div>
        <h1>Chờ duyệt</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Ba loại phê duyệt tách riêng: ghi nhớ, đầu ra công việc và hành động bên ngoài. Duyệt loại này không tự duyệt loại khác.
        </p>
        <p style={{ margin: "6px 0 0" }} data-testid="approvals-total">
          <strong>Tổng toàn bộ: {all.total + (state.real?.plansPending?.length ?? 0)} mục</strong> <span className="muted">({all.memory} ghi nhớ + {all.output} đầu ra + {all.action} hành động bên ngoài{state.real?.plansPending ? ` + ${state.real.plansPending.length} kế hoạch` : ""})</span>
        </p>
      </div>
      <div className="l-row">
        <label className="l-row small muted" style={{ gap: 6 }}>
          Lọc theo dự án
          <select className="l-select" style={{ width: "auto", minHeight: 32, padding: "3px 8px" }} value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Lọc theo dự án">
            <option value="">Tất cả dự án</option>
            {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {pid && <span className="l-badge amber" data-testid="approvals-filter" title={pendingBreakdown(c)}>Đang lọc: {pname} · {c.total} mục</span>}
      </div>
      <div className="l-tabs" role="tablist" aria-label="Loại phê duyệt">
        <button role="tab" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>Ghi nhớ ({c.memory})</button>
        <button role="tab" aria-selected={tab === "output"} onClick={() => setTab("output")}>Đầu ra công việc ({c.output})</button>
        <button role="tab" aria-selected={tab === "action"} onClick={() => setTab("action")}>Hành động bên ngoài ({c.action})</button>
        {state.real && <button role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")} data-testid="tab-plan-btn">Kế hoạch ({state.real.plansPending?.length ?? 0})</button>}
        {state.real && <button role="tab" aria-selected={tab === "change"} onClick={() => setTab("change")} data-testid="tab-change-btn">Thay đổi do PM đề xuất</button>}
        {state.real && <button role="tab" aria-selected={tab === "kmeet"} onClick={() => setTab("kmeet")} data-testid="tab-kmeet-btn">Kiến thức &amp; họp</button>}
      </div>
      {tab === "memory" && <MemoryTab focusId={focusId} pid={pid} />}
      {tab === "output" && <OutputTab pid={pid} />}
      {tab === "action" && <ActionTab focusId={focusId} pid={pid} />}
      {tab === "plan" && <PlanTab />}
      {tab === "change" && <ChangeTab />}
      {tab === "kmeet" && <KnowledgeMeetingTab />}
    </div>
  );
}

const CHANGE_STATE: Record<string, string> = { PENDING: "Chờ Chủ quyết định", APPROVED: "Đã duyệt", REJECTED: "Đã từ chối", APPLIED: "Đã áp dụng", FAILED: "Duyệt nhưng không áp dụng được" };

/** IMP-03 (OFC-05): a PM bot only PROPOSES (reassign a task); the owner decides here. Nothing changes until then, unless the owner turned automatic application on for that project. */
function ChangeTab() {
  const { state, toast } = useLumi();
  const [list, setList] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isOwner = state.real?.role === "OWNER";
  const load = useCallback(async () => {
    const r = await lumiApi("/api/v1/lumi/changes");
    if (r.ok) { setList(r.data.proposals); setErr(null); } else setErr(errText(r.error));
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000); return () => clearInterval(t); }, [load]);
  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    const r = await lumiApi(`/api/v1/lumi/changes/${id}`, { method: "POST", body: { decision } });
    toast(r.ok ? (decision === "APPROVE" ? "Đã duyệt đề xuất." : "Đã từ chối đề xuất.") : `Không thực hiện được: ${errText(r.error)}`);
    void load();
  }
  const pending = (list ?? []).filter((c) => c.state === "PENDING");
  const done = (list ?? []).filter((c) => c.state !== "PENDING");
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="tab-change">
      <div className="l-note">PM bot chỉ <strong>đề xuất</strong> đổi người nhận việc. Không có thay đổi nào có hiệu lực trước khi bạn duyệt (trừ khi bạn đã bật «PM tự áp dụng» cho dự án đó).</div>
      {err && <div className="l-note" role="alert">Không tải được: {err}</div>}
      {list !== null && pending.length === 0 && <Empty>Không có đề xuất thay đổi nào đang chờ.</Empty>}
      {pending.map((c) => (
        <div key={c.id} className="l-card" data-testid={`change-${c.task_code}`}>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}><strong>Đổi người nhận {c.task_code}: {c.task_title}</strong><span className="l-badge amber">{CHANGE_STATE[c.state]}</span></div>
          <div className="small">Dự án {c.project_name} · {c.proposed_by} đề xuất giao cho <strong>{c.to_name}</strong> · {fmtTime(c.created_at)}</div>
          <div className="small muted">Lý do: {c.reason}</div>
          {isOwner ? (
            <div className="l-row" style={{ gap: 6, marginTop: 8 }}>
              <button className="l-btn sm primary" onClick={() => void decide(c.id, "APPROVE")} data-testid={`change-approve-${c.task_code}`}>Duyệt và áp dụng</button>
              <button className="l-btn sm danger" onClick={() => void decide(c.id, "REJECT")} data-testid={`change-reject-${c.task_code}`}>Từ chối</button>
            </div>
          ) : <div className="small muted" style={{ marginTop: 6 }}>Chỉ OWNER quyết định.</div>}
        </div>
      ))}
      {done.length > 0 && (
        <details>
          <summary className="small">Đã xử lý ({done.length})</summary>
          {done.map((c) => <div key={c.id} className="small" style={{ marginTop: 4 }} data-testid={`change-done-${c.task_code}`}>{c.task_code} → {c.to_name}: <strong>{CHANGE_STATE[c.state] ?? c.state}</strong>{c.result ? ` · ${c.result}` : ""}</div>)}
        </details>
      )}
    </div>
  );
}

/** IMP-04: knowledge proposals waiting for the owner (approve on the Knowledge screen, where the sources are next to the text) and meeting proposals that need the owner. */
function KnowledgeMeetingTab() {
  const { state, toast } = useLumi();
  const isOwner = state.real?.role === "OWNER";
  const [kn, setKn] = useState<any[] | null>(null); const [mt, setMt] = useState<any[] | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const a = await lumiApi("/api/v1/lumi/knowledge/search", { method: "POST", body: { status: "PROPOSED" } });
    const b = await lumiApi("/api/v1/lumi/meetings");
    if (a.ok) setKn(a.data.items); else setErr(errText(a.error));
    if (b.ok) setMt(b.data.proposals);
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 6000); return () => clearInterval(t); }, [load]);
  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    const r = await lumiApi(`/api/v1/lumi/meeting-conclusions/${id}`, { method: "POST", body: { decision } });
    toast(r.ok ? (decision === "APPROVE" ? "Đã ghi nhận đồng ý (thay đổi thật phải làm riêng)." : "Đã từ chối.") : `Không thực hiện được: ${errText(r.error)}`);
    void load();
  }
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="tab-kmeet">
      {err && <div className="l-note" role="alert">Không tải được: {err}</div>}
      <h3 style={{ margin: "0 0 2px" }}>Kiến thức chờ duyệt ({kn?.length ?? 0})</h3>
      {kn && kn.length === 0 && <Empty>Không có đề xuất kiến thức nào đang chờ.</Empty>}
      {(kn ?? []).map((k) => (
        <div key={k.id} className="l-card" data-testid={`pending-kn-${k.code}`}>
          <strong>{k.code}</strong> · {k.title} <span className="muted small">({k.scope}, đề xuất bởi {k.proposed_by})</span>
          <div className="small muted">{(k.sources as any[]).length} nguồn · bản {k.version}</div>
          <div style={{ marginTop: 6 }}><LumiLink href="/lumi/knowledge" className="l-btn primary sm">Xem nguồn và duyệt</LumiLink></div>
        </div>
      ))}
      <h3 style={{ margin: "8px 0 2px" }}>Đề xuất từ cuộc họp ({mt?.length ?? 0})</h3>
      {mt && mt.length === 0 && <Empty>Không có đề xuất từ cuộc họp nào đang chờ.</Empty>}
      {(mt ?? []).map((c) => (
        <div key={c.id} className="l-card" data-testid={`pending-mc-${c.type}`}>
          <strong>{c.type}</strong> · {c.text} <span className="muted small">({c.meeting_code}: {c.meeting_title})</span>
          <div className="small muted">{c.reason}</div>
          {isOwner ? <div className="l-row" style={{ gap: 6, marginTop: 6 }}><button className="l-btn sm primary" onClick={() => void decide(c.id, "APPROVE")} data-testid={`pending-mc-approve-${c.type}`}>Đồng ý ghi nhận</button><button className="l-btn sm danger" onClick={() => void decide(c.id, "REJECT")}>Từ chối</button></div> : <div className="small muted">Chỉ OWNER quyết định.</div>}
        </div>
      ))}
    </div>
  );
}

function PlanTab() {
  const { state } = useLumi();
  const list = state.real?.plansPending ?? [];
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="tab-plan">
      {list.length === 0 && <Empty>Không có phiên bản kế hoạch nào đang chờ duyệt.</Empty>}
      {list.map((p) => (
        <div key={`${p.planId}:${p.version}`} className="l-card" data-testid={`pending-plan-${p.code}`}>
          <strong>{p.code} · phiên bản {p.version}</strong> <span className="muted">— {p.goalTitle}</span>
          <div className="small muted">Nộp {fmtTime(p.submittedAt)}. Duyệt theo hai bước: xem nội dung và phạm vi, rồi xác nhận.</div>
          <div style={{ marginTop: 8 }}><LumiLink href={`/lumi/plans/${p.planId}`} className="l-btn primary sm">Xem và duyệt</LumiLink></div>
        </div>
      ))}
    </div>
  );
}

function MemoryTab({ focusId, pid }: { focusId: string | null; pid: string }) {
  const { state } = useLumi();
  const list = state.memories.filter((m) => m.status === "proposed" && (!pid || m.projectId === pid));
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="tab-memory">
      {list.length === 0 && <Empty>Không có đề xuất ghi nhớ nào đang chờ{pid ? " trong dự án này" : ""}.</Empty>}
      {list.map((m) => <MemoryCard key={m.id} m={m} focus={focusId === m.id} />)}
    </div>
  );
}

function MemoryCard({ m, focus }: { m: Memory; focus: boolean }) {
  const { state, dispatch, toast } = useLumi();
  const proj = m.projectId ? project(state, m.projectId) : undefined;
  const [text, setText] = useState(m.content);
  const [scope, setScope] = useState<MemoryScope>(m.projectId ? "project" : "personal");
  const [busy, setBusy] = useState(false);
  const by = state.members.find((x) => x.id === m.proposedBy);
  const src = m.sourceMemoryId ? state.memories.find((x) => x.id === m.sourceMemoryId) : undefined;

  const decide = async (decision: "accept" | "reject") => {
    if (busy) return;
    setBusy(true);
    const r = await dispatch({ type: "memory.review", id: m.id, decision, text, scope });
    setBusy(false);
    if (r.ok && r.code !== "already") toast(decision === "accept" ? `Đã lưu ghi nhớ · ${SCOPE_LABEL[scope]}${scope === "project" && proj ? ` (${proj.name})` : ""}.` : "Đã bỏ đề xuất.");
  };

  return (
    <article className="l-card" style={focus ? { borderColor: "var(--l-accent)" } : undefined} data-memory-proposal={m.id}>
      <div className="l-row" style={{ gap: 6 }}>
        <span className="l-badge purple">Quy tắc đề xuất</span>
        <span className="l-badge">{proj ? proj.name : "Cá nhân"}</span>
        <span className="small muted">{by ? `${by.name} · ` : ""}{fmtTime(m.at)}</span>
      </div>
      <h2 style={{ margin: "8px 0 4px" }}>{m.text}</h2>
      <div className="small muted"><strong>Lý do:</strong> {m.reason}</div>
      {src && (
        <div className="small" style={{ marginTop: 6 }} data-testid="source-decision">
          <strong>Rút ra từ quyết định:</strong>{" "}
          <LumiLink href={`/lumi/memory?id=${src.id}`} className="l-chiplink">{src.text}</LumiLink>
        </div>
      )}
      <label className="l-label" htmlFor={`mc-${m.id}`}>Nội dung ghi nhớ (sửa được)</label>
      <textarea id={`mc-${m.id}`} className="l-textarea" value={text} onChange={(e) => setText(e.target.value)} />
      <fieldset style={{ border: 0, padding: 0, margin: "10px 0 0" }}>
        <legend className="l-label" style={{ margin: 0 }}>Phạm vi áp dụng</legend>
        {(["project", "area", "personal"] as const).map((s) => (
          <label key={s} className="l-row" style={{ gap: 8, margin: "6px 0", opacity: s === "project" && !m.projectId ? 0.45 : 1 }}>
            <input type="radio" name={`scope-${m.id}`} checked={scope === s} disabled={s === "project" && !m.projectId} onChange={() => setScope(s)} />
            <span>
              <strong>{SCOPE_LABEL[s]}</strong>
              {s === "project" && <span className="muted small"> {proj ? `· chỉ trong «${proj.name}»` : ""}{" (mặc định)"}</span>}
              {s === "area" && <span className="muted small"> · {proj ? `mọi dự án thuộc mảng «${proj.area}»` : "mọi dự án cùng mảng"}</span>}
              {s === "personal" && <span className="muted small"> · áp dụng cho tất cả dự án</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="l-row" style={{ marginTop: 10 }}>
        <button className="l-btn good" disabled={busy || !text.trim()} onClick={() => decide("accept")}><Check size={15} /> Duyệt và lưu</button>
        <button className="l-btn danger" disabled={busy} onClick={() => decide("reject")}><X size={15} /> Bỏ</button>
        <LumiLink href={`/lumi/memory?id=${m.id}`} className="small muted" style={{ marginLeft: "auto" }}>Xem nguồn và việc liên quan</LumiLink>
      </div>
    </article>
  );
}

function OutputTab({ pid }: { pid: string }) {
  const { state } = useLumi();
  const list = state.tasks.filter((t) => t.status === "review" && (!pid || t.projectId === pid));
  return (
    <div className="l-grid" style={{ gap: 10 }} data-testid="tab-output">
      {list.length === 0 && <Empty>Không có đầu ra nào chờ duyệt{pid ? " trong dự án này" : ""}.</Empty>}
      {list.map((t) => (
        <LumiLink key={t.id} href={`/lumi/projects/${t.projectId}?task=${t.id}&v=${outputOfTask(state, t)?.versions.length ?? 1}`} className="l-card click">
          <div className="l-row" style={{ justifyContent: "space-between" }}>
            <strong className="l-clamp2" title={t.title}>{t.title}</strong>
            <span className="l-row" style={{ gap: 6 }}><NewOutputBadge /><span className="l-badge amber">Chờ duyệt</span></span>
          </div>
          <div className="small muted">{project(state, t.projectId)?.name} · {ownerLabel(state, t)} · {t.source.label} · {fmtTime(t.updatedAt)}</div>
          <div className="small" style={{ marginTop: 4 }}>Mở để đọc, góp ý, yêu cầu sửa hoặc duyệt nội dung. Duyệt đầu ra không bật chiến dịch hay đăng bài.</div>
        </LumiLink>
      ))}
    </div>
  );
}

function ActionTab({ focusId, pid }: { focusId: string | null; pid: string }) {
  const { state, dispatch } = useLumi();
  const [busy, setBusy] = useState(false);
  const list = state.actions.filter((a) => !pid || a.projectId === pid).sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1));
  const act = async (id: string, decision: "approve" | "reject") => {
    if (busy) return;
    setBusy(true);
    await dispatch({ type: "action.review", id, decision });
    setBusy(false);
  };
  return (
    <div className="l-grid" style={{ gap: 10 }} data-testid="tab-action">
      <div className="l-note">Bản preview: duyệt ở đây chỉ ghi lại quyết định mô phỏng. Không có chiến dịch, ngân sách hay video thật nào bị thay đổi.</div>
      {list.length === 0 && <Empty>Không có yêu cầu hành động.</Empty>}
      {list.map((a) => (
        <article key={a.id} className="l-card" style={focusId === a.id ? { borderColor: "var(--l-accent)" } : undefined}>
          <div className="l-row" style={{ justifyContent: "space-between" }}>
            <strong>{a.title}</strong>
            <span className={`l-badge ${a.status === "pending" ? "amber" : a.status === "approved" ? "green" : "red"}`}>{a.status === "pending" ? "Chờ duyệt" : a.status === "approved" ? "Đã duyệt (mô phỏng)" : "Đã từ chối"}</span>
          </div>
          <div className="small muted">{project(state, a.projectId)?.name} · yêu cầu bởi {state.members.find((m) => m.id === a.requestedBy)?.name ?? "trợ lý"} · {fmtTime(a.at)}</div>
          <p className="small" style={{ margin: "6px 0" }}>{a.detail}</p>
          {a.status === "pending" && (
            <div className="l-row">
              <button className="l-btn good" disabled={busy} onClick={() => act(a.id, "approve")}><Check size={15} /> Duyệt hành động (mô phỏng)</button>
              <button className="l-btn danger" disabled={busy} onClick={() => act(a.id, "reject")}><X size={15} /> Từ chối</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
