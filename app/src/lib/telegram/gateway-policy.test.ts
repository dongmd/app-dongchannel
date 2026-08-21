import assert from "node:assert/strict";
import { test } from "node:test";

import { redact, scrub } from "../log-redact";
import {
  COMMANDS,
  GATEWAY_OUTCOMES,
  auditRecordFor,
  authorize,
  isCommand,
  isTelegramUserId,
  parseAllowlist,
  parseCommand,
  type GatewayUpdate,
  type TelegramUserId,
} from "./gateway-policy";

/**
 * P3-R01 — the bot gateway.
 *
 * Every test here runs offline against fixtures. There is no bot token, no
 * network and no database, which is the point: Q22 is an activation credential
 * dependency, not a coding blocker.
 */

const NOW = new Date("2026-08-21T12:00:00.000Z");
const OWNER: TelegramUserId = 987654321;
const OTHER: TelegramUserId = 111222333;
const ALLOWLIST: readonly TelegramUserId[] = [OWNER];

function cmd(text: string, fromId: unknown = OWNER): GatewayUpdate {
  return { kind: "command", text, fromId };
}
function cb(callbackData: unknown, fromId: unknown = OWNER): GatewayUpdate {
  return { kind: "callback", callbackData, fromId };
}

// ─────────────────────────────────────────────────────────────────
// AC-03 — fail closed
// ─────────────────────────────────────────────────────────────────

test("AC-03: an empty allowlist denies everything -- it never means 'no restriction'", () => {
  for (const list of [[], undefined as never, null as never, "" as never]) {
    const d = authorize(cmd("/status"), list as never, NOW);
    assert.equal(d.outcome, "DENY_ALLOWLIST_EMPTY", "an unset allowlist authorised somebody");
  }
});

test("AC-03: a malformed allowlist yields NOTHING, not a shorter working list", () => {
  // A typo in one id must not quietly narrow or widen access. Refusing
  // wholesale is loud; salvaging the parseable half is silent.
  for (const raw of ["123,notanid", "123, ,456", "12e3", " ", "abc", "-5", "0"]) {
    assert.deepEqual(parseAllowlist(raw), [], `"${raw}" produced a usable allowlist`);
  }
});

test("AC-03: a well-formed allowlist parses exactly", () => {
  assert.deepEqual(parseAllowlist("987654321"), [987654321]);
  assert.deepEqual(parseAllowlist(" 1 , 2 ,3 "), [1, 2, 3]);
  assert.deepEqual(parseAllowlist(123 as never), []);
});

// ─────────────────────────────────────────────────────────────────
// AC-01 — every interaction, not once per conversation
// ─────────────────────────────────────────────────────────────────

test("AC-01: allowed and denied updates interleaved in one chat are decided independently", () => {
  // G-31 verbatim: check on each interaction, not once per conversation. A
  // gateway that cached the first ALLOW would pass the first and third of these.
  const sequence = [
    { u: cmd("/status", OWNER), expect: "ALLOW" },
    { u: cmd("/drafts", OTHER), expect: "DENY_NOT_ALLOWLISTED" },
    { u: cmd("/queue", OWNER), expect: "ALLOW" },
    { u: cb("act_1", OTHER), expect: "DENY_NOT_ALLOWLISTED" },
  ];

  for (const { u, expect } of sequence) {
    assert.equal(authorize(u, ALLOWLIST, NOW).outcome, expect);
  }
});

test("AC-01: callbacks are authorised too, not just commands", () => {
  assert.equal(authorize(cb("act_x", OTHER), ALLOWLIST, NOW).outcome, "DENY_NOT_ALLOWLISTED");
  assert.equal(authorize(cb("act_x", OWNER), ALLOWLIST, NOW).outcome, "ALLOW");
});

// ─────────────────────────────────────────────────────────────────
// AC-02 — numeric ids, never usernames
// ─────────────────────────────────────────────────────────────────

test("AC-02: identity is a numeric id -- a username is not an identity", () => {
  for (const notAnId of ["@owner", "owner", "987654321", true, null, undefined, {}, 1.5, -1, 0]) {
    assert.equal(isTelegramUserId(notAnId), false, `${String(notAnId)} was accepted as an id`);
  }
  assert.equal(isTelegramUserId(OWNER), true);
});

test("AC-02: an update whose sender id is a string is refused, not coerced", () => {
  // "987654321" === 987654321 only after a coercion nobody asked for. A
  // username-shaped or string-shaped sender must not become the owner.
  const d = authorize(cmd("/status", String(OWNER)), ALLOWLIST, NOW);
  assert.equal(d.outcome, "DENY_NO_ACTOR");
});

