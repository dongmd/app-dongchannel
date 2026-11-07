"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- API payloads are rendered field by field */

import { useCallback, useEffect, useState } from "react";
import { Bell, Server } from "lucide-react";

import { ageText, describeNotification, profileCard, workerCard, type Level } from "@/lib/lumi/admin";
import { errText, lumiApi } from "@/lib/lumi/plans-client";
import { useLumi } from "./lumi-provider";
import { Empty, fmtFull, LumiLink } from "./ui";

const TONE: Record<Level, string> = { ok: "green", warn: "amber", down: "red", unknown: "" };
const LABEL: Record<Level, string> = { ok: "Bình thường", warn: "Cần chú ý", down: "Mất kết nối / dừng", unknown: "Chưa có dữ liệu" };
type Tab = "status" | "notifications" | "tools";

/** ADM-01/05/07/08/09. Only observed facts are shown, each with its age; no secret is ever displayed here. */
export function AdminView() {
  const { state } = useLumi();
  const role = state.real?.role;
  const [tab, setTab] = useState<Tab>("status");
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    const r = await lumiApi("/api/v1/lumi/admin/status");
    if (r.ok && r.data) { setData(r.data); setErr(null); } else setErr(errText(r.error));
    setNow(Date.now());
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="l-grid" style={{ gap: 14 }} data-testid="admin-view">
      <div>
        <h1 className="l-row" style={{ gap: 8 }}><Server size={22} /> Quản trị và kết nối</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>Chỉ hiện điều hệ thống thật sự quan sát được, kèm thời điểm. Không có bí mật nào hiển thị ở đây. Dữ liệu quá cũ được báo «mất tín hiệu», không hiện như trạng thái hiện tại.</p>
      </div>
      <div className="l-tabs" role="tablist" aria-label="Quản trị">
        {([["status", "Kết nối"], ["notifications", `Thông báo${data?.notifications?.unread ? ` (${data.notifications.unread})` : ""}`], ["tools", "Công cụ quản trị"]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`admin-tab-${k}`}>{label}</button>
        ))}
      </div>
      {err && <div className="l-note" role="alert" data-testid="admin-error">Không tải được: {err} <button className="l-btn sm" onClick={() => void load()}>Thử lại</button></div>}
      {!data && !err && <p className="muted" data-testid="admin-loading">Đang tải…</p>}
      {data && tab === "status" && <Connections d={data} now={now} />}
      {data && tab === "notifications" && <Notifications d={data} onSeen={load} />}
      {tab === "tools" && <Tools role={role} />}
    </div>
  );
}

function Card({ title, level, children, testid }: { title: string; level: Level; children: React.ReactNode; testid: string }) {
  return (
    <section className="l-card" data-testid={testid}>
      <div className="l-row" style={{ justifyContent: "space-between", gap: 8 }}><strong>{title}</strong><span className={`l-badge ${TONE[level]}`} data-testid={`${testid}-level`}>{LABEL[level]}</span></div>
      <div className="small" style={{ marginTop: 6 }}>{children}</div>
    </section>
  );
}

