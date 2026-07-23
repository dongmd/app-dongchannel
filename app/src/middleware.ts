import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { checkRateLimit, LIMITERS, makeKey } from "@/lib/rate-limit";

// AC04/AC05 (DC-001) + AC06 (DC-004) + AC01/AC04 (DC-016)
//   - Attach x-request-id vào mọi response
//   - Rate limit /api/auth/callback/* (login) + destructive API routes
//   - UI unauth → redirect /login
//   - API unauth → 401 JSON envelope
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Request ID — echo header nếu client gửi, else generate mới.
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  // AC01 — rate limit
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  let rateLimitResult: ReturnType<typeof checkRateLimit> | null = null;
  if (pathname.startsWith("/api/auth/callback/") || pathname === "/api/auth/signin") {
    rateLimitResult = checkRateLimit(makeKey("login", ip), LIMITERS.login);
  } else if (
    req.method !== "GET" &&
    (pathname.startsWith("/api/v1/tasks/") ||
      pathname.startsWith("/api/v1/memory/") ||
      pathname.startsWith("/api/v1/aff/") ||
      pathname.startsWith("/api/v1/youtube/") ||
      pathname.startsWith("/api/v1/admin/ingest"))
  ) {
    rateLimitResult = checkRateLimit(makeKey(`dest:${pathname}`, ip), LIMITERS.destructive);
  }

  if (rateLimitResult && !rateLimitResult.ok) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: `Quá nhiều request, thử lại sau ${Math.ceil((rateLimitResult.retryAfterMs ?? 0) / 1000)}s.`,
        },
      },
      {
        status: 429,
        headers: {
          "x-request-id": requestId,
          "retry-after": String(Math.ceil((rateLimitResult.retryAfterMs ?? 0) / 1000)),
        },
      },
    );
  }

  // Auth guard
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (token) {
    const response = NextResponse.next();
    response.headers.set("x-request-id", requestId);
    return response;
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: requestId },
        error: { code: "UNAUTHORIZED", message: "Cần đăng nhập" },
      },
      { status: 401, headers: { "x-request-id": requestId } },
    );
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("callbackUrl", pathname + search);
  return NextResponse.redirect(loginUrl, {
    headers: { "x-request-id": requestId },
  });
}

export const config = {
  matcher: [
    "/((?!login$|api/auth/|api/health$|_next/static/|_next/image|favicon\\.ico$|robots\\.txt$|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|css|js|map)$).*)",
  ],
};
