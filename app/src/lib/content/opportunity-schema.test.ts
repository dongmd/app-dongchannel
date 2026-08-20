import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  contentOpportunities,
  contentOpportunitySignals,
  contentOpportunityStatusEnum,
  opportunityOriginTypeEnum,
} from "../db/schema/opportunity-content";
import {
  FORBIDDEN_OPPORTUNITY_FIELDS,
  OPPORTUNITY_ORIGIN_TYPES,
  OPPORTUNITY_STATUSES,
} from "./opportunity-policy";

// P2-R01 AC-01, AC-05, AC-07, AC-08, AC-12 — the half that lives in the schema.
//
// Drizzle's builders are pure declarations, so this runs with no DATABASE_URL
// and no database.

const SCHEMA = join(process.cwd(), "src/lib/db/schema/opportunity-content.ts");
const POLICY = join(process.cwd(), "src/lib/content/opportunity-policy.ts");

// Takes `object` rather than `Record<string, unknown>`: a Drizzle table has no
// string index signature, so the narrower type rejects the very thing this is
// for. The cast is inside, once, instead of at every call site.
function columns(table: object): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null && "columnType" in v) {
      out[k] = v as Record<string, unknown>;
    }
  }
  return out;
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ─── AC-01 — the enum is closed at the database boundary ──────────

test("AC-01: the Postgres origin enum matches the policy list exactly", () => {
  assert.deepEqual([...opportunityOriginTypeEnum.enumValues], [...OPPORTUNITY_ORIGIN_TYPES]);
  assert.equal(opportunityOriginTypeEnum.enumValues.length, 8);
});

test("AC-01: the status enum matches the policy list exactly", () => {
  assert.deepEqual([...contentOpportunityStatusEnum.enumValues], [...OPPORTUNITY_STATUSES]);
});

test("AC-03: origin_type is NOT NULL, which makes the illegal pair unrepresentable", () => {
  const cols = columns(contentOpportunities);
  assert.equal(cols.originType?.notNull, true, "origin_type must be NOT NULL");
  assert.equal(cols.originType?.hasDefault, false, "origin_type must not have a default");
  // The other half of the asymmetry: an id with no type cannot be stored,
  // because the type column refuses null. AC-02: the id itself is nullable.
  assert.equal(cols.originId?.notNull, false, "origin_id must be nullable");
});

test("AC-05: content_mode is required with no default", () => {
  const cols = columns(contentOpportunities);
  assert.equal(cols.contentMode?.notNull, true);
  assert.equal(cols.contentMode?.hasDefault, false);
});

// ─── AC-07 / AC-12 — a decision record, structurally ──────────────

test("AC-07 + AC-12: the table carries no prose and no checked claim", () => {
  const names = Object.keys(columns(contentOpportunities));
  const lower = names.map((n) => n.toLowerCase());

  for (const forbidden of FORBIDDEN_OPPORTUNITY_FIELDS) {
    assert.equal(
      lower.includes(forbidden.toLowerCase()),
      false,
      `content_opportunities has a '${forbidden}' column; it is a decision record, not content`,
    );
  }

  // Guard against vacuity: the table must actually have columns.
  assert.ok(names.length > 10, "parsed too few columns -- the check would be vacuous");
});

test("AC-12: claims_to_check holds questions, and there is nowhere to put an answer", () => {
  const cols = columns(contentOpportunities);
  assert.ok(cols.claimsToCheck, "claims_to_check must exist");
  assert.equal(cols.claimsToCheck?.notNull, true);

  // No paired value/answer/verification column. P0-R01 was an unchecked claim
  // written down as a fact; the fix is that there is no field for the fact.
  const lower = Object.keys(cols).map((n) => n.toLowerCase());
  for (const paired of ["claimsvalue", "claimanswers", "claimsverified", "verificationstatus"]) {
    assert.equal(lower.includes(paired), false, `${paired} would make an answer storable`);
  }
});

// ─── AC-08 — creating an opportunity reaches nothing else ─────────

test("AC-08: neither the schema nor the policy can reach a project or WordPress", () => {
  for (const [name, path] of [["schema", SCHEMA], ["policy", POLICY]] as const) {
    const src = code(readFileSync(path, "utf8"));
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

    const reachable = imports.filter((s) => /wordpress|affiliateProject|\/aff\b|publish/i.test(s));
    assert.deepEqual(reachable, [], `${name} imports something it must not reach: ${reachable}`);

    for (const forbidden of ["affiliateProjects", "wordpressProductSync", "wp_post"]) {
      assert.equal(
        src.includes(forbidden),
        false,
        `${name} mentions ${forbidden}; creating an opportunity must touch neither`,
      );
    }
  }
});

// ─── The derivation link ──────────────────────────────────────────

test("the opportunity↔signal link is a table, so the cardinality runs both ways", () => {
  const cols = columns(contentOpportunitySignals);
  assert.ok(cols.contentOpportunityId, "link needs the opportunity side");
  assert.ok(cols.signalId, "link needs the signal side");

  // A signal_id column ON the opportunity would allow only one signal per
  // opportunity; a content_opportunity_id ON the signal would allow only one
  // opportunity per signal. Both are the collapse P2 exists to prevent.
  const oppCols = Object.keys(columns(contentOpportunities)).map((n) => n.toLowerCase());
  assert.equal(oppCols.includes("signalid"), false, "a signal_id column would cap it at one");
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: the column reader really reads columns", () => {
  // If `columns()` returned {}, every forbidden-field assertion above would
  // pass vacuously.
  const cols = columns(contentOpportunities);
  assert.ok(cols.id && cols.title && cols.status, "expected columns are missing");
  assert.equal(cols.title?.notNull, true);
});

test("CONTROL: the forbidden list is non-empty and would catch a real column", () => {
  assert.ok(FORBIDDEN_OPPORTUNITY_FIELDS.length >= 5);
  const pretend = ["id", "title", "body"];
  const hit = pretend.filter((n) => FORBIDDEN_OPPORTUNITY_FIELDS.includes(n));
  assert.deepEqual(hit, ["body"]);
});
