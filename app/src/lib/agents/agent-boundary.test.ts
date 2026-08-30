/**
 * P4-R01 AC-07 — no agent writes to a Source of Truth another phase owns.
 *
 * This is a property of the CODE, not of a run, so it is asserted on the source
 * rather than by executing something. A runtime test could only show that one
 * particular path did not write to `article_approvals`; this shows there is no
 * path that could.
 *
 * ## What the owner asked to be preserved, and where each lives
 *
 *   - an agent never fabricates an owner approval  -> no `article_approvals` write
 *   - an agent never publishes to WordPress        -> no WordPress client import
 *   - no parallel approval record                  -> no `telegram_pending_actions` write
 *   - no alternate publish queue                   -> no `article_publish_intents` write
 *   - `audit_events` only via P3-R06's writer      -> no direct `auditEvents` insert
 *   - model output never becomes a command         -> the checks at the bottom
 *
 * The last one is the load-bearing property. The others follow from it: an
 * agent cannot reach a table it has no mechanism to name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FORBIDDEN_AGENT_WRITES } from "./agent-policy";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The framework's own modules — the ones that must hold the boundary. */
const MODULES = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ name: f, source: readFileSync(join(HERE, f), "utf8") }));

/**
 * The framework itself, versus the agent modules built on it.
 *
 * The split exists because they have different obligations: the framework must
 * touch no database at all, while an agent's persistence layer must touch a
 * specific and narrow set of tables.
 */
const FRAMEWORK = MODULES.filter((m) => m.name === "agent-policy.ts" || m.name === "runner.ts");
const PERSISTENCE = MODULES.filter(
  (m) => !FRAMEWORK.includes(m) && !m.name.endsWith("-policy.ts"),
);

