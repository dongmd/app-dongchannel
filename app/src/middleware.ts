import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// AC05 (DC-001) + AC06 (DC-004) — auth guard cho mọi request trừ public path.
//   UI routes  → redirect /login?callbackUrl=<orig>
//   API routes → 401 JSON envelope (không redirect vì fetch sẽ follow ra HTML)
export async function middleware(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (token) return NextResponse.next();

  const { pathname, search } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        data: null,
        meta: { request_id: crypto.randomUUID() },
        error: { code: "UNAUTHORIZED", message: "Cần đăng nhập" },
      },
      { status: 401 },
    );
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("callbackUrl", pathname + search);
  return NextResponse.redirect(loginUrl);
}

// Matcher anchored theo segment. Chạy trên pathname (không có query).
export const config = {
  matcher: [
    "/((?!login$|api/auth/|api/health$|_next/static/|_next/image|favicon\\.ico$|robots\\.txt$|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|css|js|map)$).*)",
  ],
};
