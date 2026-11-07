"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */

import { useCallback, useEffect, useState } from "react";

import { errText, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { fmtFull, Modal } from "./ui";

/**
 * "Quyền & tự chủ" of one assistant (OWNER only). Four DIFFERENT things stay separate (TDD 8.11): which tools the profile keeps (capability mode),
 * how far it may continue by itself (autonomy limits), and the explicit, limited, expiring grants for actions outside (Q3).
 * Changing the capability mode switches dispatch OFF until the assistant is checked and switched on again.
 */
export function AuthorityDialog({ a, projects, onClose, onChanged }: { a: any | null; projects: { id: string; name: string }[]; onClose: () => void; onChanged: () => void }) {
  const [grants, setGrants] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [full, setFull] = useState(false); const [ack, setAck] = useState(false);
  const [mc, setMc] = useState(""); const [ms, setMs] = useState("");
  const [g, setG] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");

  const loadGrants = useCallback(async () => {
    if (!a) return;
    const r = await lumiApi(`/api/v1/lumi/assistants/${a.id}/grants`);
    if (r.ok) setGrants(r.data.grants); else setErr(errText(r.error));
  }, [a]);
  useEffect(() => {
    if (!a) return;
    setMsg(null); setErr(null); setBusy(false); setKey(newKey()); setAck(false); setFull(a.capability_mode === "DECLARED_FULL");
    setMc(String(a.max_continuations ?? 0)); setMs(String(a.max_subtasks ?? 0)); setGrants(null); setG({ project: projects[0]?.id ?? "" });
    void loadGrants();
    // Reset ONLY when a different assistant is opened: the list behind refreshes every few seconds and must not wipe what the owner is typing or ticking.
  }, [a?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function call(path: string, body: unknown, ok: string, k?: string) {
    if (busy) return; setBusy(true); setMsg(null); setErr(null);
    const r = await lumiApi(path, { method: "POST", body, key: k });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.error)); return r; }
    setMsg(ok); onChanged(); await loadGrants();
    return r;
  }
  const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const row = (k: string, label: string, ph?: string, type = "text") => <label className="l-label" style={{ flex: 1, minWidth: 140 }}>{label}<input className="l-input" type={type} step="any" value={g[k] ?? ""} onChange={(e) => setG((p: any) => ({ ...p, [k]: e.target.value }))} placeholder={ph} data-testid={`gr-${k}`} /></label>;

  return (
    <Modal open={a !== null} onClose={onClose} title={`Quyền & tự chủ — ${a?.name ?? ""}`} wide>
      <div className="l-grid" style={{ gap: 14 }} data-testid="authority-dialog">
        {msg && <div className="l-note" role="status" data-testid="auth-msg">{msg}</div>}
        {err && <div className="l-note" role="alert" data-testid="auth-error">{err}</div>}

        <section>
          <h3 style={{ margin: "0 0 4px" }}>1. Công cụ của profile</h3>
          <p className="small muted" style={{ margin: "0 0 6px" }}><strong>RESTRICTED</strong>: profile Hermes chỉ được bật đúng danh sách công cụ đã chọn (kiểm khi kiểm tra kết nối/bật giao việc). <strong>DECLARED_FULL</strong>: bạn khai báo bot giữ đủ công cụ; ứng dụng không chặn terminal/trình duyệt/tệp của nó — đó là <em>công cụ</em>, không phải <em>quyền hành động</em>.</p>
          <label className="small l-row" style={{ gap: 6 }}><input type="radio" checked={!full} onChange={() => setFull(false)} data-testid="cap-restricted" /> RESTRICTED (khuyến nghị)</label>
          <label className="small l-row" style={{ gap: 6 }}><input type="radio" checked={full} onChange={() => setFull(true)} data-testid="cap-full" /> DECLARED_FULL</label>
          {full && <label className="small l-row" style={{ gap: 6, marginTop: 4 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="cap-ack" /> Tôi hiểu và xác nhận (ghi tên tôi và thời điểm)</label>}
          <div className="l-row" style={{ gap: 8, marginTop: 6 }}>
            <button className="l-btn sm primary" disabled={busy || (full === (a?.capability_mode === "DECLARED_FULL")) || (full && !ack)} data-testid="cap-save"
              onClick={() => void call(`/api/v1/lumi/assistants/${a.id}/capability`, { mode: full ? "DECLARED_FULL" : "RESTRICTED", acknowledged: full && ack }, "Đã đổi chế độ công cụ. Giao việc đã TẮT; kiểm tra kết nối rồi bật lại.")}>Đổi chế độ (tắt giao việc)</button>
            <span className="small muted">Hiện tại: {a?.capability_mode}{a?.capability_ack_at ? ` · xác nhận bởi ${String(a.capability_ack_by).replace(/^web:/, "")} lúc ${fmtFull(a.capability_ack_at)}` : ""}</span>
          </div>
        </section>

        <section>
          <h3 style={{ margin: "0 0 4px" }}>2. Giới hạn tự chủ</h3>
          <div className="l-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="l-label" style={{ width: 200 }}>Số lần tự tiếp tục tối đa (0–50)<input className="l-input" inputMode="numeric" value={mc} onChange={(e) => setMc(e.target.value)} data-testid="au-continuations" /></label>
            <label className="l-label" style={{ width: 200 }}>Số việc con tối đa (0–100)<input className="l-input" inputMode="numeric" value={ms} onChange={(e) => setMs(e.target.value)} data-testid="au-subtasks" /></label>
            <button className="l-btn sm" disabled={busy} data-testid="au-save" onClick={() => void call(`/api/v1/lumi/assistants/${a.id}/autonomy`, { max_continuations: n(mc), max_subtasks: n(ms) }, "Đã lưu giới hạn tự chủ.")}>Lưu</button>
          </div>
        </section>

        <section>
          <h3 style={{ margin: "0 0 4px" }}>3. Giấy ủy quyền hành động bên ngoài (Q3)</h3>
          <p className="small muted" style={{ margin: "0 0 6px" }}>Mỗi giấy nêu đúng tài khoản, loại hành động, hạn mức và hạn dùng; hết hạn hoặc bị thu hồi thì không còn hiệu lực. Trong phạm vi giấy, bot không hỏi lại; ngoài phạm vi nó phải hỏi bạn.</p>
          {grants === null ? <p className="muted">Đang tải…</p> : grants.length === 0 ? <p className="small muted" data-testid="grants-empty">Chưa có giấy ủy quyền nào.</p> : (
            <ul className="small" style={{ margin: "0 0 8px", paddingLeft: 18 }} data-testid="grants-list">
              {grants.map((x) => {
                const live = x.state === "ACTIVE" && new Date(x.valid_until).getTime() > Date.now();
                return (
                  <li key={x.id} data-testid="grant-row" data-state={live ? "ACTIVE" : x.state === "REVOKED" ? "REVOKED" : "EXPIRED"}>
                    <strong>{x.action_type}</strong> · {x.account_ref} · {x.project_name} · {x.budget_total !== null ? `ngân sách ${x.budget_total} ${x.currency ?? ""} (đã dùng ${x.spent})` : "không có hạn mức tiền"} · đến {fmtFull(x.valid_until)} · {live ? "đang hiệu lực" : x.state === "REVOKED" ? "đã thu hồi" : "hết hạn"}
                    {live && <button className="l-btn sm danger" style={{ marginLeft: 8 }} disabled={busy} data-testid="grant-revoke" onClick={() => void call(`/api/v1/lumi/grants/${x.id}/revoke`, {}, "Đã thu hồi giấy ủy quyền.")}>Thu hồi</button>}
                  </li>
                );
              })}
            </ul>
          )}
          <form className="l-grid" style={{ gap: 8, border: "1px solid var(--l-border)", borderRadius: 8, padding: 8 }} data-testid="grant-form"
            onSubmit={(e) => { e.preventDefault(); void call("/api/v1/lumi/grants", { assistant_id: a.id, project_id: g.project, account_ref: g.account_ref, action_type: g.action_type, currency: g.currency || undefined, per_action_max: n(g.per_action_max ?? ""), budget_total: n(g.budget_total ?? ""), count_limit: n(g.count_limit ?? ""), ask_if_amount_over: n(g.ask_if_amount_over ?? ""), valid_until: g.valid_until ? new Date(g.valid_until + "T23:59:59").toISOString() : "", note: g.note || undefined }, "Đã cấp giấy ủy quyền.", key).then(() => setKey(newKey())); }}>
            <div className="small"><strong>Cấp giấy mới</strong></div>
            <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="l-label" style={{ flex: 1, minWidth: 160 }}>Dự án<select className="l-select" value={g.project ?? ""} onChange={(e) => setG((p: any) => ({ ...p, project: e.target.value }))} required data-testid="gr-project">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              {row("account_ref", "Tài khoản (tham chiếu, không bí mật)", "vd google-ads-main")}
              {row("action_type", "Loại hành động", "vd ads.spend")}
            </div>
            <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
              {row("currency", "Tiền tệ", "USD")}{row("per_action_max", "Tối đa mỗi lần", "", "number")}{row("budget_total", "Tổng ngân sách", "", "number")}{row("count_limit", "Số lần tối đa", "", "number")}{row("ask_if_amount_over", "Hỏi lại nếu vượt", "", "number")}
            </div>
            <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="l-label" style={{ width: 200 }}>Có hiệu lực đến ngày (≤ 365 ngày)<input className="l-input" type="date" value={g.valid_until ?? ""} onChange={(e) => setG((p: any) => ({ ...p, valid_until: e.target.value }))} required data-testid="gr-valid_until" /></label>
              {row("note", "Ghi chú")}
            </div>
            <div><button className="l-btn primary sm" disabled={busy || !g.account_ref || !g.action_type} data-testid="gr-submit">Cấp giấy ủy quyền</button></div>
          </form>
        </section>
        <div className="l-row" style={{ justifyContent: "flex-end" }}><button className="l-btn" onClick={onClose}>Đóng</button></div>
      </div>
    </Modal>
  );
}