test("AC-02: the actor comes from the update, never from the payload", () => {
  const d = authorize(cb("act_1", OWNER), ALLOWLIST, NOW);
  assert.equal(d.actorId, OWNER);
});

// ─────────────────────────────────────────────────────────────────
// AC-04 — a refusal leaks nothing
// ─────────────────────────────────────────────────────────────────

test("AC-04: every refusal reason is generic and mentions no subject", () => {
  const refusals = [
    authorize(cmd("/project 41", OTHER), ALLOWLIST, NOW),
    authorize(cmd("/nosuchcommand", OWNER), ALLOWLIST, NOW),
    authorize(cmd("just some chatter", OWNER), ALLOWLIST, NOW),
    authorize(cb("", OWNER), ALLOWLIST, NOW),
    // `null`, not `undefined`: a JS default parameter fires on `undefined`, so
    // `cmd("/status", undefined)` quietly became the owner and this "refusal"
    // was an ALLOW. The test caught it; the fixture was the bug.
    authorize(cmd("/status", null), ALLOWLIST, NOW),
    authorize(cmd("/status", OWNER), [], NOW),
  ];

  for (const d of refusals) {
    assert.notEqual(d.outcome, "ALLOW");
    assert.equal(d.command, undefined, "a refusal carried a resolved command");
    assert.equal(d.args, undefined, "a refusal carried the caller's arguments");
    // Nothing about what exists, and no echo of what was sent.
    assert.equal(/41|nosuchcommand|chatter/.test(d.reason), false, d.reason);
  }
});

test("AC-04: a denied caller cannot tell an existing object from a missing one", () => {
  // The same refusal for both, byte for byte. A difference here is an oracle.
  const a = authorize(cmd("/project 41", OTHER), ALLOWLIST, NOW);
  const b = authorize(cmd("/project 999999", OTHER), ALLOWLIST, NOW);
  assert.deepEqual(a, b);
});

// ─────────────────────────────────────────────────────────────────
// Unknown input does nothing  (owner constraint)
// ─────────────────────────────────────────────────────────────────

test("an unknown command is refused and resolves to no action at all", () => {
  const d = authorize(cmd("/deleteeverything", OWNER), ALLOWLIST, NOW);
  assert.equal(d.outcome, "DENY_UNKNOWN_COMMAND");
  assert.equal(d.command, undefined, "an unknown command resolved to a command");
});

test("the gateway cannot turn raw input into an action outside the closed set", () => {
  // Whatever the text, an ALLOW carries a member of COMMANDS or nothing.
  const hostile = [
    "/newproject; drop table tasks",
    "/../../etc/passwd",
    "/status\n/newproject",
    "/PROJECT 1",
    "/project@dc_bot 1",
    "//",
    "/",
    "/ status",
  ];

  for (const text of hostile) {
    const d = authorize(cmd(text, OWNER), ALLOWLIST, NOW);
    if (d.outcome === "ALLOW") {
      assert.ok(isCommand(d.command), `"${text}" allowed a non-command: ${String(d.command)}`);
    } else {
      assert.equal(d.command, undefined);
    }
  }
});

test("command parsing is exact -- case-insensitive name, @botname stripped, args kept whole", () => {
  assert.deepEqual(parseCommand("/PROJECT 41"), { name: "project", args: "41" });
  assert.deepEqual(parseCommand("/project@dc_bot 41"), { name: "project", args: "41" });
  assert.deepEqual(parseCommand("/status"), { name: "status", args: "" });
  assert.deepEqual(parseCommand("/newproject https://a.example/b c"), {
    name: "newproject",
    args: "https://a.example/b c",
  });

  for (const notCommand of ["", " ", "hello", "/", "//", 42, null, undefined, {}]) {
    assert.equal(parseCommand(notCommand as never), null, `${String(notCommand)} parsed`);
  }
});

// ─────────────────────────────────────────────────────────────────
// AC-11 — registry and handlers reconcile BOTH ways
// ─────────────────────────────────────────────────────────────────

test("AC-11: the command set is exactly the owner's spec §2 -- closed both ways", () => {
  const spec = [
    "newproject", "research", "projects", "project", "contentplan",
    "queue", "drafts", "article", "status", "help",
  ];

  // Not a subset check in either direction: an addition and an omission must
  // both fail, which a `.every(includes)` in one direction would not catch.
  assert.deepEqual([...COMMANDS].sort(), [...spec].sort());
  assert.equal(COMMANDS.length, 10);
  assert.equal(new Set(COMMANDS).size, COMMANDS.length, "a command is listed twice");
});

