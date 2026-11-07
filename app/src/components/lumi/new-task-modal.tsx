"use client";

import { useEffect, useMemo, useState } from "react";

import { canReceiveTasks } from "@/lib/lumi/engine";
import { useLumi } from "./lumi-provider";
import { Modal } from "./ui";

export function NewTaskModal() {
  const { state, newTask, closeNewTask, dispatch, toast } = useLumi();
  const { open, preset } = newTask;
  const projects = state.projects.filter((p) => p.status === "active");
  const [projectId, setProjectId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [outputWanted, setOutputWanted] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  // Một mã cho mỗi lần mở biểu mẫu: bấm đúp hay gửi lại không tạo việc thứ hai (chế độ dữ liệu thật).
  const [reqId, setReqId] = useState("");

  useEffect(() => {
    if (!open) return;
    const pid = preset.projectId ?? projects[0]?.id ?? "";
    setProjectId(pid);
    setOwnerId(preset.ownerId ?? "");
    setTitle(preset.title ?? "");
    setRequest("");
    setOutputWanted("");
    setDue("");
    setBusy(false);
    setReqId(crypto.randomUUID());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const candidates = useMemo(() => state.members.filter((m) => canReceiveTasks(m, projectId)), [state.members, projectId]);
  // Người nhận mặc định: trợ lý đầu tiên của dự án, nếu chưa có thì Chủ.
  const effectiveOwner = candidates.some((m) => m.id === ownerId) ? ownerId : (candidates.find((m) => m.kind === "bot")?.id ?? candidates[0]?.id ?? "");
  const recipient = state.members.find((m) => m.id === effectiveOwner);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const r = await dispatch({ type: "task.create", projectId, title, request, outputWanted, ...(due ? { due } : {}), ownerId: effectiveOwner, via: "web", clientRequestId: reqId });
    setBusy(false);
    if (r.ok) {
      toast(`Đã tạo việc ${r.taskId}${recipient?.kind === "bot" && recipient.hermes === "none" ? " · Chờ kết nối trợ lý" : ""}.`);
      closeNewTask();
    }
  }

  return (
    <Modal open={open} onClose={closeNewTask} title="Việc mới">
      <form onSubmit={submit}>
        <label className="l-label" htmlFor="nt-project">Dự án</label>
        <select id="nt-project" className="l-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="l-label" htmlFor="nt-owner">Người nhận (phụ trách chính)</label>
        <select id="nt-owner" className="l-select" value={effectiveOwner} onChange={(e) => setOwnerId(e.target.value)}>
          {candidates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.kind === "human" ? `${m.name} (tôi tự nhận)` : m.name}
            </option>
          ))}
        </select>
        {recipient?.kind === "bot" && recipient.hermes === "none" && (
          <p className="small" style={{ color: "#f7d98a", margin: "6px 0 0" }}>
            {recipient.name} {state.mode === "db" ? "chưa được bật giao việc (xem Telegram & kết nối)" : "đã có hồ sơ nhưng chưa kết nối Hermes (mô phỏng)"}. Việc sẽ nằm ở «Mới» với nhãn «Chờ kết nối trợ lý».
          </p>
        )}
        <label className="l-label" htmlFor="nt-title">Tiêu đề</label>
        <input id="nt-title" data-autofocus className="l-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Soạn 3 mẫu quảng cáo Google Search" required />
        <label className="l-label" htmlFor="nt-req">Yêu cầu chi tiết</label>
        <textarea id="nt-req" className="l-textarea" value={request} onChange={(e) => setRequest(e.target.value)} />
        <div className="l-grid cols2">
          <div>
            <label className="l-label" htmlFor="nt-out">Đầu ra mong muốn</label>
            <input id="nt-out" className="l-input" value={outputWanted} onChange={(e) => setOutputWanted(e.target.value)} placeholder="Ví dụ: 3 mẫu quảng cáo" />
          </div>
          <div>
            <label className="l-label" htmlFor="nt-due">Hạn (nếu có)</label>
            <input id="nt-due" className="l-input" value={due} onChange={(e) => setDue(e.target.value)} placeholder="Ví dụ: thứ Sáu" />
          </div>
        </div>
        <div className="l-row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" className="l-btn" onClick={closeNewTask}>Hủy</button>
          <button type="submit" className="l-btn primary" disabled={busy || !title.trim() || !effectiveOwner}>Giao việc</button>
        </div>
      </form>
    </Modal>
  );
}
