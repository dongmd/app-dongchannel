"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  PROFILE_COOKIE,
  PROFILE_PARAM,
  getForcedProfile,
  profileFilterSchema,
  type ProfileFilter,
} from "./types";
import { useProfileFilterContext } from "./context";

// AC06 — helper duy nhất cho client. Priority khớp `lib/profiles/server.ts`:
//   URL param → cookie (từ context, server layout đã resolve) → 'all'
export interface UseProfileFilter {
  current: ProfileFilter;
  forced: ProfileFilter | null;
  setFilter: (next: ProfileFilter) => void;
}

// Cookie 1 năm, path=/ — persist giữa session, không nhạy cảm nên không cần Secure/HttpOnly.
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

export function useProfileFilter(): UseProfileFilter {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { cookieDefault } = useProfileFilterContext();

  const { current, forced } = useMemo(() => {
    const forcedProfile = getForcedProfile(pathname);
    if (forcedProfile) return { current: forcedProfile, forced: forcedProfile };
    const raw = params.get(PROFILE_PARAM);
    const parsed = raw ? profileFilterSchema.safeParse(raw) : null;
    if (parsed?.success) return { current: parsed.data, forced: null };
    return { current: cookieDefault, forced: null };
  }, [params, pathname, cookieDefault]);

  const setFilter = useCallback(
    (next: ProfileFilter) => {
      if (forced) return; // AC03 — readonly trên /aff và /youtube
      const search = new URLSearchParams(params.toString());
      // AC02 — literal set profile=all thay vì delete param (rõ ràng cho analytics).
      search.set(PROFILE_PARAM, next);
      const target = `${pathname}?${search.toString()}`;

      // Persist cookie (không nhạy cảm, path=/ để dùng khắp app)
      if (typeof document !== "undefined") {
        document.cookie = `${PROFILE_COOKIE}=${next}; path=/; max-age=${COOKIE_MAX_AGE_S}; samesite=lax`;
      }

      router.push(target);
    },
    [forced, params, pathname, router],
  );

  return { current, forced, setFilter };
}
