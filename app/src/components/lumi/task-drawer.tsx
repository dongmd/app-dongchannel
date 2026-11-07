"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, MessageSquarePlus, Pencil, Plug } from "lucide-react";

import { canReceiveTasks } from "@/lib/lumi/engine";
import { outputOfTask, ownerLabel, project } from "@/lib/lumi/selectors";
import { useLumi } from "./lumi-provider";
import { Drawer, fmtFull, LumiLink, SourceBadge, StatusBadge } from "./ui";

const VIA_LABEL = { web: "Web", telegram: "Telegram", system: "Hệ thống" } as const;
const EVENT_LABEL: Record<string, string> = {
  created: "Tạo việc",
  assigned: "Giao việc",
  started: "Bắt đầu làm",
  output: "Gửi đầu ra",
  comment: "Góp ý",
  revision_requested: "Yêu cầu sửa",
  approved: "Duyệt đầu ra",
  status: "Trạng thái",
  connection: "Kết nối",
};

/** Chi tiết một việc: dùng trong ngăn kéo (trang dự án) và dạng cột bên cạnh (Telegram mô phỏng trên desktop). */
export function TaskDetail({ taskId }: { taskId: string | null }) {
  const { state, dispatch } = useLumi();
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : undefined;
  const out = task ? outputOfTask(state, task) : undefined;
  const [ver, setVer] = useState(1);
  const [revise, setRevise] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const latest = out?.versions.length ?? 0;
  // Liên kết từ Dashboard mở đúng phiên bản đầu ra (?v=N); không có thì mở bản mới nhất.
  const sp = useSearchParams();
  const wantV = sp.get("task") === taskId ? Number(sp.get("v")) : Number.NaN;
  useEffect(() => {
    setVer(Number.isInteger(wantV) && wantV >= 1 && wantV <= latest ? wantV : latest || 1);
  }, [latest, taskId, wantV]);
  useEffect(() => {
    setRevise("");
    setComment("");
  }, [taskId]);

  if (!task) return null;
  const proj = project(state, task.projectId);
  const owner = state.members.find((m) => m.id === task.ownerId);
  const shown = out?.versions.find((v) => v.v === ver) ?? out?.versions[latest - 1];
  const canChangeOwner = task.status !== "review" && task.status !== "done";
  const eligible = state.members.filter((m) => canReceiveTasks(m, task.projectId));
  const linkedActions = state.actions.filter((a) => a.taskId === task.id);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <div data-testid="task-detail" data-task={task.id}>
      <div className="l-row" style={{ gap: 6 }}>
        <span className="muted small">{task.id}</span>
        <StatusBadge status={task.status} />
        <SourceBadge task={task} />
        {task.waitingConnection && <span className="l-badge amber">Chờ kết nối trợ lý</span>}
      </div>
      <h2 style={{ marginTop: 8, fontSize: "1.2rem" }}>{task.title}</h2>
      <p className="muted small" style={{ margin: "2px 0 10px" }}>
        Dự án <LumiLink href={`/lumi/projects/${task.projectId}`}><u>{proj?.name}</u></LumiLink> · tạo {fmtFull(task.createdAt)}
        {task.due ? ` · hạn ${task.due}` : ""}
      </p>

      <div className="l-card" style={{ marginBottom: 12 }}>
        <div className="l-label" style={{ marginTop: 0 }}>Yêu cầu</div>
        <div>{task.request}</div>
        <div className="l-label">Đầu ra mong muốn</div>
        <div>{task.outputWanted}</div>
        {proj?.area === "YouTube" && (
          <>
            <div className="l-label">Video (để đếm theo video, không đếm theo việc)</div>
            <div className="l-row">
              <select
                className="l-select"
                style={{ flex: 1, minWidth: 0 }}
                aria-label="Video của việc này"
                value={task.videoId ?? ""}
                onChange={(e) => dispatch({ type: "task.setVideo", taskId: task.id, videoId: e.target.value || null })}
              >
                <option value="">Chưa gắn video cụ thể</option>
                {state.videos.filter((v) => v.projectId === task.projectId).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
              </select>
              <button className="l-btn sm" onClick={async () => { const r = await dispatch({ type: "video.create", projectId: task.projectId, title: task.title, status: "scripting" }); if (r.ok && r.id) await dispatch({ type: "task.setVideo", taskId: task.id, videoId: r.id }); }}>
                Tạo video từ việc này
              </button>
            </div>
          </>
        )}
        <div className="l-label">Người phụ trách chính</div>
        {canChangeOwner ? (
          <select className="l-select" aria-label="Người phụ trách chính" value={task.ownerId} onChange={(e) => dispatch({ type: "task.assign", taskId: task.id, ownerId: e.target.value, via: "web" })}>
            {eligible.map((m) => (
              <option key={m.id} value={m.id}>{m.kind === "human" ? `${m.name} (tôi tự nhận)` : m.name}</option>
            ))}
          </select>
        ) : (
          <div>{ownerLabel(state, task)}</div>
        )}
        {task.waitingConnection && owner && !state.mode && (
          <div className="l-note" style={{ marginTop: 10 }}>
            {owner.name} chưa kết nối Hermes (mô phỏng), nên việc đang «Chờ kết nối trợ lý».
            <div style={{ marginTop: 8 }}>
              <button className="l-btn sm" onClick={() => dispatch({ type: "member.connect", id: owner.id, connected: true })}>
                <Plug size={14} /> Giả lập kết nối Hermes cho {owner.name}
              </button>
            </div>
          </div>
        )}
        <div className="l-row" style={{ marginTop: 10 }}>
          {!state.mode && task.status === "ready" && (
            <button className="l-btn sm" onClick={() => dispatch({ type: "task.move", taskId: task.id, to: "doing" })}>Bắt đầu</button>
          )}
          {!state.mode && owner?.kind === "human" && task.status !== "done" && (
            <button className="l-btn sm good" onClick={() => dispatch({ type: "task.move", taskId: task.id, to: "done" })}>
              <Check size={14} /> Hoàn tất (tôi làm)
            </button>
          )}
        </div>
      </div>

      {task.real && state.real && <RealPanel task={task} role={state.real.role} />}

      <h3 style={{ margin: "14px 0 6px" }}>Đầu ra</h3>
      {!out || !shown ? (
        <p className="muted">
          {task.status === "doing" && owner?.kind === "bot" ? "Trợ lý đang làm (mô phỏng), đầu ra sẽ hiện sau vài giây." : "Chưa có đầu ra."}
        </p>
      ) : (
        <div className="l-out" data-testid="output">
          <div className="l-row" style={{ justifyContent: "space-between" }}>
            <strong>{shown.title}</strong>
            <span className={`l-badge ${out.state === "approved" ? "green" : out.state === "changes_requested" ? "amber" : ""}`}>
              {out.state === "approved" ? `Đã duyệt bản ${out.approvedVersion}` : out.state === "changes_requested" ? "Đã yêu cầu sửa" : "Chờ duyệt"}
            </span>
          </div>
          {out.versions.length > 1 && (
            <div className="l-tabs" style={{ margin: "8px 0" }} role="tablist" aria-label="Các bản đầu ra">
              {out.versions.map((v) => (
                <button key={v.v} role="tab" aria-selected={ver === v.v} onClick={() => setVer(v.v)}>Bản {v.v}</button>
              ))}
            </div>
          )}
          {shown.v < latest && <div className="l-note" style={{ margin: "8px 0" }} data-testid="old-version-note">Bạn đang xem bản {shown.v}; hiện đã có bản {latest}.</div>}
          {shown.revisionNote &&<div className="l-note" style={{ margin: "8px 0" }}>Sửa theo góp ý: {shown.revisionNote}</div>}
          {shown.sections.map((sec) => (
            <div key={sec.heading} style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 650 }}>{sec.heading}</div>
              <pre>{sec.body}</pre>
              {sec.meta && <div className="small muted">{sec.meta}</div>}
            </div>
          ))}
          {task.status === "review" && shown.v === latest && (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--l-border)", paddingTop: 12 }}>
              <div className="l-row">
                <button className="l-btn good" disabled={busy} onClick={() => run(() => dispatch({ type: "task.approveOutput", taskId: task.id, via: "web", version: latest }))}>
                  <Check size={16} /> Duyệt bản {latest}
                </button>
              </div>
              <p className="small muted" style={{ margin: "8px 0" }}>Duyệt chỉ chốt nội dung. Bật chiến dịch, tăng ngân sách hay đăng video là yêu cầu riêng ở mục Chờ duyệt.</p>
              <label className="l-label" htmlFor="rev">Yêu cầu sửa</label>
              <textarea id="rev" className="l-textarea" value={revise} onChange={(e) => setRevise(e.target.value)} placeholder="Ví dụ: ngắn hơn, nhấn mạnh dùng thử miễn phí" />
              <div className="l-row" style={{ marginTop: 8 }}>
                <button
                  className="l-btn"
                  disabled={busy || !revise.trim()}
                  onClick={() => run(async () => { const r = await dispatch({ type: "task.requestRevision", taskId: task.id, text: revise, via: "web", version: latest }); if (r.ok) setRevise(""); })}
                >
                  <Pencil size={14} /> Gửi yêu cầu sửa
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {linkedActions.length > 0 && (
        <div className="l-card" style={{ marginTop: 12 }}>
          <div className="l-label" style={{ marginTop: 0 }}>Hành động bên ngoài liên quan (yêu cầu riêng)</div>
          {linkedActions.map((a) => (
            <div key={a.id} className="l-row" style={{ justifyContent: "space-between" }}>
              <span>{a.title}</span>
              <LumiLink href={`/lumi/approvals?tab=action&id=${a.id}`} className="l-badge amber">{a.status === "pending" ? "Chờ duyệt" : a.status === "approved" ? "Đã duyệt (mô phỏng)" : "Đã từ chối"}</LumiLink>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ margin: "18px 0 6px" }}>Phản hồi và lịch sử</h3>
      {!state.mode && <div className="l-row" style={{ marginBottom: 10 }}>
        <input className="l-input" style={{ flex: 1 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Thêm góp ý cho việc này…" aria-label="Thêm góp ý" />
        <button className="l-btn" disabled={!comment.trim() || busy} onClick={() => run(async () => { const r = await dispatch({ type: "task.comment", taskId: task.id, text: comment, via: "web" }); if (r.ok) setComment(""); })}>
          <MessageSquarePlus size={14} /> Gửi
        </button>
      </div>}
      <div className="l-timeline">
        {[...task.history].reverse().map((h) => (
          <div className="ev" key={h.id}>
            <div className="small muted">{fmtFull(h.at)} · {h.byName} · {VIA_LABEL[h.via]}</div>
            <div><strong>{EVENT_LABEL[h.kind] ?? h.kind}</strong>{h.version ? ` (bản ${h.version})` : ""}{h.text ? `: ${h.text}` : ""}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const REAL_STATUS_LABEL: Record<string, string> = {
  CAPTURED: "Đã bắt", WAITING_ASSISTANT: "Chờ trợ lý sẵn sàng", QUEUED: "Chờ chạy", RUNNING: "Đang chạy", WAITING_REVIEW: "Chờ duyệt",
  REVISION_REQUESTED: "Cần giao sửa", REJECTED: "Từ chối", APPROVED: "Đã duyệt", COMPLETED: "Hoàn thành", FAILED: "Lỗi", ON_HOLD: "Tạm giữ", CANCELLED: "Đã hủy",
};

/** Chi tiết kỹ thuật thật của việc (chỉ ở chế độ dữ liệu thật): trạng thái đầy đủ, lượt chạy, lỗi, giao lại/hủy, liên kết kết quả muộn. */
function RealPanel({ task, role }: { task: NonNullable<ReturnType<typeof useLumi>["state"]["tasks"][number]>; role: "OWNER" | "ADMIN" | "VIEWER" }) {
  const { dispatch } = useLumi();
  const [busy, setBusy] = useState(false);
  const r = task.real!;
  const canManage = role !== "VIEWER";
  const retryable = ["FAILED", "ON_HOLD", "REJECTED", "REVISION_REQUESTED"].includes(r.status);
  const closed = ["COMPLETED", "CANCELLED", "APPROVED"].includes(r.status);
  const go = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); await fn(); setBusy(false); };
  return (
    <div className="l-card" style={{ marginBottom: 12 }} data-testid="real-panel">
      <div className="l-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className={`l-badge ${["FAILED", "REJECTED"].includes(r.status) ? "red" : ["COMPLETED", "APPROVED"].includes(r.status) ? "green" : "amber"}`}>Trạng thái thật: {REAL_STATUS_LABEL[r.status] ?? r.status}</span>
        {r.needsDecision && <span className="l-badge amber">Cần quyết định: lệnh giao có thể đã tới Hermes, app không tự gửi lại</span>}
        {r.revisionRound > 0 && <span className="l-badge">Vòng sửa {r.revisionRound}</span>}
      </div>
      {r.errorCode && <div className="l-note" style={{ marginTop: 8 }}>Lỗi {r.errorCode}{r.errorMessage ? `: ${r.errorMessage}` : ""}</div>}
      {r.holdReason && <div className="small muted" style={{ marginTop: 6 }}>Lý do giữ/hủy: {r.holdReason}</div>}
      <div className="l-label">Lần chạy ({r.runs.length})</div>
      {r.runs.length === 0 ? <div className="small muted">Chưa có lần chạy.</div> : r.runs.map((x) => (
        <div key={x.n} className="small" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span>#{x.n}</span><span>{x.kind}</span><strong>{x.state}</strong>
          {x.remoteStop !== "NONE" && <span className="muted">dừng phía Hermes: {x.remoteStop === "CONFIRMED" ? "đã xác nhận" : "CHƯA xác nhận (app ngừng chờ ≠ bot đã dừng)"}</span>}
          {x.errorCode && <span style={{ color: "#f08a8a" }}>{x.errorCode}</span>}
        </div>
      ))}
      {r.children.length > 0 && (
        <>
          <div className="l-label">Kế hoạch / việc con ({r.children.length}){r.checkpoints > 0 ? ` · ${r.checkpoints} điểm dừng` : ""}</div>
          {r.children.map((c) => (
            <div key={c.code} className="small" style={{ display: "flex", gap: 8, flexWrap: "wrap" }} data-testid="plan-item">
              <span>{c.code}</span><strong>{REAL_STATUS_LABEL[c.status] ?? c.status}</strong><span>{c.title}</span>
              {c.note && <span className="muted">{c.note}</span>}
            </div>
          ))}
        </>
      )}
      <div className="l-row" style={{ marginTop: 10, flexWrap: "wrap" }}>
        {canManage && retryable && <button className="l-btn sm" disabled={busy} onClick={() => go(() => dispatch({ type: "task.retry", taskId: task.id }))}>{r.status === "REVISION_REQUESTED" ? "Giao trợ lý sửa" : "Giao lại"}</button>}
        {canManage && !closed && <button className="l-btn sm danger" disabled={busy} onClick={() => go(() => dispatch({ type: "task.cancel", taskId: task.id, reason: "Chủ hủy từ giao diện Dong-Lumi" }))}>Hủy việc</button>}
        {r.lateOutputs > 0 && <a className="l-btn sm" href={`/work/${r.uuid}`}>Có {r.lateOutputs} kết quả đến muộn: xem và quyết định</a>}
        <a className="small muted" href={`/work/${r.uuid}`}>Chi tiết kỹ thuật</a>
      </div>
    </div>
  );
}

export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  if (!taskId) return null;
  return (
    <Drawer open onClose={onClose} title={`Việc ${taskId}`}>
      <TaskDetail taskId={taskId} />
    </Drawer>
  );
}
