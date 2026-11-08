"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";

import { CATEGORY_LABEL, GOAL_RESULT_LABEL, PLAN_STATUS_LABEL, PLAN_TONE, SOURCE_LABEL, TASK_STATUS_LABEL, VERSION_LABEL, errText, fmtMoney, lumiApi, newKey } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull, fmtTime, LumiLink, Modal } from "./ui";
import { ProgressBar } from "./progress-bar";

const AI_NOTE = "Chi phí AI chưa đo theo lượt. Trần ngân sách chỉ giới hạn các khoản được ghi vào sổ; không thay thế hạn mức ở tài khoản nhà cung cấp.";

export function PlanView({ id }: { id: string }) {
  const { state, toast } = useLumi();
  const isOwner = state.real?.role === "OWNER";
  const [d, setD] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dlg, setDlg] = useState<null | { kind: "confirm" | "revise" | "reject" | "cancel" | "reviseplan" | "ledger"; version?: any }>(null);

  const load = useCallback(async () => {
    const r = await lumiApi(`/api/v1/lumi/plans/${id}`);
    if (r.ok && r.data) { setD(r.data); setErr(null); } else setErr(errText(r.error));
    setLoading(false);
  }, [id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 4000);
    return () => clearInterval(t);
  }, [load]);

  const exec = d?.budgets?.find((b: any) => b.kind === "EXECUTE");
  const prep = d?.budgets?.find((b: any) => b.kind === "PREPARE");
  const pending = d?.versions?.find((v: any) => v.state === "SUBMITTED" && v.version === d.plan.current_version);
  const approved = d?.versions?.find((v: any) => v.state === "APPROVED");
  const live = d && !["REJECTED", "CANCELLED", "DONE", "PARTIAL_DONE"].includes(d.plan.status);
  const diff = useMemo(() => (pending ? diffBodies(approved?.body, pending.body, approved?.ceiling_amount, pending.ceiling_amount) : null), [pending, approved]);

  if (loading) return <p className="muted" data-testid="plan-loading">Đang tải…</p>;
  if (err || !d) return <div className="l-note" role="alert" data-testid="plan-error">Không tải được kế hoạch: {err} <button className="l-btn sm" onClick={() => void load()}>Thử lại</button></div>;
  const { plan, goal } = d;

  async function post(path: string, body: any, okMsg: string, key?: string) {
    const r = await lumiApi(path, { method: "POST", body, key });
    if (!r.ok) { toast(`Không thực hiện được: ${errText(r.error)}`); return r; }
    toast(r.data?.already_processed ? "Đã xử lý trước đó, không làm lại." : okMsg);
    void load();
    return r;
  }

  return (
    <div className="l-grid" style={{ gap: 16 }} data-testid="plan-view">
      <ProgressBar planId={id} />
      <div>
        <LumiLink href="/lumi/company" className="small muted l-row" style={{ gap: 4 }}><ArrowLeft size={14} /> Tổng quan công ty</LumiLink>
        <h1 style={{ margin: "6px 0 2px" }}>{plan.code} · {goal.title}</h1>
        <div className="l-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className={`l-badge ${PLAN_TONE[plan.status] ?? ""}`} data-testid="plan-status">{PLAN_STATUS_LABEL[plan.status] ?? plan.status}</span>
          <span className="small muted">Mục tiêu {goal.code}{goal.status === "CLOSED" ? ` · đã đóng: ${GOAL_RESULT_LABEL[goal.result] ?? goal.result}` : " · đang theo đuổi"} · trưởng kế hoạch: {plan.lead_name}</span>
        </div>
        <p className="muted" style={{ margin: "6px 0 0" }}>{goal.outcome}</p>
      </div>
      <div className="l-banner" role="note" data-testid="plan-honesty"><strong>Đọc kỹ.</strong><span>{state.real?.hermesMode}. {AI_NOTE} Nội dung kế hoạch do bot lập, chưa được kiểm chứng sự thật; duyệt không thay cho kiểm chứng.</span></div>

      {plan.status === "PAUSED_ADJUSTMENT" && <div className="l-note" role="alert" data-testid="plan-paused"><strong>Tạm dừng chờ điều chỉnh ngân sách.</strong> Phần thực tế đã ghi cộng cam kết vượt trần. Việc mới không được gửi cho bot. Yêu cầu bot lập phiên bản mới với trần cao hơn hoặc giảm phạm vi.</div>}
      {plan.status === "DRAFTING" && <PlanningState d={d} canAct={state.real?.role !== "VIEWER"} onRetry={(pt: any) => void post(`/api/v1/tasks/${pt.id}/runs`, { mode: "RETRY", expected_status: pt.status }, "Đã giao lại cho bot lập kế hoạch (một lượt chạy mới).", newKey())} />}
      {plan.status === "NEEDS_REVISION" && !pending && <PlanningState d={d} canAct={state.real?.role !== "VIEWER"} onRetry={(pt: any) => void post(`/api/v1/tasks/${pt.id}/runs`, { mode: "RETRY", expected_status: pt.status }, "Đã giao lại cho bot sửa kế hoạch (một lượt chạy mới).", newKey())} />}

      {pending && (
        <section className="l-card" data-testid="pending-version">
          <h2 style={{ marginTop: 0 }}>Phiên bản {pending.version} chờ bạn duyệt</h2>
          <p className="small muted">Bước 1 — xem nội dung và phạm vi. Bước 2 — xác nhận. Sau khi xác nhận, bot tự thực hiện trong phạm vi này mà không hỏi lại từng thao tác; phần vượt trần, thay đổi ngoài phạm vi hoặc ngoại lệ sẽ quay lại hỏi bạn.</p>
          <BodyView v={pending} diff={diff} />
          {isOwner ? (
            <div className="l-row" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <button className="l-btn primary" onClick={() => setDlg({ kind: "confirm", version: pending })} data-testid="plan-approve-open"><ShieldCheck size={15} /> Duyệt… (bước 2: xác nhận)</button>
              <button className="l-btn" onClick={() => setDlg({ kind: "revise", version: pending })} data-testid="plan-revise-open">Yêu cầu sửa</button>
              <button className="l-btn danger" onClick={() => setDlg({ kind: "reject", version: pending })} data-testid="plan-reject-open">Từ chối</button>
              {plan.status === "PENDING_APPROVAL" && <button className="l-btn ghost" onClick={() => void post(`/api/v1/lumi/plans/${id}/decide`, { version: pending.version, content_hash: pending.content_hash, decision: "DEFER" }, "Đã hoãn.")}>Hoãn</button>}
              {plan.status === "DEFERRED" && <button className="l-btn" onClick={() => void post(`/api/v1/lumi/plans/${id}/decide`, { version: pending.version, content_hash: pending.content_hash, decision: "RESUME" }, "Đã tiếp tục chờ duyệt.")}>Tiếp tục chờ duyệt</button>}
            </div>
          ) : <p className="small muted">Chỉ Chủ (OWNER) được duyệt.</p>}
        </section>
      )}

      {approved && (
        <section className="l-card" data-testid="approved-version">
          <h2 style={{ marginTop: 0 }}>Phiên bản đang áp dụng: {approved.version}</h2>
          <BodyView v={approved} compact />
        </section>
      )}

      <section className="l-card" data-testid="plan-versions">
        <h2 style={{ marginTop: 0 }}>Các phiên bản và quyết định</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {d.versions.map((v: any) => {
            const ap = d.approvals.find((a: any) => a.object_version === v.version);
            return <li key={v.id}>v{v.version} · {VERSION_LABEL[v.state] ?? v.state} · trần {fmtMoney(v.ceiling_amount, v.currency)} · {fmtTime(v.submitted_at)}{ap ? ` · Chủ: ${ap.decision}${ap.reason ? ` («${ap.reason}»)` : ""} lúc ${fmtFull(ap.decided_at)}` : ""}{v.expires_at && v.state === "SUBMITTED" ? ` · hết hạn ${fmtFull(v.expires_at)}` : ""}</li>;
          })}
        </ul>
      </section>

      <section className="l-card" data-testid="plan-tasks">
        <h2 style={{ marginTop: 0 }}>Việc trong kế hoạch</h2>
        {d.tasks.filter((t: any) => t.key).length === 0 ? <Empty>Chưa có việc nào. Việc được tạo khi bạn duyệt một phiên bản.</Empty> : (
          <div style={{ overflowX: "auto" }}>
            <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th align="left">Mã</th><th align="left">Việc</th><th align="left">Trạng thái</th><th align="left">Đầu ra</th><th align="right">Cam kết còn mở</th></tr></thead>
              <tbody>
                {d.tasks.filter((t: any) => t.key).map((t: any) => (
                  <tr key={t.id} data-testid={`task-${t.key}`}>
                    <td>{t.code}</td><td>{t.title}<div className="small muted">{t.acceptance}</div></td>
                    <td>{TASK_STATUS_LABEL[t.status] ?? t.status}{t.needs_decision ? " · cần quyết định" : ""}</td>
                    <td>{t.out_version ? `v${t.out_version} · ${t.out_state}` : "—"}</td>
                    <td align="right">{fmtMoney(t.committed_open, exec?.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>Hoàn tất một việc = bạn đã duyệt đầu ra của nó. Kế hoạch chỉ hoàn tất khi mọi việc đã xong hoặc hủy và có báo cáo cuối. Mục tiêu chỉ đóng khi bạn chốt kết quả.</p>
      </section>

      <section className="l-card" data-testid="plan-ledger">
        <h2 style={{ marginTop: 0 }}>Ngân sách và sổ</h2>
        {exec ? (
          <div className="l-metrics">
            <Metric label="Trần đã duyệt" value={fmtMoney(exec.ceiling, exec.currency)} />
            <Metric label="Cam kết còn mở" value={fmtMoney(exec.committed, exec.currency)} />
            <Metric label="Thực tế đã biết" value={fmtMoney(exec.actual, exec.currency)} />
            <Metric label="Khả dụng" value={fmtMoney(Number(exec.ceiling) - Number(exec.actual) - Number(exec.committed) - Number(exec.reserve), exec.currency)} />
            <Metric label="Lượt chạy chưa biết chi phí AI" value={`${exec.unknown_count} lượt`} testid="unknown-count" />
          </div>
        ) : <p className="muted">Chưa có ngân sách thực thi (chưa duyệt phiên bản nào).</p>}
        {prep && <p className="small muted">Chuẩn bị (lập kế hoạch): chỉ ghi nhận, không có trần · {prep.unknown_count} lượt chạy chưa biết chi phí AI · thực tế đã biết {fmtMoney(prep.actual, prep.currency)}.</p>}
        <p className="small" role="note" data-testid="ai-cost-note">{AI_NOTE}</p>
        {isOwner && live && <button className="l-btn sm" onClick={() => setDlg({ kind: "ledger" })} data-testid="ledger-open">Ghi khoản chi thực tế</button>}
        {d.ledger.length > 0 && (
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th align="left">Thời điểm</th><th align="left">Loại</th><th align="left">Mục</th><th align="right">Số tiền</th><th align="left">Nguồn</th><th align="left">Đối soát</th></tr></thead>
              <tbody>
                {d.ledger.map((e: any) => (
                  <tr key={e.id}>
                    <td>{fmtTime(e.occurred_at)}</td><td>{e.entry_type}</td><td>{CATEGORY_LABEL[e.category] ?? e.category}{e.note ? <span className="small muted"> · {e.note}</span> : null}</td>
                    <td align="right">{fmtMoney(e.amount, e.currency)}</td><td>{SOURCE_LABEL[e.source] ?? e.source}</td>
                    <td>{e.entry_type === "ACTUAL" && e.amount !== null ? (e.reconciliation === "RECONCILED" ? `đã đối soát (${e.reconciliation_key})` : isOwner ? <button className="l-btn sm ghost" onClick={() => void post(`/api/v1/lumi/plans/${id}/reconcile`, { entry_ids: [e.id], reconciliation_key: window.prompt("Mã sao kê / chứng từ đối soát?") ?? "" }, "Đã đối soát.")}>Đối soát…</button> : "chưa đối soát") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="l-card" data-testid="plan-reports">
        <h2 style={{ marginTop: 0 }}>Báo cáo</h2>
        {d.reports.length === 0 ? <Empty>Chưa có báo cáo. Báo cáo mốc xuất hiện khi việc ở mốc kết thúc; báo cáo cuối khi kế hoạch kết thúc.</Empty> : d.reports.map((r: any, i: number) => <ReportView key={r.id} r={r} open={i === 0} />)}
      </section>

      {isOwner && live && (
        <div className="l-row" style={{ gap: 8 }}>
          {["EXECUTING", "PAUSED_ADJUSTMENT", "NEEDS_REVISION"].includes(plan.status) && <button className="l-btn" onClick={() => setDlg({ kind: "reviseplan" })} data-testid="plan-revise-plan-open">Yêu cầu bot sửa kế hoạch</button>}
          <button className="l-btn danger" onClick={() => setDlg({ kind: "cancel" })} data-testid="plan-cancel-open">Hủy kế hoạch</button>
        </div>
      )}

      <ConfirmDialog dlg={dlg} onClose={() => setDlg(null)} id={id} post={post} exec={exec} />
    </div>
  );
}

function Metric({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return <div className="l-metric"><div className="small muted">{label}</div><div className="l-metric-v" data-testid={testid}>{value}</div></div>;
}

function PlanningState({ d, canAct, onRetry }: { d: any; canAct: boolean; onRetry: (pt: any) => void }) {
  const pt = d.planningTask;
  const taskLink = pt?.project_slug ? <LumiLink href={`/lumi/projects/${pt.project_slug}?task=${pt.code}`} className="l-chiplink">Mở việc {pt.code}</LumiLink> : null;
  if (pt && ["FAILED", "ON_HOLD", "CANCELLED", "SYNC_DELAYED"].includes(pt.status)) {
    return (
      <div className="l-note" role="alert" data-testid="planning-failed">
        <strong>Bot chưa lập được kế hoạch.</strong> Việc {pt.code}: {TASK_STATUS_LABEL[pt.status] ?? pt.status}{pt.run_state ? ` · lượt chạy ${pt.run_state}` : ""}{pt.error_code ? ` · lỗi ${pt.error_code}` : ""}, cập nhật {fmtTime(pt.updated_at)}.
        {" "}Chưa có gì được thực hiện hay chi tiêu. Giao lại sẽ mở MỘT lượt chạy mới (tính vào hạn mức lượt); hoặc hủy kế hoạch bên dưới. {taskLink}
        {canAct && pt.status === "FAILED" && <div style={{ marginTop: 8 }}><button className="l-btn primary sm" onClick={() => onRetry(pt)} data-testid="planning-retry">Giao lại lượt lập kế hoạch</button></div>}
      </div>
    );
  }
  if (pt && pt.status === "WAITING_ASSISTANT") {
    return (
      <div className="l-note" role="alert" data-testid="planning-bot-not-ready">
        <strong>Bot trưởng kế hoạch chưa sẵn sàng.</strong> Việc {pt.code} đang chờ vì trợ lý chưa được kết nối hoặc chưa bật giao việc. Kế hoạch chưa được lập; hãy kết nối/bật giao việc rồi giao lại, hoặc hủy kế hoạch. {taskLink}
      </div>
    );
  }
  return (
    <div className="l-note" data-testid="planning-state">
      <strong>Đang chờ bot lập kế hoạch.</strong> {pt ? <>Việc {pt.code}: {TASK_STATUS_LABEL[pt.status] ?? pt.status}{pt.run_state ? ` · lượt chạy ${pt.run_state}` : ""}{pt.error_code ? ` · lỗi ${pt.error_code}` : ""}, cập nhật {fmtTime(pt.updated_at)}. </> : null}
      Nếu quá lâu hoặc lỗi, thông báo lỗi sẽ hiện ở đây; bạn cũng có thể hủy kế hoạch. {taskLink}
    </div>
  );
}

function ConfirmDialog({ dlg, onClose, id, post, exec }: { dlg: any; onClose: () => void; id: string; post: (p: string, b: any, m: string, k?: string) => Promise<any>; exec: any }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState("TOOL"); const [amount, setAmount] = useState(""); const [cur, setCur] = useState("USD"); const [src, setSrc] = useState("PROVIDER_STATEMENT");
  const [key] = useState(() => newKey());
  useEffect(() => { if (dlg) { setText(""); setBusy(false); setAmount(""); setCur(exec?.currency ?? "USD"); } }, [dlg]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!dlg) return null;
  const v = dlg.version;
  async function go() {
    if (busy) return; setBusy(true);
    let r: any;
    if (dlg.kind === "confirm") r = await post(`/api/v1/lumi/plans/${id}/decide`, { version: v.version, content_hash: v.content_hash, decision: "APPROVE" }, `Đã duyệt phiên bản ${v.version}. Bot bắt đầu thực hiện trong phạm vi đã duyệt.`);
    else if (dlg.kind === "revise" || dlg.kind === "reject") r = await post(`/api/v1/lumi/plans/${id}/decide`, { version: v.version, content_hash: v.content_hash, decision: dlg.kind === "revise" ? "REVISE" : "REJECT", reason: text }, dlg.kind === "revise" ? "Đã yêu cầu bot sửa." : "Đã từ chối.");
    else if (dlg.kind === "cancel") r = await post(`/api/v1/lumi/plans/${id}/cancel`, { reason: text }, "Đã hủy kế hoạch.");
    else if (dlg.kind === "reviseplan") r = await post(`/api/v1/lumi/plans/${id}/revise`, { instruction: text }, "Đã giao bot sửa kế hoạch (việc đang chạy không bị ảnh hưởng).");
    else r = await post(`/api/v1/lumi/plans/${id}/ledger`, { category: cat, amount: Number(amount), currency: cur, source: src, note: text || undefined }, "Đã ghi khoản chi.", key);
    setBusy(false);
    if (r?.ok) onClose();
  }
  const titles: Record<string, string> = { confirm: `Bước 2 — xác nhận duyệt phiên bản ${v?.version ?? ""}`, revise: "Yêu cầu sửa", reject: "Từ chối", cancel: "Hủy kế hoạch", reviseplan: "Yêu cầu bot sửa kế hoạch", ledger: "Ghi khoản chi thực tế" };
  return (
    <Modal open onClose={onClose} title={titles[dlg.kind] ?? ""}>
      <div className="l-grid" style={{ gap: 10 }} data-testid={`dlg-body-${dlg.kind}`}>
        {dlg.kind === "confirm" && (
          <>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Bạn cấp phép cho bot thực hiện <strong>{v.body.tasks.length} việc</strong> đã liệt kê, trong trần <strong>{fmtMoney(v.ceiling_amount, v.currency)}</strong>.</li>
              <li><strong>Không có hành động bên ngoài</strong> trong phiên bản này (không đăng, không chạy quảng cáo, không chi tiền ngoài hệ thống).</li>
              <li>Sau xác nhận, bot <strong>không hỏi lại</strong> từng thao tác trong phạm vi; vượt trần, thay đổi ngoài phạm vi hoặc ngoại lệ sẽ quay lại hỏi bạn.</li>
              <li>{AI_NOTE}</li>
              <li>Duyệt kế hoạch không thay cho kiểm chứng sự thật của nội dung.</li>
            </ul>
          </>
        )}
        {(dlg.kind === "revise" || dlg.kind === "reject" || dlg.kind === "cancel" || dlg.kind === "reviseplan") && (
          <label className="l-label">{dlg.kind === "reviseplan" ? "Bạn muốn bot sửa gì?" : "Lý do (tối thiểu 3 ký tự)"}<textarea className="l-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} data-testid="dlg-text" /></label>
        )}
        {dlg.kind === "ledger" && (
          <>
            <label className="l-label">Loại chi<select className="l-select" value={cat} onChange={(e) => setCat(e.target.value)}>{Object.entries(CATEGORY_LABEL).map(([k, lab]) => <option key={k} value={k}>{lab}</option>)}</select></label>
            <div className="l-row" style={{ gap: 8 }}>
              <label className="l-label" style={{ flex: 1 }}>Số tiền<input className="l-input" type="number" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="ledger-amount" /></label>
              <label className="l-label" style={{ width: 100 }}>Tiền tệ<input className="l-input" value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} /></label>
            </div>
            <label className="l-label">Nguồn<select className="l-select" value={src} onChange={(e) => setSrc(e.target.value)}><option value="PROVIDER_STATEMENT">Sao kê nhà cung cấp</option><option value="MANUAL">Tôi nhập tay</option></select></label>
            <label className="l-label">Ghi chú<input className="l-input" value={text} onChange={(e) => setText(e.target.value)} /></label>
          </>
        )}
        <div className="l-row" style={{ justifyContent: "flex-end" }}>
          <button className="l-btn" onClick={onClose}>Đóng</button>
          <button className={`l-btn ${dlg.kind === "reject" || dlg.kind === "cancel" ? "danger" : "primary"}`} disabled={busy} onClick={() => void go()} data-testid="dlg-confirm">{dlg.kind === "confirm" ? "Xác nhận duyệt" : "Xác nhận"}</button>
        </div>
      </div>
    </Modal>
  );
}

function BodyView({ v, diff, compact }: { v: any; diff?: ReturnType<typeof diffBodies> | null; compact?: boolean }) {
  const b = v.body;
  return (
    <div className="l-grid" style={{ gap: 8 }} data-testid="body-view">
      <p style={{ margin: 0 }}>{b.summary}</p>
      <div className="small"><span className="l-badge amber">do bot lập, chưa kiểm chứng</span> <span className="muted">nộp bởi {v.submitted_by} · {fmtFull(v.submitted_at)} · mã {String(v.content_hash).slice(0, 10)}…</span></div>
      {diff && (diff.added.length || diff.removed.length || diff.changed.length || diff.ceilingDelta !== 0) ? (
        <div className="l-note" data-testid="version-diff"><strong>So với phiên bản đang áp dụng:</strong> thêm [{diff.added.join(", ") || "—"}] · bỏ [{diff.removed.join(", ") || "—"}] · đổi [{diff.changed.join(", ") || "—"}] · trần {diff.ceilingDelta >= 0 ? "+" : ""}{diff.ceilingDelta}</div>
      ) : null}
      <div><strong>Trần xin duyệt:</strong> {fmtMoney(v.ceiling_amount, v.currency)} <span className="muted small">· dự toán thấp/cơ sở/cao: {fmtMoney(v.est_low, v.currency)} / {fmtMoney(v.est_base, v.currency)} / {fmtMoney(v.est_high, v.currency)} (ước tính của bot; «chưa biết» = chưa có số)</span></div>
      <div className="small" data-testid="no-external-actions"><ShieldCheck size={13} /> <strong>Không có hành động bên ngoài trong phiên bản này.</strong></div>
      {!compact && <>
        <div><strong>Cơ hội và bằng chứng</strong><ul className="small" style={{ margin: "2px 0", paddingLeft: 18 }}>{b.opportunity.evidence.map((e: any, i: number) => <li key={i}>{e.claim} <span className="muted">— {e.ref} ({e.as_of})</span></li>)}</ul></div>
        <div className="small"><strong>Trong phạm vi:</strong> {b.scope.in.join("; ")} · <strong>Ngoài phạm vi:</strong> {b.scope.out.join("; ") || "—"}</div>
      </>}
      <div style={{ overflowX: "auto" }}>
        <table className="l-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th align="left">Việc</th><th align="left">Đầu ra / tiêu chí đạt</th><th align="right">Phân bổ</th><th align="left">Hạn</th></tr></thead>
          <tbody>{b.tasks.map((t: any) => (
            <tr key={t.key}><td>{t.title}<div className="small muted">{t.key} · {t.assignee_slug}</div></td><td>{t.expected_output}<div className="small muted">{t.acceptance}</div></td><td align="right">{t.budget_alloc ? fmtMoney(t.budget_alloc.amount, t.budget_alloc.currency) : "chưa có dự toán"}</td><td>{t.due_in_days ? `+${t.due_in_days} ngày` : "—"}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {!compact && <div className="small"><strong>Điều kiện dừng:</strong> {b.stop_conditions.join("; ")} · <strong>Rủi ro:</strong> {b.risks.join("; ") || "—"} · <strong>Phương án thay thế:</strong> {b.alternatives.join("; ") || "—"}</div>}
    </div>
  );
}

function ReportView({ r, open }: { r: any; open: boolean }) {
  const [show, setShow] = useState(open);
  const b = r.body;
  return (
    <div className="l-card" style={{ marginTop: 8 }} data-testid={`report-${r.kind}`}>
      <button className="l-btn ghost sm" onClick={() => setShow((s) => !s)} aria-expanded={show}>{r.kind === "FINAL" ? "Báo cáo cuối" : `Báo cáo mốc ${r.milestone_key}`} · {fmtFull(r.created_at)}{r.supersedes_report_id ? " · bản cập nhật" : ""}</button>
      {show && (
        <div className="l-grid" style={{ gap: 6, marginTop: 6 }}>
          <div className="small">Việc: {b.completion.completed}/{b.completion.tasks_total} hoàn tất · {b.completion.cancelled} hủy · {b.completion.open} đang mở · Kế hoạch: <strong>{PLAN_STATUS_LABEL[b.plan.status] ?? b.plan.status}</strong> · Mục tiêu: {b.goal.status === "CLOSED" ? GOAL_RESULT_LABEL[b.goal.result] : "chưa đóng"}</div>
          <div className="small">Ngân sách: trần {fmtMoney(b.ledger.execute?.ceiling, b.ledger.execute?.currency)} · cam kết mở {fmtMoney(b.ledger.execute?.committed_open, b.ledger.execute?.currency)} · thực tế đã biết {fmtMoney(b.ledger.execute?.actual_known, b.ledger.execute?.currency)} · <strong>{b.ledger.execute?.unknown_count ?? 0} lượt chưa biết chi phí AI</strong> · đã đối soát {b.ledger.reconciled} / chưa {b.ledger.unreconciled}</div>
          <div className="small"><strong>Kinh doanh: chưa đánh giá.</strong> {b.business.note}</div>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(b.limits as string[]).map((l, i) => <li key={i}>{l}</li>)}</ul>
          <div className="small muted">Nguồn: chi phí AI {b.data_sources.ai_cost} · doanh thu {b.data_sources.revenue} · nội dung kế hoạch {b.data_sources.plan_content} · Hermes {b.data_sources.hermes_mode}</div>
        </div>
      )}
    </div>
  );
}

function diffBodies(prev: any, next: any, prevCeil: any, nextCeil: any) {
  const pm = new Map<string, any>((prev?.tasks ?? []).map((t: any) => [t.key, t]));
  const nm = new Map<string, any>((next?.tasks ?? []).map((t: any) => [t.key, t]));
  const added = [...nm.keys()].filter((k) => !pm.has(k));
  const removed = [...pm.keys()].filter((k) => !nm.has(k));
  const changed = [...nm.keys()].filter((k) => pm.has(k) && JSON.stringify(pm.get(k)) !== JSON.stringify(nm.get(k)));
  return { added, removed, changed, ceilingDelta: prev ? Number(nextCeil) - Number(prevCeil) : 0 };
}
