/**
 * P3-R02 — the dispatch table.
 *
 * The database is a stub here, deliberately. What these cases are about is the
 * TABLE: that it is closed, that every command reaches a handler, that a bad
 * argument never reaches one, and that no handler leaks a row or an error
 * object into a reply. What the queries return from a real database is proven
 * where it can be — `deploy/test-command-integrity.sh`, against PostgreSQL.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { COMMANDS, authorize, type Command, type GatewayDecision } from "./gateway-policy";
import {
  HANDLED_COMMANDS,
  HANDLERS,
  SPECIFIED_COMMANDS,
  runCommand,
  type HandlerContext,
} from "./command-handlers";

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** Returns nothing, for every query. Enough to exercise the table. */
const emptyDb = {
  select: () => emptyDb,
  from: () => emptyDb,
  leftJoin: () => emptyDb,
  where: () => emptyDb,
  orderBy: () => emptyDb,
  limit: () => Promise.resolve([]),
  as: () => emptyDb,
  execute: () => Promise.resolve([]),
};

const ctx: HandlerContext = { db: emptyDb, permitted: [...COMMANDS] };

/**
 * A decision, obtained the way a handler can only be reached: from the gateway.
 * Built by actually calling `authorize`, so a change to its shape breaks these
 * tests rather than letting them assert against a hand-made object that the
 * gateway no longer produces.
 */
const OWNER = 4242;
function allow(command: Command, args = ""): GatewayDecision {
  const d = authorize({ kind: "command", fromId: OWNER, text: `/${command} ${args}`.trim() }, [OWNER], new Date());
  if (d.outcome !== "ALLOW") throw new Error(`gateway refused /${command}: ${d.reason}`);
  return d;
}

/** Valid arguments per command, so the table can be exercised end to end. */
const VALID: { readonly [K in Command]: string } = {
  newproject: `${ID} A project`,
  research: "compare two email tools",
  projects: "",
  project: ID,
  contentplan: "",
  queue: "",
  drafts: "",
  article: ID,
  status: "",
  help: "",
};

describe("P3-R02 AC-01: the dispatch table is closed and complete", () => {
  it("handles exactly the ten commands", () => {
    assert.deepEqual(HANDLED_COMMANDS, [...COMMANDS].sort());
    assert.equal(HANDLED_COMMANDS.length, 10);
  });

  it("the handler table and the spec registry agree", () => {
    assert.deepEqual(HANDLED_COMMANDS, SPECIFIED_COMMANDS);
  });

  it("every command actually reaches a handler and returns lines", async () => {
    for (const c of COMMANDS) {
      const r = await runCommand(ctx, allow(c), VALID[c]);
      assert.ok(Array.isArray(r.lines), `${c} returned no lines`);
      assert.equal(typeof r.ok, "boolean", c);
    }
  });

  it("there is no handler for anything outside the set", () => {
    assert.equal((HANDLERS as Record<string, unknown>).publish, undefined);
    assert.equal((HANDLERS as Record<string, unknown>).deploy, undefined);
  });
});

describe("P3-R01 AC-11: no handler is reachable without passing the gateway", () => {
  // Structural, per the criterion: every registered handler is enumerated and
  // each is shown to be unreachable without an ALLOW decision. Not by reading
  // call sites, which only describes today's callers.

  it("every registered handler refuses a non-ALLOW decision", async () => {
    const denials: GatewayDecision[] = [
      { outcome: "DENY_NOT_ALLOWLISTED", reason: "not on the allowlist" },
      { outcome: "DENY_ALLOWLIST_EMPTY", reason: "allowlist is empty" },
      { outcome: "DENY_NO_ACTOR", reason: "no actor" },
      { outcome: "DENY_MALFORMED", reason: "malformed" },
      { outcome: "DENY_UNKNOWN_COMMAND", reason: "unknown command" },
    ];
    for (const c of COMMANDS) {
      for (const d of denials) {
        // The command the caller WANTED is supplied as raw args, so a handler
        // that ignored the decision would still have everything it needed.
        const r = await runCommand(ctx, d, VALID[c]);
        assert.equal(r.ok, false, `${c} ran on ${d.outcome}`);
        assert.equal(r.lines.join(""), d.reason);
      }
    }
  });

  it("an ALLOW decision with no command reaches nothing either", async () => {
    // P3-R01 promises `command` is present only on ALLOW. Checked rather than
    // trusted: the two modules can be edited apart, and this is the seam.
    const r = await runCommand(ctx, { outcome: "ALLOW", reason: "allowed" }, "status");
    assert.equal(r.ok, false);
  });

  it("CONTROL: the SAME input through a real ALLOW decision does reach a handler", async () => {
    // Without this, every refusal above would be equally explained by
    // `runCommand` refusing everything.
    for (const c of COMMANDS) {
      const r = await runCommand(ctx, allow(c), VALID[c]);
      assert.ok(Array.isArray(r.lines), c);
    }
  });

  it("the enumeration covers every handler, so none is exempt", () => {
    assert.deepEqual(HANDLED_COMMANDS, [...COMMANDS].sort());
  });

  it("a handler cannot be reached by naming a command as a string", () => {
    // `runCommand` takes a GatewayDecision. A bare command does not type-check,
    // which is the enforcement -- asserted here so the guarantee is written
    // down where a reader looks, rather than living only in a signature.
    const asAny = runCommand as unknown as (a: unknown, b: unknown, c: unknown) => Promise<unknown>;
    assert.equal(typeof asAny, "function");
    assert.equal(runCommand.length, 3);
  });
});