test("AC-11: every command the registry declares is resolvable, and nothing else is", () => {
  for (const c of COMMANDS) {
    const d = authorize(cmd(`/${c}`, OWNER), ALLOWLIST, NOW);
    assert.equal(d.outcome, "ALLOW", `/${c} is declared but not resolvable`);
    assert.equal(d.command, c);
  }
  assert.equal(isCommand("newprojects"), false);
  assert.equal(isCommand(""), false);
});

// ─────────────────────────────────────────────────────────────────
// AC-06 / AC-08 — nothing secret reaches a log or an audit record
// ─────────────────────────────────────────────────────────────────

test("AC-06: a bare Telegram bot token is redacted from log output", () => {
  // The shape that leaks: it is embedded in the API URL, so a failed request
  // quoting its own URL prints the credential in full.
  const token = "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
  const line = `GET https://api.telegram.org/bot${token}/getUpdates failed`;

  const scrubbed = scrub(line);
  assert.equal(scrubbed.includes(token), false, "the bot token survived redaction");
  assert.match(scrubbed, /REDACTED/);
  assert.match(scrubbed, /api\.telegram\.org/, "redaction destroyed the debuggable part too");
});

test("AC-06: a token in a structured field is redacted whatever the key looks like", () => {
  const token = "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
  const out = JSON.stringify(redact({ botToken: token, note: `using ${token}` }));
  assert.equal(out.includes(token), false, "the bot token survived structured redaction");
});

test("AC-08: the audit record carries ids and outcomes -- never text or payload", () => {
  const allowed = auditRecordFor(authorize(cmd("/project 41", OWNER), ALLOWLIST, NOW), NOW);
  assert.deepEqual(allowed, {
    action: "telegram.gateway",
    outcome: "ALLOW",
    actorId: OWNER,
    command: "project",
    at: NOW.toISOString(),
  });
  // The argument the owner typed is not in the record.
  assert.equal(JSON.stringify(allowed).includes("41"), false);

  const denied = auditRecordFor(authorize(cmd("/project 41", OTHER), ALLOWLIST, NOW), NOW);
  assert.equal(denied.outcome, "DENY_NOT_ALLOWLISTED");
  assert.equal(denied.actorId, null, "a denied caller's id was recorded as if verified");
  assert.equal(denied.command, null);
});

test("AC-08: a denial is recorded, not swallowed", () => {
  // A refusal that leaves no trace is indistinguishable from an attack that
  // never happened.
  const r = auditRecordFor(authorize(cmd("/status", OTHER), ALLOWLIST, NOW), NOW);
  assert.equal(r.action, "telegram.gateway");
  assert.ok(r.at);
});

// ─────────────────────────────────────────────────────────────────
// AC-05 — the decision is pure
// ─────────────────────────────────────────────────────────────────

test("AC-05: the decision is a pure function of its inputs", () => {
  const a = authorize(cmd("/queue", OWNER), ALLOWLIST, NOW);
  const b = authorize(cmd("/queue", OWNER), ALLOWLIST, NOW);
  assert.deepEqual(a, b);

  // Different clock, same answer today -- `now` is in the signature for the
  // time-bounded rules P3-R03 adds, not because anything here reads it.
  const later = authorize(cmd("/queue", OWNER), ALLOWLIST, new Date("2027-01-01T00:00:00Z"));
  assert.deepEqual(later, a);
});

test("AC-05: authorize does not mutate its inputs", () => {
  const list: TelegramUserId[] = [OWNER];
  const update = cmd("/status", OWNER);
  const snapshot = JSON.stringify({ list, update });
  authorize(update, list, NOW);
  assert.equal(JSON.stringify({ list, update }), snapshot);
});

// ─────────────────────────────────────────────────────────────────
// AC-10 — CONTROL
// ─────────────────────────────────────────────────────────────────

test("AC-10 CONTROL: the suite proves the allowlist can DENY", () => {
  // A suite whose every fixture is allowed would pass with the check deleted.
  const outcomes = new Set([
    authorize(cmd("/status", OWNER), ALLOWLIST, NOW).outcome,
    authorize(cmd("/status", OTHER), ALLOWLIST, NOW).outcome,
    authorize(cmd("/status", OWNER), [], NOW).outcome,
    authorize(cmd("/nope", OWNER), ALLOWLIST, NOW).outcome,
    authorize(cmd("x", OWNER), ALLOWLIST, NOW).outcome,
    authorize(cmd("/status", "nope"), ALLOWLIST, NOW).outcome,
  ]);

  assert.ok(outcomes.has("ALLOW"), "nothing is ever allowed -- the gateway is inert");
  assert.ok(outcomes.size >= 5, `only ${outcomes.size} distinct outcomes exercised`);
  for (const o of outcomes) {
    assert.ok((GATEWAY_OUTCOMES as readonly string[]).includes(o), `${o} is outside the vocabulary`);
  }
});
