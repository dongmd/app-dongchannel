"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare, Plus, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { MEET_ID, planOffice, type OfficePlan, type RoomPlan } from "@/lib/lumi/office-layout";
import { meetingBoard, officeMemberView, seatedMemberIds, type MeetingBoard, type MeetingRow } from "@/lib/lumi/office-state";
import { lumiApi } from "@/lib/lumi/plans-client";
import { memberOpenTasks, memberStates } from "@/lib/lumi/selectors";
import { OWNER_ID, type Member } from "@/lib/lumi/types";
import { Avatar, avatarOf } from "./avatar";
import { useLumi } from "./lumi-provider";
import { MemberPanel } from "./member-panel";
import type { Office3DHandle, Office3DMeeting, Office3DMember } from "./office-3d";
import { LumiLink } from "./ui";

// Chỉ tải cảnh 3D (three.js) khi người dùng chọn 3D.
const Office3D = dynamic(() => import("./office-3d").then((m) => m.Office3D), {
  ssr: false,
  loading: () => <div className="l-stage tall" style={{ display: "grid", placeItems: "center" }}><span className="muted">Đang dựng cảnh 3D…</span></div>,
});

type View = "2d" | "3d";
const MEET_POLL_MS = 8000;

/** Dữ liệu họp thật cho Phòng họp (OFC-08): danh sách cuộc họp và người dự cuộc họp đang mở gần nhất. Chỉ đọc; mô phỏng thì không gọi. */
function useMeetings(enabled: boolean) {
  const [rows, setRows] = useState<MeetingRow[] | null>(null);
  const [seats, setSeats] = useState<{ slug?: string | null; role?: string }[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    const load = async () => {
      const r = await lumiApi("/api/v1/lumi/meetings");
      if (dead || !r.ok) return;
      const list = (r.data?.meetings ?? []) as MeetingRow[];
      setRows(list);
      const open = list.find((m) => m.state === "OPEN");
      if (!open) {
        setSeats([]);
        return;
      }
      const d = await lumiApi(`/api/v1/lumi/meetings/${open.code}`);
      if (!dead && d.ok) setSeats((d.data?.participants ?? []) as { slug?: string | null; role?: string }[]);
    };
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, MEET_POLL_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [enabled]);
  return { rows, seats };
}

