"use client";

import { Bell, Plus, Search } from "lucide-react";
import { UserMenu } from "@/components/user-menu";

// AC02 — global header với search + profile switcher placeholder + +Task + notif + user menu.
// Profile switcher = DC-003. Search = DC-013. +Task = DC-005 (dashboard summary). Notif = DC-015.
// V1 các button chưa hoạt động, chỉ tạo khung UI đúng ARIA + focus.
export function GlobalHeader() {
  return (
    <header
      role="banner"
      className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur md:px-6"
    >
      {/* Chừa chỗ mobile menu toggle */}
      <div className="w-10 md:hidden" aria-hidden="true" />

      {/* Profile switcher — DC-003 */}
      <button
        type="button"
        disabled
        className="hidden items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground disabled:opacity-60 md:flex"
        aria-label="Chọn profile (chưa hoạt động — DC-003)"
      >
        <span className="font-mono text-xs">▼</span>
        Tất cả
      </button>

      {/* Search — DC-013 */}
      <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-1.5 text-sm text-muted-foreground">
        <Search className="h-4 w-4" aria-hidden="true" />
        <span>Tìm task, offer, video, memory… (sẽ có ở DC-013)</span>
      </div>

      {/* +Task */}
      <button
        type="button"
        disabled
        className="hidden items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm text-primary disabled:opacity-60 md:flex"
        aria-label="Tạo nhiệm vụ mới (sẽ có ở DC-005)"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Tạo nhiệm vụ
      </button>

      {/* Notification — DC-015 */}
      <button
        type="button"
        disabled
        className="relative rounded-md border border-border p-1.5 text-muted-foreground disabled:opacity-60"
        aria-label="Thông báo (sẽ có ở DC-015)"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
      </button>

      <UserMenu />
    </header>
  );
}
