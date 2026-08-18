import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PrivilegeChecker, type RoleLookup } from "./privilege.ts";
import type { AppRole } from "../db/schema/identity.ts";

// A session issued when the user WAS an owner. This is the whole point: the
// token keeps saying OWNER long after the allowlist stopped agreeing.
const staleOwnerSession = { user: { email: "owner@dongchannel.com", role: "OWNER" as AppRole } };

/** Mutable stand-in for email_allowlist. */
function allowlist(initial: Record<string, AppRole | null>) {
  const table = { ...initial };
  const lookup: RoleLookup = async (email) => table[email] ?? null;
  return {
    lookup,
    set: (email: string, role: AppRole | null) => {
      if (role === null) delete table[email];
      else table[email] = role;
    },
  };
}

describe("TD-17 — revocation reaches a live session", () => {
  test("OWNER downgraded to VIEWER loses privilege without logging out", async () => {
    const list = allowlist({ "owner@dongchannel.com": "OWNER" });
    const checker = new PrivilegeChecker(list.lookup, 0); // no cache window

    assert.equal((await checker.check(staleOwnerSession, ["OWNER"])).allowed, true);

    list.set("owner@dongchannel.com", "VIEWER");

    const after = await checker.check(staleOwnerSession, ["OWNER"]);
    assert.equal(after.allowed, false, "a downgraded owner kept OWNER privilege");
    assert.equal(after.reason, "INSUFFICIENT_ROLE");
    // The token still says OWNER; the canonical source is what answered.
    assert.equal(after.currentRole, "VIEWER");
    assert.equal(staleOwnerSession.user.role, "OWNER");
  });

  test("removal from the allowlist revokes entirely", async () => {
    const list = allowlist({ "owner@dongchannel.com": "OWNER" });
    const checker = new PrivilegeChecker(list.lookup, 0);

    list.set("owner@dongchannel.com", null);

    const after = await checker.check(staleOwnerSession, ["OWNER", "VIEWER"]);
    assert.equal(after.allowed, false);
    assert.equal(after.reason, "REVOKED");
  });

  test("an old, still-valid token cannot perform a privileged action after revoke", async () => {
    // No sign-out, no token expiry, no user action of any kind.
    const list = allowlist({ "owner@dongchannel.com": "OWNER" });
    const checker = new PrivilegeChecker(list.lookup, 0);

    list.set("owner@dongchannel.com", null);

    for (const action of [["OWNER"], ["OWNER", "VIEWER"]] as const) {
      assert.equal((await checker.check(staleOwnerSession, action)).allowed, false);
    }
  });

  test("the current owner keeps working — revocation must not lock the owner out", async () => {
    const list = allowlist({ "owner@dongchannel.com": "OWNER" });
    const checker = new PrivilegeChecker(list.lookup, 0);
    const d = await checker.check(staleOwnerSession, ["OWNER"]);
    assert.equal(d.allowed, true);
    assert.equal(d.currentRole, "OWNER");
  });
});

describe("bounded freshness", () => {
  test("a cached decision expires, so revocation lands within the TTL", async () => {
    let clock = 0;
    const list = allowlist({ "owner@dongchannel.com": "OWNER" });
    const checker = new PrivilegeChecker(list.lookup, 15_000, () => clock);

    assert.equal((await checker.check(staleOwnerSession, ["OWNER"])).allowed, true);

    list.set("owner@dongchannel.com", null);

    // Inside the window the cached answer is still used -- stated, bounded.
    clock = 14_999;
    assert.equal((await checker.check(staleOwnerSession, ["OWNER"])).allowed, true);

    clock = 15_001;
    assert.equal((await checker.check(staleOwnerSession, ["OWNER"])).allowed, false);
  });

  test("revoke() clears immediately, without waiting out the TTL", async () => {
    const list = allowlist({ "owner@dongchannel.com": "OWNER" });
    const checker = new PrivilegeChecker(list.lookup, 15_000, () => 0);

    await checker.check(staleOwnerSession, ["OWNER"]);
    list.set("owner@dongchannel.com", null);
    checker.revoke("owner@dongchannel.com");

    assert.equal((await checker.check(staleOwnerSession, ["OWNER"])).allowed, false);
  });
});

describe("fails closed", () => {
  test("no session is denied", async () => {
    const checker = new PrivilegeChecker(async () => "OWNER", 0);
    assert.equal((await checker.check(null, ["OWNER"])).reason, "NO_SESSION");
    assert.equal((await checker.check({ user: {} }, ["OWNER"])).reason, "NO_SESSION");
  });

  test("a lookup failure denies rather than assuming the old role", async () => {
    const checker = new PrivilegeChecker(async () => {
      throw new Error("db down");
    }, 0);
    const d = await checker.check(staleOwnerSession, ["OWNER"]);
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "LOOKUP_FAILED");
  });

  test("email comparison is case and whitespace insensitive", async () => {
    const list = allowlist({ "owner@dongchannel.com": "OWNER" });
    const checker = new PrivilegeChecker(list.lookup, 0);
    const messy = { user: { email: "  OWNER@DongChannel.com  ", role: "OWNER" as AppRole } };
    assert.equal((await checker.check(messy, ["OWNER"])).allowed, true);
  });
});
