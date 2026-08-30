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

  // Trust reverse-proxy headers (CloudPanel Nginx set X-Forwarded-Host + Proto).
  // Fallback req.nextUrl.origin nếu client gọi trực tiếp (dev).
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const loginUrl = new URL("/login", `${proto}://${host}`);
  loginUrl.searchParams.set("callbackUrl", pathname + search);
  return NextResponse.redirect(loginUrl, {
    headers: { "x-request-id": requestId },
  });
}

// Three self-verifying endpoints are excluded, and each carries its own reason.
//
// `api/telegram/webhook` (P3-R01 AC-07) authenticates with Telegram's secret
// token header, not with a session. Left in the matcher it was redirected to
// /login, so the transport could never have been reached by Telegram at all --
// a defect found while building the preview route, because the transport probe
// calls the handler directly and never crosses this file.
//
// `preview/` (P3-R07) authenticates with a signed, scoped, revocable capability.
// Requiring a session there would defeat the requirement outright: the point of
// Q32 Option A is that reviewing a draft from a phone does not need a login.
//
// `api/v1/outbound/alerts` (P4-R09 AC-05) is called by a Hermes cron job --
// a shell script with no browser and no cookie, so `getToken` can never
// succeed for it. It authenticates with a shared service token compared in
// constant time, and FAILS CLOSED when that token is unconfigured: an endpoint
// that opened because its secret was missing would be a public queue of
// production failures. This exclusion was found the same way the webhook one
// was -- the endpoint answered 401 to a correct token, because the request
// never reached the handler.
//
// None is unguarded. Each verifies before it acts, refuses without side
// effects, and audits every decision -- which is more than a session cookie
// would have told any of them.
export const config = {
  matcher: [
    "/((?!login$|api/auth/|api/health$|api/telegram/webhook$|api/v1/outbound/alerts$|preview/|_next/static/|_next/image|favicon\\.ico$|robots\\.txt$|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|css|js|map)$).*)",
  ],
};
