import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildAuditRecord } from "../audit/audit-policy";
import {
  PUBLISH_AUTHORISATIONS,
  articleState,
  authorisesPublish,
  buildApproval,
  buildWithdrawal,
  isFactVerified,
  isPayloadHash,
  markTelegramActionSql,
  type ApprovalInput,
  type ApprovalRecord,
  type VerificationState,
} from "./approval-policy";

/**
 * P3-R04 — approval records, proven offline.
 *
 * `AC-03`'s choke point and `AC-08`'s immutability are DATABASE facts and are
 * proven by executing against a real PostgreSQL — `deploy/test-approval-integrity.sh`.
 * Nothing here claims to have proven them.
 */

const NOW = new Date("2026-08-22T12:00:00.000Z");
const OWNER = 987654321;
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function approvalInput(over: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    articleId: "art-1",
    revisionId: "rev-3",
    approvedBy: OWNER,
    payloadHash: HASH,
    callbackNonce: "act_0123456789abcdef0123456789abcdef",
    ttlMs: 3_600_000,
    ...over,
  };
}

function approval(over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "ap-1",
    articleId: "art-1",
    revisionId: "rev-3",
    approvedBy: OWNER,
    approvedAt: NOW,
    payloadHash: HASH,
    callbackNonce: "act_0123456789abcdef0123456789abcdef",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    withdrawsId: null,
    ...over,
  };
}

function verification(over: Partial<VerificationState> = {}): VerificationState {
  return {
    articleId: "art-1",
    evidenceLevel: "E3",
    qaResult: "pass",
    claimsChecked: 4,
    unsupportedClaims: 0,
    conflictingClaims: 0,
    lastVerifiedAt: NOW,
    ...over,
  };
}

// ─── AC-01 / AC-10: the record's fields ───────────────────────────

test("AC-01: an approval carries exactly the PROPOSED §7.1 fields", () => {
  const v = buildApproval(approvalInput(), NOW);
  assert.equal(v.ok, true, v.ok === false ? v.detail : "");
  if (!v.ok) return;

  assert.deepEqual(Object.keys(v.record).sort(), [
    "approvedAt", "approvedBy", "articleId", "callbackNonce",
    "expiresAt", "payloadHash", "revisionId", "withdrawsId",
  ]);
  assert.equal(v.record.expiresAt.getTime(), NOW.getTime() + 3_600_000);
});

test("AC-10: approved_by must be a Telegram NUMERIC id, not a coerced string", () => {
  for (const bad of ["987654321", "@owner", null, undefined, {}, 1.5, -1, 0]) {
    const v = buildApproval(approvalInput({ approvedBy: bad }), NOW);
    assert.equal(v.ok, false, `${String(bad)} was accepted as an approver`);
    assert.equal(v.ok === false && v.reason, "BAD_ACTOR");
  }
});

test("AC-05: payload_hash must be sha256 hex, and a refusal does not echo it", () => {
  for (const ok of [HASH, OTHER_HASH, "0".repeat(64)]) {
    assert.equal(isPayloadHash(ok), true);
  }
  for (const bad of ["", "abc", "A".repeat(64), "z".repeat(64), "a".repeat(63), "a".repeat(65), null, 42]) {
    assert.equal(isPayloadHash(bad), false, `${String(bad)} accepted as a hash`);
  }

  const suspicious = "not-a-hash-but-maybe-a-secret";
  const v = buildApproval(approvalInput({ payloadHash: suspicious }), NOW);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.detail.includes(suspicious), false, "the refusal echoed the value");
});

// ─── AC-07: one revision, never "the latest" ──────────────────────

test('AC-07: "latest" is not a revision -- it is a promise to resolve one later', () => {
  for (const notARevision of ["latest", "LATEST", "head", "HEAD", "current", " latest ", "", "  "]) {
    const v = buildApproval(approvalInput({ revisionId: notARevision }), NOW);
    assert.equal(v.ok, false, `"${notARevision}" was accepted as a revision`);
    assert.equal(v.ok === false && v.reason, "BAD_REVISION");
  }
  assert.equal(buildApproval(approvalInput({ revisionId: "rev-3" }), NOW).ok, true);
});

test("AC-07: an approval does not authorise a DIFFERENT revision, however recent", () => {
  const d = authorisesPublish(
    { approval: approval(), revisionId: "rev-4", currentHash: HASH },
    NOW,
  );
  assert.equal(d.authorisation, "REVISION_MISMATCH");
});

// ─── AC-05: editing after approval invalidates it ─────────────────

