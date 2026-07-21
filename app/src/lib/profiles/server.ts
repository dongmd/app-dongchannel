import "server-only";
import { cookies } from "next/headers";
import {
  PROFILE_COOKIE,
  PROFILE_PARAM,
  profileFilterSchema,
  type ProfileFilter,
} from "./types";

// AC04/AC05/AC06 — read priority: URL searchParam → cookie → default 'all'.
// SearchParams của Next.js 15 là async (Promise). Server Component pass thẳng vào.
type SearchParamsInput =
  | Record<string, string | string[] | undefined>
  | Promise<Record<string, string | string[] | undefined>>
  | undefined;

function parseParam(raw: unknown): ProfileFilter | null {
  if (typeof raw !== "string") return null;
  const result = profileFilterSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// Đọc chỉ cookie (không URL) — dùng cho layout không nhận searchParams.
export async function getCookieProfile(): Promise<ProfileFilter> {
  try {
    const store = await cookies();
    const fromCookie = parseParam(store.get(PROFILE_COOKIE)?.value);
    return fromCookie ?? "all";
  } catch {
    return "all";
  }
}

export async function getProfileFilter(searchParams?: SearchParamsInput): Promise<ProfileFilter> {
  // 1. Từ URL — ưu tiên cao nhất, đáng share/bookmark.
  const sp = searchParams instanceof Promise ? await searchParams : searchParams;
  const fromUrl = sp ? parseParam(sp[PROFILE_PARAM]) : null;
  if (fromUrl) return fromUrl;

  // 2. Từ cookie — persistence giữa session.
  return getCookieProfile();
}
