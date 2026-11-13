"use client";
/**
 * Công tắc giao việc (chỉ OWNER). Thiết kế để KHÔNG ai phải đoán đang bật hay tắt:
 *   • mỗi công tắc hiện TRẠNG THÁI HIỆN TẠI bằng chữ + màu (xanh = đang bật, đỏ/xám = đang tắt), và là công tắc trượt;
 *   • mọi thay đổi đều hỏi xác nhận bằng một câu nói rõ hậu quả;
 *   • một dòng «Tóm tắt» cho biết bot nào đang nhận việc và cái gì đang chặn bot còn lại;
 *   • sau khi bấm có thông báo kết quả (thành công hoặc lý do bị chặn).
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, explain } from "./api";

interface A { id: string; name: string; slug: string; connection_state: string; dispatch_enabled: boolean; hermes_profile: string | null }

const ON = { background: "rgba(46,160,67,0.16)", color: "#3fb950", border: "1px solid rgba(46,160,67,0.55)" } as const;
const OFF = { background: "rgba(139,148,158,0.14)", color: "#9aa4af", border: "1px solid rgba(139,148,158,0.4)" } as const;
const BAD = { background: "rgba(248,81,73,0.16)", color: "#ff7b72", border: "1px solid rgba(248,81,73,0.55)" } as const;
const pill = (s: Record<string, string>) => ({ ...s, borderRadius: 999, padding: "3px 12px", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" as const });

function Switch({ on, disabled, label, onClick, testid }: { on: boolean; disabled?: boolean; label: string; onClick: () => void; testid: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick} data-testid={testid} data-on={on ? "1" : "0"}
      style={{ width: 52, height: 28, borderRadius: 999, border: "none", padding: 3, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, background: on ? "#2ea043" : "#6e7681", display: "flex", justifyContent: on ? "flex-end" : "flex-start", transition: "all .15s", flex: "none" }}>
      <span style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", display: "block" }} />
    </button>
  );
}

export function AssistantPanel({ assistants, role, emergencyStop, m1Enabled }: { assistants: A[]; role: string; emergencyStop: boolean; m1Enabled: boolean }) {
  const router = useRouter();
  const [m1, setM1] = useState(m1Enabled); const [stop, setStop] = useState(emergencyStop);
  const [disp, setDisp] = useState<Record<string, boolean>>(() => Object.fromEntries(assistants.map((a) => [a.id, a.dispatch_enabled])));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setM1(m1Enabled); }, [m1Enabled]);
  useEffect(() => { setStop(emergencyStop); }, [emergencyStop]);
  useEffect(() => { setDisp(Object.fromEntries(assistants.map((a) => [a.id, a.dispatch_enabled]))); }, [assistants]);
  if (role !== "OWNER") return null;

  async function change(confirmText: string, fn: () => ReturnType<typeof api>, apply: () => void, doneText: string) {
    if (busy || !window.confirm(confirmText)) return;
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { apply(); setMsg({ ok: true, text: doneText }); router.refresh(); } else setMsg({ ok: false, text: `Không thực hiện được: ${explain(r)}` });
  }

  const receiving = assistants.filter((a) => disp[a.id] && a.connection_state === "VERIFIED");
  const blocked = assistants.filter((a) => !receiving.includes(a));
  const why = (a: A) => (a.connection_state !== "VERIFIED" ? "chưa kết nối thật" : !disp[a.id] ? "giao việc đang tắt" : "");
  const ready = m1 && !stop && receiving.length > 0;

  return (
    <section className="l-card l-grid" style={{ gap: 14 }} aria-label="Trợ lý và công tắc" data-testid="switch-panel">
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Công tắc giao việc <span className="small muted">(chỉ Chủ)</span></h2>

      <div data-testid="readiness-summary" role="status" style={{ ...(ready ? ON : BAD), borderRadius: 10, padding: "10px 14px" }}>
        <strong>{ready ? "SẴN SÀNG: hệ thống đang giao việc cho bot." : "CHƯA GIAO VIỆC ĐƯỢC."}</strong>
        <div className="small" style={{ marginTop: 4, color: "inherit" }}>
          {!m1 ? "① Luồng giao việc đang TẮT — bật công tắc tổng ở bước ①. " : "① Luồng giao việc: bật. "}
          {stop ? "② Đang DỪNG KHẨN CẤP — mở lại ở bước ②. " : "② Không dừng khẩn cấp. "}
          {receiving.length > 0 ? `③ Bot đang nhận việc: ${receiving.map((a) => a.slug).join(", ")}. ` : "③ Chưa bot nào nhận việc — bật công tắc của bot ở bước ③. "}
          {blocked.length > 0 ? `Bot chưa nhận: ${blocked.map((a) => `${a.slug} (${why(a)})`).join(", ")}.` : ""}
        </div>
      </div>

      <div className="l-row" style={{ gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <strong>① Luồng giao việc (công tắc tổng)</strong>
          <div className="small muted">Tắt thì KHÔNG bot nào nhận việc mới, kể cả bot đã bật. Bật thì các bot đã bật giao việc bắt đầu nhận.</div>
        </div>
        <span style={pill(m1 ? ON : BAD)} data-testid="m1-state">{m1 ? "ĐANG BẬT" : "ĐANG TẮT"}</span>
        <Switch on={m1} disabled={busy} label="Luồng giao việc" testid="m1-switch"
          onClick={() => void change(m1 ? "TẮT luồng giao việc?\nKhông bot nào nhận việc mới nữa (việc đang chạy không bị giết)." : "BẬT luồng giao việc?\nCác bot đã bật giao việc sẽ bắt đầu nhận việc và có thể chạy mô hình có phí.", () => api("POST", "/api/v1/lumi/flags", { key: "m1_enabled", value: !m1 }), () => setM1(!m1), m1 ? "Đã TẮT luồng giao việc." : "Đã BẬT luồng giao việc.")} />
      </div>

      <div className="l-row" style={{ gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <strong>② Dừng khẩn cấp</strong>
          <div className="small muted">Bật khi cần chặn ngay mọi việc mới và hành động ra ngoài. Bình thường để TẮT («Bình thường»).</div>
        </div>
        <span style={pill(stop ? BAD : ON)} data-testid="stop-state">{stop ? "ĐANG DỪNG KHẨN CẤP" : "BÌNH THƯỜNG"}</span>
        <Switch on={stop} disabled={busy} label="Dừng khẩn cấp" testid="stop-switch"
          onClick={() => void change(stop ? "MỞ LẠI sau dừng khẩn cấp?\nHệ thống nhận việc trở lại." : "DỪNG KHẨN CẤP?\nChặn ngay việc mới và hành động ra ngoài cho tới khi bạn mở lại.", () => api("POST", "/api/v1/lumi/flags", { key: "emergency_stop", value: !stop }), () => setStop(!stop), stop ? "Đã MỞ LẠI (hết dừng khẩn cấp)." : "Đã DỪNG KHẨN CẤP.")} />
      </div>

      <div>
        <strong>③ Từng bot nhận việc</strong>
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
          {assistants.map((a) => {
            const on = !!disp[a.id]; const verified = a.connection_state === "VERIFIED";
            return (
              <li key={a.id} data-testid={`bot-row-${a.slug}`} className="l-row" style={{ gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid rgba(139,148,158,0.25)" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <strong>{a.name}</strong> <span className="small muted">({a.slug} · profile {a.hermes_profile ?? "—"})</span>
                  <div className="small" style={{ color: verified ? "#3fb950" : "#ff7b72" }}>{verified ? "Đã kết nối thật" : `Chưa kết nối thật (${a.connection_state}) — kiểm tra kết nối ở màn Tổ chức trước`}</div>
                </div>
                <span style={pill(on && verified ? ON : OFF)} data-testid={`bot-state-${a.slug}`}>{on ? "ĐANG NHẬN VIỆC" : "ĐANG TẮT"}</span>
                <Switch on={on} disabled={busy || (!verified && !on)} label={`Giao việc cho ${a.name}`} testid={`bot-switch-${a.slug}`}
                  onClick={() => void change(on ? `TẮT giao việc cho ${a.name}?\nBot này không nhận việc mới.` : `BẬT giao việc cho ${a.name}?\nBot có thể nhận việc và chạy mô hình có phí (trong giới hạn lượt của hồ sơ bot).`, () => api("POST", `/api/v1/lumi/assistants/${a.id}/dispatch`, { enabled: !on }), () => setDisp({ ...disp, [a.id]: !on }), on ? `Đã TẮT giao việc cho ${a.name}.` : `Đã BẬT giao việc cho ${a.name}.`)} />
              </li>
            );
          })}
          {assistants.length === 0 && <li className="muted" style={{ padding: "8px 0" }}>Chưa có trợ lý nào. Tạo ở màn Tổ chức.</li>}
        </ul>
      </div>

      {msg && <p role="status" data-testid="switch-msg" style={{ margin: 0, ...(msg.ok ? ON : BAD), borderRadius: 8, padding: "8px 12px" }}>{msg.text}</p>}
    </section>
  );
}
