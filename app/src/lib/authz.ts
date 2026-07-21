import "server-only";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getServerSession, type Session } from "next-auth";
import type { AppRole } from "@/lib/db/schema/identity";
import { authOptions } from "@/lib/auth/options";

// Guard cho server component. Redirect / nếu không đủ quyền
// (không throw 403 vì user hợp lệ chỉ là không đủ quyền cho trang cụ thể).
// Middleware đã chặn unauth trước — thêm getServerSession() defensive check.
export async function requireRoleOrRedirect(
  allowed: readonly AppRole[],
  redirectTo = "/",
): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  if (!allowed.includes(session.user.role)) redirect(redirectTo);
  return session;
}

// Guard cho route handler /api/v1/*. Trả 403 JSON envelope (không redirect).
// Trả `null` nếu OK để caller tiếp tục xử lý, hoặc `NextResponse` để early return.
export async function requireRoleForApi(
  allowed: readonly AppRole[],
  requestId: string,
): Promise<{ session: Session } | { error: NextResponse }> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return {
      error: NextResponse.json(
        {
          data: null,
          meta: { request_id: requestId },
          error: { code: "UNAUTHORIZED", message: "Cần đăng nhập" },
        },
        { status: 401 },
      ),
    };
  }
  if (!allowed.includes(session.user.role)) {
    return {
      error: NextResponse.json(
        {
          data: null,
          meta: { request_id: requestId },
          error: { code: "FORBIDDEN", message: "Không đủ quyền" },
        },
        { status: 403 },
      ),
    };
  }
  return { session };
}