test("AC-05: an edit after approval refuses the publish", () => {
  // The scenario the criterion names: approve, edit, attempt to publish.
  const approved = approval({ payloadHash: HASH });

  const before = authorisesPublish({ approval: approved, revisionId: "rev-3", currentHash: HASH }, NOW);
  assert.equal(before.authorisation, "AUTHORISED");

  const afterEdit = authorisesPublish(
    { approval: approved, revisionId: "rev-3", currentHash: OTHER_HASH },
    NOW,
  );
  assert.equal(afterEdit.authorisation, "CONTENT_CHANGED");
});

test("AC-05: a missing or malformed current hash refuses rather than passing", () => {
  for (const bad of ["", "abc", null, undefined]) {
    const d = authorisesPublish(
      { approval: approval(), revisionId: "rev-3", currentHash: bad as unknown as string },
      NOW,
    );
    assert.notEqual(d.authorisation, "AUTHORISED", `${String(bad)} authorised a publish`);
  }
});

test("AC-05: an edited AND expired article reports the EDIT", () => {
  // An expiry is a schedule; a changed hash means the thing the owner consented
  // to no longer exists. The second is the fact they need.
  const d = authorisesPublish(
    {
      approval: approval({ expiresAt: new Date(NOW.getTime() - 1) }),
      revisionId: "rev-3",
      currentHash: OTHER_HASH,
    },
    NOW,
  );
  assert.equal(d.authorisation, "CONTENT_CHANGED");
});

// ─── AC-09: expiry ────────────────────────────────────────────────

test("AC-09: expiry is exact -- at the instant, one ms before, one ms after", () => {
  const expiry = new Date(NOW.getTime() + 1000);
  const a = approval({ expiresAt: expiry });
  const check = { approval: a, revisionId: "rev-3", currentHash: HASH };

  assert.equal(authorisesPublish(check, new Date(expiry.getTime() - 1)).authorisation, "AUTHORISED");
  assert.equal(authorisesPublish(check, new Date(expiry.getTime())).authorisation, "EXPIRED");
  assert.equal(authorisesPublish(check, new Date(expiry.getTime() + 1)).authorisation, "EXPIRED");
});

test("AC-09: an approval with no usable expiry is refused, not treated as eternal", () => {
  for (const bad of [null, undefined, "soon", new Date("nonsense")]) {
    const d = authorisesPublish(
      { approval: approval({ expiresAt: bad as unknown as Date }), revisionId: "rev-3", currentHash: HASH },
      NOW,
    );
    assert.equal(d.authorisation, "EXPIRED", `${String(bad)} was treated as a valid expiry`);
  }
});

test("AC-09: no approval at all is NO_APPROVAL, not a silent pass", () => {
  assert.equal(
    authorisesPublish({ approval: null, revisionId: "rev-3", currentHash: HASH }, NOW).authorisation,
    "NO_APPROVAL",
  );
});

// ─── AC-08: immutable; withdrawal is a new record ─────────────────

test("AC-08: a withdrawal is a NEW record pointing at the original", () => {
  const original = approval();
  const v = buildWithdrawal(original, OWNER, new Date(NOW.getTime() + 60_000));
  assert.equal(v.ok, true);
  if (!v.ok) return;

  assert.equal(v.record.withdrawsId, original.id);
  assert.equal(v.record.articleId, original.articleId);
  assert.equal(v.record.revisionId, original.revisionId);
  // The original is untouched -- this module returns a new record and has no
  // way to express an edit.
  assert.equal(original.withdrawsId, null);
});

test("AC-08: a withdrawn approval authorises nothing", () => {
  const d = authorisesPublish(
    { approval: approval(), isWithdrawn: true, revisionId: "rev-3", currentHash: HASH },
    NOW,
  );
  assert.equal(d.authorisation, "WITHDRAWN");
});

test("AC-08: a withdrawal row itself never authorises a publish", () => {
  const d = authorisesPublish(
    { approval: approval({ withdrawsId: "ap-1", id: "ap-2" }), revisionId: "rev-3", currentHash: HASH },
    NOW,
  );
  assert.equal(d.authorisation, "WITHDRAWN");
});

// ─── AC-04 / AC-12: approval never implies verification ───────────

test("AC-04: approving an article with unsourced claims leaves it UNVERIFIED", () => {
  // The criterion that matters most. Both records exist and DISAGREE, and the
  // disagreement is the design.
  const unsourced = verification({ unsupportedClaims: 3, qaResult: "fail", evidenceLevel: "E1" });
  const state = articleState(approval(), unsourced);

  assert.equal(state.approved, true);
  assert.equal(state.factVerified, false);
});

test("AC-04: approval and verification are computed from DIFFERENT inputs", () => {
  // Same approval, different verification -> different verdict. Same
  // verification, different approval -> same verdict. Neither can move the
  // other.
  const strong = verification();
  const weak = verification({ qaResult: "fail" });

  assert.equal(articleState(approval(), strong).factVerified, true);
  assert.equal(articleState(approval(), weak).factVerified, false);
  assert.equal(articleState(null, strong).factVerified, true);
  assert.equal(articleState(null, strong).approved, false);
});

