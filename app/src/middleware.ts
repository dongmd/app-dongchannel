// AC05 — mọi route trừ public paths yêu cầu session hợp lệ.
// Public paths được exclude qua matcher config (rẻ hơn check trong handler).
// Unauthenticated → redirect /login?callbackUrl=<orig>.
import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: { signIn: "/login" },
});

// Matcher anchored theo segment để tránh route tương lai `/loginhelp` hoặc `/api/authorize`
// vô tình bypass auth guard. Rule:
//   /login              (exact)
//   /api/auth/...       (prefix, phải có `/` sau)
//   /api/health         (exact)
//   /_next/static/...   (prefix)
//   /_next/image        (exact)
//   /favicon.ico, /robots.txt, các đuôi ảnh phổ biến  (exact ext)
// Matcher chạy trên pathname (không có query string), nên chỉ cần anchor `$` hoặc `/`.
export const config = {
  matcher: [
    "/((?!login$|api/auth/|api/health$|_next/static/|_next/image|favicon\\.ico$|robots\\.txt$|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|css|js|map)$).*)",
  ],
};
