import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailAllowlist, type AppRole } from "@/lib/db/schema/identity";

export interface AllowlistDecision {
  allowed: boolean;
  role: AppRole;
  source: "db" | "env-bootstrap" | "none";
}

// AC04 — chỉ email ĐẦU TIÊN trong env được bootstrap OWNER. Các email khác default VIEWER.
// Env chỉ là fallback lúc DB chưa seed; role thật quản lý qua bảng email_allowlist.
interface EnvAllowlistEntry {
  email: string;
  role: AppRole;
}
function getEnvAllowlist(): EnvAllowlistEntry[] {
  const raw = process.env.AUTH_EMAIL_ALLOWLIST ?? "";
  const seen = new Set<string>();
  const out: EnvAllowlistEntry[] = [];
  for (const entry of raw.split(",")) {
    const email = entry.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, role: out.length === 0 ? "OWNER" : "VIEWER" });
  }
  return out;
}

// Priority: DB (source of truth) → env bootstrap (V1 khi DB chưa seed).
export async function checkAllowlist(rawEmail: string): Promise<AllowlistDecision> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { allowed: false, role: "VIEWER", source: "none" };

  try {
    const rows = await db
      .select({ role: emailAllowlist.role })
      .from(emailAllowlist)
      .where(eq(emailAllowlist.email, email))
      .limit(1);
    const row = rows[0];
    if (row) return { allowed: true, role: row.role, source: "db" };
  } catch (err) {
    // DB không reach được → fallback env. Log nhẹ (không log email).
    console.error("[allowlist] DB check failed, falling back to env:", (err as Error).message);
  }

  const envEntry = getEnvAllowlist().find((e) => e.email === email);
  if (envEntry) return { allowed: true, role: envEntry.role, source: "env-bootstrap" };

  return { allowed: false, role: "VIEWER", source: "none" };
}
