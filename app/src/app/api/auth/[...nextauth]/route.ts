import { authOptions } from "@/lib/auth/options";
import NextAuth from "next-auth";
import { checkRateLimit, LIMITERS, makeKey } from "@/lib/rate-limit";

const handler = NextAuth(authOptions);

type Ctx = { params: Promise<{ nextauth: string[] }> };

/** NFR-08: sign-in attempts are rate limited per client address (10/min). Reading the session/csrf stays unlimited. */
async function limitedPost(req: Request, ctx: Ctx) {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip");
  const r = checkRateLimit(makeKey("auth-post", fwd), LIMITERS.login);
  if (!r.ok) {
    return new Response(JSON.stringify({ error: "RATE_LIMITED" }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(Math.ceil((r.retryAfterMs ?? 1000) / 1000)) } });
  }
  return (handler as unknown as (req: Request, ctx: Ctx) => Promise<Response>)(req, ctx);
}

export { handler as GET, limitedPost as POST };
