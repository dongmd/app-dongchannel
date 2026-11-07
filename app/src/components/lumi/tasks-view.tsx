"use client";

import { useMemo, useState } from "react";
import { ListChecks } from "lucide-react";

import { STATUS_LABEL } from "@/lib/lumi/selectors";
import { TASK_STATUS_LABEL } from "@/lib/lumi/plans-client";
import { filterTasks, statusCounts, type TaskFilter } from "@/lib/lumi/task-filter";
import { TASK_STATUSES, type TaskStatus } from "@/lib/lumi/types";
import { useLumi } from "./lumi-provider";
import { Empty, fmtTime, LumiLink, NewOutputBadge, SourceBadge, StatusBadge } from "./ui";

/** PRJ-06: tasks across projects. Same state and same selectors as the Dashboard, so the counts of one scope agree. */
export function TasksView() {
  const { state } = useLumi();
  const [f, setF] = useState<TaskFilter>({ status: "all" });
  const set = (p: Partial<TaskFilter>) => setF((x) => ({ ...x, ...p }));
  const nowMs = Date.now();
  const scope = useMemo(() => filterTasks(state, { projectId: f.projectId, ownerId: f.ownerId }, nowMs), [state, f.projectId, f.ownerId, nowMs]);
  const list = useMemo(() => filterTasks(state, f, nowMs), [state, f, nowMs]);
  const c = statusCounts(scope);
  const realStatuses = Array.from(new Set(state.tasks.map((t) => t.real?.status).filter((x): x is string => !!x))).sort();
  const people = state.members.filter((m) => m.kind === "bot" || m.kind === "human");
  const pname = (id: string) => state.projects.find((p) => p.id === id)?.name ?? "Dự án đã xóa";
  const filtered = f.projectId || f.ownerId || (f.status && f.status !== "all") || f.realStatus || f.source || f.due || f.q;

  return (
    <div className="l-grid" style={{ gap: 14 }} data-testid="tasks-view">
      <div>
        <h1 className="l-row" style={{ gap: 8 }}><ListChecks size={22} /> Việc xuyên dự án</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Mọi việc của mọi dự án trong một danh sách. Số đếm dùng cùng nguồn với Dashboard: cùng phạm vi thì cùng con số.</p>
      </div>
      <div className="l-card" data-testid="task-filters">
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="l-label" style={{ flex: 2, minWidth: 200 }}>Tìm theo từ khóa<input className="l-input" value={f.q ?? ""} onChange={(e) => set({ q: e.target.value })} placeholder="mã, tiêu đề, yêu cầu, người nhận…" data-testid="tf-q" /></label>
          <label className="l-label" style={{ flex: 1, minWidth: 150 }}>Dự án
            <select className="l-select" value={f.projectId ?? ""} onChange={(e) => set({ projectId: e.target.value || undefined })} data-testid="tf-project"><option value="">Tất cả</option>{state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="l-label" style={{ flex: 1, minWidth: 150 }}>Người nhận
            <select className="l-select" value={f.ownerId ?? ""} onChange={(e) => set({ ownerId: e.target.value || undefined })} data-testid="tf-owner"><option value="">Tất cả</option>{people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label className="l-label" style={{ flex: 1, minWidth: 130 }}>Trạng thái
            <select className="l-select" value={f.status ?? "all"} onChange={(e) => set({ status: e.target.value as TaskFilter["status"] })} data-testid="tf-status"><option value="all">Tất cả</option><option value="open">Đang mở (như Dashboard)</option>{TASK_STATUSES.map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}</select></label>
          {realStatuses.length > 0 && (
            <label className="l-label" style={{ flex: 1, minWidth: 150 }}>Trạng thái thật
              <select className="l-select" value={f.realStatus ?? ""} onChange={(e) => set({ realStatus: e.target.value || undefined })} data-testid="tf-real"><option value="">Tất cả</option>{realStatuses.map((k) => <option key={k} value={k}>{TASK_STATUS_LABEL[k] ?? k}</option>)}</select></label>
          )}
          <label className="l-label" style={{ flex: 1, minWidth: 120 }}>Nguồn
            <select className="l-select" value={f.source ?? ""} onChange={(e) => set({ source: (e.target.value || undefined) as TaskFilter["source"] })} data-testid="tf-source"><option value="">Tất cả</option><option value="web">Web</option><option value="telegram">Telegram</option></select></label>
          <label className="l-label" style={{ flex: 1, minWidth: 120 }}>Hạn
            <select className="l-select" value={f.due ?? ""} onChange={(e) => set({ due: (e.target.value || undefined) as TaskFilter["due"] })} data-testid="tf-due"><option value="">Tất cả</option><option value="overdue">Quá hạn</option><option value="has">Có hạn</option><option value="none">Chưa có hạn</option></select></label>
        </div>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }} data-testid="task-counts">
          <strong data-testid="tf-shown">{list.length}</strong><span className="small muted">/ {state.tasks.length} việc</span>
          <span className="small muted">· trong phạm vi dự án/người nhận đã chọn:</span>
          {TASK_STATUSES.map((k) => <span key={k} className="l-badge" data-testid={`tc-${k}`}>{STATUS_LABEL[k as TaskStatus]} {c[k]}</span>)}
          {filtered ? <button className="l-btn sm" onClick={() => setF({ status: "all" })} data-testid="tf-clear">Xóa lọc</button> : null}
        </div>
      </div>
      {list.length === 0 ? <Empty>{state.tasks.length === 0 ? "Chưa có việc nào." : "Không có việc nào khớp bộ lọc."}</Empty> : (
        <div className="l-grid" style={{ gap: 8 }} data-testid="task-list">
          {list.map((t) => (
            <LumiLink key={t.id} href={`/lumi/projects/${t.projectId}?task=${t.id}`} className="l-card click" data-testid={`task-row-${t.id}`}>
              <div className="l-row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
                <div><strong>{t.id}</strong> · {t.title}</div>
                <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}><StatusBadge status={t.status} />{t.status === "review" && <NewOutputBadge />}{t.real ? <span className="l-badge">{TASK_STATUS_LABEL[t.real.status] ?? t.real.status}</span> : null}<SourceBadge task={t} /></div>
              </div>
              <div className="small muted">{pname(t.projectId)} · {t.ownerName}{t.due ? ` · hạn ${fmtTime(t.due)}` : ""} · cập nhật {fmtTime(t.updatedAt)}</div>
            </LumiLink>
          ))}
        </div>
      )}
    </div>
  );
}
