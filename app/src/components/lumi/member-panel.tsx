"use client";

import { useState } from "react";
import { Archive, ArchiveRestore, Pencil, Plug, Send } from "lucide-react";

import { memberOpenTasks, memberStates, ownerLabel } from "@/lib/lumi/selectors";
import { Avatar } from "./avatar";
import { useLumi } from "./lumi-provider";
import { Drawer, LumiLink, StatusBadge } from "./ui";

export const PERMISSION_LABEL = { owner: "Chủ", pm: "Trợ lý PM", assistant: "Trợ lý" } as const;

/** Ba trạng thái tách rõ cho một thành viên. */
export function StateChips({ memberId }: { memberId: string }) {
  const { state } = useLumi();
  const m = state.members.find((x) => x.id === memberId);
  if (!m) return null;
  const st = memberStates(state, m);
  if (m.kind === "human") {
    return (
      <div className="l-row" style={{ gap: 4 }}>
        <span className="l-badge green">Chủ hệ thống</span>
        <span className={`l-badge ${st.executing ? "purple" : ""}`}>{st.executing ? `Đang làm ${st.executing} việc` : "Rảnh"}</span>
      </div>
    );
  }
  return (
    <div className="l-row" style={{ gap: 4 }} data-testid="state-chips">
      <span className="l-badge green" title="Hồ sơ đã tạo">1 · Đã tạo hồ sơ</span>
      <span className={`l-badge ${st.hermes === "connected" ? "green" : "amber"}`} title="Kết nối Hermes (mô phỏng trong preview)">
        2 · {st.hermes === "connected" ? "Đã kết nối Hermes (mô phỏng)" : "Chưa kết nối Hermes"}
      </span>
      <span className={`l-badge ${st.executing ? "purple" : ""}`} title="Đang có việc chạy">
        3 · {st.executing ? `Đang thực thi ${st.executing} việc (mô phỏng)` : "Chưa thực thi"}
      </span>
    </div>
  );
}

export function MemberPanel({ memberId, onClose, projectFilter }: { memberId: string | null; onClose: () => void; projectFilter?: string }) {
  const { state, dispatch, openNewTask, openMemberForm } = useLumi();
  const [confirm, setConfirm] = useState(false);
  const m = memberId ? state.members.find((x) => x.id === memberId) : undefined;
  if (!m) return null;
  const open = memberOpenTasks(state, m.id).filter((t) => !projectFilter || t.projectId === projectFilter);
  const review = state.tasks.filter((t) => t.ownerId === m.id && t.status === "review");
  const projects = state.projects.filter((p) => (m.kind === "human" ? p.status === "active" : m.projectIds.includes(p.id)));
  const archived = m.status === "archived";

  return (
    <Drawer open onClose={onClose} title={`Hồ sơ ${m.name}`}>
      <div data-testid="member-panel" data-member={m.id}>
        <div className="l-row" style={{ gap: 14, alignItems: "flex-start" }}>
          <Avatar avatar={m.avatar} size={64} label={`Avatar của ${m.name}`} />
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: "1.3rem" }}>{m.name}</h2>
            <div className="muted">{m.role}</div>
            <div className="l-row" style={{ gap: 4, marginTop: 6 }}>
              <span className="l-badge blue">{PERMISSION_LABEL[m.permission]}</span>
              {archived && <span className="l-badge red">Đã lưu trữ</span>}
            </div>
          </div>
        </div>
        <div style={{ margin: "12px 0" }}><StateChips memberId={m.id} /></div>
        {m.description && <p style={{ margin: "6px 0 12px" }}>{m.description}</p>}

        <div className="l-label">Dự án tham gia</div>
        <div className="l-row" style={{ gap: 4 }}>
          {projects.length === 0 && <span className="muted">Chưa tham gia dự án nào</span>}
          {projects.map((p) => <LumiLink key={p.id} href={`/lumi/projects/${p.id}`} className="l-badge blue">{p.name}{p.pmId === m.id ? " · PM" : ""}</LumiLink>)}
        </div>

        <div className="l-label">Việc đang phụ trách ({open.length})</div>
        {open.length === 0 && <p className="muted" style={{ margin: 0 }}>Không có việc đang mở.</p>}
        <div className="l-grid" style={{ gap: 6 }}>
          {open.map((t) => (
            <LumiLink key={t.id} href={`/lumi/projects/${t.projectId}?task=${t.id}`} className="l-card click" style={{ padding: "8px 12px" }}>
              <div className="l-row" style={{ justifyContent: "space-between" }}>
                <strong className="small">{t.id} · {t.title}</strong>
                <StatusBadge status={t.status} />
              </div>
              {t.waitingConnection && <div className="small" style={{ color: "#f7d98a" }}>Chờ kết nối trợ lý</div>}
            </LumiLink>
          ))}
        </div>

        <div className="l-label">Mục chờ duyệt</div>
        {review.length === 0 ? <p className="muted" style={{ margin: 0 }}>Không có.</p> : review.map((t) => (
          <LumiLink key={t.id} href={`/lumi/projects/${t.projectId}?task=${t.id}`} className="l-badge amber">Đầu ra {t.id} chờ duyệt ({ownerLabel(state, t)})</LumiLink>
        ))}

        <div className="l-row" style={{ marginTop: 18 }}>
          <button className="l-btn primary" disabled={archived} onClick={() => openNewTask({ ownerId: m.id, ...(projectFilter ? { projectId: projectFilter } : projects[0] ? { projectId: projects[0].id } : {}) })} data-testid="assign-task">
            <Send size={15} /> Giao việc
          </button>
          <button className="l-btn" onClick={() => openMemberForm({ editId: m.id })}><Pencil size={14} /> Sửa hồ sơ</button>
          {m.kind === "bot" && (
            <button className="l-btn" onClick={() => dispatch({ type: "member.connect", id: m.id, connected: m.hermes !== "connected" })}>
              <Plug size={14} /> {m.hermes === "connected" ? "Ngắt Hermes (mô phỏng)" : "Giả lập kết nối Hermes"}
            </button>
          )}
          {m.kind === "bot" && !archived && !confirm && <button className="l-btn danger" onClick={() => setConfirm(true)}><Archive size={14} /> Lưu trữ</button>}
          {m.kind === "bot" && archived && <button className="l-btn" onClick={() => dispatch({ type: "member.restore", id: m.id })}><ArchiveRestore size={14} /> Khôi phục</button>}
        </div>
        {confirm && (
          <div className="l-note" style={{ marginTop: 10 }}>
            Lưu trữ {m.name}? Việc đang mở sẽ chuyển về Chủ; tên người phụ trách vẫn giữ trong lịch sử.
            <div className="l-row" style={{ marginTop: 8 }}>
              <button className="l-btn danger sm" onClick={async () => { await dispatch({ type: "member.archive", id: m.id }); setConfirm(false); }}>Xác nhận lưu trữ</button>
              <button className="l-btn sm" onClick={() => setConfirm(false)}>Giữ lại</button>
            </div>
          </div>
        )}
        {m.kind === "bot" && <p className="small muted" style={{ marginTop: 12 }}>Kết nối Hermes trong preview chỉ là mô phỏng. Trợ lý mới chưa kết nối sẽ nhận việc ở trạng thái «Chờ kết nối trợ lý».</p>}
      </div>
    </Drawer>
  );
}
