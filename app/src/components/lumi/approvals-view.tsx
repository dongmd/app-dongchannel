"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Check, X } from "lucide-react";

import { outputOfTask, ownerLabel, pendingBreakdown, pendingCounts, project, SCOPE_LABEL } from "@/lib/lumi/selectors";
import type { Memory, MemoryScope } from "@/lib/lumi/types";
import { useLumi } from "./lumi-provider";
import { Empty, fmtTime, LumiLink } from "./ui";

type Tab = "memory" | "output" | "action" | "plan";

export function ApprovalsView() {
  const { state } = useLumi();
  const sp = useSearchParams();
  const initial = (["memory", "output", "action", "plan"] as const).find((t) => t === sp.get("tab")) ?? "memory";
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
      </div>
      {tab === "memory" && <MemoryTab focusId={focusId} pid={pid} />}
      {tab === "output" && <OutputTab pid={pid} />}
      {tab === "action" && <ActionTab focusId={focusId} pid={pid} />}
      {tab === "plan" && <PlanTab />}
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
            <span className="l-badge amber">Chờ duyệt</span>
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
