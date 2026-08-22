import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  AUDIT_ACTIONS,
  AUDIT_RESULTS,
  AUDIT_RETENTION,
  buildAuditRecord,
  findSecret,
  isAuditAction,
  isTelegramRef,
  type AuditInput,
} from "./audit-policy";
import { AuditWriteError, recordAudit, type AuditTx } from "./write";
import { auditEvents } from "../db/schema/audit";

/**
 * P3-R06 — the audit log's shape rules, proven offline.
 *
 * The append-only guarantee itself is a DATABASE fact and is proven by
 * executing `UPDATE` and `DELETE` against a real PostgreSQL —
 * `deploy/test-audit-append-only.sh`, per AC-03. Nothing here claims to have
 * proven it; asserting append-only from application code would be exactly the
 * comment-shaped assurance this requirement was raised to replace.
 */

const NOW = new Date("2026-08-21T12:00:00.000Z");

function input(over: Partial<AuditInput> = {}): AuditInput {
  return { action: "telegram.command", result: "OK", ...over };
}

// ─── Vocabulary is closed (AC-06) ─────────────────────────────────

test("AC-06: the action vocabulary is closed -- an ad-hoc string is refused", () => {
  const v = buildAuditRecord(input({ action: "did.a.thing" }), NOW);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "UNKNOWN_ACTION");

  for (const a of AUDIT_ACTIONS) {
    assert.equal(isAuditAction(a), true);
    assert.equal(buildAuditRecord(input({ action: a }), NOW).ok, true, `${a} was refused`);
  }
  assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length, "an action is listed twice");
});

test("AC-06: every P3 state change AC-06 names has an action", () => {
  // Named individually rather than by count, so dropping one fails here rather
  // than silently shrinking the vocabulary.
  for (const needed of [
    "telegram.gateway.deny",
    "telegram.command",
    "telegram.callback.resolve",
    "telegram.ratelimit.refuse",
    "approval.create",
    "approval.confirm",
    "approval.cancel",
    "approval.expire",
  ]) {
    assert.ok(
      (AUDIT_ACTIONS as readonly string[]).includes(needed),
      `AC-06 requires an entry for ${needed} and no action exists for it`,
    );
  }
});

test("AC-04: the result is a closed set -- 'it was attempted' is not an outcome", () => {
  assert.equal(buildAuditRecord(input({ result: "probably" }), NOW).ok, false);
  for (const r of AUDIT_RESULTS) {
    assert.equal(buildAuditRecord(input({ result: r }), NOW).ok, true, `${r} was refused`);
  }
});

// ─── AC-05: "where safe" is ids only ──────────────────────────────

test("AC-05: telegram_ref accepts ids and nothing else", () => {
  for (const ok of ["123", "123:456", "1", "99999999999999999999"]) {
    assert.equal(isTelegramRef(ok), true, `${ok} was refused`);
  }
  for (const bad of [
    "@owner",
    "hello there",
    "123:abc",
    "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1", // a bot token has this shape
    "a@b.com",
    "",
    "123:456:789",
    " 123",
    null,
    42,
  ]) {
    assert.equal(isTelegramRef(bad), false, `${String(bad)} was accepted as an id reference`);
  }
});

test("AC-05: a refused telegram_ref does not echo the value it refused", () => {
  const token = "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
  const v = buildAuditRecord(input({ telegramRef: token }), NOW);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "TELEGRAM_REF_NOT_IDS");
  // The error message travels into logs. Echoing the suspect value there would
  // leak the very thing the refusal exists to keep out.
  assert.equal(v.ok === false && v.detail.includes(token), false, "the refusal echoed the token");
});

// ─── No secret ever reaches the log ───────────────────────────────

test("a secret in the payload refuses the write -- redaction is not enough here", () => {
  // An audit row cannot be edited or deleted afterwards, so a secret written
  // here is written for good. Scrubbing would leave the caller still passing it.
  const cases: Array<[string, unknown]> = [
    ["bare bot token", { note: "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1" }],
    ["token in a URL", { url: "https://api.telegram.org/bot8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1/x" }],
    ["google client secret", { s: "GOCSPX-abcdefghijklmnopqrstuvwxyz" }],
    ["api key", { k: "sk-abcdefghijklmnopqrstuvwxyz012345" }],
    ["dsn with password", { db: "postgres://user:hunter2@host/db" }],
    ["private key", { pem: "-----BEGIN RSA PRIVATE KEY-----" }],
    ["secret-named key", { apiKey: "whatever" }],
    ["nested", { a: { b: { c: { token: "x" } } } }],
    ["in an array", { list: ["fine", "GOCSPX-abcdefghijklmnopqrstuvwxyz"] }],
  ];

  for (const [name, payload] of cases) {
    const v = buildAuditRecord(input({ before: {}, after: payload }), NOW);
    assert.equal(v.ok, false, `${name} was accepted into the audit log`);
    assert.equal(v.ok === false && v.reason, "SECRET_IN_PAYLOAD", name);
  }
});

