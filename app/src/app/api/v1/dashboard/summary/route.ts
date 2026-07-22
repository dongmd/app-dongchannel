import { NextResponse, type NextRequest } from "next/server";
import { requireRoleForApi } from "@/lib/authz";
import { computeDashboardSummary } from "@/lib/dashboard/summary";
import { profileFilterSchema, type ProfileFilter } from "@/lib/profiles/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AC02 — envelope response, filter theo ?profile=all|aff|yt (default all).
// AC role: mọi user đã đăng nhập được xem (không giới hạn OWNER/ADMIN như /admin).
export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN", "VIEWER"], requestId);
  if ("error" in gate) return gate.error;

  const rawProfile = req.nextUrl.searchParams.get("profile");
  const parsed = rawProfile ? profileFilterSchema.safeParse(rawProfile) : null;
  const profile: ProfileFilter = parsed?.success ? parsed.data : "all";

  const summary = await computeDashboardSummary(profile);
  return NextResponse.json({
    data: summary,
    meta: { request_id: requestId },
    error: null,
  });
}
