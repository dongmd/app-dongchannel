import "server-only";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getServerSession, type Session } from "next-auth";
import type { AppRole } from "@/lib/db/schema/identity";
import { authOptions } from "@/lib/auth/options";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailAllowlist } from "@/lib/db/schema/identity";
import { PrivilegeChecker } from "@/lib/auth/privilege";

// email_allowlist is the canonical source an owner actually edits -- not the
// JWT, and not the users.role copy that only refreshes at sign-in.
export const privilegeChecker = new PrivilegeChecker(async (email) => {
  const rows = await db
    .select({ role: emailAllowlist.role })
    .from(emailAllowlist)
    .where(eq(emailAllowlist.email, email))
    .limit(1);
  return rows[0]?.role ?? null;
});

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

// ─── TD-17: privileged mutations re-check the canonical source ────
//
// requireRoleForApi above trusts session.user.role, which comes from a JWT
// stamped at sign-in. That is fine for reads. It is not fine for anything with
// a side effect, because an allowlist edit does not reach a live token.
//
// Use this instead for: owner approval, WordPress publish/update, Google Ads
// create/launch/scale/stop, budget changes, admin and security actions.
export async function requirePrivilegeForApi(
  allowed: readonly AppRole[],
  requestId: string,
): Promise<{ session: Session } | { error: NextResponse }> {
  const session = await getServerSession(authOptions);
  const decision = await privilegeChecker.check(session, allowed);

  if (!decision.allowed) {
    const status = decision.reason === "NO_SESSION" ? 401 : 403;
    return {
      error: NextResponse.json(
        {
          data: null,
          meta: { request_id: requestId },
          // The reason is returned deliberately: an operator whose access was
          // revoked mid-session should see why, not a generic 403.
          error: { code: decision.reason ?? "FORBIDDEN", message: "Không đủ quyền" },
        },
        { status },
      ),
    };
  }

  return { session: session as Session };
}
