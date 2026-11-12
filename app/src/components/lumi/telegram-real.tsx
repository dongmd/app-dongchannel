"use client";

import { Check, X } from "lucide-react";
import { useState } from "react";

import { AssistantPanel } from "@/components/work/assistant-panel";
import { useLumi } from "./lumi-provider";
import { Empty } from "./ui";
import { TelegramSim } from "./telegram-sim";

/** Trang Telegram ở chế độ dữ liệu thật: bản nháp bot tạo ra chờ Chủ xác nhận, cách gửi tin, và công tắc trợ lý/dừng khẩn cấp. */
export function TelegramEntry() {
  const { state } = useLumi();
  return state.mode === "db" ? <TelegramReal /> : <TelegramSim />;
}

function TelegramReal() {
  const { state, dispatch } = useLumi();
  const [busy, setBusy] = useState(false);
  const real = state.real!;
  const canManage = real.role !== "VIEWER";
  const projectName = (id?: string) => state.projects.find((p) => p.id === id)?.name ?? "chưa rõ";
  const botName = (id: string) => state.members.find((m) => m.id === id)?.name ?? "chưa rõ";
  const go = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); await fn(); setBusy(false); };

  return (
    <div data-testid="telegram-real">
      <h1 style={{ fontSize: "1.4rem", margin: "0 0 4px" }}>Telegram &amp; kết nối</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Bot chỉ tạo được <strong>bản nháp</strong>. Chưa có việc nào cho tới khi bạn bấm Xác nhận ở đây. Chiều giao việc cho Hermes và nộp đầu ra do hệ thống thực hiện (không qua Telegram).
      </p>

      <div className="l-card" style={{ marginBottom: 14 }}>
        <div className="l-label" style={{ marginTop: 0 }}>Cách giao việc từ Telegram</div>
        <p style={{ margin: "4px 0" }}>
          Gửi cho bot{real.telegramBot ? <> <strong>@{real.telegramBot}</strong></> : null} một tin bắt đầu bằng <code>Giao việc:</code>, nêu tên dự án và người nhận, ví dụ:
        </p>
        <pre style={{ margin: "6px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>Giao việc: soạn 3 tiêu đề quảng cáo cho {state.projects[0]?.name ?? "Test offer US"}, giao cho {real.assistants[0]?.slug ?? "lumitest"}</pre>
        <p className="small muted" style={{ margin: 0 }}>Bot trả lời mã bản nháp (dạng <code>OK xxxxxxxx</code>); bản nháp hiện ngay bên dưới và hết hạn sau 15 phút.</p>
      </div>

      <h2 style={{ fontSize: "1.05rem", margin: "6px 0" }}>Bản nháp chờ xác nhận ({state.tgDrafts.length})</h2>
      {state.tgDrafts.length === 0 ? (
        <Empty>Chưa có bản nháp nào.</Empty>
      ) : (
        <div className="l-card" data-testid="draft-list">
          {state.tgDrafts.map((d) => (
            <div key={d.id} className="l-row" style={{ justifyContent: "space-between", gap: 10, padding: "6px 0", flexWrap: "wrap" }} data-draft={d.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div><span className="small muted">OK {d.id.slice(0, 8)}</span> · {d.sourceText}</div>
                <div className="small muted">Dự án: {projectName(d.projectId)} · Người nhận: {botName(d.assigneeId)}{!d.projectId ? " · THIẾU dự án" : ""}</div>
              </div>
              {canManage && (
                <div className="l-row">
                  <button className="l-btn good" disabled={busy || !d.projectId} onClick={() => go(async () => { const r = await dispatch({ type: "tg.draftConfirm", draftId: d.id }); if (r.ok && r.taskId && r.code !== "already") window.location.assign(`/lumi/projects/${state.tasks.find((t) => t.id === r.taskId)?.projectId ?? d.projectId}?task=${r.taskId}`); })}>
                    <Check size={14} /> Xác nhận
                  </button>
                  <button className="l-btn" disabled={busy} onClick={() => go(() => dispatch({ type: "tg.draftCancel", draftId: d.id }))}><X size={14} /> Bỏ</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: "1.05rem", margin: "18px 0 6px" }}>Trợ lý, giao việc và dừng khẩn cấp</h2>
      <AssistantPanel assistants={real.assistants} role={real.role} emergencyStop={real.emergencyStop} m1Enabled={real.m1Enabled} />
      {real.role !== "OWNER" && <p className="small muted">Chỉ OWNER bật/tắt giao việc và công tắc.</p>}
    </div>
  );
}
