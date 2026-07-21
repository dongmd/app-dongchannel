import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { GlobalHeader } from "./global-header";

// AC04 — layout wrap tất cả route trong group (dashboard).
// AC07 — landmarks: <nav>, <header>, <main> chuẩn a11y + skip link cho keyboard user.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground"
      >
        Bỏ qua điều hướng
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <GlobalHeader />
        <main id="main-content" className="flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
