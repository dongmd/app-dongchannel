import "server-only";
import { db } from "@/lib/db";
import { auditEvents, type NewAuditEventRow } from "@/lib/db/schema/audit";

/**
 * Auth security telemetry — **not** the canonical P3 immutable audit log.
 *
 * Owner decision, 2026-08-22. This module records authentication events on a
 * **best-effort** basis: a failed write is logged and swallowed, because an
 * audit outage must not lock the owner out of their own dashboard.
 *
 * `P3-R06` is the canonical immutable audit log and its `AC-09` makes the
 * opposite choice — a failed write **fails the operation**. The two do not
 * conflict, and the reason is scope: `P3-R06 AC-06` binds **P3 state changes**,
 * and a login is not one. Extending R06 over authentication would trade an
 * availability property nobody asked to trade.
 *
 * ## The distinction lives in the DATA, not only in this comment
 *
 * Both write to `audit_events`, which is the one canonical audit table
 * (`P3-R06 AC-01` — there is no second log). What separates them is the
 * `action` vocabulary: these are `login.*` / `logout`, P3's are `telegram.*`,
 * `approval.*` and `preview.*`, and the two sets are **disjoint and asserted to
 * be so** in `audit-policy.test.ts`. A query for canonical P3 audit actions
 * therefore never picks up a best-effort row.
 *
 * **These names are deliberately NOT prefixed `auth.`**, tempting as it is. The
 * table is append-only as of migration `0028`, so existing rows can never be
 * migrated — a rename would split the login history permanently in exchange for
 * a tidiness the disjointness already provides.
 *
 * **Do not cite this module as evidence for `P3-R06`.** It is outside that
 * requirement's scope.
 *
 * ## Provenance
 *
 * Created under `DC-001`, a story id in a **superseded** document. No canonical
 * V2 requirement owns this behaviour — the `CSG-01` category — and `P3-R08`'s
 * inventory did not capture it either, its declared scope being shell and
 * control-plane surfaces rather than the auth layer. Reported to the owner
 * rather than absorbed into a requirement it does not belong to.
 */
type AuthAction = "login.success" | "login.denied" | "login.error" | "logout";

/**
 * The action names this module owns. Exported so the disjointness with
 * `P3-R06`'s vocabulary can be asserted rather than assumed.
 */
export const AUTH_TELEMETRY_ACTIONS = [
  "login.success",
  "login.denied",
  "login.error",
  "logout",
] as const;

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
    // Deliberately swallowed, and this is the whole reason the module is
    // classified as telemetry rather than audit: an audit outage must not lock
    // the owner out of their own dashboard. `P3-R06 AC-09` makes the opposite
    // choice for P3 state changes, on purpose — those are governed actions, a
    // login attempt is not.
    console.error("[auth-telemetry] insert failed:", (err as Error).message);
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