export function OfficeView() {
  const { state, openMemberForm } = useLumi();
  const [view, setView] = useState<View>("2d");
  const [selected, setSelected] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pid, setPid] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const handle = useRef<Office3DHandle | null>(null);
  const isDb = state.mode === "db";

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
  const plan = useMemo(
    () =>
      planOffice(
        members.map((m) => ({ id: m.id, kind: m.kind, projectIds: m.projectIds })),
        state.projects.filter((p) => !pid || p.id === pid).map((p) => ({ id: p.id, name: p.name, area: p.area, status: p.status })),
      ),
    [members, state.projects, pid],
  );

  const { rows, seats } = useMeetings(isDb);
  const board = useMemo(() => meetingBoard(rows), [rows]);
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const meeting: Office3DMeeting = useMemo(
    () => ({ available: isDb && rows !== null, board: isDb && rows !== null ? board : null, seatIds: isDb ? seatedMemberIds(seats, OWNER_ID).filter((id) => memberIds.has(id)) : [] }),
    [isDb, rows, board, seats, memberIds],
  );

  // Chọn thành viên (từ 2D hay 3D) mở cùng một bảng hồ sơ; chọn Phòng họp mở khung họp bên dưới. Đóng bảng vẫn giữ mục đang chọn khi đổi 2D/3D.
  const choose = (id: string | null) => {
    setSelected(id);
    setPanelOpen(id !== null && id !== MEET_ID);
    sync({ m: id });
  };
  const changeView = (v: View) => {
    setView(v);
    setUnsupported(null);
    sync({ view: v });
  };
  const addMember = (projectId?: string) => openMemberForm({ ...(projectId ? { presetProjectId: projectId } : pid ? { presetProjectId: pid } : {}) });

  const data3d: Office3DMember[] = useMemo(
    () =>
      members.map((m) => {
        const v = officeMemberView(state, m);
        return { id: m.id, name: m.name, role: m.role, color: avatarOf(m.avatar).color, human: m.kind === "human", status: v.status, label: v.label, bubble: v.bubble, review: v.review };
      }),
    [members, state],
  );

  return (
    <div className="l-grid" style={{ gap: 14 }}>
      <div className="l-row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Văn phòng</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Mỗi dự án một phòng: ai đang làm gì, việc nào chờ duyệt. Bấm một thành viên để xem hồ sơ và giao việc; bấm Phòng họp để xem các cuộc họp.</p>
        </div>
        <button className="l-btn primary" onClick={() => addMember()} data-testid="add-member"><Plus size={16} /> Thêm trợ lý</button>
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
        <span className="small muted">{members.length} thành viên · {plan.rooms.filter((r) => r.kind !== "meet" && r.kind !== "free").length} phòng</span>
      </div>

      {view === "2d" ? (
        <Office2D plan={plan} members={members} selected={selected} onSelect={choose} onAdd={addMember} board={board} meetingReady={meeting.available} />
      ) : unsupported ? (
        <div className="l-card" role="alert" data-testid="no-webgl">
          <strong>Thiết bị này không hiển thị được cảnh 3D.</strong>
          <p className="muted" style={{ margin: "6px 0 10px" }}>{unsupported} Bạn vẫn dùng đầy đủ chức năng ở chế độ 2D.</p>
          <button className="l-btn primary" onClick={() => changeView("2d")}>Chuyển về 2D</button>
        </div>
      ) : (
        <>
          <div className="l-stage tall" data-testid="stage-3d">
            <span className={`l-badge ${isDb ? "green" : "amber"}`} style={{ position: "absolute", left: 10, bottom: 10, zIndex: 6 }}>{isDb ? "Dữ liệu thật · cảnh 3D minh họa" : "Cảnh 3D mô phỏng · dữ liệu demo"}</span>
            <Office3D plan={plan} members={data3d} meeting={meeting} selectedId={selected} onSelect={choose} onAdd={() => addMember()} onUnsupported={setUnsupported} handleRef={handle} />
            <div className="controls">
              <button className="l-btn sm" onClick={() => handle.current?.zoom(0.8)} aria-label="Phóng to"><ZoomIn size={15} /></button>
              <button className="l-btn sm" onClick={() => handle.current?.zoom(1.25)} aria-label="Thu nhỏ"><ZoomOut size={15} /></button>
              <button className="l-btn sm" onClick={() => handle.current?.reset()} data-testid="reset-view"><RotateCcw size={14} /> Đặt lại góc nhìn</button>
            </div>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Kéo để xoay, cuộn hoặc chụm hai ngón để thu phóng, bấm vào nhân vật hoặc bàn họp để mở chi tiết.</p>
          <div className="l-row" role="group" aria-label="Danh sách thành viên (bàn phím)">
            {members.map((m) => (
              <button key={m.id} className="l-btn sm" aria-pressed={selected === m.id} onClick={() => choose(m.id)} style={selected === m.id ? { borderColor: "var(--l-accent)" } : undefined}>
                <Avatar avatar={m.avatar} size={20} /> {m.name}
              </button>
            ))}
            <button className="l-btn sm" aria-pressed={selected === MEET_ID} onClick={() => choose(MEET_ID)} style={selected === MEET_ID ? { borderColor: "var(--l-accent)" } : undefined} data-testid="pick-meet"><MessagesSquare size={15} /> Phòng họp</button>
          </div>
        </>
      )}

      {selected === MEET_ID && <MeetingRoomPanel board={board} ready={meeting.available} isDb={isDb} onClose={() => choose(null)} />}
      <MemberPanel memberId={panelOpen && selected !== MEET_ID ? selected : null} onClose={() => setPanelOpen(false)} projectFilter={pid || undefined} />
    </div>
  );
}

