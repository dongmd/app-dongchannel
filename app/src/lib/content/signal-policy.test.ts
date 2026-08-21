import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORBIDDEN_SIGNAL_FIELDS,
  ROUTE_TYPES,
  SIGNAL_ACTIONS,
  SIGNAL_STATUSES,
  canonicalKeyFor,
  checkProvenance,
  checkRouting,
  isDuplicateKey,
  normalise,
  observationKeyFor,
  isoWeekKey,
  producedNothing,
  type RouteDecision,
} from "./signal-policy";

// P2-R02 AC-02 … AC-07, AC-09, AC-10.
//
// The property under test is that a signal stays an observation. Everything
// here is a way of asking: can this layer accidentally decide something?

const T0 = new Date("2026-08-20T00:00:00.000Z");

// ─── AC-06 — provenance is mandatory, in one of two forms ─────────

test("AC-06: a signal with neither a source nor an actor is refused", () => {
  const v = checkProvenance({ capturedAt: T0 });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "NO_PROVENANCE");

  assert.equal(checkProvenance({ sourceId: "  ", capturedBy: "", capturedAt: T0 }).ok, false);
});

test("AC-06: a connector signal proves provenance by its source", () => {
  assert.equal(checkProvenance({ sourceId: "src-1", capturedAt: T0 }).ok, true);
});

test("AC-06: an owner seed proves provenance by its actor", () => {
  // The owner directive: OWNER_SEED may skip the signal layer, but never the
  // record of who seeded it and when.
  assert.equal(checkProvenance({ capturedBy: "owner@dongchannel", capturedAt: T0 }).ok, true);
});

test("AC-06: capture time is mandatory, and an unparseable one is refused", () => {
  const missing = checkProvenance({ sourceId: "src-1" });
  assert.equal(missing.ok === false && missing.reason, "NO_CAPTURE_TIME");

  const bad = checkProvenance({ sourceId: "src-1", capturedAt: new Date("nonsense") });
  assert.equal(bad.ok === false && bad.reason, "INVALID_CAPTURE_TIME");
  // Distinguishable on purpose: an unparseable timestamp looks like an answer
  // and compares false against everything, which is worse than a null.
});

// ─── AC-05 — normalisation ────────────────────────────────────────

