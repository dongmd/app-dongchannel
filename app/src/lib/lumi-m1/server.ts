import "server-only";
/**
 * Next-side wiring for the M1 handlers: DB singleton, principal resolution (service token or signed-in session with the
 * CANONICAL role from email_allowlist), JSON envelope, request id, simple per-actor rate limit.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import type postgres from "postgres";
import { authOptions } from "@/lib/auth/options";
import { privilegeChecker } from "@/lib/authz";
import type { Db } from "./core";
import { connectLumi, postgresDb } from "./pg-adapter";
import { handle, resolveBotToken, type ApiCtx, type Principal } from "./handlers";
import { SimulatedHermes } from "./hermes-port";
import { SshHermes } from "./ssh-hermes";
import type { HermesPort } from "./core";

const g = globalThis as unknown as { __lumiSql?: postgres.Sql; __lumiHermes?: HermesPort; __lumiBuckets?: Map<string, { n: number; t: number }> };

export function lumiSql(): postgres.Sql {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  g.__lumiSql ??= connectLumi(process.env.DATABASE_URL, { max: 5 });
  return g.__lumiSql;
}
export function lumiDb(): Db { return postgresDb(lumiSql()); }

/** LUMI_HERMES_MODE=ssh selects the REAL adapter (test profile over SSH); otherwise the labelled simulation. */
export function lumiHermes(): HermesPort {
  g.__lumiHermes ??= process.env.LUMI_HERMES_MODE === "ssh"
    ? new SshHermes({ host: process.env.LUMI_HERMES_SSH_HOST ?? "dlnew", profile: process.env.LUMI_HERMES_PROFILE ?? "lumitest", maxTurns: Number(process.env.LUMI_HERMES_MAX_TURNS ?? 8), runDeadlineSeconds: Number(process.env.LUMI_RUN_DEADLINE_SECONDS ?? 600) })
    : new SimulatedHermes();
  return g.__lumiHermes;
}

function allow(key: string): boolean {
  const buckets = (g.__lumiBuckets ??= new Map());
  const nowMs = Date.now();
  const b = buckets.get(key);
  const WINDOW = 60_000, MAX = 60;
  if (!b || nowMs - b.t > WINDOW) { buckets.set(key, { n: 1, t: nowMs }); return true; }
  b.n += 1;
  return b.n <= MAX;
}

export function lumiCtx(): ApiCtx {
  return { db: lumiDb(), hermes: lumiHermes(), now: () => new Date(), allow };
}

export async function resolvePrincipal(req: NextRequest): Promise<{ principal: Principal | null; invalidToken: boolean }> {
  const presented = req.headers.get("x-dc-service-token");
  if (presented !== null) {
    const slug = resolveBotToken(presented, process.env.LUMI_BOT_TOKENS);
    return slug ? { principal: { kind: "bot", slug, actorRef: `bot:${slug}` }, invalidToken: false } : { principal: null, invalidToken: true };
  }
  const session = await getServerSession(authOptions);
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) return { principal: null, invalidToken: false };
  const d = await privilegeChecker.check(session, ["OWNER", "ADMIN", "VIEWER"]);
  if (!d.allowed || !d.currentRole || d.currentRole === "AGENT") return { principal: null, invalidToken: false };
  return { principal: { kind: "user", actorRef: `web:${email}`, role: d.currentRole as "OWNER" | "ADMIN" | "VIEWER" }, invalidToken: false };
}

export function lumiRoute(name: string) {
  return async (req: NextRequest, c: { params: Promise<Record<string, string>> }): Promise<NextResponse> => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const reply = (status: number, data: unknown, error: unknown = null) =>
      NextResponse.json({ data, meta: { request_id: requestId }, error }, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
    try {
      const { principal, invalidToken } = await resolvePrincipal(req);
      if (invalidToken || !principal) return reply(401, null, { code: "UNAUTHORIZED", message: "Cần đăng nhập hoặc token dịch vụ" });
      let body: unknown = {};
      let rawLength = 0;
      if (req.method !== "GET") {
        // Session-authenticated writes must be JSON: a cross-site form post cannot send this content type without a preflight.
        if (principal.kind === "user" && !(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
          return reply(415, null, { code: "UNSUPPORTED_MEDIA_TYPE", message: "Cần application/json" });
        }
        const text = await req.text();
        rawLength = text.length;
        if (text.trim()) {
          try { body = JSON.parse(text); } catch { return reply(400, null, { code: "VALIDATION_ERROR", message: "JSON không hợp lệ" }); }
        }
      }
      const params = await c.params;
      const r = await handle(name, lumiCtx(), { principal, params, body, headers: req.headers, rawLength });
      return reply(r.status, r.data, r.error ?? null);
    } catch {
      return reply(500, null, { code: "INTERNAL", message: "Lỗi hệ thống" });
    }
  };
}

/** For server components: the signed-in person with the CANONICAL role (allowlist), or null. */
export async function currentUser(): Promise<{ actorRef: string; email: string; role: "OWNER" | "ADMIN" | "VIEWER" } | null> {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) return null;
  const d = await privilegeChecker.check(session, ["OWNER", "ADMIN", "VIEWER"]);
  if (!d.allowed || !d.currentRole || d.currentRole === "AGENT") return null;
  return { actorRef: `web:${email}`, email, role: d.currentRole as "OWNER" | "ADMIN" | "VIEWER" };
}