function Connections({ d, now }: { d: any; now: number }) {
  const snap = d.hermes.snapshot;
  const pub = d.hermes.public;
  const dbMs = Date.parse(d.now);
  const drift = Math.abs(now - dbMs) > 120_000;
  return (
    <div className="l-grid" style={{ gap: 12 }}>
      {drift && <div className="l-note" role="note">Giờ trình duyệt lệch giờ máy chủ hơn 2 phút: các mốc «x phút trước» tính theo giờ trình duyệt.</div>}
      <div className="l-grid cols2">
        <Card title="Cơ sở dữ liệu" level="ok" testid="card-db">Truy vấn thành công lúc {fmtFull(d.now)}.</Card>
        <Card title="Hermes (cổng công khai)" level={pub ? (pub.level === "ok" ? "ok" : pub.level === "impaired" ? "warn" : "down") : "unknown"} testid="card-hermes-public">
          {pub ? <>Mức: {pub.level}{pub.version ? ` · phiên bản ${pub.version}` : ""}{pub.gatewayState ? ` · gateway ${pub.gatewayState}` : ""}{pub.activeSessions !== undefined ? ` · ${pub.activeSessions} phiên` : ""}<div className="muted">Kiểm lúc {fmtFull(pub.checkedAt)}{pub.error ? ` · ${pub.error}` : ""}</div></> : "Chưa kiểm được (không đọc được trạng thái công khai)."}
        </Card>
        {d.workers.length === 0 ? <Card title="Worker" level="unknown" testid="card-worker-none">Chưa có worker nào ghi tín hiệu.</Card> : d.workers.map((w: any) => {
          const c = workerCard(w.status, now);
          return <Card key={w.lane} title={`Worker «${w.lane === "real" ? "thật" : "giả (mô phỏng)"}»`} level={c.level} testid={`card-worker-${w.lane}`}>{c.text}<div className="muted">Phục vụ: {(w.status.serves ?? []).join(", ") || "(không giới hạn — chỉ CSDL cục bộ)"} · chế độ {w.status.mode}</div></Card>;
        })}
        <Card title="Telegram (ứng dụng)" level={d.telegram.appWebhookConfigured ? "ok" : "unknown"} testid="card-telegram">
          Bot của ứng dụng (webhook): {d.telegram.appWebhookConfigured ? "đã cấu hình" : "chưa cấu hình"}. Bot Hermes dùng để giao việc: {d.telegram.hermesBot ? `@${d.telegram.hermesBot}` : "chưa khai báo"}. <span className="muted">Đường Telegram nào là chính còn chờ quyết định Q14.</span>
        </Card>
        <Card title="WordPress" level={!d.wordpress.configured ? "unknown" : d.wordpress.last_sync?.error ? "warn" : d.wordpress.last_sync ? "ok" : "unknown"} testid="card-wordpress">
          {d.wordpress.configured ? "Đã cấu hình." : "Chưa cấu hình."} {d.wordpress.last_sync ? <>Lần đồng bộ gần nhất: {d.wordpress.last_sync.state}, {ageText(d.wordpress.last_sync.updated_at, now)}{d.wordpress.last_sync.error ? ` · lỗi ${d.wordpress.last_sync.error}` : ""}.</> : "Chưa có lần đồng bộ nào được ghi."}
        </Card>
      </div>

      <h2 style={{ margin: "6px 0 0", fontSize: "1.05rem" }}>Profile Hermes {snap ? <span className="small muted">· dữ liệu {ageText(snap.at, now)}</span> : null}</h2>
      {!snap ? <Empty>Chưa có ảnh chụp trạng thái Hermes từ worker thật (worker chưa chạy hoặc chưa đọc được).</Empty> : (
        <div className="l-grid cols2" data-testid="hermes-profiles">
          {snap.profiles.map((p: any) => {
            const c = profileCard(p, snap.at, now);
            return <Card key={p.profile} title={`Profile ${p.profile}`} level={c.level} testid={`card-profile-${p.profile}`}>{c.lines.map((l, i) => <div key={i}>{l}</div>)}</Card>;
          })}
        </div>
      )}

      <section className="l-card" data-testid="card-backups">
        <div className="l-row" style={{ justifyContent: "space-between" }}><strong>Sao lưu cơ sở dữ liệu</strong><span className={`l-badge ${d.backups.readable && d.backups.latest.length ? "green" : "amber"}`}>{d.backups.readable ? (d.backups.latest.length ? "Có bản sao lưu" : "Không thấy bản nào") : "Không đọc được thư mục"}</span></div>
        <div className="small" style={{ marginTop: 6 }}>
          {d.backups.latest.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{d.backups.latest.map((b: any) => <li key={b.name}>{b.name} · {(b.size / 1024 / 1024).toFixed(1)} MB · {ageText(b.mtime, now)}</li>)}</ul> : "Chưa thấy tệp .dump nào."}
          <div className="muted" style={{ marginTop: 4 }}>{d.restore_drill ? `Diễn tập khôi phục gần nhất: ${d.restore_drill.result} (${fmtFull(d.restore_drill.at)})` : "Chưa có diễn tập khôi phục nào được ghi nhận: có bản sao lưu chưa đồng nghĩa khôi phục được."}</div>
        </div>
      </section>
    </div>
  );
}

