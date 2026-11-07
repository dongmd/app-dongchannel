"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Send } from "lucide-react";

import { outputOfTask, project, STATUS_LABEL } from "@/lib/lumi/selectors";
import type { Chat, DemoState, TgDraft, TgMessage } from "@/lib/lumi/types";
import { Avatar } from "./avatar";
import { useLumi } from "./lumi-provider";
import { TaskDetail } from "./task-drawer";
import { LumiLink } from "./ui";

const SUGGESTIONS = [
  { label: "Giao việc: 3 mẫu quảng cáo", text: "Giao việc: soạn 3 mẫu quảng cáo Google Search cho Test offer US" },
  { label: "/viec dàn ý video", text: "/viec viết dàn ý video về công cụ AI cho Kênh tiếng Anh, hạn thứ Sáu" },
  { label: "Hỏi: Google Search?", text: "Nên chạy Google Search hay Facebook trước?" },
];

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export function TelegramSim() {
  const { state, dispatch } = useLumi();
  const [chat, setChat] = useState<Chat>("aff");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wide = useWide();
  const msgs = state.tgMessages.filter((m) => m.chat === chat);
  const bot = state.members.find((m) => m.profileKey === chat);

  // Việc hiển thị bên cạnh: việc vừa chọn; chưa chọn thì việc của thẻ mới nhất trong cuộc chat này.
  const lastTask = [...msgs]
    .reverse()
    .map((m) => (m.card?.type === "status" ? m.card.taskId : m.card?.type === "draft" ? state.tgDrafts.find((d) => d.id === (m.card as { draftId: string }).draftId)?.taskId : undefined))
    .find(Boolean);
  const shownTask = picked && state.tasks.some((t) => t.id === picked) ? picked : (lastTask ?? null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight; // chỉ cuộn khung chat, không cuộn cả trang
  }, [msgs.length, chat, state.rev]);

  async function send(t: string) {
    const v = t.trim();
    if (!v || busy) return;
    setBusy(true);
    setText("");
    await dispatch({ type: "tg.send", chat, text: v });
    setBusy(false);
  }

  return (
    <div className="l-grid" style={{ gap: 14 }}>
      <div>
        <h1>Telegram mô phỏng</h1>
        <p className="muted" style={{ margin: "4px 0 0", maxWidth: 760 }}>
          Trình mô phỏng để thử luồng giao việc. <strong>Không gửi tin Telegram thật</strong>, không gọi model. Hai cuộc chat dùng chung dữ liệu công việc với web.
        </p>
      </div>
      <div className="l-tabs" role="tablist" aria-label="Cuộc chat">
        <button role="tab" aria-selected={chat === "aff"} onClick={() => { setChat("aff"); setPicked(null); }}>Trợ lý AFF</button>
        <button role="tab" aria-selected={chat === "yt"} onClick={() => { setChat("yt"); setPicked(null); }}>Trợ lý YouTube</button>
      </div>
      <div className="l-tg-layout">
        <div className="l-phone" data-testid="phone" data-chat={chat}>
          <header>
            {bot && <Avatar avatar={bot.avatar} size={34} />}
            <div>
              <div style={{ fontWeight: 650 }}>{bot?.name ?? "Bot"}</div>
              <div className="small muted">bot mô phỏng · không phải Telegram thật</div>
            </div>
          </header>
          <div className="l-msgs" aria-live="polite" ref={listRef}>
            {msgs.map((m) => <Message key={m.id} m={m} state={state} wide={wide} onPick={setPicked} picked={shownTask} />)}
          </div>
          <div className="l-tg-suggest" aria-label="Gợi ý tin nhắn">
            {SUGGESTIONS.map((s) => (
              <button key={s.label} className="l-tgbtn" onClick={() => setText(s.text)} title={s.text}>{s.label}</button>
            ))}
          </div>
          <form className="l-compose" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            <input className="l-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nhắn cho bot… (/viec hoặc «Giao việc:»)" aria-label="Tin nhắn" />
            <button className="l-btn primary" type="submit" disabled={busy || !text.trim()} aria-label="Gửi"><Send size={16} /></button>
          </form>
        </div>
        <aside className="l-tg-side" aria-label="Việc đang chọn" data-testid="tg-side">
          <div className="l-card">
            <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <h2>Việc đang chọn</h2>
              <span className="small muted">cùng dữ liệu với web</span>
            </div>
            {shownTask ? <TaskDetail taskId={shownTask} /> : <p className="muted">Gửi «Giao việc: …» hoặc bấm «Xem việc» trên một thẻ để xem chi tiết tại đây.</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Message({ m, state, wide, onPick, picked }: { m: TgMessage; state: DemoState; wide: boolean; onPick: (id: string) => void; picked: string | null }) {
  if (!m.card) return <div className={`l-msg ${m.from}`}>{m.text}</div>;
  return (
    <>
      {m.text && <div className="l-msg bot">{m.text}</div>}
      <CardView m={m} state={state} wide={wide} onPick={onPick} picked={picked} />
    </>
  );
}

function CardView({ m, state, wide, onPick, picked }: { m: TgMessage; state: DemoState; wide: boolean; onPick: (id: string) => void; picked: string | null }) {
  const card = m.card!;
  switch (card.type) {
    case "draft":
      return <DraftCard draft={state.tgDrafts.find((d) => d.id === card.draftId)} state={state} onPick={onPick} wide={wide} />;
    case "status":
      return <StatusCard m={m} state={state} wide={wide} onPick={onPick} picked={picked} />;
    case "convert":
      return <ConvertCard m={m} />;
    case "feedback_prompt":
      return <div className="l-msg bot">{m.text}</div>;
  }
}

function ConvertCard({ m }: { m: TgMessage }) {
  const { dispatch } = useLumi();
  const card = m.card as Extract<NonNullable<TgMessage["card"]>, { type: "convert" }>;
  return (
    <div className="l-tgbtns" style={{ marginTop: -2 }}>
      <button className="l-tgbtn" disabled={!!card.draftId} onClick={() => dispatch({ type: "tg.convert", messageId: m.id })}>
        {card.draftId ? "Đã chuyển thành thẻ việc" : "Chuyển thành việc"}
      </button>
    </div>
  );
}

function DraftCard({ draft, state, onPick, wide }: { draft: TgDraft | undefined; state: DemoState; onPick: (id: string) => void; wide: boolean }) {
  const { dispatch } = useLumi();
  const [busy, setBusy] = useState(false);
  if (!draft) return <div className="l-msg bot">Thẻ không còn tồn tại.</div>;
  const proj = draft.projectId ? project(state, draft.projectId) : undefined;
  const assignee = state.members.find((m) => m.id === draft.assigneeId);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  if (draft.state === "created") {
    const t = state.tasks.find((x) => x.id === draft.taskId);
    return (
      <div className="l-card-tg" data-testid="tg-created">
        <div>✅ Đã tạo việc <strong>{draft.taskId}</strong></div>
        <div className="small muted l-clamp2">{t?.title} · {proj?.name} · {t?.ownerName}</div>
        {t && <div className="small muted">Nguồn: {t.source.label} (mô phỏng)</div>}
        <div className="l-tgbtns">
          {wide && <button className="l-tgbtn" onClick={() => draft.taskId && onPick(draft.taskId)}>Xem việc</button>}
          <LumiLink className="l-tgbtn" href={`/lumi/projects/${draft.projectId}?task=${draft.taskId}`} data-testid="tg-open-web">
            Mở trên Dong-Lumi <ExternalLink size={12} style={{ display: "inline" }} />
          </LumiLink>
        </div>
      </div>
    );
  }
  if (draft.state === "cancelled") return <div className="l-msg bot muted">Đã hủy thẻ việc.</div>;

  return (
    <div className="l-card-tg" data-testid="tg-draft" data-draft={draft.id}>
      {draft.step === "pick_project" ? (
        <>
          <div><strong>Việc này thuộc dự án nào?</strong></div>
          <div className="small muted l-clamp2">«{draft.title}»</div>
          <div className="l-tgbtns">
            {state.projects.filter((p) => p.status === "active").map((p) => (
              <button key={p.id} className="l-tgbtn" disabled={busy} onClick={() => run(() => dispatch({ type: "tg.draftSetProject", draftId: draft.id, projectId: p.id }))}>{p.name}</button>
            ))}
            <button className="l-tgbtn" onClick={() => run(() => dispatch({ type: "tg.draftCancel", draftId: draft.id }))}>Hủy</button>
          </div>
        </>
      ) : draft.step === "pick_assignee" ? (
        <>
          <div><strong>Giao cho ai?</strong></div>
          <div className="l-tgbtns">
            {state.members.filter((m) => m.status === "active" && (m.kind === "human" || !draft.projectId || m.projectIds.includes(draft.projectId))).map((m) => (
              <button key={m.id} className="l-tgbtn" disabled={busy} onClick={() => run(() => dispatch({ type: "tg.draftSetAssignee", draftId: draft.id, assigneeId: m.id }))}>
                {m.kind === "human" ? "Tôi tự nhận" : m.name}
              </button>
            ))}
            <button className="l-tgbtn" onClick={() => run(() => dispatch({ type: "tg.draftStep", draftId: draft.id, step: "main" }))}>Quay lại</button>
          </div>
        </>
      ) : (
        <>
          <div><strong>Xác nhận tạo việc</strong></div>
          <div className="l-clamp2" style={{ margin: "4px 0" }}>{draft.title}</div>
          <div className="small muted">Dự án: <strong style={{ color: "#dbe8ff" }}>{proj?.name}</strong></div>
          <div className="small muted">Người nhận: <strong style={{ color: "#dbe8ff" }}>{assignee?.kind === "human" ? "Tôi tự nhận" : assignee?.name}</strong></div>
          <div className="small muted">Đầu ra mong muốn: {draft.outputWanted}</div>
          {draft.due && <div className="small muted">Hạn: {draft.due}</div>}
          <div className="l-tgbtns">
            <button className="l-tgbtn" disabled={busy} onClick={() => run(() => dispatch({ type: "tg.draftConfirm", draftId: draft.id }))}>Tạo việc</button>
            <button className="l-tgbtn" disabled={busy} onClick={() => run(() => dispatch({ type: "tg.draftStep", draftId: draft.id, step: "pick_project" }))}>Đổi dự án</button>
            <button className="l-tgbtn" disabled={busy} onClick={() => run(() => dispatch({ type: "tg.draftStep", draftId: draft.id, step: "pick_assignee" }))}>Đổi người</button>
            <button className="l-tgbtn" disabled={busy} onClick={() => run(() => dispatch({ type: "tg.draftCancel", draftId: draft.id }))}>Hủy</button>
          </div>
        </>
      )}
    </div>
  );
}

function StatusCard({ m, state, wide, onPick, picked }: { m: TgMessage; state: DemoState; wide: boolean; onPick: (id: string) => void; picked: string | null }) {
  const { dispatch } = useLumi();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const card = m.card as Extract<NonNullable<TgMessage["card"]>, { type: "status" }>;
  const t = state.tasks.find((x) => x.id === card.taskId);
  if (!t) return null;
  const out = outputOfTask(state, t);
  const latest = out?.versions.length ?? 0;
  const isCurrent = card.version === latest;
  const version = out?.versions.find((v) => v.v === card.version);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  // Nút của bản cũ hoặc việc đã xong vẫn bấm được nhưng bị máy chủ chặn (không duyệt trùng): hiện mờ để dễ nhận ra.
  const live = isCurrent && t.status === "review";
  // Một dòng trạng thái duy nhất (không lặp lại nhãn trạng thái và ghi chú).
  let line: string;
  if (out?.state === "approved" && out.approvedVersion === card.version) line = `✅ Đã duyệt bản ${card.version}`;
  else if (!isCurrent) line = `Bản ${card.version} đã cũ, hiện có bản ${latest}`;
  else if (t.status === "doing") line = "Đang sửa theo góp ý…";
  else if (t.status === "review") line = "Chờ bạn duyệt nội dung";
  else line = STATUS_LABEL[t.status];

  return (
    <div className="l-card-tg" data-testid="tg-status" data-task={t.id} data-version={card.version} style={picked === t.id && wide ? { borderColor: "#6aa6ff" } : undefined}>
      <div className="l-clamp2" title={t.title}><strong>{t.id}</strong> · {t.title}</div>
      <div className="small muted">Bản {card.version}{version ? ` · ${version.sections.length} mục` : ""}</div>
      <div className="small" style={{ margin: "4px 0", color: "#cfe1ff" }} data-testid="tg-state">{line}</div>
      {!wide && open && version && (
        <div className="small" style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
          {version.sections.map((s) => `• ${s.heading}\n${s.body}`).join("\n\n")}
        </div>
      )}
      <div className="l-tgbtns">
        <button className="l-tgbtn" onClick={() => (wide ? onPick(t.id) : setOpen((v) => !v))}>{wide ? "Xem việc" : open ? "Ẩn nội dung" : "Xem nội dung"}</button>
        <LumiLink className="l-tgbtn" href={`/lumi/projects/${t.projectId}?task=${t.id}`}>Mở trên Dong-Lumi</LumiLink>
        <button className="l-tgbtn" style={live ? undefined : { opacity: 0.55 }} disabled={busy} onClick={() => run(() => dispatch({ type: "task.approveOutput", taskId: t.id, via: "telegram", version: card.version }))}>Duyệt nội dung</button>
        <button className="l-tgbtn" style={live ? undefined : { opacity: 0.55 }} disabled={busy} onClick={() => run(() => dispatch({ type: "tg.feedbackPrompt", taskId: t.id, chat: m.chat }))}>Yêu cầu sửa</button>
      </div>
    </div>
  );
}
