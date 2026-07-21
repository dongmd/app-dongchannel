import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { ProfileFilterProvider } from "@/lib/profiles/context";
import { getCookieProfile } from "@/lib/profiles/server";

// Route group (dashboard) — layout wrap.
// Async: resolve cookie profile 1 lần ở server rồi truyền xuống ProfileFilterProvider
// để client hook có initial giá trị mà không cần đọc document.cookie (tránh hydration mismatch).
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieDefault = await getCookieProfile();
  return (
    <ProfileFilterProvider cookieDefault={cookieDefault}>
      <AppShell>{children}</AppShell>
    </ProfileFilterProvider>
  );
}
