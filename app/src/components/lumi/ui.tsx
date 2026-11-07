"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { NEW_OUTPUT_LABEL, STATUS_LABEL } from "@/lib/lumi/selectors";
import type { Task, TaskStatus } from "@/lib/lumi/types";

export function LumiLink({ href, children, ...rest }: { href: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link href={href as Route} {...rest}>
      {children}
    </Link>
  );
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} giờ trước`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} ngày trước`;
  return d.toLocaleDateString("vi-VN");
}
export const fmtFull = (iso: string) => new Date(iso).toLocaleString("vi-VN", { dateStyle: "medium", timeStyle: "short" });

const TONE: Record<TaskStatus, string> = { new: "", ready: "blue", doing: "purple", review: "amber", done: "green" };
export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`l-badge ${TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}
export function SourceBadge({ task }: { task: Task }) {
  return (
    <span className="l-badge" title="Nguồn tạo việc">
      {task.source.label}
      {task.source.kind === "telegram" && !task.real ? " (mô phỏng)" : ""}
    </span>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Chỉ phụ thuộc `open`: nếu phụ thuộc onClose thì mỗi lần dữ liệu demo cập nhật, ô đang gõ sẽ mất tiêu điểm.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]),textarea");
    first?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="l-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="l-modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={wide ? { width: "min(760px,100%)" } : undefined}>
        <div className="l-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <h2>{title}</h2>
          <button className="l-btn ghost sm" onClick={onClose} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="l-drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="l-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="l-row" style={{ justifyContent: "flex-end", marginBottom: 4 }}>
          <button className="l-btn ghost sm" onClick={onClose} aria-label="Đóng">
            <X size={16} /> Đóng
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted" style={{ padding: "10px 2px" }}>{children}</p>;
}

/** DSH-03: the same badge everywhere an output is waiting for the owner (Dashboard, Chờ duyệt, task list, task panel). */
export function NewOutputBadge() {
  return <span className="l-badge amber" data-testid="new-output-badge">{NEW_OUTPUT_LABEL}</span>;
}
