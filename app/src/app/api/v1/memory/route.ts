import { NextResponse, type NextRequest } from "next/server";
import { requireRoleForApi } from "@/lib/authz";
import { listMemory, type MemoryTab } from "@/lib/memory/list";
import { profileFilterSchema, type ProfileFilter } from "@/lib/profiles/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TABS: MemoryTab[] = ["pending", "user_profile", "decision", "playbook"];

export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN", "VIEWER"], requestId);
  if ("error" in gate) return gate.error;

  const rawTab = req.nextUrl.searchParams.get("tab") ?? "pending";
  const tab = (VALID_TABS as string[]).includes(rawTab) ? (rawTab as MemoryTab) : "pending";

  const rawProfile = req.nextUrl.searchParams.get("profile");
  const parsed = rawProfile ? profileFilterSchema.safeParse(rawProfile) : null;
  const profile: ProfileFilter = parsed?.success ? parsed.data : "all";

  const items = await listMemory({ tab, profile });
  return NextResponse.json({
    data: { items, tab, profile },
    meta: { request_id: requestId },
    error: null,
  });
}