/** Khung Phòng họp: tóm tắt đọc được của các cuộc họp thật; thao tác họp (mở, đóng góp, duyệt) ở trang Họp (MTG). */
function MeetingRoomPanel({ board, ready, isDb, onClose }: { board: MeetingBoard; ready: boolean; isDb: boolean; onClose: () => void }) {
  return (
    <section className="l-card" data-testid="meet-panel" aria-label="Phòng họp">
      <div className="l-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 className="l-row" style={{ gap: 8, margin: 0, fontSize: "1.05rem" }}><MessagesSquare size={18} /> Phòng họp</h2>
        <div className="l-row" style={{ gap: 6 }}>
          {isDb && <LumiLink href="/lumi/meetings" className="l-btn sm primary" data-testid="meet-open-page">Mở trang Họp</LumiLink>}
          <button className="l-btn sm" onClick={onClose}>Đóng</button>
        </div>
      </div>
      <p className="muted small" style={{ margin: "6px 0 10px" }}>Họp là ngoại lệ có lý do, không phải bước mặc định. Kết luận họp không tự mở rộng ngân sách hay quyền; việc có một người phụ trách rõ đi thẳng bàn giao.</p>
      {!isDb ? (
        <p className="o2-empty" data-testid="meet-sim">Họp cần dữ liệu thật (đăng nhập). Chế độ mô phỏng không có cuộc họp.</p>
      ) : !ready ? (
        <p className="o2-empty">Đang tải các cuộc họp…</p>
      ) : (
        <BoardColumns board={board} />
      )}
    </section>
  );
}

function BoardColumns({ board }: { board: MeetingBoard }) {
  return (
    <div className="o2-board" data-testid="meet-board">
      {board.columns.map((c) => (
        <div key={c.key} className="o2-col" data-col={c.key}>
          <h4><span>{c.title}</span><span className="muted">{c.count}</span></h4>
          {c.lines.length ? <ul>{c.lines.map((l) => <li key={l}>{l}</li>)}</ul> : <div className="o2-empty">Chưa có</div>}
        </div>
      ))}
    </div>
  );
}

function Office2D({ plan, members, selected, onSelect, onAdd, board, meetingReady }: { plan: OfficePlan; members: Member[]; selected: string | null; onSelect: (id: string) => void; onAdd: (projectId?: string) => void; board: MeetingBoard; meetingReady: boolean }) {
  const { state } = useLumi();
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const ORDER = { doing: 0, ready: 1, new: 2, review: 3, done: 4 } as const;
  const projectOf = (r: RoomPlan) => (r.id.startsWith("p:") ? r.id.slice(2) : undefined);
  return (
    <div className="l-floor" data-testid="office-2d">
      <div className="o2-rooms">
        {plan.rooms.map((r) => {
          if (r.kind === "meet") {
            const open = board.open.length;
            return (
              <section key={r.id} className="o2-room wide" style={{ ["--rc" as string]: r.accent }} aria-label={r.name} data-room={r.id}>
                <div className="l-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                  <h3>{r.name}<small>{r.sub}</small></h3>
                  <button className="l-btn sm" aria-pressed={selected === MEET_ID} style={selected === MEET_ID ? { borderColor: "var(--l-accent)" } : undefined} onClick={() => onSelect(MEET_ID)} data-testid="pick-meet-2d">
                    <MessagesSquare size={15} /> {state.mode !== "db" ? "Cần dữ liệu thật" : !meetingReady ? "Đang tải" : open > 0 ? `${open} cuộc họp đang mở` : "Chưa có họp đang mở"}
                  </button>
                </div>
                {state.mode === "db" && meetingReady ? <BoardColumns board={board} /> : <p className="o2-empty">Họp cần dữ liệu thật (đăng nhập).</p>}
              </section>
            );
          }
          return (
            <section key={r.id} className="o2-room" style={{ ["--rc" as string]: r.accent }} aria-label={r.name} data-room={r.id}>
              <h3>{r.name}<small>{r.sub}</small></h3>
              {r.desks.length === 0 ? (
                <div className="o2-empty"><p style={{ margin: "0 0 8px" }}>Chưa có trợ lý.</p><button className="l-btn sm" onClick={() => onAdd(projectOf(r))}><Plus size={14} /> Thêm trợ lý</button></div>
              ) : (
                <div className="o2-desks">
                  {r.desks.map((d) => {
                    const m = byId.get(d.memberId);
                    if (!m) return null;
                    const mine = memberOpenTasks(state, m.id);
                    const current = [...mine].sort((a, b) => ORDER[a.status] - ORDER[b.status])[0];
                    const review = mine.filter((t) => t.status === "review").length;
                    const st = memberStates(state, m);
                    return (
                      <button key={m.id} className={`l-desk${m.status === "archived" ? " dim" : ""}`} aria-pressed={selected === m.id} onClick={() => onSelect(m.id)} data-member={m.id}>
                        {state.mode !== "db" && <span className="l-badge amber l-sim" title="Dữ liệu và trạng thái trong preview là mô phỏng">Mô phỏng</span>}
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
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
