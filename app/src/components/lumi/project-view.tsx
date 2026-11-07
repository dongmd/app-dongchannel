"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Gavel, User2 } from "lucide-react";

import { canReceiveTasks } from "@/lib/lumi/engine";
import { activeRulesFor, approvalsHref, ownerLabel, pendingBreakdown, pendingCounts, projectSummary, SCOPE_LABEL, STATUS_LABEL } from "@/lib/lumi/selectors";
import { TASK_STATUSES, type Task } from "@/lib/lumi/types";
import { Avatar } from "./avatar";
import { useLumi } from "./lumi-provider";
import { TaskDrawer } from "./task-drawer";
import { Empty, fmtTime, LumiLink, SourceBadge } from "./ui";

export function ProjectView({ id }: { id: string }) {
  const { state, dispatch, toast } = useLumi();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const taskId = sp.get("task");
  const [tab, setTab] = useState<"kanban" | "rules" | "team">("kanban");
  const proj = state.projects.find((p) => p.id === id);
  const [title, setTitle] = useState("");
  const [more, setMore] = useState(false);
  const [request, setRequest] = useState("");
  const [outputWanted, setOutputWanted] = useState("");
  const [due, setDue] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [reqId, setReqId] = useState(() => crypto.randomUUID());

  if (!proj) return <Empty>Không thấy dự án này. <LumiLink href="/lumi/projects"><u>Về danh sách dự án</u></LumiLink></Empty>;
  const sum = projectSummary(state, id);
  const counts = pendingCounts(state, id);
  const candidates = state.members.filter((m) => canReceiveTasks(m, id));
  const defaultOwner = candidates.find((m) => m.kind === "bot")?.id ?? candidates[0]?.id ?? "";
  const effOwner = candidates.some((m) => m.id === ownerId) ? ownerId : defaultOwner;
  const recipient = candidates.find((m) => m.id === effOwner);
  const rules = activeRulesFor(state, id);
  const tasks = state.tasks.filter((t) => t.projectId === id);

  const openTask = (t: string) => router.replace(`${pathname}?task=${t}` as Route, { scroll: false });
  const closeTask = () => router.replace(pathname as Route, { scroll: false });

  async function give(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    const r = await dispatch({ type: "task.create", projectId: id, title, request, outputWanted, ...(due ? { due } : {}), ownerId: effOwner, via: "web", clientRequestId: reqId });
    setBusy(false);
    if (r.ok) {
      toast(`Đã tạo việc ${r.taskId}${recipient?.kind === "bot" && recipient.hermes === "none" ? " · Chờ kết nối trợ lý" : ""}.`);
      setTitle("");
      setRequest("");
      setOutputWanted("");
      setDue("");
      setReqId(crypto.randomUUID());
      if (r.taskId) openTask(r.taskId);
    }
  }

  return (
    <div className="l-grid" style={{ gap: 16 }}>
      <div>
        <div className="l-row" style={{ gap: 8 }}>
          <h1>{proj.name}</h1>
          <span className="l-badge blue">{proj.area}</span>
        </div>
        <p className="muted" style={{ margin: "4px 0 0", maxWidth: 820 }}>{proj.goal}</p>
      </div>

      {/* Trong khoảng 10 giây: đã quyết gì và vì sao, việc tiếp theo, ai phụ trách, đầu ra cần duyệt. */}
      <section aria-label="Tóm tắt dự án" className="l-summary" data-testid="project-summary">
        <div className="l-card">
          <div className="l-row small muted"><Gavel size={14} /> Lần trước đã quyết</div>
          {sum.decision ? (
            <>
              <div style={{ fontWeight: 650, margin: "4px 0" }}>{sum.decision.text}</div>
              <div className="small muted"><strong>Vì sao:</strong> {sum.decision.reason.length > 150 ? `${sum.decision.reason.slice(0, 147)}…` : sum.decision.reason}</div>
              <LumiLink href={`/lumi/memory?id=${sum.decision.id}`} className="small" style={{ color: "var(--l-accent)" }}>Xem lý do và nguồn <ArrowRight size={12} style={{ display: "inline" }} /></LumiLink>
            </>
          ) : (
            <Empty>Chưa có quyết định nào.</Empty>
          )}
        </div>
        <div className="l-card">
          <div className="l-row small muted"><ArrowRight size={14} /> Việc tiếp theo</div>
          {sum.next ? (
            <>
              <div style={{ fontWeight: 650, margin: "4px 0" }}>{sum.next.title}</div>
              <div className="small muted">{STATUS_LABEL[sum.next.status]}{sum.next.waitingConnection ? " · Chờ kết nối trợ lý" : ""}</div>
              <button className="l-btn sm" style={{ marginTop: 8 }} onClick={() => openTask(sum.next!.id)}>Mở việc {sum.next.id}</button>
            </>
          ) : (
            <Empty>Không còn việc mở.</Empty>
          )}
        </div>
        <div className="l-card">
          <div className="l-row small muted"><User2 size={14} /> Ai phụ trách</div>
          <div className="l-row" style={{ margin: "6px 0" }}>
            {sum.next ? (
              <>
                <Avatar avatar={state.members.find((m) => m.id === sum.next!.ownerId)?.avatar ?? "bot"} size={30} />
                <div>
                  <div style={{ fontWeight: 650, lineHeight: 1.2 }}>{ownerLabel(state, sum.next)}</div>
                  <div className="small muted">phụ trách việc tiếp theo</div>
                </div>
              </>
            ) : <span className="muted">Chưa giao</span>}
          </div>
          <div className="small muted">PM dự án: <strong style={{ color: "var(--l-text)" }}>{sum.pm?.name ?? "Chưa có"}</strong></div>
        </div>
        <div className="l-card" data-testid="pending-card">
          <div className="l-row small muted" style={{ justifyContent: "space-between" }}>
            <span className="l-row" style={{ gap: 6 }}><AlertCircle size={14} /> Cần bạn duyệt</span>
            <LumiLink href={`/lumi/approvals?tab=${counts.output ? "output" : counts.memory ? "memory" : "action"}&project=${id}`} className="l-chiplink amber" title={pendingBreakdown(counts)} data-testid="pending-total">
              {counts.total} mục
            </LumiLink>
          </div>
          {counts.total === 0 ? (
            <div className="l-row" style={{ marginTop: 6, color: "var(--l-green)" }}><CheckCircle2 size={16} /> Không có gì chờ duyệt</div>
          ) : (
            <div style={{ marginTop: 6 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>Gồm ghi nhớ + đầu ra + hành động bên ngoài</div>
              {sum.review.map((t) => (
                <button key={t.id} className="l-btn sm wrap" style={{ display: "flex", width: "100%", marginBottom: 4 }} onClick={() => openTask(t.id)} title={t.title}>
                  <span className="l-clamp2">Đầu ra: {t.title}</span>
                </button>
              ))}
              <div className="l-row" style={{ gap: 4 }}>
                <LumiLink href={approvalsHref("output", id)} className="l-chiplink">{counts.output} đầu ra</LumiLink>
                <LumiLink href={approvalsHref("memory", id)} className="l-chiplink">{counts.memory} ghi nhớ</LumiLink>
                <LumiLink href={approvalsHref("action", id)} className="l-chiplink">{counts.action} hành động</LumiLink>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Ô giao việc: luôn hiện dự án và người nhận. */}
      <form className="l-card" onSubmit={give} aria-label="Giao việc" data-testid="composer">
        <div className="l-row" style={{ marginBottom: 8 }}>
          <span className="l-badge amber" data-testid="composer-project">Dự án: {proj.name}</span>
          <label className="l-row small muted" style={{ gap: 6 }}>
            Người nhận
            <select className="l-select" style={{ width: "auto", minHeight: 32, padding: "3px 8px" }} value={effOwner} onChange={(e) => setOwnerId(e.target.value)} aria-label="Người nhận" data-testid="composer-owner">
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>{m.kind === "human" ? `${m.name} (tôi tự nhận)` : m.name}</option>
              ))}
            </select>
          </label>
          {recipient?.kind === "bot" && recipient.hermes === "none" && <span className="l-badge amber">Chưa kết nối Hermes: việc sẽ chờ kết nối</span>}
        </div>
        <div className="l-row" style={{ flexWrap: "nowrap" }}>
          <input className="l-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Giao việc mới cho ${recipient?.name ?? "người nhận"} trong ${proj.name}…`} aria-label="Nội dung việc cần giao" />
          <button type="submit" className="l-btn primary" disabled={busy || !title.trim() || !effOwner}>Giao việc</button>
        </div>
        <button type="button" className="l-btn ghost sm" style={{ marginTop: 6 }} onClick={() => setMore((v) => !v)}>{more ? "Ẩn chi tiết" : "Thêm chi tiết (yêu cầu, đầu ra, hạn)"}</button>
        {more && (
          <div className="l-grid cols3" style={{ marginTop: 6 }}>
            <div style={{ gridColumn: "1 / -1" }}><textarea className="l-textarea" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Yêu cầu chi tiết" aria-label="Yêu cầu chi tiết" /></div>
            <input className="l-input" value={outputWanted} onChange={(e) => setOutputWanted(e.target.value)} placeholder="Đầu ra mong muốn" aria-label="Đầu ra mong muốn" />
            <input className="l-input" value={due} onChange={(e) => setDue(e.target.value)} placeholder="Hạn (nếu có)" aria-label="Hạn" />
          </div>
        )}
      </form>

      <div className="l-tabs" role="tablist" aria-label="Nội dung dự án">
        <button role="tab" aria-selected={tab === "kanban"} onClick={() => setTab("kanban")}>Bảng việc</button>
        <button role="tab" aria-selected={tab === "rules"} onClick={() => setTab("rules")}>Quy tắc áp dụng ({rules.length})</button>
        <button role="tab" aria-selected={tab === "team"} onClick={() => setTab("team")}>Thành viên ({sum.members.length})</button>
      </div>

      {tab === "kanban" && <Kanban tasks={tasks} onOpen={openTask} />}
      {tab === "rules" && (
        <div className="l-grid" style={{ gap: 10 }}>
          {rules.length === 0 && <Empty>Chưa có quy tắc nào áp dụng cho dự án này. Duyệt đề xuất ghi nhớ ở mục Chờ duyệt để thêm.</Empty>}
          {rules.map((r) => (
            <LumiLink key={r.id} href={`/lumi/memory?id=${r.id}`} className="l-card click">
              <div className="l-row" style={{ justifyContent: "space-between" }}>
                <strong>{r.text}</strong>
                <span className="l-badge purple">{SCOPE_LABEL[r.scope]}{r.scope === "area" && r.area ? ` · ${r.area}` : ""}</span>
              </div>
              <div className="muted small">{r.content}</div>
            </LumiLink>
          ))}
          <p className="small muted">Chỉ hiện quy tắc riêng của dự án này, quy tắc dùng chung cho mảng «{proj.area}» và quy tắc cá nhân. Quy tắc riêng của dự án khác không áp dụng ở đây.</p>
        </div>
      )}
      {tab === "team" && (
        <div className="l-grid cols3">
          {sum.members.map((m) => (
            <div key={m.id} className="l-card l-row">
              <Avatar avatar={m.avatar} size={38} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650 }}>{m.name}{sum.pm?.id === m.id ? " · PM" : ""}</div>
                <div className="small muted">{m.role}</div>
              </div>
              {m.permission !== "assistant" && sum.pm?.id !== m.id && (
                <button className="l-btn sm" onClick={() => dispatch({ type: "project.setPm", projectId: id, memberId: m.id })}>Đặt làm PM</button>
              )}
            </div>
          ))}
        </div>
      )}

      <TaskDrawer taskId={taskId} onClose={closeTask} />
    </div>
  );
}

