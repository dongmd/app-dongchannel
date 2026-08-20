import assert from "node:assert/strict";
import { test } from "node:test";

import * as schema from "../db/schema";
import {
  contentModeEnum,
  contentRefreshStateEnum,
  evidenceLevelEnum,
  qaDepthEnum,
} from "../db/schema/content";
import {
  CONTENT_MODES,
  DEFAULT_MODE_POLICY,
  EVIDENCE_LEVELS,
  QA_DEPTHS,
  REFRESH_STATES,
} from "./content-mode-policy";

// P2-R05 AC-01, the half that is easy to lose.
//
// The closed enum exists twice: once in Postgres, once in TypeScript. That
// duplication is unavoidable — the policy module must stay database-free to be
// testable (AC-09), and the database must reject a sixth value on its own
// rather than trusting whichever caller remembered to check.
//
// What is avoidable is the two drifting. A mode added to the policy but not to
// the migration does not fail here, in CI; it fails on the first insert in
// production, as a constraint violation with no obvious cause. So the agreement
// is asserted rather than assumed.
//
// This file imports Drizzle's schema builders, which are pure declarations —
// no connection, no DATABASE_URL, no database.

interface ColumnLike {
  readonly columnType?: unknown;
  readonly enumValues?: readonly string[];
  readonly notNull?: unknown;
  readonly hasDefault?: unknown;
}

function isColumn(value: unknown): value is ColumnLike {
  return typeof value === "object" && value !== null && "columnType" in value;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

test("AC-01: the Postgres content_mode enum matches CONTENT_MODES exactly", () => {
  assert.deepEqual([...contentModeEnum.enumValues], [...CONTENT_MODES]);
});

test("AC-01: qa_depth, evidence_level and refresh_state agree across both sides", () => {
  assert.deepEqual([...qaDepthEnum.enumValues], [...QA_DEPTHS]);
  assert.deepEqual([...evidenceLevelEnum.enumValues], [...EVIDENCE_LEVELS]);
  assert.deepEqual([...contentRefreshStateEnum.enumValues], [...REFRESH_STATES]);
});

test("AC-01: every database mode has a policy — no mode can be stored unpriced", () => {
  for (const mode of contentModeEnum.enumValues) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULT_MODE_POLICY, mode),
      `${mode} is storable but has no policy`,
    );
  }
});

test("AC-02: every table carrying a content mode requires it, with no default", () => {
  // Stated over the whole schema rather than over one table by name.
  //
  // Today this covers `article_content_modes` alone — one table, so the
  // assertion is not vacuous. When P2-R01 adds `ContentOpportunity`, its
  // `content_mode` falls under the same rule automatically, which is the
  // reason R05 was built before R01: the column ships required from birth
  // instead of arriving nullable and being tightened by a second migration.
  // Walked structurally rather than through Drizzle's types: the point is to
  // catch a table nobody thought to add to this list, so the traversal must not
  // depend on knowing the list.
  const tables = Object.entries(schema as Record<string, unknown>);

  let checked = 0;

  for (const [tableName, table] of tables) {
    if (typeof table !== "object" || table === null) continue;

    for (const [columnName, column] of Object.entries(table as Record<string, unknown>)) {
      if (!isColumn(column)) continue;
      if (column.enumValues === undefined) continue;
      if (column.columnType !== "PgEnumColumn") continue;
      // Only the content-mode enum; other enums have their own rules.
      if (!sameValues(column.enumValues, contentModeEnum.enumValues)) continue;

      checked += 1;
      assert.equal(
        column.notNull,
        true,
        `${tableName}.${columnName} carries a content mode but allows null`,
      );
      assert.equal(
        column.hasDefault,
        false,
        `${tableName}.${columnName} has a default content mode; AC-02 forbids a silent default`,
      );
    }
  }

  assert.ok(checked > 0, "found no content_mode column at all — the guard would be vacuous");
});

test("CONTROL: the comparison is against the real enum, not a literal", () => {
  // If `contentModeEnum.enumValues` were empty or undefined, deepEqual against
  // an equally empty expectation would pass. Anchor it.
  assert.ok(contentModeEnum.enumValues.length >= 5);
  assert.equal(contentModeEnum.enumName, "content_mode");
  assert.ok(!contentModeEnum.enumValues.includes("BLOG" as never));
});
