// TD-17 — revocation that actually revokes.
//
// The problem: `session.user.role` comes from a JWT stamped at sign-in. Editing
// `email_allowlist` changes nothing for a session already holding a token, so a
// revoked OWNER kept OWNER until it expired. Granting worked; revoking did not.
//
// The fix: every privileged mutation re-checks the canonical source. Not the
// token, not the cached `users.role` -- `email_allowlist`, which is what an
// owner actually edits.
//
// A short cache keeps this from becoming a query per request while giving
// revocation a bounded, stated worst case rather than "whenever the token
// expires". Fifteen seconds is the number; it is small enough that a revoked
// operator cannot do meaningful damage and large enough that a burst of API
// calls does not hammer the database.
//
// Deliberately NOT applied to reads. This is the gate for actions with side
// effects -- owner approval, WordPress publish or update, Google Ads
// create/launch/scale/stop, budget changes, admin and security actions.

import type { AppRole } from "@/lib/db/schema/identity";

export const PRIVILEGE_CACHE_TTL_MS = 15_000;

export type PrivilegeDenial =
  | "NO_SESSION"
  | "REVOKED"          // no longer on the allowlist at all
  | "INSUFFICIENT_ROLE" // still allowed in, but not for this
  | "LOOKUP_FAILED";

export interface PrivilegeDecision {
  allowed: boolean;
  reason?: PrivilegeDenial;
  /** The role the canonical source reports right now, not the one in the token. */
  currentRole?: AppRole;
}

/** Resolves the *current* role, or null if the identity is no longer allowed. */
export type RoleLookup = (email: string) => Promise<AppRole | null>;

interface CacheEntry {
  role: AppRole | null;
  at: number;
}

/**
 * Cache is per-process and tiny. It is a rate limiter, not a source of truth:
 * `revoke()` clears an entry immediately so an owner revoking access does not
 * wait out the TTL.
 */
export class PrivilegeChecker {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly lookup: RoleLookup,
    private readonly ttlMs: number = PRIVILEGE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drop a cached decision. Call after any allowlist write. */
  revoke(email: string): void {
    this.cache.delete(email.trim().toLowerCase());
  }

  clear(): void {
    this.cache.clear();
  }

  async check(
    session: { user?: { email?: string | null; role?: AppRole } } | null,
    allowed: readonly AppRole[],
  ): Promise<PrivilegeDecision> {
    const email = session?.user?.email?.trim().toLowerCase();
    if (!email) {
      return { allowed: false, reason: "NO_SESSION" };
    }

    let role: AppRole | null;
    const hit = this.cache.get(email);
    if (hit && this.now() - hit.at < this.ttlMs) {
      role = hit.role;
    } else {
      try {
        role = await this.lookup(email);
      } catch {
        // Fail closed. A database that cannot answer "is this person still an
        // owner" is not a reason to assume they are.
        return { allowed: false, reason: "LOOKUP_FAILED" };
      }
      this.cache.set(email, { role, at: this.now() });
    }

    if (role === null) {
      return { allowed: false, reason: "REVOKED" };
    }
    if (!allowed.includes(role)) {
      // Covers the downgrade case: the token still says OWNER, the allowlist
      // says VIEWER, and the allowlist wins.
      return { allowed: false, reason: "INSUFFICIENT_ROLE", currentRole: role };
    }

    return { allowed: true, currentRole: role };
  }
}