function Kanban({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const { state } = useLumi();
  return (
    <div className="l-kanban" data-testid="kanban">
      {TASK_STATUSES.map((st) => {
        const col = tasks.filter((t) => t.status === st);
        return (
          <section className="l-col" key={st} aria-label={STATUS_LABEL[st]}>
            <h3>
              <span>{STATUS_LABEL[st]}</span>
              <span className="l-badge">{col.length}</span>
            </h3>
            {col.length === 0 && <div className="small muted" style={{ padding: "4px 2px" }}>Trống</div>}
            {col.map((t) => {
              const o = state.members.find((m) => m.id === t.ownerId);
              return (
                <button key={t.id} className="l-ticket" onClick={() => onOpen(t.id)} data-task={t.id}>
                  <div className="l-row small muted" style={{ justifyContent: "space-between" }}>
                    <span>{t.id}</span>
                    <span>{fmtTime(t.updatedAt)}</span>
                  </div>
                  <div className="t">{t.title}</div>
                  <div className="l-row" style={{ gap: 6 }}>
                    <Avatar avatar={o?.avatar ?? "bot"} size={22} />
                    <span className="small">{ownerLabel(state, t)}</span>
                  </div>
                  <div className="l-row" style={{ gap: 4, marginTop: 6 }}>
                    <SourceBadge task={t} />
                    {t.waitingConnection && <span className="l-badge amber">Chờ kết nối trợ lý</span>}
                    {t.status === "review" && <span className="l-badge amber">Cần duyệt</span>}
                  </div>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
