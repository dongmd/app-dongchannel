"use client";

import { signOut, useSession } from "next-auth/react";

// AC06 — logout button. Hiển thị email + role, click "Đăng xuất" xoá session.
export function UserMenu() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <span className="text-xs text-muted-foreground">Đang tải…</span>;
  }

  if (!session?.user) return null;

  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="flex flex-col items-end leading-tight">
        <span className="font-medium">{session.user.email}</span>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {session.user.role}
        </span>
      </div>
      <button
        type="button"
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Đăng xuất
      </button>
    </div>
  );
}
