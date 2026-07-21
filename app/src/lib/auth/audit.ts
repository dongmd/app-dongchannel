import "server-only";
import { db } from "@/lib/db";
import { auditEvents, type NewAuditEventRow } from "@/lib/db/schema/audit";

type AuthAction = "login.success" | "login.denied" | "login.error" | "logout";

export interface AuthAuditPayload {
  action: AuthAction;
  actorId?: string;
  requestId?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

// AC08 — ghi audit event cho login pass/fail.
// Policy AC10:
//   - login.denied / login.error → actorId = maskEmail (không expose PII của người ngoài allowlist)
//   - login.success / logout    → actorId = raw email (user đã hợp lệ, cần trace được)
// Comment ở call site cần lặp lại rule này để reviewer không lệch chuẩn.
export async function recordAuthEvent(payload: AuthAuditPayload): Promise<void> {
  const hasExtras = Boolean(payload.reason || payload.meta);
  const row: NewAuditEventRow = {
    actorType: "user",
    actorId: payload.actorId ?? null,
    action: payload.action,
    entityType: "auth",
    entityId: null,
    beforeJson: null,
    afterJson: hasExtras ? { reason: payload.reason, meta: payload.meta } : null,
    requestId: payload.requestId ?? null,
  };
  try {
    await db.insert(auditEvents).values(row);
  } catch (err) {
    // Không throw — audit fail không được block login.
    console.error("[audit] insert failed:", (err as Error).message);
  }
}

// AC10 — mask email cho denied event. Giữ 1 ký tự đầu local part + độ dài để trace mà không lộ full name.
// VD:  "abc.def@x.com" → "a***(7)@x.com"
//      "ab@x.com"      → "a***(2)@x.com"
export function maskEmail(email: string): string {
  const parts = email.trim().toLowerCase().split("@");
  const local = parts[0];
  const domain = parts[1];
  if (!local || !domain) return "invalid";
  const head = local.slice(0, 1);
  return `${head}***(${local.length})@${domain}`;
}