function Notifications({ d, onSeen }: { d: any; onSeen: () => void | Promise<void> }) {
  const n = d.notifications;
  async function seen() { await lumiApi("/api/v1/lumi/notifications/seen", { method: "POST", body: {} }); await onSeen(); }
  return (
    <section className="l-card" data-testid="notifications">
      <div className="l-row" style={{ justifyContent: "space-between", gap: 8 }}>
        <div className="l-row" style={{ gap: 8 }}><Bell size={16} /><strong>Việc cần bạn xử lý</strong><span className="small muted">chưa đọc: <span data-testid="notif-unread">{n.unread}</span></span></div>
        <button className="l-btn sm" onClick={() => void seen()} disabled={n.unread === 0} data-testid="notif-seen">Đánh dấu đã đọc</button>
      </div>
      <p className="small muted" style={{ margin: "6px 0" }}>Cùng sự kiện được xếp hàng gửi Telegram; hộp này hiện chúng trong ứng dụng nên không phụ thuộc kênh Telegram đã nối hay chưa.</p>
      {n.rows.length === 0 ? <Empty>Chưa có thông báo nào.</Empty> : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {n.rows.map((r: any) => {
            const t = describeNotification(r);
            const unread = !n.seen_at || Date.parse(r.created_at) > Date.parse(n.seen_at);
            return (
              <li key={r.id} className="l-card" data-testid="notif-row" data-unread={unread ? "1" : "0"} style={{ padding: 8 }}>
                <div>{unread ? <span className="l-badge amber" style={{ marginRight: 6 }}>mới</span> : null}{r.href ? <LumiLink href={r.href} className="l-chiplink">{t.text}</LumiLink> : t.text}</div>
                <div className="small muted">{fmtFull(r.created_at)} · {t.delivery}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const GROUPS: { title: string; items: { label: string; href: string; note: string }[] }[] = [
  { title: "Agents", items: [{ label: "Hồ sơ nhân viên AI", href: "/lumi/org", note: "tạo/sửa/kết nối, công cụ được phép, giới hạn chạy" }, { label: "Kết nối và trạng thái Hermes", href: "/admin", note: "trang Quản trị cũ: profile, mô hình, skill, MCP" }] },
  { title: "Tích hợp", items: [{ label: "Telegram & kết nối", href: "/lumi/telegram", note: "bản nháp giao việc, công tắc giao việc, dừng khẩn cấp" }, { label: "WordPress / webhook / ghép đôi", href: "/admin", note: "trang Quản trị cũ" }] },
  { title: "Tự động hóa", items: [{ label: "Cron của Hermes", href: "/admin", note: "xem trạng thái job ở thẻ profile; cấu hình ở trang cũ" }] },
  { title: "Dữ liệu & chẩn đoán", items: [{ label: "Phiên, tệp, log", href: "/admin", note: "trang Quản trị cũ" }, { label: "Tìm kiếm", href: "/search", note: "tìm trong dữ liệu đã nhập" }] },
  { title: "Bảo mật & cài đặt", items: [{ label: "Khóa và cấu hình nhạy cảm", href: "/admin", note: "chỉ OWNER/ADMIN thấy và đổi (SR-07)" }] },
];

function Tools({ role }: { role?: string }) {
  const allowed = role === "OWNER" || role === "ADMIN";
  return (
    <div className="l-grid" style={{ gap: 12 }} data-testid="admin-tools">
      <div className="l-banner" role="note"><strong>Giữ nguyên chức năng cũ.</strong><span>Các công cụ quản trị Hermes hiện có được gom nhóm ở đây và mở ở trang cũ; không có chức năng nào bị bỏ.</span></div>
      {!allowed ? <div className="l-note" role="note" data-testid="admin-tools-denied">Chỉ OWNER/ADMIN dùng nhóm công cụ này (xem khóa, đổi cấu hình nhạy cảm). Tài khoản của bạn chỉ có quyền xem.</div> : GROUPS.map((g) => (
        <section key={g.title} className="l-card" data-testid={`tools-${g.title}`}>
          <strong>{g.title}</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{g.items.map((i) => <li key={i.label}><LumiLink href={i.href}>{i.label}</LumiLink> <span className="small muted">— {i.note}</span></li>)}</ul>
        </section>
      ))}
    </div>
  );
}
