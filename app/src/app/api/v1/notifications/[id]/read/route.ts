import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { markRead } from "@/lib/notifications/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
  const { id } = await ctx.params;
  const changed = await markRead(session.user.id, id);
  return NextResponse.json({
    data: { changed },
    meta: { request_id: requestId },
    error: null,
  });
}