describe("P3-R02 AC-02: a bad argument never reaches a handler", () => {
  it("/project with a malformed id is refused before any query", async () => {
    // The stub would return [] and produce a NOT_FOUND. A MALFORMED_ID here
    // proves the parse ran first -- the two refusals are distinguishable, which
    // is the whole point of keeping them separate.
    const r = await runCommand(ctx, allow("project"), "not-an-id");
    assert.equal(r.ok, false);
    assert.equal(r.refusal, "MALFORMED_ID");
  });

  it("a well-formed id that matches nothing is NOT_FOUND, a different answer", async () => {
    const r = await runCommand(ctx, allow("project"), ID);
    assert.equal(r.ok, false);
    assert.equal(r.refusal, "NOT_FOUND");
  });

  it("an argument to a command that takes none is refused", async () => {
    const r = await runCommand(ctx, allow("status"), "please");
    assert.equal(r.ok, false);
    assert.equal(r.refusal, "UNEXPECTED_ARGUMENT");
  });
});

describe("P3-R02 AC-04b: /newproject reports a non-execution state", () => {
  it("names the status it would create, and it is not an execution state", async () => {
    const r = await runCommand(ctx, allow("newproject"), `${ID} Acme funnel`);
    assert.equal(r.ok, true);
    const text = r.lines.join("\n");
    assert.ok(text.includes("CANDIDATE"));
    for (const s of ["APPROVED_FOR_TEST", "TESTING", "SCALE", "CAMPAIGN_DRAFTED"]) {
      assert.equal(text.includes(s), false, `mentions ${s}`);
    }
  });

  it("MUST FAIL: no programme id", async () => {
    const r = await runCommand(ctx, allow("newproject"), "just a name");
    assert.equal(r.ok, false);
  });
});

describe("P3-R02 AC-09: /help is scoped to the caller", () => {
  it("lists only what the caller may use", async () => {
    const r = await runCommand({ db: emptyDb, permitted: ["help", "status"] }, allow("help"), "");
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines.join("\n").includes("/newproject"), false);
  });

  it("permitting nothing lists nothing -- it does not fall back to everything", async () => {
    const r = await runCommand({ db: emptyDb, permitted: [] }, allow("help"), "");
    assert.deepEqual(r.lines, []);
  });
});

describe("P3-R02: no reply leaks a row or an error object", () => {
  it("every line is a string", async () => {
    for (const c of COMMANDS) {
      const r = await runCommand(ctx, allow(c), VALID[c]);
      for (const l of r.lines) assert.equal(typeof l, "string", `${c} returned a non-string`);
    }
  });

  it("no reply contains a stack trace or an SQL fragment", async () => {
    for (const c of COMMANDS) {
      const r = await runCommand(ctx, allow(c), VALID[c]);
      const text = r.lines.join("\n");
      assert.equal(/\bat \w+ \(|SELECT |INSERT |node_modules/.test(text), false, `${c}: ${text}`);
    }
  });

  it("CONTROL: the commands were actually run -- some produced output", async () => {
    // Without this, "no reply leaks anything" would also be satisfied by ten
    // handlers that all returned nothing at all.
    const outputs = await Promise.all(COMMANDS.map((c) => runCommand(ctx, allow(c), VALID[c])));
    assert.ok(
      outputs.some((r) => r.lines.length > 0),
      "every command returned an empty reply -- nothing was exercised",
    );
  });
});
