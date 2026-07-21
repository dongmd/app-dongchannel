import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";

// Route group (dashboard) — chỉ layout wrap, không thay đổi URL.
// Middleware đã chặn unauthenticated, không cần double-check ở đây.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
