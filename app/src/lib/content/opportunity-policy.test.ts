import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLOSED_WITHOUT_CONTENT,
  FORBIDDEN_OPPORTUNITY_FIELDS,
  OPPORTUNITY_ORIGIN_TYPES,
  OPPORTUNITY_STATUSES,
  TERMINAL_STATUSES,
  allowedTransitionsFrom,
  checkDerivation,
  checkOrigin,
  checkTransition,
  isOpportunityOriginType,
  type OpportunityStatus,
} from "./opportunity-policy";

// P2-R01 AC-01 … AC-04, AC-09, AC-11, AC-12.
//
// The property under test is not "an opportunity can be created". It is that
// the three things this entity exists to prevent stay prevented: a signal
// silently becoming an opportunity, a decision disappearing instead of being
// recorded, and an unchecked claim being written down as a fact.

// ─── AC-01 — the eight origin types ───────────────────────────────

test("AC-01: exactly the eight origin types from PF-01", () => {
  assert.deepEqual([...OPPORTUNITY_ORIGIN_TYPES], [
    "AFFILIATE_OFFER",
    "KEYWORD",
    "TREND",
    "PRODUCT_TOOL",
    "COMPETITOR_MOVE",
    "CONTENT_GAP",
    "PERFORMANCE_EXPANSION",
    "OWNER_SEED",
  ]);
  assert.equal(OPPORTUNITY_ORIGIN_TYPES.length, 8);
});

test("AC-01: a ninth value is not an origin type", () => {
  for (const bad of ["YOUTUBE_NICHE", "affiliate_offer", "", "OTHER", null, undefined, 7, {}]) {
    assert.equal(isOpportunityOriginType(bad), false, `${String(bad)} must be rejected`);
  }
  // The two MASTER v3 types V2 deliberately does not cover.
  assert.equal(isOpportunityOriginType("YOUTUBE_VIDEO"), false);
});

// ─── AC-02 / AC-03 — the nullable-origin asymmetry ────────────────

test("AC-02: a null origin_id is valid, not an error", () => {
  // An owner idea typed into Telegram points at no source object.
  assert.deepEqual(checkOrigin({ originType: "OWNER_SEED", originId: null }), { ok: true });
  assert.deepEqual(checkOrigin({ originType: "CONTENT_GAP", originId: undefined }), { ok: true });
});

test("AC-03: origin_type without origin_id is allowed; the reverse is refused", () => {
  assert.equal(checkOrigin({ originType: "TREND", originId: null }).ok, true);

  const reversed = checkOrigin({ originType: null, originId: "some-uuid" });
  assert.equal(reversed.ok, false);
  assert.equal(reversed.ok === false && reversed.reason, "ORIGIN_TYPE_MISSING");
});

test("AC-03: an unrecognised origin type is refused distinctly from a missing one", () => {
  const bad = checkOrigin({ originType: "MADE_UP" as never, originId: null });
  assert.equal(bad.ok, false);
  // Distinguishable, because "you sent nonsense" and "you sent nothing" call
  // for different fixes at the caller.
  assert.equal(bad.ok === false && bad.reason, "ORIGIN_TYPE_INVALID");
});

// ─── AC-04 — "nothing" is a recorded outcome ──────────────────────

test("AC-04: REJECTED and DROPPED are states, and both are terminal", () => {
  assert.ok(OPPORTUNITY_STATUSES.includes("REJECTED"));
  assert.ok(OPPORTUNITY_STATUSES.includes("DROPPED"));
  assert.ok(TERMINAL_STATUSES.has("REJECTED"));
  assert.ok(TERMINAL_STATUSES.has("DROPPED"));

  // They are distinct: a judgement on the merits, versus a withdrawal for an
  // external reason. Collapsing them loses why nothing was produced.
  assert.equal(CLOSED_WITHOUT_CONTENT.size, 2);
  assert.equal(CLOSED_WITHOUT_CONTENT.has("PUBLISHED"), false);
});

test("AC-04: closing without content requires a reason", () => {
  for (const to of ["REJECTED", "DROPPED"] as const) {
    const bare = checkTransition("PROPOSED", to);
    assert.equal(bare.ok, false, `${to} must not close silently`);
    assert.equal(bare.ok === false && bare.reason, "REASON_REQUIRED");

    assert.equal(checkTransition("PROPOSED", to, "  ").ok, false, "whitespace is not a reason");
    assert.equal(checkTransition("PROPOSED", to, "out of topic scope").ok, true);
  }
});

test("AC-04: publishing does not require a closing reason", () => {
  // PUBLISHED is a success, not a decline. Demanding a reason there would push
  // callers toward writing filler, which devalues the field where it matters.
  assert.equal(checkTransition("IN_PRODUCTION", "PUBLISHED").ok, true);
});

