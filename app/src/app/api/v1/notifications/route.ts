import { NextResponse, type NextRequest } from "next/server";
import { requireRoleForApi } from "@/lib/authz";
import { listNotifications, countUnread } from "@/lib/notifications/list";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const gate = await requireRoleForApi(["OWNER", "ADMIN", "VIEWER"], requestId);
  if ("error" in gate) return gate.error;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: "UNAUTHORIZED", message: "Cần user id" },
      },
      { status: 401 },
    );
  }

  const unreadOnly = req.nextUrl.searchParams.get("unread") === "1";
  const [items, unreadCount] = await Promise.all([
    listNotifications({ userId: session.user.id, unreadOnly, limit: 20 }),
    countUnread(session.user.id),
  ]);

  return NextResponse.json({
    data: { items, unreadCount },
    meta: { request_id: requestId },
    error: null,
  });
}