test("AC-05: every source must produce the same four fields", () => {
  const ok = normalise({
    canonicalKey: " KEYWORD:seo tools ",
    kind: "KEYWORD",
    originMode: "CONNECTOR",
    title: "  SEO tools  ",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.signal.title, "SEO tools");
  assert.equal(ok.ok === true && ok.signal.canonicalKey, "KEYWORD:seo tools");
});

test("AC-05: a signal that cannot be normalised names the field it lacks", () => {
  for (const field of ["canonicalKey", "kind", "originMode", "title"] as const) {
    const raw: Record<string, string> = {
      canonicalKey: "K:x",
      kind: "KEYWORD",
      originMode: "CONNECTOR",
      title: "x",
    };
    delete raw[field];
    const v = normalise(raw);
    assert.equal(v.ok, false, `${field} missing must refuse`);
    assert.equal(v.ok === false && v.reason, `MISSING_${field.toUpperCase()}`);
  }
});

test("AC-05: whitespace is not content", () => {
  assert.equal(normalise({ canonicalKey: "K:x", kind: "K", originMode: "C", title: "   " }).ok, false);
});

// ─── AC-07 — deterministic dedup ──────────────────────────────────

test("AC-07: the same observation from two sources yields one key", () => {
  const a = canonicalKeyFor("keyword", "  SEO   Tools ");
  const b = canonicalKeyFor("KEYWORD", "seo tools");
  assert.equal(a, b);
  assert.ok(isDuplicateKey(a, b));
  assert.equal(a, "KEYWORD:seo tools");
});

test("AC-07: different observations do not collide", () => {
  assert.equal(isDuplicateKey(canonicalKeyFor("KEYWORD", "a"), canonicalKeyFor("TREND", "a")), false);
  assert.equal(isDuplicateKey(canonicalKeyFor("KEYWORD", "a"), canonicalKeyFor("KEYWORD", "b")), false);
});

test("AC-07: the key is idempotent — computing it twice is the same key", () => {
  assert.equal(canonicalKeyFor("TREND", "x y"), canonicalKeyFor("TREND", "x y"));
});

// ─── Observation identity vs entity identity ──────────────────────
//
// Owner invariant, 2026-08-20. It caught a real defect: keying a point-in-time
// observation on its subject alone collapses every future sighting into the
// first one, so a scheduled radar goes quiet after its first pass and looks
// healthy doing it.

test("INV: retrying the SAME observation yields the same key — no duplicate", () => {
  const a = observationKeyFor("TREND", "AI  Tools", "2026-W34");
  const b = observationKeyFor("TREND", "ai tools", "2026-W34");
  assert.equal(a, b, "a retry or replay must deduplicate");
});

test("INV: a genuinely NEW observation in a new window is NOT collapsed", () => {
  const august = observationKeyFor("TREND", "ai tools", "2026-W34");
  const december = observationKeyFor("TREND", "ai tools", "2026-W50");
  assert.notEqual(
    august, december,
    "a trend re-emerging months later must be able to enter the queue again",
  );
});

test("INV: entity-like signals stay window-free — a programme is one programme", () => {
  // The distinction is what the signal is ABOUT. An affiliate programme seen in
  // August and December is the same programme, and a second sighting SHOULD
  // collapse. A measurement taken twice is two measurements.
  const a = canonicalKeyFor("AFFILIATE_PROGRAM", "Systeme.io");
  const b = canonicalKeyFor("AFFILIATE_PROGRAM", "systeme.io");
  assert.equal(a, b);
  assert.equal(a.includes("@"), false, "an entity key carries no window");
});

test("INV: an observation without a window is refused, not silently keyed", () => {
  // Defaulting to "no window" would reintroduce the collapse quietly.
  assert.throws(() => observationKeyFor("TREND", "ai tools", "  "));
});

test("INV: the ISO week bucket is deterministic and actually buckets", () => {
  const mon = new Date("2026-08-17T00:00:00Z");
  const sun = new Date("2026-08-23T23:59:59Z");
  const nextMon = new Date("2026-08-24T00:00:00Z");
  assert.equal(isoWeekKey(mon), isoWeekKey(sun), "a week is one bucket");
  assert.notEqual(isoWeekKey(sun), isoWeekKey(nextMon), "the next week is a new bucket");
  assert.equal(isoWeekKey(mon), isoWeekKey(new Date("2026-08-17T12:00:00Z")));
  assert.match(isoWeekKey(mon), /^\d{4}-W\d{2}$/);
});

// ─── AC-02 / AC-03 — four outcomes, and nothing is one of them ────

test("AC-02: all four outcomes are representable", () => {
  const many: RouteDecision[] = [
    { routeType: "CONTENT_OPPORTUNITY", status: "ACCEPTED" },
    { routeType: "AFFILIATE_PROJECT", status: "ACCEPTED" },
  ];
  // many opportunities + a project candidate, from one signal
  assert.equal(checkRouting(many).ok, true);

  // just a project candidate
  assert.equal(checkRouting([{ routeType: "AFFILIATE_PROJECT", status: "ACCEPTED" }]).ok, true);

  // just content
  assert.equal(checkRouting([{ routeType: "CONTENT_OPPORTUNITY", status: "ACCEPTED" }]).ok, true);

  // nothing -- recorded, with a reason
  assert.equal(
    checkRouting([{ routeType: "NO_ACTION", status: "ACCEPTED", reason: "out of topic scope" }]).ok,
    true,
  );
});

test("AC-03: 'nothing' must be written down, not omitted", () => {
  const silence = checkRouting([]);
  assert.equal(silence.ok, false);
  assert.equal(silence.ok === false && silence.reason, "EMPTY_DECISION_SET");
  // Silence is indistinguishable from never having looked, which is the exact
  // thing AC-03 exists to prevent.
});

test("AC-03: declining requires a reason", () => {
  const noReason = checkRouting([{ routeType: "NO_ACTION", status: "ACCEPTED" }]);
  assert.equal(noReason.ok === false && noReason.reason, "REASON_REQUIRED");

  const rejected = checkRouting([{ routeType: "CONTENT_OPPORTUNITY", status: "REJECTED" }]);
  assert.equal(rejected.ok === false && rejected.reason, "REASON_REQUIRED");

  assert.equal(
    checkRouting([{ routeType: "CONTENT_OPPORTUNITY", status: "REJECTED", reason: "thin" }]).ok,
    true,
  );
});

test("AC-03: 'produced nothing' is distinguishable from 'never considered'", () => {
  assert.equal(producedNothing([]), false, "never considered is not the same as declined");
  assert.equal(
    producedNothing([{ routeType: "NO_ACTION", status: "ACCEPTED", reason: "off-topic" }]),
    true,
  );
  assert.equal(
    producedNothing([{ routeType: "CONTENT_OPPORTUNITY", status: "ACCEPTED" }]),
    false,
  );
});

test("AC-02: one route type per signal — multiple engines yes, duplicates no", () => {
  const dup = checkRouting([
    { routeType: "CONTENT_OPPORTUNITY", status: "ACCEPTED" },
    { routeType: "CONTENT_OPPORTUNITY", status: "PROPOSED" },
  ]);
  assert.equal(dup.ok === false && dup.reason, "DUPLICATE_ROUTE_TYPE");
});

// ─── AC-04 / AC-10 — the layer cannot decide or publish ───────────

test("AC-04: the action vocabulary contains no write, no publish, no project", () => {
  for (const a of SIGNAL_ACTIONS) {
    assert.ok(
      ["RECORD_ROUTE", "MARK_DUPLICATE", "DISCARD", "NONE"].includes(a),
      `${a} is outside the permitted vocabulary`,
    );
  }
  for (const banned of ["PUBLISH", "CREATE_PROJECT", "WRITE_ARTICLE", "SCORE"]) {
    assert.equal(
      (SIGNAL_ACTIONS as readonly string[]).includes(banned),
      false,
      `${banned} must not be expressible`,
    );
  }
});

test("AC-10: the intake lifecycle contains no editorial state", () => {
  assert.deepEqual([...SIGNAL_STATUSES], ["NEW", "ROUTED", "DUPLICATE", "DISCARDED"]);

  // The nine-state lifecycle this replaced. Every one of these is a decision
  // about content, and decisions live on ContentOpportunity now.
  for (const editorial of [
    "RESEARCHING",
    "NEEDS_EVIDENCE",
    "READY_FOR_DECISION",
    "WATCHLIST",
    "APPROVED",
    "REJECTED",
    "ARCHIVED",
  ]) {
    assert.equal(
      (SIGNAL_STATUSES as readonly string[]).includes(editorial),
      false,
      `${editorial} is an editorial state and must not be a signal status`,
    );
  }
});

test("AC-10: the forbidden-field list names every judgement field removed", () => {
  for (const f of ["overall_score", "scoring_version", "score_breakdown"]) {
    assert.ok(FORBIDDEN_SIGNAL_FIELDS.includes(f), `${f} must stay forbidden`);
  }
});

// ─── CONTROL ──────────────────────────────────────────────────────

test("CONTROL: checkRouting distinguishes its three refusal reasons", () => {
  const reasons = new Set(
    [
      checkRouting([]),
      checkRouting([{ routeType: "NO_ACTION", status: "ACCEPTED" }]),
      checkRouting([
        { routeType: "WATCHLIST", status: "ACCEPTED" },
        { routeType: "WATCHLIST", status: "ACCEPTED" },
      ]),
    ].map((v) => (v.ok ? "OK" : v.reason)),
  );
  assert.deepEqual(
    [...reasons].sort(),
    ["DUPLICATE_ROUTE_TYPE", "EMPTY_DECISION_SET", "REASON_REQUIRED"],
  );
});

test("CONTROL: the happy paths pass, so the refusals mean something", () => {
  assert.equal(checkProvenance({ sourceId: "s", capturedAt: T0 }).ok, true);
  assert.equal(normalise({ canonicalKey: "K:a", kind: "K", originMode: "C", title: "t" }).ok, true);
  assert.equal(checkRouting([{ routeType: "CONTENT_OPPORTUNITY", status: "ACCEPTED" }]).ok, true);
  assert.equal(ROUTE_TYPES.length, 5);
});
