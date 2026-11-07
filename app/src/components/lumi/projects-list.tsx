"use client";

import { approvalsHref, pendingBreakdown, pendingCounts, projectSummary } from "@/lib/lumi/selectors";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Avatar } from "./avatar";
import { ProjectModal } from "./dashboard-forms";
import { useLumi } from "./lumi-provider";
import { LumiLink } from "./ui";

export function ProjectsList() {
  const { state } = useLumi();
  const [adding, setAdding] = useState(false);
  const canAdd = state.mode !== "db" || state.real?.role === "OWNER";
  return (
    <div className="l-grid" style={{ gap: 16 }}>
      <div className="l-row" style={{ justifyContent: "space-between" }}>
        <h1>Dự án</h1>
        {canAdd && <button className="l-btn primary" onClick={() => setAdding(true)} data-testid="project-new"><Plus size={15} /> Dự án mới</button>}
      </div>
      <ProjectModal open={adding} onClose={() => setAdding(false)} />
      {state.projects.filter((p) => p.status === "active").length === 0 && <p className="muted" data-testid="projects-empty">Chưa có dự án nào.{canAdd ? " Bấm «Dự án mới» để tạo." : ""}</p>}
      <div className="l-grid cols2">
        {state.projects.filter((p) => p.status === "active").map((p) => {
          const s = projectSummary(state, p.id);
          const c = pendingCounts(state, p.id);
          const firstTab = c.output ? "output" : c.memory ? "memory" : "action";
          return (
            <article key={p.id} className="l-card" data-project={p.id}>
              <div className="l-row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                <LumiLink href={`/lumi/projects/${p.id}`} style={{ minWidth: 0 }}><h2 className="l-clamp2">{p.name}</h2></LumiLink>
                <span className="l-badge blue">{p.area}</span>
              </div>
              <p className="muted small" style={{ margin: "6px 0" }}>{p.goal}</p>
              {s.decision && <div className="small"><strong>Đã quyết:</strong> {s.decision.text}</div>}
              <div className="small"><strong>Việc tiếp theo:</strong> {s.next ? s.next.title : "Không còn việc mở"}</div>
              <div className="l-row" style={{ marginTop: 10, justifyContent: "space-between" }}>
                <div className="l-row" style={{ gap: 4 }}>
                  {s.members.map((m) => <Avatar key={m.id} avatar={m.avatar} size={26} label={m.name} />)}
                </div>
                <LumiLink href={`/lumi/projects/${p.id}`} className="small muted">{s.open} việc mở</LumiLink>
              </div>
              <div className="l-row" style={{ marginTop: 10, gap: 4 }} data-testid="project-pending">
                <span className="small muted">Chờ duyệt:</span>
                <LumiLink href={approvalsHref(firstTab, p.id)} className="l-chiplink amber" title={pendingBreakdown(c)}>{c.total} mục</LumiLink>
                <span className="small muted">gồm</span>
                <LumiLink href={approvalsHref("output", p.id)} className="l-chiplink">{c.output} đầu ra</LumiLink>
                <LumiLink href={approvalsHref("memory", p.id)} className="l-chiplink">{c.memory} ghi nhớ</LumiLink>
                <LumiLink href={approvalsHref("action", p.id)} className="l-chiplink">{c.action} hành động</LumiLink>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
