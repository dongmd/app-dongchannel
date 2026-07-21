"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { NAV_ITEMS } from "./nav-items";
import { cn } from "@/lib/utils";

// AC01/AC03/AC05 — sidebar 6 mục (business + admin separated), highlight active, collapsible mobile.
// AC07 — mobile drawer đóng đúng chuẩn: aria-hidden khi ẩn, link không nhận tab focus, ESC đóng.
export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // ESC đóng drawer (song song với click overlay)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Media query breakpoint md = 768px — dùng để bỏ hidden trên desktop.
  // Đơn giản hoá: dùng CSS `md:` prefix, chỉ set aria-hidden khi < md AND !open.
  // Để không cần JS check media, cho phép luôn hidden mobile khi !open và luôn visible desktop.
  // Compromise: dùng aria-hidden={!open} — trên desktop CSS bắt buộc translate-x-0 nhưng screen reader
  // vẫn thấy aria-hidden nếu !open. Fix: aria-hidden chỉ bind mobile → dùng data-attr + CSS media,
  // hoặc bỏ hẳn aria-hidden và dùng inert kèm media query. Chọn giải pháp đơn giản: tính isDesktop
  // sau mount và cập nhật.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const drawerHidden = !isDesktop && !open;

  return (
    <>
      {/* Mobile toggle — chỉ hiện ≤ md */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed left-3 top-3 z-50 rounded-md border border-border bg-background p-2 md:hidden"
        aria-label={open ? "Đóng menu" : "Mở menu"}
        aria-expanded={open}
        aria-controls="app-sidebar"
      >
        {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>

      {/* Overlay khi mobile drawer mở */}
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <nav
        id="app-sidebar"
        aria-label="Điều hướng chính"
        aria-hidden={drawerHidden || undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-background transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="h-6 w-6 rounded bg-primary" aria-hidden="true" />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Ops Hub</span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              DongChannel
            </span>
          </div>
        </div>

        <ul className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {NAV_ITEMS.map((item, idx) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            const prev = NAV_ITEMS[idx - 1];
            const showDivider = prev && prev.section === "business" && item.section === "admin";
            return (
              <li key={item.href}>
                {showDivider ? (
                  <hr className="my-2 border-border" aria-hidden="true" />
                ) : null}
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? "page" : undefined}
                  tabIndex={drawerHidden ? -1 : 0}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {item.label}
                  </span>
                  {item.badgeCount ? (
                    <span className="rounded-full bg-primary/20 px-2 py-0.5 text-xs text-primary">
                      {item.badgeCount}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-border p-3 text-[11px] text-muted-foreground">
          v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0"} · scaffold
        </div>
      </nav>
    </>
  );
}
