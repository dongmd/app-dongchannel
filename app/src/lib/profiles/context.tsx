"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ProfileFilter } from "./types";

// Server layout resolve giá trị cookie 1 lần rồi truyền xuống provider này.
// Client hook `useProfileFilter` sẽ đọc URL trước, fallback về `cookieDefault` từ đây.
// Cách này khớp priority server (URL → cookie → 'all') mà không cần đọc document.cookie
// (tránh hydration mismatch).
interface ProfileFilterCtx {
  cookieDefault: ProfileFilter;
}

const Ctx = createContext<ProfileFilterCtx>({ cookieDefault: "all" });

export function ProfileFilterProvider({
  cookieDefault,
  children,
}: {
  cookieDefault: ProfileFilter;
  children: ReactNode;
}) {
  return <Ctx.Provider value={{ cookieDefault }}>{children}</Ctx.Provider>;
}

export function useProfileFilterContext() {
  return useContext(Ctx);
}