test("AC-12: isFactVerified takes no approval -- consent cannot reach the question", () => {
  // Structural, not behavioural. The function's only parameter is the
  // verification state, so there is no argument through which an approval could
  // influence it.
  assert.equal(isFactVerified.length, 1);

  for (const notVerified of [
    verification({ qaResult: "fail" }),
    verification({ qaResult: null }),
    verification({ unsupportedClaims: 1 }),
    verification({ conflictingClaims: 1 }),
    verification({ claimsChecked: 0 }),
    verification({ lastVerifiedAt: null }),
    verification({ evidenceLevel: "E2" }),
    verification({ evidenceLevel: "E0" }),
  ]) {
    assert.equal(isFactVerified(notVerified), false, JSON.stringify(notVerified));
  }
  assert.equal(isFactVerified(verification()), true);
  assert.equal(isFactVerified(null), false);
});

test("AC-03: this module cannot express a write to the verification state", () => {
  // Making the dangerous thing UNSAYABLE rather than merely unsaid -- the same
  // technique P1-R06 used for its permit type. Source is read with comments
  // stripped: the doc block above names every field, and a scanner that cannot
  // tell prose from code punishes clear writing.
  const src = readFileSync(join(process.cwd(), "src/lib/telegram/approval-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  for (const forbidden of [
    /\bupdate\s*\(/i,
    /\binsert\s*\(/i,
    /articleVerification/,
    /\bdb\b/,
    /set_config\s*\(\s*['"`]dc\.in_telegram_action['"`]\s*,\s*['"`]off/,
  ]) {
    assert.equal(forbidden.test(src), false, `approval-policy can reach ${forbidden}`);
  }
});

test("AC-03: the Telegram-action marker is set, never cleared", () => {
  // The flag is transaction-scoped (`true` as the third argument), so it ends
  // with the transaction. A module that could turn it OFF could exempt itself
  // from the guard, which is the one thing the guard exists to prevent.
  const sql = markTelegramActionSql();
  assert.match(sql, /set_config/);
  assert.match(sql, /dc\.in_telegram_action/);
  assert.match(sql, /'on'/);
  assert.match(sql, /,\s*true\s*\)/, "the flag must be transaction-local");
  assert.equal(/'off'|false\s*\)$/.test(sql), false);
});

// ─── Audit seam (P3-R06) ──────────────────────────────────────────

test("the P3-R06 writer accepts an approval audit record, and no hash leaks", () => {
  for (const [action, result] of [
    ["approval.create", "OK"],
    ["approval.cancel", "OK"],
    ["approval.expire", "EXPIRED"],
  ] as const) {
    const rec = {
      actorType: "user" as const,
      action,
      actorId: OWNER,
      result,
      entityType: "article_approval",
      entityId: "ap-1",
      before: { approved: false },
      after: { approved: true },
    };
    const v = buildAuditRecord(rec, NOW);
    assert.equal(v.ok, true, v.ok === false ? v.detail : "");
    // The nonce is P3-R03's live bearer token; it must never reach a permanent row.
    assert.equal(JSON.stringify(v.ok && v.record).includes("act_"), false);
  }
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("AC-13 CONTROL: every authorisation outcome is reachable and in the vocabulary", () => {
  const seen = new Set([
    authorisesPublish({ approval: approval(), revisionId: "rev-3", currentHash: HASH }, NOW).authorisation,
    authorisesPublish({ approval: null, revisionId: "rev-3", currentHash: HASH }, NOW).authorisation,
    authorisesPublish({ approval: approval(), isWithdrawn: true, revisionId: "rev-3", currentHash: HASH }, NOW).authorisation,
    authorisesPublish({ approval: approval(), revisionId: "rev-9", currentHash: HASH }, NOW).authorisation,
    authorisesPublish({ approval: approval(), revisionId: "rev-3", currentHash: OTHER_HASH }, NOW).authorisation,
    authorisesPublish({ approval: approval({ expiresAt: new Date(0) }), revisionId: "rev-3", currentHash: HASH }, NOW).authorisation,
  ]);

  assert.equal(seen.size, PUBLISH_AUTHORISATIONS.length, `only ${seen.size} outcomes exercised`);
  assert.ok(seen.has("AUTHORISED"), "nothing is ever authorised -- the checker is inert");
  for (const o of seen) {
    assert.ok((PUBLISH_AUTHORISATIONS as readonly string[]).includes(o), `${o} is outside the vocabulary`);
  }
});

test("AC-13 CONTROL: buildApproval both accepts and refuses", () => {
  assert.equal(buildApproval(approvalInput(), NOW).ok, true, "nothing is ever approved");
  assert.equal(buildApproval(approvalInput({ payloadHash: "x" }), NOW).ok, false, "nothing is ever refused");
});