/** Source with comments stripped: a boundary named in prose is not a violation. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("AC-07 — the framework holds the control-plane boundary", () => {
  it("CONTROL — the scan can see the framework's modules", () => {
    // A boundary test whose file list is empty passes every assertion below
    // and proves nothing. This is checked first for that reason.
    // This asserted an EXACT file list and broke when P4-R02 added an agent to
    // the directory -- the M-15 class for the third time. The claim that does
    // not expire is that the framework's own two modules are present and the
    // scan reached them; every OTHER module in here is then held to the same
    // boundaries below, which is the behaviour that should grow, not break.
    const names = MODULES.map((m) => m.name);
    for (const required of ["agent-policy.ts", "runner.ts"]) {
      assert.ok(names.includes(required), `${required} was not scanned`);
    }
    assert.ok(MODULES.length >= 2, `only ${MODULES.length} modules found`);
    assert.equal(FRAMEWORK.length, 2, "the framework must be exactly agent-policy and runner");
    assert.ok(PERSISTENCE.length >= 1, "no agent persistence module was scanned");
    assert.ok(MODULES.every((m) => m.source.length > 500));
  });

  it("no module imports the approval, publish-intent or WordPress schema", () => {
    const FORBIDDEN_IMPORTS = [
      "schema/approval",
      "schema/two-step",
      "schema/wordpress",
      "telegram/two-step-policy",
      "wordpress/client",
    ];
    for (const m of MODULES) {
      const src = code(m.source);
      for (const imp of FORBIDDEN_IMPORTS) {
        assert.equal(
          src.includes(imp),
          false,
          `${m.name} imports ${imp} — an agent must not reach that Source of Truth`,
        );
      }
    }
  });

  it("the FRAMEWORK modules write no table at all", () => {
    // Persistence goes through the injected `RunSink`, which the CALLER owns.
    // The framework holding a database handle is what would make every
    // assertion here a matter of discipline rather than of structure.
    //
    // This applied to EVERY module in the directory until P4-R02 added
    // `project-research.ts`, which is legitimately an agent's persistence
    // layer -- it must write claims and evidence. A blanket ban would have
    // forced that module somewhere it does not belong, or been deleted.
    //
    // So the ban is scoped to the framework, and agent persistence gets the
    // SPECIFIC rule below, which is the AC-07 property rather than a proxy
    // for it.
    for (const m of FRAMEWORK) {
      const src = code(m.source);
      for (const forbidden of ["drizzle-orm", "lib/db/client", "from \"../db", "postgres("]) {
        assert.equal(src.includes(forbidden), false, `${m.name} reaches for a database (${forbidden})`);
      }
      assert.equal(/\.insert\s*\(/.test(src), false, `${m.name} performs an insert`);
      assert.equal(/\.update\s*\(/.test(src), false, `${m.name} performs an update`);
      assert.equal(/\.delete\s*\(/.test(src), false, `${m.name} performs a delete`);
    }
  });

  it("an agent's persistence layer writes ONLY research and evidence tables", () => {
    // AC-07 stated precisely instead of by proxy. These modules DO hold a
    // database handle -- that is their job -- so the property that matters is
    // WHICH tables they can reach.
    const ALLOWED = ["claims", "evidence", "agentRuns", "affiliateProjects", "modelPolicies"];
    const FORBIDDEN_TABLES = [
      "articleApprovals", "articlePublishIntents", "telegramPendingActions",
      "auditEvents", "articlePreviewLinks",
    ];
    for (const m of PERSISTENCE) {
      const src = code(m.source);
      for (const table of FORBIDDEN_TABLES) {
        assert.equal(src.includes(table), false,
          `${m.name} names ${table} -- an agent must not reach that Source of Truth`);
      }
      // And a SELECT on affiliateProjects is fine; a write to it is not.
      assert.equal(/update\(affiliateProjects\)/.test(src), false,
        `${m.name} updates affiliate_projects -- AC-02 forbids advancing a project`);
      assert.equal(/insert\(affiliateProjects\)/.test(src), false,
        `${m.name} inserts an affiliate project`);
      // CONTROL: it really does write the tables it is supposed to, so this
      // test is not passing against a module that writes nothing.
      assert.ok(ALLOWED.some((tbl) => src.includes(tbl)), `${m.name} writes nothing at all`);
    }
  });

  it("every *-policy module is pure: it imports nothing at all", () => {
    // Applies to project-research-policy.ts too, and to whatever P4-R03..R06
    // add. A purity rule that named one file would stop protecting the moment
    // a second policy module appeared -- which has now happened once.
    const policies = MODULES.filter((m) => m.name.endsWith("-policy.ts"));
    assert.ok(policies.length >= 2, "expected at least two policy modules");
    for (const m of policies) {
      const imports = code(m.source).match(/^\s*import\s/gm) ?? [];
      assert.equal(
        imports.length, 0,
        `${m.name} must import nothing — that is what makes its decisions testable as data`,
      );
    }
    const policy = MODULES.find((m) => m.name === "agent-policy.ts")!;
    // And it must not reach for ambient state either: a module that reads the
    // clock cannot be tested by feeding it a time.
    assert.equal(code(policy.source).includes("Date.now"), false);
    assert.equal(code(policy.source).includes("process.env"), false);
    assert.equal(code(policy.source).includes("new Date("), false);
  });

  it("model output is never dispatched, evaluated, or used to pick a code path", () => {
    // The load-bearing property. An agent has no mechanism by which to name a
    // destination, which is why the table boundaries above hold.
    const runner = MODULES.find((m) => m.name === "runner.ts")!;
    const src = code(runner.source);
    for (const construct of ["eval(", "new Function", "require(", "import("]) {
      assert.equal(src.includes(construct), false, `runner.ts uses ${construct}`);
    }
    // The tool name comes from the caller's parameter, never from a response.
    assert.equal(/response\.\w*[Tt]ool/.test(src), false);
    assert.equal(/output\.\w*[Tt]ool/.test(src), false);
    assert.equal(/output\[/.test(src), false, "runner.ts indexes into model output");
  });

  it("the forbidden-write list is not empty and names the P3 tables", () => {
    // If this list were emptied, every rule above would still pass while the
    // requirement's stated boundary had silently disappeared.
    assert.ok(FORBIDDEN_AGENT_WRITES.length >= 6);
    const joined = FORBIDDEN_AGENT_WRITES.join("|");
    for (const table of [
      "article_approvals",
      "article_publish_intents",
      "audit_events",
      "telegram_pending_actions",
    ]) {
      assert.ok(joined.includes(table), `${table} is not named as forbidden`);
    }
  });

  it("the migration does not claim to enforce AC-07 in the database", () => {
    // Recorded because the temptation is real and the claim would be false: the
    // database cannot see which application module opened the connection, so a
    // trigger refusing writes "from an agent" would depend on a flag the agent
    // itself set.
    const sql = readFileSync(
      join(HERE, "..", "db", "migrations", "0034_p4r01_agent_framework.sql"),
      "utf8",
    );
    assert.ok(sql.includes("AC-07 is NOT enforced here"));
    assert.equal(/CREATE\s+TRIGGER/i.test(sql), false);
  });
});
