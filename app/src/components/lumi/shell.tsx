"use client";

import { usePathname } from "next/navigation";
import { Bell, Brain, CalendarDays, Building2, FolderKanban, ListChecks, Menu, MessageCircle, Plus, RotateCcw, Server, Sparkles, Target, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { pendingBreakdown, pendingCounts } from "@/lib/lumi/selectors";
import { Avatar } from "./avatar";
import { useLumi } from "./lumi-provider";
import { MemberFormModal } from "./member-form";
import { NewTaskModal } from "./new-task-modal";
import { LumiLink, Modal } from "./ui";

// Lối vào các chức năng cũ của ứng dụng (cần đăng nhập Google và Postgres, nên trong preview sẽ chuyển về trang đăng nhập).
const LEGACY = [
  { href: "/?legacy=1", label: "Tổng quan (cũ)" },
  { href: "/tasks", label: "Công việc (cũ)" },
  { href: "/aff", label: "AFF (cũ)" },
  { href: "/youtube", label: "YouTube (cũ)" },
  { href: "/memory", label: "Trí nhớ (cũ)" },
  { href: "/moneyos", label: "Money OS (cũ)" },
  { href: "/search", label: "Tìm kiếm (cũ)" },
  { href: "/admin", label: "Quản trị (cũ)" },
];

export function Shell({ children }: { children: ReactNode }) {
  const { state, reset, openNewTask, navOpen, setNavOpen } = useLumi();
  const path = usePathname();
  const counts = pendingCounts(state);
  const plansPending = state.real?.plansPending?.length ?? 0;
  const totalPending = counts.total + plansPending;
  const [confirmReset, setConfirmReset] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const owner = state.members.find((m) => m.kind === "human")!;
  const real = state.mode === "db";
  const cur = (p: string, exact = false) => (exact ? path === p : path === p || path.startsWith(`${p}/`));
  const close = () => setNavOpen(false);

  return (
    <div className="lumi">
      <div className="l-shell">
        <aside className={`l-side${navOpen ? " open" : ""}`} aria-label="Điều hướng chính">
          <div className="l-brand">
            <span className="logo" aria-hidden>
              <Sparkles size={17} />
            </span>
            <span>Dong-Lumi</span>
            <span className="l-badge amber" style={{ marginLeft: "auto" }}>{real ? "Thử nghiệm" : "Preview"}</span>
          </div>
          <button className="l-btn primary" onClick={() => { openNewTask(); close(); }} data-testid="new-task">
            <Plus size={16} /> Việc mới
          </button>
          <nav className="l-nav" onClick={(e) => (e.target as HTMLElement).closest("a") && close()}>
            <div className="group">Điều hành</div>
            <LumiLink href="/lumi" aria-current={cur("/lumi", true) ? "page" : undefined}>
              <CalendarDays size={17} /> Hôm nay
            </LumiLink>
            <LumiLink href="/lumi/approvals" aria-current={cur("/lumi/approvals") ? "page" : undefined} title={`${pendingBreakdown(counts)}${plansPending ? ` + ${plansPending} kế hoạch` : ""}`}>
              <Bell size={17} /> Chờ duyệt
              {totalPending > 0 && <span className="count" aria-label={`${pendingBreakdown(counts)}${plansPending ? ` + ${plansPending} kế hoạch` : ""}`} data-testid="nav-pending-count">{totalPending} mục</span>}
            </LumiLink>
            <LumiLink href="/lumi/projects" aria-current={path === "/lumi/projects" ? "page" : undefined}>
              <FolderKanban size={17} /> Dự án
            </LumiLink>
            <div className="l-sub">
              {state.projects
                .filter((p) => p.status === "active")
                .map((p) => (
                  <LumiLink key={p.id} href={`/lumi/projects/${p.id}`} aria-current={cur(`/lumi/projects/${p.id}`) ? "page" : undefined}>
                    {p.name}
                  </LumiLink>
                ))}
            </div>
            <LumiLink href="/lumi/tasks" aria-current={cur("/lumi/tasks") ? "page" : undefined} data-testid="nav-tasks">
              <ListChecks size={17} /> Việc xuyên dự án
            </LumiLink>
            <div className="group">Công ty</div>
            {real && (
              <LumiLink href="/lumi/company" aria-current={cur("/lumi/company") || cur("/lumi/plans") ? "page" : undefined} data-testid="nav-company">
                <Target size={17} /> Tổng quan công ty
              </LumiLink>
            )}
            {real && (
              <LumiLink href="/lumi/org" aria-current={cur("/lumi/org") ? "page" : undefined} data-testid="nav-org">
                <Users size={17} /> Tổ chức
              </LumiLink>
            )}
            <LumiLink href="/lumi/office" aria-current={cur("/lumi/office") ? "page" : undefined}>
              <Building2 size={17} /> Văn phòng
            </LumiLink>
            <div className="group">Nghiệp vụ</div>
            <LumiLink href="/lumi/memory" aria-current={cur("/lumi/memory") ? "page" : undefined}>
              <Brain size={17} /> Bộ nhớ
            </LumiLink>
            <div className="group">Hệ thống</div>
            <LumiLink href="/lumi/telegram" aria-current={cur("/lumi/telegram") ? "page" : undefined}>
              <MessageCircle size={17} /> {real ? "Telegram & kết nối" : "Telegram mô phỏng"}
              {real && state.tgDrafts.length > 0 && <span className="count" aria-label="Bản nháp chờ xác nhận">{state.tgDrafts.length} nháp</span>}
            </LumiLink>
            {real && (
              <LumiLink href="/lumi/admin" aria-current={cur("/lumi/admin") ? "page" : undefined} data-testid="nav-admin">
                <Server size={17} /> Quản trị &amp; thông báo
                {(state.real?.notifUnread ?? 0) > 0 && <span className="count" aria-label="Thông báo chưa đọc" data-testid="nav-notif-count">{state.real!.notifUnread} mới</span>}
              </LumiLink>
            )}
            <div className="group">Chức năng cũ</div>
            <button className="item" onClick={() => setLegacyOpen((v) => !v)} aria-expanded={legacyOpen}>
              Mở danh sách ({LEGACY.length})
            </button>
            {legacyOpen && (
              <div className="l-sub">
                {(real ? [{ href: "/work", label: "Giao việc: chi tiết kỹ thuật" }, ...LEGACY] : LEGACY).map((l) => (
                  <LumiLink key={l.href} href={l.href}>{l.label}</LumiLink>
                ))}
                <p className="small muted" style={{ padding: "2px 10px" }}>{real ? "Giao diện cũ của Ops Hub, cùng phiên đăng nhập." : "Cần đăng nhập Google và cơ sở dữ liệu; trong preview sẽ chuyển về trang đăng nhập."}</p>
              </div>
            )}
          </nav>
          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {!real && (
              <button className="l-btn ghost sm" onClick={() => setConfirmReset(true)}>
                <RotateCcw size={14} /> Đặt lại dữ liệu demo
              </button>
            )}
            <div className="l-row" style={{ padding: "6px 4px", borderTop: "1px solid var(--l-border)" }}>
              <Avatar avatar={owner.avatar} size={30} />
              <div>
                <div style={{ fontWeight: 600, lineHeight: 1.2 }}>{owner.name}</div>
                <div className="small muted">{real ? `Chủ hệ thống · ${state.real?.role}` : "Chủ hệ thống"}</div>
              </div>
            </div>
          </div>
        </aside>

        <div className="l-main">
          <div className="l-topbar">
            <button className="l-btn sm" onClick={() => setNavOpen(true)} aria-label="Mở menu"><Menu size={16} /></button>
            <strong>Dong-Lumi</strong>
            <span className="l-badge amber">{real ? "Thử nghiệm" : "Preview"}</span>
            <button className="l-btn primary sm" style={{ marginLeft: "auto" }} onClick={() => openNewTask()}><Plus size={14} /> Việc mới</button>
          </div>
          {real ? (
            <div className="l-banner" role="note" data-testid="real-banner">
              <strong>Dữ liệu thật · môi trường thử nghiệm.</strong>
              <span>Việc lưu trong PostgreSQL. {state.real?.hermesMode}. {state.real?.emergencyStop ? "DỪNG KHẨN CẤP đang bật. " : ""}{state.real?.m1Enabled ? "" : "Luồng M1 đang TẮT: không giao việc mới. "}Không chạy quảng cáo, không đăng bài.</span>
            </div>
          ) : (
            <div className="l-banner" role="note">
              <strong>Bản preview · dữ liệu mô phỏng.</strong>
              <span>Chưa kết nối Hermes, Telegram thật hay cơ sở dữ liệu. Không gửi tin, không chạy quảng cáo, không đăng bài.</span>
            </div>
          )}
          <main className="l-content">{children}</main>
        </div>
      </div>
      {navOpen && <div style={{ position: "fixed", inset: 0, zIndex: 35 }} onClick={close} aria-hidden />}
      <NewTaskModal />
      <MemberFormModal />
      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Đặt lại dữ liệu demo?">
        <p className="muted">Toàn bộ thay đổi trong preview (trợ lý mới, việc, ghi nhớ, tin nhắn Telegram mô phỏng) sẽ quay về dữ liệu mẫu ban đầu.</p>
        <div className="l-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button className="l-btn" onClick={() => setConfirmReset(false)}>Giữ nguyên</button>
          <button className="l-btn danger" onClick={async () => { await reset(); setConfirmReset(false); }}>Đặt lại</button>
        </div>
      </Modal>
    </div>
  );
}
