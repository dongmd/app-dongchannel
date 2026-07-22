import { NextResponse, type NextRequest } from "next/server";
import { requireRoleForApi } from "@/lib/authz";
import { unifiedSearch, type SearchEntityType } from "@/lib/search/search";
import { profileFilterSchema, type ProfileFilter } from "@/lib/profiles/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: SearchEntityType[] = [
  "task",
  "memory",
  "offer",
  "video",
  "niche",
  "market",
  "message",
];

export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN", "VIEWER"], requestId);
  if ("error" in gate) return gate.error;

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const rawProfile = req.nextUrl.searchParams.get("profile");
  const parsed = rawProfile ? profileFilterSchema.safeParse(rawProfile) : null;
  const profile: ProfileFilter = parsed?.success ? parsed.data : "all";
  const rawType = req.nextUrl.searchParams.get("type");
  const type =
    rawType && (VALID_TYPES as string[]).includes(rawType) ? (rawType as SearchEntityType) : "all";

  const result = await unifiedSearch({ q, profile, type });
  return NextResponse.json({
    data: result,
    meta: { request_id: requestId },
    error: null,
  });
}