test("the secret scan names a path, never a value", () => {
  const v = buildAuditRecord(
    input({ before: {}, after: { nested: { token: "supersecretvalue" } } }),
    NOW,
  );
  assert.equal(v.ok, false);
  const detail = v.ok === false ? v.detail : "";
  assert.match(detail, /\$\.after\.nested\.token/);
  assert.equal(detail.includes("supersecretvalue"), false, "the detail leaked the value");
});

test("the secret scan terminates on a cycle and on deep nesting", () => {
  // A validator that can be hung by its input is a denial of service on the
  // write path, and this one sits in front of every audited action.
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(findSecret(cyclic), null);

  let deep: Record<string, unknown> = { end: "x" };
  for (let i = 0; i < 40; i++) deep = { deep };
  assert.match(String(findSecret(deep)), /nesting too deep/);
});

test("ordinary payloads are not refused -- a scanner that refuses everything is useless", () => {
  const v = buildAuditRecord(
    input({ before: { status: "DRAFT" }, after: { status: "RESEARCHING", projectId: "p-1" } }),
    NOW,
  );
  assert.equal(v.ok, true, v.ok === false ? v.detail : "");
});

// ─── AC-07: both halves or neither ────────────────────────────────

test("AC-07: an entry saying only what a thing became is refused", () => {
  const afterOnly = buildAuditRecord(input({ after: { status: "X" } }), NOW);
  assert.equal(afterOnly.ok, false);
  assert.equal(afterOnly.ok === false && afterOnly.reason, "MISSING_BEFORE_AFTER");

  const beforeOnly = buildAuditRecord(input({ before: { status: "X" } }), NOW);
  assert.equal(beforeOnly.ok, false);

  const both = buildAuditRecord(input({ before: { s: 1 }, after: { s: 2 } }), NOW);
  assert.equal(both.ok, true);

  // Neither is fine: not every audited action is a state change.
  assert.equal(buildAuditRecord(input(), NOW).ok, true);
});

test("AC-07: before/after must be objects, not strings pretending to be state", () => {
  const v = buildAuditRecord(input({ before: "DRAFT", after: "LIVE" }), NOW);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "PAYLOAD_NOT_PLAIN");
});

// ─── AC-09: a failed audit write fails the operation ──────────────

test("AC-09: a refused record THROWS -- it is not logged-less-and-carried-on", async () => {
  const tx: AuditTx = {
    insert: () => ({ values: async () => { throw new Error("should not be reached"); } }),
  };
  await assert.rejects(
    () => recordAudit(tx, input({ action: "nope" }), NOW),
    (e: unknown) => e instanceof AuditWriteError && e.reason === "UNKNOWN_ACTION",
  );
});

test("AC-09: a database failure propagates -- the caller's transaction rolls back with it", async () => {
  const boom = new Error("connection lost");
  const tx: AuditTx = { insert: () => ({ values: async () => { throw boom; } }) };

  await assert.rejects(
    () => recordAudit(tx, input(), NOW),
    (e: unknown) => e === boom,
  );
});

test("AC-08: the write goes through the CALLER's transaction handle", async () => {
  // The function takes `tx` rather than opening its own connection. That is
  // what makes it impossible to commit the change and lose the entry.
  const captured: { table: unknown; row: Record<string, unknown> | undefined } = {
    table: null,
    row: undefined,
  };
  const tx: AuditTx = {
    insert: (t) => {
      captured.table = t;
      return { values: async (r) => { captured.row = r; } };
    },
  };

  await recordAudit(
    tx,
    input({ actorId: 987654321, telegramRef: "42:7", before: { s: "a" }, after: { s: "b" } }),
    NOW,
  );

  assert.equal(captured.table, auditEvents, "the write did not target audit_events");
  const row = captured.row;
  assert.ok(row, "nothing was written -- a no-op writer would pass a bare 'no error' test");
  assert.equal(row.action, "telegram.command");
  assert.equal(row.result, "OK");
  assert.equal(row.actorId, "987654321");
  assert.equal(row.telegramRef, "42:7");
  assert.deepEqual(row.beforeJson, { s: "a" });
  assert.deepEqual(row.afterJson, { s: "b" });
  assert.equal(row.createdAt, NOW);
});

test("AC-01: the writer targets audit_events and no other table", async () => {
  // A second audit log is the failure mode AC-01 forbids. There is one insert
  // target and this asserts which.
  const targets: unknown[] = [];
  const tx: AuditTx = { insert: (t) => { targets.push(t); return { values: async () => {} }; } };
  await recordAudit(tx, input(), NOW);
  assert.deepEqual(targets, [auditEvents]);
});

