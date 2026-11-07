"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { memberOpenTasks, memberStates } from "@/lib/lumi/selectors";
import type { Member } from "@/lib/lumi/types";
import { Avatar, avatarOf } from "./avatar";
import { useLumi } from "./lumi-provider";
import { MemberPanel } from "./member-panel";
import type { Office3DHandle, Office3DMember } from "./office-3d";

// Chỉ tải cảnh 3D (three.js) khi người dùng chọn 3D.
const Office3D = dynamic(() => import("./office-3d").then((m) => m.Office3D), {
  ssr: false,
  loading: () => <div className="l-stage" style={{ display: "grid", placeItems: "center" }}><span className="muted">Đang dựng cảnh 3D…</span></div>,
});

type View = "2d" | "3d";

export function OfficeView() {
  const { state, openMemberForm } = useLumi();
  const [view, setView] = useState<View>("2d");
  const [selected, setSelected] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pid, setPid] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const handle = useRef<Office3DHandle | null>(null);

  // Khôi phục chế độ và thành viên đang chọn từ URL để giữ lại khi tải lại trang.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("view") === "3d") setView("3d");
    const m = sp.get("m");
    if (m) setSelected(m);
    const p = sp.get("p");
    if (p) setPid(p);
  }, []);
  const sync = useCallback((next: { view?: View; m?: string | null; p?: string }) => {
    const sp = new URLSearchParams(window.location.search);
    if (next.view) sp.set("view", next.view);
    if (next.m !== undefined) {
      if (next.m) sp.set("m", next.m);
      else sp.delete("m");
    }
    if (next.p !== undefined) {
      if (next.p) sp.set("p", next.p);
      else sp.delete("p");
    }
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  }, []);

  const members = useMemo(
    () =>
      state.members
        .filter((m) => showArchived || m.status === "active")
        .filter((m) => !pid || m.kind === "human" || m.projectIds.includes(pid)),
    [state.members, showArchived, pid],
  );

  // Chọn thành viên (từ 2D hay 3D) mở cùng một bảng hồ sơ. Đóng bảng vẫn giữ thành viên đang chọn khi đổi 2D/3D.
  const choose = (id: string | null) => {
    setSelected(id);
    setPanelOpen(id !== null);
    sync({ m: id });
  };
  const changeView = (v: View) => {
    setView(v);
    setUnsupported(null);
    sync({ view: v });
  };

  const data3d: Office3DMember[] = useMemo(
    () =>
      members.map((m) => {
        const st = memberStates(state, m);
        return { id: m.id, name: m.name, role: m.role, avatar: m.avatar, color: avatarOf(m.avatar).color, archived: m.status === "archived", busy: st.executing > 0, waiting: st.waiting > 0 };
      }),
    [members, state],
  );

  return (
    <div className="l-grid" style={{ gap: 14 }}>
      <div className="l-row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Văn phòng</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Đội của bạn: ai đang làm gì, việc nào chờ duyệt. Bấm một thành viên để xem hồ sơ và giao việc.</p>
        </div>
        <button className="l-btn primary" onClick={() => openMemberForm({ ...(pid ? { presetProjectId: pid } : {}) })} data-testid="add-member"><Plus size={16} /> Thêm trợ lý</button>
      </div>

      <div className="l-row">
        <div className="l-tabs" role="tablist" aria-label="Chế độ xem">
          <button role="tab" aria-selected={view === "2d"} onClick={() => changeView("2d")} data-testid="view-2d">2D</button>
          <button role="tab" aria-selected={view === "3d"} onClick={() => changeView("3d")} data-testid="view-3d">3D</button>
        </div>
        <select className="l-select" style={{ width: "auto" }} value={pid} onChange={(e) => { setPid(e.target.value); sync({ p: e.target.value }); }} aria-label="Lọc theo dự án">
          <option value="">Tất cả dự án</option>
          {state.projects.filter((p) => p.status === "active").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="l-row small muted" style={{ gap: 6 }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Hiện đã lưu trữ
        </label>
        <span className="small muted">{members.length} thành viên</span>
      </div>

      {view === "2d" ? (
        <Office2D members={members} selected={selected} onSelect={choose} pid={pid} />
      ) : unsupported ? (
        <div className="l-card" role="alert" data-testid="no-webgl">
          <strong>Thiết bị này không hiển thị được cảnh 3D.</strong>
          <p className="muted" style={{ margin: "6px 0 10px" }}>{unsupported} Bạn vẫn dùng đầy đủ chức năng ở chế độ 2D.</p>
          <button className="l-btn primary" onClick={() => changeView("2d")}>Chuyển về 2D</button>
        </div>
      ) : (
        <>
          <div className="l-stage" data-testid="stage-3d">
            <span className="l-badge amber" style={{ position: "absolute", left: 10, bottom: 10, zIndex: 2 }}>Cảnh 3D mô phỏng · dữ liệu demo</span>
            <Office3D members={data3d} selectedId={selected} onSelect={choose} onUnsupported={setUnsupported} handleRef={handle} />
            <div className="controls">
              <button className="l-btn sm" onClick={() => handle.current?.zoom(0.8)} aria-label="Phóng to"><ZoomIn size={15} /></button>
              <button className="l-btn sm" onClick={() => handle.current?.zoom(1.25)} aria-label="Thu nhỏ"><ZoomOut size={15} /></button>
              <button className="l-btn sm" onClick={() => handle.current?.reset()} data-testid="reset-view"><RotateCcw size={14} /> Đặt lại góc nhìn</button>
            </div>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Kéo để xoay, cuộn hoặc chụm hai ngón để thu phóng, bấm vào nhân vật để mở hồ sơ.</p>
          <div className="l-row" role="group" aria-label="Danh sách thành viên (bàn phím)">
            {members.map((m) => (
              <button key={m.id} className="l-btn sm" aria-pressed={selected === m.id} onClick={() => choose(m.id)} style={selected === m.id ? { borderColor: "var(--l-accent)" } : undefined}>
                <Avatar avatar={m.avatar} size={20} /> {m.name}
              </button>
            ))}
          </div>
        </>
      )}

      <MemberPanel memberId={panelOpen ? selected : null} onClose={() => setPanelOpen(false)} projectFilter={pid || undefined} />
    </div>
  );
}

function Office2D({ members, selected, onSelect, pid }: { members: Member[]; selected: string | null; onSelect: (id: string) => void; pid: string }) {
  const { state } = useLumi();
  const ORDER = { doing: 0, ready: 1, new: 2, review: 3, done: 4 } as const;
  return (
    <div className="l-floor" data-testid="office-2d">
      <div className="l-grid cols3" style={{ gap: 22 }}>
        {members.map((m) => {
          const mine = memberOpenTasks(state, m.id).filter((t) => !pid || t.projectId === pid);
          const current = [...mine].sort((a, b) => ORDER[a.status] - ORDER[b.status])[0];
          const review = mine.filter((t) => t.status === "review").length;
          const st = memberStates(state, m);
          return (
            <button key={m.id} className={`l-desk${m.status === "archived" ? " dim" : ""}`} aria-pressed={selected === m.id} onClick={() => onSelect(m.id)} data-member={m.id}>
              <span className="l-badge amber l-sim" title="Dữ liệu và trạng thái trong preview là mô phỏng">Mô phỏng</span>
              <div className="l-row" style={{ gap: 12, flexWrap: "nowrap", alignItems: "center" }}>
                <Avatar avatar={m.avatar} size={52} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="l-desk-name">{m.name}</div>
                  <div className="small muted l-clamp1">{m.role}</div>
                </div>
              </div>
              <div className="l-desk-line">
                <span className="small muted">Việc hiện tại</span>
                {current ? (
                  <div className="l-clamp2" style={{ fontWeight: 600 }} title={current.title}>
                    {current.title}
                    {st.waiting > 0 && current.waitingConnection ? <span style={{ color: "#f7d98a" }}> · chờ kết nối</span> : null}
                  </div>
                ) : (
                  <div className="muted">Rảnh</div>
                )}
              </div>
              <div className="l-row" style={{ marginTop: 8, justifyContent: "space-between" }}>
                <span className={`l-badge ${review > 0 ? "amber" : ""}`}>{review > 0 ? `${review} đầu ra chờ duyệt` : "Không có đầu ra chờ duyệt"}</span>
                {m.status === "archived" && <span className="l-badge red">Đã lưu trữ</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
