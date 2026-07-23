import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { markAllRead } from "@/lib/notifications/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const requestId = crypto.randomUUID();
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: "UNAUTHORIZED", message: "Cần đăng nhập" },
      },
      { status: 401 },
    );
  }
  const count = await markAllRead(session.user.id);
  return NextResponse.json({
    data: { count },
    meta: { request_id: requestId },
    error: null,
  });
}
