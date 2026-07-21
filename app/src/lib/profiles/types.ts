// Profile filter cho global switcher (PRD mục 7.2).
// Slug khớp Hermes profile slug thực tế trên VPS (Discovery Gate mục 4): `aff`, `yt`.
// `all` = không lọc (mặc định ở Overview & Tasks).
import { z } from "zod";

export const PROFILE_FILTER_VALUES = ["all", "aff", "yt"] as const;
export type ProfileFilter = (typeof PROFILE_FILTER_VALUES)[number];

export const profileFilterSchema = z.enum(PROFILE_FILTER_VALUES);

// URL search-param key + cookie key. Cùng đặt ở đây để tránh rải rác magic strings.
export const PROFILE_PARAM = "profile" as const;
export const PROFILE_COOKIE = "dc_profile" as const;

// Nhãn hiển thị. Bot-name khớp Discovery Gate mục 4.
export const PROFILE_LABELS: Record<ProfileFilter, { short: string; long: string }> = {
  all: { short: "Tất cả", long: "Tất cả profile" },
  aff: { short: "AFF Bot", long: "AFF Research Bot" },
  yt: { short: "YouTube Bot", long: "YouTube Global Bot" },
};

// AC03 — pathname bắt buộc gán profile cụ thể (badge readonly).
export function getForcedProfile(pathname: string): ProfileFilter | null {
  if (pathname === "/aff" || pathname.startsWith("/aff/")) return "aff";
  if (pathname === "/youtube" || pathname.startsWith("/youtube/")) return "yt";
  return null;
}
