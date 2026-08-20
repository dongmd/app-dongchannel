import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { contentOpportunities } from "../db/schema/opportunity-content";
import {
  opportunityRoutes,
  opportunitySignals,
  signalStatusEnum,
} from "../db/schema/opportunity";
import {
  FORBIDDEN_SIGNAL_FIELDS,
  ROUTE_TYPES,
  SIGNAL_STATUSES,
} from "./signal-policy";

// P2-R02 AC-01, AC-04, AC-06, AC-07, AC-10 — the half that lives in the schema.
//
// The greenfield cleanup this verifies was an owner decision (Q30): judgement
// fields on the observation layer were REMOVED, not left read-only, because the
// tables held zero rows, no migration had reached production, and nothing
// referenced them. These assertions are what stop them coming back.

function columns(table: object): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null && "columnType" in v) {
      out[k] = v as Record<string, unknown>;
    }
  }
  return out;
}

// ─── AC-10 — the judgement is gone, and stays gone ────────────────

test("AC-10: opportunity_signals carries no score, no verdict, no rank", () => {
  const names = Object.keys(columns(opportunitySignals));
  assert.ok(names.length > 10, "parsed too few columns -- the check would be vacuous");

  const lower = names.map((n) => n.toLowerCase());
  for (const forbidden of FORBIDDEN_SIGNAL_FIELDS) {
    assert.equal(
      lower.includes(forbidden.toLowerCase().replace(/_/g, "")) ||
        lower.includes(forbidden.toLowerCase()),
      false,
      `opportunity_signals still has '${forbidden}' -- judgement belongs to ContentOpportunity`,
    );
  }
});

test("AC-10: `confidence` survived on purpose, and the distinction is real", () => {
  // confidence answers "how reliable is this observation" -- an evidence
  // property inherited from the source's trust tier. It does not answer "is
  // this worth writing about", which is the judgement AC-10 forbids here.
  const cols = columns(opportunitySignals);
  assert.ok(cols.confidence, "confidence must remain");
  assert.equal(cols.confidence?.notNull, true);
  // And the thing it must not have become:
  assert.equal(Object.keys(cols).includes("overallScore"), false);
});

test("AC-10: the intake status enum in Postgres matches the policy exactly", () => {
  assert.deepEqual([...signalStatusEnum.enumValues], [...SIGNAL_STATUSES]);
  assert.equal(signalStatusEnum.enumValues.length, 4);
});

// ─── AC-06 / AC-07 — provenance and dedup are enforced by the schema ──

test("AC-06: the capture time is NOT NULL", () => {
  const cols = columns(opportunitySignals);
  assert.equal(cols.discoveredAt?.notNull, true, "capture time must be mandatory");
});

test("AC-07: the dedup key is NOT NULL, so the unique index actually binds", () => {
  const cols = columns(opportunitySignals);
  assert.equal(
    cols.canonicalKey?.notNull,
    true,
    "Postgres treats NULLs as distinct: a nullable unique key permits unlimited duplicates",
  );
});

test("AC-07: a duplicate can name what it duplicates", () => {
  assert.ok(columns(opportunitySignals).duplicateOfSignalId, "duplicate_of_signal_id must exist");
});

// ─── AC-01 — the layers are separate tables ───────────────────────

test("AC-01: signal and opportunity are different tables with different columns", () => {
  const sig = Object.keys(columns(opportunitySignals));
  const opp = Object.keys(columns(contentOpportunities));

  // The opportunity owns what a decision owns.
  assert.ok(opp.includes("contentMode"), "content_mode belongs to the opportunity");
  assert.ok(opp.includes("status"), "the editorial lifecycle belongs to the opportunity");
  // The signal owns what an observation owns.
  assert.ok(sig.includes("canonicalKey"));
  assert.ok(sig.includes("confidence"));
  // And the signal does not carry the opportunity's mode.
  assert.equal(sig.includes("contentMode"), false, "a signal has no content mode");
});

test("the route column names the thing it actually references", () => {
  const cols = columns(opportunityRoutes);
  assert.ok(cols.signalId, "routes hang off signals");
  assert.equal(
    Object.keys(cols).includes("opportunityId"),
    false,
    "the old name said opportunity while the FK pointed at a signal",
  );
  assert.ok(cols.contentOpportunityId, "an accepted content route can name what it produced");
});

// ─── AC-04 — the layer reaches nothing that writes ────────────────

test("AC-04: the signal policy imports nothing at all", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/signal-policy.ts"), "utf8");
  const imports = [...src.matchAll(/^\s*import\s/gm)];
  assert.equal(imports.length, 0, "the policy module must stay dependency-free");
});

test("AC-04: the schema module cannot reach a publisher or a project", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/db/schema/opportunity.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  assert.ok(specs.length > 0, "parsed no imports -- the guard would be vacuous");

  const bad = specs.filter((s) => /wordpress|publish|\/aff\b/i.test(s));
  assert.deepEqual(bad, [], `the signal layer must not import: ${bad.join(", ")}`);
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: the column reader really reads these tables", () => {
  assert.ok(columns(opportunitySignals).id, "signals: id missing");
  assert.ok(columns(opportunityRoutes).routeType, "routes: route_type missing");
  assert.ok(columns(contentOpportunities).title, "opportunities: title missing");
  assert.equal(ROUTE_TYPES.length, 5);
});

test("CONTROL: the forbidden list would catch a real column name", () => {
  assert.ok(FORBIDDEN_SIGNAL_FIELDS.includes("overall_score"));
  const pretend = ["id", "title", "overall_score"];
  assert.deepEqual(
    pretend.filter((n) => FORBIDDEN_SIGNAL_FIELDS.includes(n)),
    ["overall_score"],
  );
});
