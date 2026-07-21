import "server-only";
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, type AppRole } from "@/lib/db/schema/identity";
import { checkAllowlist } from "./allowlist";
import { recordAuthEvent, maskEmail } from "./audit";

if (!process.env.NEXTAUTH_SECRET) {
  // Đảm bảo fail early trong prod — dev có thể chạy tạm.
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXTAUTH_SECRET is required in production");
  }
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 }, // AC03 — 7 ngày
  secret: process.env.NEXTAUTH_SECRET,
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === "production"
          ? "__Secure-next-auth.session-token"
          : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      authorization: {
        params: {
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
        },
      },
    }),
  ],
  callbacks: {
    // AC02 — chặn ngay ở signIn nếu không allowlist. AC08 — audit.
    // Auth.js v4 sẽ redirect /login?error=AccessDenied khi trả false (PascalCase, xem docs/TDD.md mục 27).
    async signIn({ user, account, profile }) {
      const email = user.email?.trim().toLowerCase();
      if (!email) {
        await recordAuthEvent({ action: "login.denied", reason: "missing_email" });
        return false;
      }
      // Chỉ chấp nhận email đã verify từ Google (chặn workspace admin fabricate email chưa verify).
      if (account?.provider === "google") {
        const emailVerified = (profile as { email_verified?: boolean } | undefined)?.email_verified;
        if (emailVerified !== true) {
          await recordAuthEvent({
            action: "login.denied",
            actorId: maskEmail(email),
            reason: "email_not_verified",
          });
          return false;
        }
      }
      const decision = await checkAllowlist(email);
      if (!decision.allowed) {
        // AC10 — mask email, không log raw
        await recordAuthEvent({
          action: "login.denied",
          actorId: maskEmail(email),
          reason: "not_in_allowlist",
          meta: { provider: account?.provider },
        });
        return false;
      }
      // Upsert user + last_login. Sync role theo decision mới nhất từ allowlist (v/d admin đổi role).
      // Không block signIn nếu DB fail — log riêng.
      try {
        const existing = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (existing[0]) {
          await db
            .update(users)
            .set({
              name: user.name ?? null,
              image: user.image ?? null,
              googleSub: account?.providerAccountId ?? null,
              role: decision.role,
              lastLoginAt: new Date(),
            })
            .where(eq(users.id, existing[0].id));
        } else {
          await db.insert(users).values({
            email,
            name: user.name ?? null,
            image: user.image ?? null,
            googleSub: account?.providerAccountId ?? null,
            role: decision.role,
            lastLoginAt: new Date(),
          });
        }
        await recordAuthEvent({
          action: "login.success",
          actorId: email,
          meta: { provider: account?.provider, source: decision.source },
        });
        return true;
      } catch (err) {
        await recordAuthEvent({
          action: "login.error",
          actorId: maskEmail(email),
          reason: "db_upsert_failed",
          meta: { message: (err as Error).message },
        });
        // Fail closed — nếu DB down thì không cấp session mới
        return false;
      }
    },

    // AC04 — nhét role + userId vào JWT.
    // Refetch DB mỗi lần signIn để đồng bộ role update từ allowlist.
    async jwt({ token, user, trigger }) {
      if (trigger === "signIn" || (user?.email && !token.role)) {
        const email = (user?.email ?? token.email)?.toString().trim().toLowerCase();
        if (email) {
          try {
            const rows = await db
              .select({ id: users.id, role: users.role })
              .from(users)
              .where(eq(users.email, email))
              .limit(1);
            const row = rows[0];
            if (row) {
              token.userId = row.id;
              token.role = row.role;
              token.email = email;
            }
          } catch (err) {
            console.error("[auth.jwt] db fetch failed:", (err as Error).message);
          }
        }
      }
      return token;
    },

    // AC04 — expose role/id ra session cho UI + API guard.
    // Nếu jwt callback không lấy được userId (DB down) — trả về session không có user để downstream
    // guard buộc re-login, tránh query `WHERE user_id = ''` sai record.
    async session({ session, token }) {
      if (!token.userId) {
        return { expires: session.expires } as typeof session;
      }
      if (session.user) {
        session.user.id = token.userId;
        session.user.email = (token.email as string) ?? session.user.email ?? "";
        session.user.role = (token.role ?? "VIEWER") as AppRole;
      }
      return session;
    },
  },
  pages: { signIn: "/login", error: "/login" },
  events: {
    async signOut({ token }) {
      await recordAuthEvent({
        action: "logout",
        actorId: typeof token?.email === "string" ? token.email : undefined,
      });
    },
  },
};
