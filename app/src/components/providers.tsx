"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

// Client-side SessionProvider để useSession()/signOut() dùng được trong Client Components.
// Auth.js v4 pattern chuẩn — session state được fetch lười khi component gọi useSession.
export function AppProviders({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
