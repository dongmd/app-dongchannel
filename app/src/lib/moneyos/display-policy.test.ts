/**
 * P4-R11 — the surfaces are only as honest as this module.
 *
 * Every test here is about a way a presentation layer can invent a fact the
 * database never stated. That is the whole risk of this requirement: the pages
 * are not hard to build, they are easy to make subtly untrue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_REASONS,
  OPPORTUNITY_STATUS_LABELS,
  UNKNOWN,
  display,
  displayCoverage,
  displayScore,
  inStoredOrder,
  isThinlyAssessed,
  label,
} from "./display-policy";

// ─── AC-04 ─────────────────────────────────────────────────────────

describe("AC-04 — an absent value is UNKNOWN, never zero and never a dash", () => {
  it("renders null and undefined as UNKNOWN", () => {
    assert.equal(display(null), UNKNOWN);
    assert.equal(display(undefined), UNKNOWN);
  });

  it("renders an empty or whitespace string as UNKNOWN", () => {
    // An empty cell reads like "nothing here", which is a claim.
    assert.equal(display(""), UNKNOWN);
    assert.equal(display("   "), UNKNOWN);
  });

  it("does NOT turn a genuine zero into UNKNOWN", () => {
    // The mistake in the other direction, and equally wrong: a real zero is an
    // answer. This is the only place the two are told apart.
    assert.equal(display(0), "0");
    assert.equal(displayScore(0), "0.0");
  });

  it("renders a non-finite number as UNKNOWN rather than 'NaN'", () => {
    assert.equal(display(NaN), UNKNOWN);
    assert.equal(display(Infinity), UNKNOWN);
    assert.equal(displayScore(NaN), UNKNOWN);
  });

  it("an unscored opportunity shows UNKNOWN, which is not a low score", () => {
    assert.equal(displayScore(null), UNKNOWN);
    assert.notEqual(displayScore(null), "0");
    assert.notEqual(displayScore(null), "0.0");
    assert.notEqual(displayScore(null), "-");
  });

  it("a real score renders to one decimal", () => {
    assert.equal(displayScore(82), "82.0");
    assert.equal(displayScore(7.25), "7.3");
  });
});

describe("AC-04 — coverage, because 82 over 3 dimensions is not 82 over 11", () => {
  it("renders known/total", () => {
    assert.equal(displayCoverage(3, 11), "3/11");
  });

  it("is UNKNOWN when either half is missing", () => {
    assert.equal(displayCoverage(null, 11), UNKNOWN);
    assert.equal(displayCoverage(3, null), UNKNOWN);
    assert.equal(displayCoverage(null, null), UNKNOWN);
  });

  it("is UNKNOWN rather than a division by zero", () => {
    assert.equal(displayCoverage(0, 0), UNKNOWN);
  });

  it("thin assessment returns NULL when coverage is unknown -- not false", () => {
    // UNKNOWN-is-not-false at the surface. A boolean would collapse "we do not
    // know how much was assessed" into the reassuring answer.
    assert.equal(isThinlyAssessed(null, 11), null);
    assert.equal(isThinlyAssessed(3, null), null);
    assert.notEqual(isThinlyAssessed(null, null), false);
  });

  it("thin assessment is true below half the dimensions and false above", () => {
    assert.equal(isThinlyAssessed(3, 11), true);
    assert.equal(isThinlyAssessed(9, 11), false);
    assert.equal(isThinlyAssessed(5, 10), false);
  });
});

// ─── AC-02 ─────────────────────────────────────────────────────────

describe("AC-02 — the UI computes no ranking", () => {
  it("preserves the stored order exactly, including a deliberately wrong one", () => {
    // The test the criterion asks for by name: feed unsorted rows, assert they
    // come out untouched. If anyone adds a .sort() to `inStoredOrder`, or a
    // page sorts on its own, this is what fails.
    const rows = [
      { id: "a", score: 12 },
      { id: "b", score: 99 },
      { id: "c", score: 50 },
      { id: "d", score: null },
      { id: "e", score: 1 },
    ];
    assert.deepEqual(inStoredOrder(rows), rows);
    assert.deepEqual(
      inStoredOrder(rows).map((r) => r.id),
      ["a", "b", "c", "d", "e"],
    );
  });

  it("does not reorder nulls to the end on its own", () => {
    // NULLS LAST is the QUERY's decision, made once in queries.ts. If this
    // module also did it, there would be two ranking authorities.
    const rows = [{ s: null }, { s: 10 }, { s: null }, { s: 5 }];
    assert.deepEqual(inStoredOrder(rows), rows);
  });

  it("returns the same array contents for an empty list", () => {
    assert.deepEqual(inStoredOrder([]), []);
  });
});

// ─── Labels ────────────────────────────────────────────────────────

describe("a status the label map does not know is shown as itself", () => {
  it("maps a known status", () => {
    assert.equal(label(OPPORTUNITY_STATUS_LABELS, "CANDIDATE"), "Ứng viên");
  });

  it("shows an unmapped status verbatim rather than hiding it", () => {
    // A value added by a later migration must APPEAR on the page. A default of
    // "Unknown status" would make a new enum value invisible.
    assert.equal(label(OPPORTUNITY_STATUS_LABELS, "ARCHIVED_BY_FUTURE_MIGRATION"),
      "ARCHIVED_BY_FUTURE_MIGRATION");
  });

  it("an absent status is UNKNOWN", () => {
    assert.equal(label(OPPORTUNITY_STATUS_LABELS, null), UNKNOWN);
    assert.equal(label(OPPORTUNITY_STATUS_LABELS, "  "), UNKNOWN);
  });
});

// ─── AC-08 ─────────────────────────────────────────────────────────

describe("AC-08 — the empty state explains itself", () => {
  it("every surface has a reason, and each names what would fill it", () => {
    const keys = [
      "opportunities", "signals", "clusters", "trends",
      "candidates", "evidence", "agents",
    ];
    for (const k of keys) {
      const r = EMPTY_REASONS[k];
      assert.ok(r, `${k}: no empty reason -- the surface would render a bare shrug`);
      assert.ok(r!.what.length > 3, `${k}: 'what' is too thin`);
      assert.ok(r!.why.length > 10, `${k}: 'why' does not explain anything`);
      // Naming the requirement makes the answer checkable rather than vague.
      assert.match(r!.filledBy, /P4-R\d\d|Owner/, `${k}: filledBy names no owner`);
    }
  });

  it("CONTROL — the reasons are distinct, not one sentence copied seven times", () => {
    const whys = Object.values(EMPTY_REASONS).map((r) => r.why);
    assert.equal(new Set(whys).size, whys.length, "duplicated empty-state reason");
  });
});