test("AC-04: every non-terminal state can reach a recorded 'nothing'", () => {
  // If some state could only move forward, work would pile up in it with no way
  // to say "we decided against this" -- and the trace AC-04 exists for would be
  // missing exactly where a decision was made.
  for (const s of OPPORTUNITY_STATUSES) {
    if (TERMINAL_STATUSES.has(s)) continue;
    const outs = allowedTransitionsFrom(s);
    assert.ok(
      outs.some((o) => CLOSED_WITHOUT_CONTENT.has(o)),
      `${s} cannot record a decision to stop`,
    );
  }
});

// ─── AC-09 — explicit transitions ─────────────────────────────────

test("AC-09: an invalid transition is refused, not ignored", () => {
  const skip = checkTransition("PROPOSED", "PUBLISHED", "looks fine");
  assert.equal(skip.ok, false);
  assert.equal(skip.ok === false && skip.reason, "INVALID_TRANSITION");
});

test("AC-09: terminal states are terminal, including back to themselves", () => {
  for (const t of ["PUBLISHED", "REJECTED", "DROPPED"] as const) {
    assert.deepEqual([...allowedTransitionsFrom(t)], []);
    const v = checkTransition(t, "RESEARCHING", "changed my mind");
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "TERMINAL");
  }
});

test("AC-09: the transition table is an allowlist over the real status list", () => {
  // A status added later with no edges is unreachable and inescapable -- a loud
  // failure. This asserts every status is actually covered, so a new one cannot
  // silently inherit permissive behaviour.
  for (const s of OPPORTUNITY_STATUSES) {
    const outs = allowedTransitionsFrom(s);
    assert.ok(Array.isArray(outs), `${s} has no transition entry`);
    for (const o of outs) {
      assert.ok(
        OPPORTUNITY_STATUSES.includes(o as OpportunityStatus),
        `${s} -> ${o} names a status that does not exist`,
      );
    }
  }
});

// ─── The semantic boundary: a signal is not an opportunity ────────

test("a non-OWNER_SEED opportunity must rest on at least one signal", () => {
  const v = checkDerivation("TREND", []);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "SIGNAL_REQUIRED");
});

test("OWNER_SEED is the one origin that needs no signal", () => {
  assert.equal(checkDerivation("OWNER_SEED", []).ok, true);
});

test("an opportunity may rest on MANY signals", () => {
  // The whole point of the separation: three observations about one tool
  // collapse into one decision, rather than three.
  assert.equal(checkDerivation("PRODUCT_TOOL", ["a", "b", "c"]).ok, true);
});

test("the same signal cannot be linked twice to one opportunity", () => {
  const v = checkDerivation("KEYWORD", ["a", "b", "a"]);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "DUPLICATE_SIGNAL");
});

// ─── AC-07 / AC-12 — a decision record, not content ───────────────

test("AC-07 + AC-12: the forbidden-field list names prose AND checked claims", () => {
  for (const f of ["body", "content", "draft"]) {
    assert.ok(FORBIDDEN_OPPORTUNITY_FIELDS.includes(f), `${f} must be forbidden`);
  }
  for (const f of ["verified", "checkedAt", "claimValue", "price", "rating"]) {
    assert.ok(FORBIDDEN_OPPORTUNITY_FIELDS.includes(f), `${f} must be forbidden`);
  }
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: checkTransition distinguishes its three refusal reasons", () => {
  // If it collapsed to a single boolean, most assertions above would still
  // pass while the caller lost the ability to say what went wrong.
  const reasons = new Set(
    [
      checkTransition("PUBLISHED", "READY", "x"),
      checkTransition("PROPOSED", "PUBLISHED", "x"),
      checkTransition("PROPOSED", "REJECTED"),
    ].map((v) => (v.ok ? "OK" : v.reason)),
  );
  assert.deepEqual([...reasons].sort(), ["INVALID_TRANSITION", "REASON_REQUIRED", "TERMINAL"]);
});

test("CONTROL: the happy path really passes, so refusals mean something", () => {
  // A policy that refused everything would satisfy every negative test above.
  assert.equal(checkTransition("PROPOSED", "RESEARCHING").ok, true);
  assert.equal(checkTransition("RESEARCHING", "READY").ok, true);
  assert.equal(checkTransition("READY", "IN_PRODUCTION").ok, true);
  assert.equal(checkTransition("IN_PRODUCTION", "PUBLISHED").ok, true);
  assert.equal(checkOrigin({ originType: "KEYWORD", originId: "kw-1" }).ok, true);
  assert.equal(checkDerivation("KEYWORD", ["s1"]).ok, true);
});