// ─── AC-11: retention is stated ───────────────────────────────────

test("AC-11: retention is stated, and no expiry mechanism exists", () => {
  assert.equal(AUDIT_RETENTION.policy, "INDEFINITE");
  assert.equal(AUDIT_RETENTION.expiryMechanism, "NONE");
  assert.match(AUDIT_RETENTION.enforcedBy, /0028/);
});

// ─── AC-12: CONTROL ───────────────────────────────────────────────

test("AC-12 CONTROL: a suppressed write is detected", () => {
  // The failure this guards: a writer that quietly did nothing. A test
  // asserting only "no error" would pass against a no-op logger, so the suite
  // asserts the row is CONSTRUCTED, field by field, and the insert target with
  // it (above). Here: prove the builder can both accept and refuse, so neither
  // outcome is the only one it is capable of.
  const accepted = buildAuditRecord(input(), NOW);
  const refused = buildAuditRecord(input({ action: "nope" }), NOW);

  assert.equal(accepted.ok, true, "the builder never accepts -- every test below is vacuous");
  assert.equal(refused.ok, false, "the builder never refuses -- the rules are decorative");
});

test("AC-12 CONTROL: the record carries the fields a forensic read needs", () => {
  const v = buildAuditRecord(
    input({
      actorType: "user",
      actorId: 987654321,
      entityType: "approval",
      entityId: "a-1",
      requestId: "req-9",
      result: "REFUSED",
      before: { state: "PENDING" },
      after: { state: "CANCELLED" },
      telegramRef: "42:7",
    }),
    NOW,
  );

  assert.equal(v.ok, true);
  if (!v.ok) return;

  // Who, what, which object, before/after, when, outcome, reference -- spec §10.
  for (const field of [
    "actorType", "actorId", "action", "entityType", "entityId",
    "beforeJson", "afterJson", "requestId", "result", "telegramRef", "at",
  ] as const) {
    assert.notEqual(v.record[field], undefined, `${field} missing from the record`);
  }
  assert.equal(v.record.at, NOW, "the record does not carry the supplied clock");
});

// ─────────────────────────────────────────────────────────────────
// The two write guarantees are separable in the data  (owner decision 2026-08-22)
// ─────────────────────────────────────────────────────────────────

test("P3 audit actions and auth telemetry actions are DISJOINT", () => {
  // `lib/auth/audit.ts` writes to the same table on a BEST-EFFORT basis: a
  // failed write is swallowed so an audit outage cannot lock the owner out.
  // P3-R06 AC-09 makes the opposite choice for P3 state changes.
  //
  // Both guarantees therefore coexist in one table, which is correct -- AC-01
  // forbids a second log -- but only stays readable while the two vocabularies
  // do not overlap. Asserted rather than described: a future action named
  // "login.approve" would make a query for canonical P3 audit rows silently
  // return best-effort ones.
  // Read the list from source rather than importing it: `lib/auth/audit.ts` is
  // correctly `server-only` -- it holds a live `db` handle -- and restructuring
  // live auth code to make a test convenient is the wrong trade. Same technique
  // as `refresh-worker-boundary.test.ts`.
  //
  // Comments are stripped first. Guards in this project have been tripped three
  // times by prose in their own explanatory comments, and the doc block above
  // that constant names every P3 action.
  const src = readFileSync(join(process.cwd(), "src/lib/auth/audit.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  const block = src.match(/AUTH_TELEMETRY_ACTIONS\s*=\s*\[([\s\S]*?)\]/);
  const body = block?.[1];
  assert.ok(body, "AUTH_TELEMETRY_ACTIONS not found -- this test would assert nothing");

  const AUTH_TELEMETRY_ACTIONS = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    AUTH_TELEMETRY_ACTIONS.length >= 4,
    `only ${AUTH_TELEMETRY_ACTIONS.length} telemetry actions parsed -- extraction is broken`,
  );

  for (const telemetry of AUTH_TELEMETRY_ACTIONS) {
    assert.equal(
      isAuditAction(telemetry),
      false,
      `"${telemetry}" is in BOTH vocabularies -- a P3 audit query would return a best-effort row`,
    );
  }

  for (const canonical of AUDIT_ACTIONS) {
    assert.equal(
      (AUTH_TELEMETRY_ACTIONS as readonly string[]).includes(canonical),
      false,
      `"${canonical}" is claimed by auth telemetry as well`,
    );
  }

  // CONTROL: both sets are non-empty, or disjointness is trivially true.
  assert.ok(AUTH_TELEMETRY_ACTIONS.length > 0);
  assert.ok(AUDIT_ACTIONS.length > 0);
});
