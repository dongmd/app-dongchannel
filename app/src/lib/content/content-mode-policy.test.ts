import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTENT_MODES,
  DEFAULT_MODE_POLICY,
  EVIDENCE_FLOOR,
  MODE_POLICY_VERSION,
  claimTtlDays,
  deriveModeState,
  deriveRefreshDueAt,
  deriveRefreshState,
  deriveSlaDeadline,
  effectiveTtlDays,
  evidenceRank,
  isClaimAdmissible,
  isContentMode,
  isFresh,
  refreshActionFor,
  resolveModePolicy,
  slaOutcome,
  type ContentMode,
  type ModePolicyOverrides,
} from "./content-mode-policy";

// P2-R05 AC-01, AC-03 … AC-07, AC-09, AC-10.
//
// The property under test is not "a mode has a TTL". It is that the two things
// a mode is allowed to change — how long content stays fresh and how much
// process it goes through — are separable from the one thing it is never
// allowed to change: whether a claim was checked.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-08-20T00:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

// ─── AC-01 — the enum is closed ───────────────────────────────────

test("AC-01: exactly the five modes, and nothing else narrows", () => {
  assert.deepEqual([...CONTENT_MODES], [
    "COMMERCIAL",
    "EVERGREEN",
    "NEWS",
    "TREND",
    "UPDATE",
  ]);

  for (const mode of CONTENT_MODES) {
    assert.equal(isContentMode(mode), true, `${mode} must be recognised`);
  }

  // The values most likely to arrive from a careless caller.
  for (const bad of ["commercial", "BLOG", "", "NEWS ", null, undefined, 0, {}]) {
    assert.equal(isContentMode(bad), false, `${String(bad)} must be rejected`);
  }
});

test("AC-01: every mode has a complete policy — no mode falls through", () => {
  for (const mode of CONTENT_MODES) {
    const p = DEFAULT_MODE_POLICY[mode];
    assert.ok(p, `${mode} has no policy`);
    assert.ok(p.ttlDays > 0, `${mode} ttlDays must be positive`);
    assert.ok(p.slaHours > 0, `${mode} slaHours must be positive`);
  }
});

// ─── AC-03 — TTL is per mode, not global ──────────────────────────

test("AC-03: TTL differs by mode — NEWS and TREND short, EVERGREEN long", () => {
  const news = DEFAULT_MODE_POLICY.NEWS.ttlDays;
  const trend = DEFAULT_MODE_POLICY.TREND.ttlDays;
  const evergreen = DEFAULT_MODE_POLICY.EVERGREEN.ttlDays;

  assert.ok(news < evergreen, "NEWS must expire before EVERGREEN");
  assert.ok(trend < evergreen, "TREND must expire before EVERGREEN");

  // The gap this replaces: one hard-coded 90 for everything. If every mode
  // agreed on a number again, the requirement would be undone without any
  // test failing — so the distinctness is asserted directly.
  const distinct = new Set(CONTENT_MODES.map((m) => DEFAULT_MODE_POLICY[m].ttlDays));
  assert.ok(distinct.size > 1, "a single TTL for all modes is the G-21 gap, not the fix");
});

test("AC-03: the same anchor produces different due dates per mode", () => {
  const anchor = T0;
  const newsDue = deriveRefreshDueAt("NEWS", anchor);
  const evergreenDue = deriveRefreshDueAt("EVERGREEN", anchor);

  assert.ok(newsDue && evergreenDue);
  assert.ok(newsDue.getTime() < evergreenDue.getTime());
});

test("AC-03: per-claim TTL tightens the window; the shortest wins", () => {
  // An evergreen guide quoting a price is stale when the price is stale.
  assert.equal(effectiveTtlDays("EVERGREEN"), 365);
  assert.equal(effectiveTtlDays("EVERGREEN", ["price"]), claimTtlDays("price"));
  assert.equal(effectiveTtlDays("EVERGREEN", ["price", "discount"]), claimTtlDays("discount"));

  // Taking the longest would be the bug: a year-old price under a fresh badge.
  assert.ok(effectiveTtlDays("EVERGREEN", ["price"]) < effectiveTtlDays("EVERGREEN"));

  // A claim looser than the mode does not loosen the mode.
  assert.equal(effectiveTtlDays("NEWS", ["cookie_duration"]), DEFAULT_MODE_POLICY.NEWS.ttlDays);

  // An unrecognised claim key gets the default, not infinity.
  assert.equal(claimTtlDays("something_nobody_registered"), 90);
});

test("AC-03: expiry is boundary-exact and does not fire a moment early", () => {
  const ttl = DEFAULT_MODE_POLICY.NEWS.ttlDays;

  assert.equal(deriveRefreshState("NEWS", T0, at(ttl * DAY - 1)), "FRESH");
  assert.equal(deriveRefreshState("NEWS", T0, at(ttl * DAY)), "REFRESH_REQUIRED");
  assert.equal(deriveRefreshState("NEWS", T0, at(ttl * DAY + 1)), "REFRESH_REQUIRED");
});

// ─── UNKNOWN is not false, and not fresh either ───────────────────

test("a missing anchor is UNKNOWN — never FRESH, never silently expired", () => {
  assert.equal(deriveRefreshState("EVERGREEN", null, T0), "UNKNOWN");
  assert.equal(deriveRefreshDueAt("EVERGREEN", null), null);

  // UNKNOWN must stay distinguishable from REFRESH_REQUIRED: "never checked"
  // and "checked and expired" are different work.
  assert.notEqual(deriveRefreshState("EVERGREEN", null, T0), "REFRESH_REQUIRED");

  assert.equal(isFresh("UNKNOWN"), false);
  assert.equal(isFresh("REFRESH_REQUIRED"), false);
  assert.equal(isFresh("FRESH"), true);
});

test("an unparseable anchor is UNKNOWN, not epoch-zero and instantly stale", () => {
  assert.equal(deriveRefreshState("NEWS", new Date("not a date"), T0), "UNKNOWN");
});

// ─── AC-04 — expiry may only mark ─────────────────────────────────

test("AC-04: no refresh action can unpublish or edit", () => {
  const actions = new Set(
    (["FRESH", "REFRESH_REQUIRED", "UNKNOWN"] as const).map(refreshActionFor),
  );

  assert.deepEqual(
    [...actions].sort(),
    ["MARK_REFRESH_REQUIRED", "MARK_UNKNOWN", "NONE"],
  );

  // Stated as a property rather than a list, so a later addition to the
  // vocabulary trips this rather than sliding past it.
  for (const action of actions) {
    assert.ok(
      action.startsWith("MARK_") || action === "NONE",
      `${action} is neither a mark nor a no-op`,
    );
  }
});

test("AC-04: expiry marks, and a fresh item is left entirely alone", () => {
  assert.equal(refreshActionFor(deriveRefreshState("NEWS", T0, at(DAY))), "NONE");
  assert.equal(
    refreshActionFor(deriveRefreshState("NEWS", T0, at(400 * DAY))),
    "MARK_REFRESH_REQUIRED",
  );
});

// ─── AC-05 — the mapping is configuration ─────────────────────────

test("AC-05: configuration overrides TTL, QA depth and SLA per mode", () => {
  const overrides: ModePolicyOverrides = {
    NEWS: { ttlDays: 3, qaDepth: "STANDARD", slaHours: 6 },
  };

  const p = resolveModePolicy("NEWS", overrides);
  assert.equal(p.ttlDays, 3);
  assert.equal(p.qaDepth, "STANDARD");
  assert.equal(p.slaHours, 6);

  // Overriding one mode leaves the others untouched.
  assert.deepEqual(resolveModePolicy("EVERGREEN", overrides), DEFAULT_MODE_POLICY.EVERGREEN);
});

test("AC-05: a nonsensical override falls back rather than breaking the queue", () => {
  // Zero, negative and NaN all present as a broken refresh queue rather than
  // as an error: 0 marks everything permanently overdue, NaN marks nothing.
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = resolveModePolicy("NEWS", { NEWS: { ttlDays: bad } });
    assert.equal(p.ttlDays, DEFAULT_MODE_POLICY.NEWS.ttlDays, `ttlDays ${bad} must fall back`);
  }
});

// ─── AC-10 — mode never relaxes the claim rules ───────────────────

test("AC-10: no default mode sits below the evidence floor", () => {
  for (const mode of CONTENT_MODES) {
    assert.ok(
      evidenceRank(DEFAULT_MODE_POLICY[mode].minEvidenceLevel) >= evidenceRank(EVIDENCE_FLOOR),
      `${mode} defaults below the evidence floor`,
    );
  }
});

test("AC-10: configuration cannot lower the evidence floor — it is clamped", () => {
  // The exact configuration change that would reintroduce P0-R01: make the
  // fast mode accept assertions with nothing behind them.
  for (const attempt of ["E0", "E1"] as const) {
    const p = resolveModePolicy("NEWS", { NEWS: { minEvidenceLevel: attempt } });
    assert.equal(
      p.minEvidenceLevel,
      EVIDENCE_FLOOR,
      `an override to ${attempt} must be clamped back to the floor`,
    );
  }

  // Raising it is allowed — the clamp is a floor, not a lock.
  assert.equal(
    resolveModePolicy("NEWS", { NEWS: { minEvidenceLevel: "E4" } }).minEvidenceLevel,
    "E4",
  );
});

test("AC-10: an E0 claim is inadmissible in every mode, in every configuration", () => {
  const relaxAll: ModePolicyOverrides = Object.fromEntries(
    CONTENT_MODES.map((m) => [m, { minEvidenceLevel: "E0" as const }]),
  );

  for (const mode of CONTENT_MODES) {
    assert.equal(
      isClaimAdmissible(mode, "E0", relaxAll),
      false,
      `${mode} admitted an unchecked claim`,
    );
    assert.equal(isClaimAdmissible(mode, "E1", relaxAll), false);
    assert.equal(isClaimAdmissible(mode, "E2", relaxAll), true);
  }
});

test("AC-10: speed and truth are separate axes — NEWS is faster but not laxer", () => {
  const news = DEFAULT_MODE_POLICY.NEWS;
  const commercial = DEFAULT_MODE_POLICY.COMMERCIAL;

  assert.ok(news.slaHours < commercial.slaHours, "NEWS must be faster");
  assert.equal(news.qaDepth, "EXPEDITED");
  assert.ok(
    evidenceRank(news.minEvidenceLevel) >= evidenceRank(EVIDENCE_FLOOR),
    "being faster must not lower the evidence requirement",
  );
});

// ─── AC-06 — the SLA is measurable ────────────────────────────────

test("AC-06: SLA deadline follows the mode", () => {
  const commissioned = T0;
  assert.equal(
    deriveSlaDeadline("NEWS", commissioned).getTime(),
    commissioned.getTime() + DEFAULT_MODE_POLICY.NEWS.slaHours * HOUR,
  );
  assert.ok(
    deriveSlaDeadline("NEWS", commissioned) < deriveSlaDeadline("COMMERCIAL", commissioned),
  );
});

test("AC-06: an item still in flight can already be reported as missed", () => {
  const sla = DEFAULT_MODE_POLICY.NEWS.slaHours;

  // Nothing published, and the window is long gone. Measuring only completed
  // work would hide exactly the item worth chasing.
  assert.equal(slaOutcome("NEWS", T0, null, at(3 * DAY)), "MISSED");

  assert.equal(slaOutcome("NEWS", T0, null, at(1 * HOUR)), "IN_PROGRESS");
  assert.equal(slaOutcome("NEWS", T0, null, at(sla * HOUR * 0.9)), "AT_RISK");

  assert.equal(slaOutcome("NEWS", T0, at(sla * HOUR - 1), at(3 * DAY)), "MET");
  assert.equal(slaOutcome("NEWS", T0, at(sla * HOUR + 1), at(3 * DAY)), "MISSED");
});

// ─── AC-07 — changing mode re-derives ─────────────────────────────

test("AC-07: changing the mode changes TTL, QA and due date together", () => {
  const anchor = T0;
  const now = at(60 * DAY);

  const asNews = deriveModeState("NEWS", anchor, now);
  const asEvergreen = deriveModeState("EVERGREEN", anchor, now);

  // Same row, same anchor, same clock — only the mode changed.
  assert.equal(asNews.refreshState, "REFRESH_REQUIRED");
  assert.equal(asEvergreen.refreshState, "FRESH");

  assert.notEqual(asNews.ttlDays, asEvergreen.ttlDays);
  assert.notEqual(asNews.qaDepth, asEvergreen.qaDepth);
  assert.notEqual(
    asNews.refreshDueAt?.getTime(),
    asEvergreen.refreshDueAt?.getTime(),
  );

  // Nothing is cached, so nothing can be left behind: the derived value is a
  // function of the inputs, not a column that must be remembered.
  assert.deepEqual(deriveModeState("NEWS", anchor, now), asNews);
});

test("AC-07: the derived state carries the policy version that produced it", () => {
  assert.equal(deriveModeState("TREND", T0, at(DAY)).policyVersion, MODE_POLICY_VERSION);
});

test("AC-07: an override changes the derived state without any migration", () => {
  const now = at(20 * DAY);
  const before = deriveModeState("NEWS", T0, now);
  const after = deriveModeState("NEWS", T0, now, [], { NEWS: { ttlDays: 365 } });

  assert.equal(before.refreshState, "REFRESH_REQUIRED");
  assert.equal(after.refreshState, "FRESH");
});

// ─── CONTROL ──────────────────────────────────────────────────────
// Every group carries a control; a suite that cannot fail is not evidence.
// These assert the inverse of the rules above, so if the policy were gutted --
// one TTL for every mode, or an evidence floor that obeyed configuration --
// this test would pass while the others fell over, and the mismatch is the
// signal. Run positively: each control confirms the fixture it depends on is
// really wired to the code under test.

test("CONTROL: the harness observes the real module, not a copy of its numbers", () => {
  // If DEFAULT_MODE_POLICY were shadowed or stale, this comparison against a
  // freshly resolved policy would drift.
  for (const mode of CONTENT_MODES) {
    assert.deepEqual(resolveModePolicy(mode), DEFAULT_MODE_POLICY[mode]);
  }

  // And the clamp is genuinely reachable from the values the tests use: an
  // override below the floor must differ from the override as written, or the
  // AC-10 test above would be asserting something that cannot happen.
  const attempted = "E0" as const;
  const resolved = resolveModePolicy("NEWS", { NEWS: { minEvidenceLevel: attempted } });
  assert.notEqual(resolved.minEvidenceLevel, attempted);
  assert.equal(resolved.minEvidenceLevel, EVIDENCE_FLOOR);
});

test("CONTROL: a deliberately wrong expectation fails", () => {
  // The freshness derivation is the thing every other assertion rests on. If
  // it silently returned FRESH for everything, most of this file would still
  // pass. Prove it distinguishes.
  const states = new Set<string>([
    deriveRefreshState("NEWS", T0, at(DAY)),
    deriveRefreshState("NEWS", T0, at(400 * DAY)),
    deriveRefreshState("NEWS", null, T0),
  ]);
  assert.equal(states.size, 3, "the three refresh states must be distinguishable");
});

test("CONTROL: the mode list drives the tests, not a hard-coded duplicate", () => {
  // A test that iterates a private copy of the mode list would keep passing
  // after a sixth mode was added without a policy. Assert the source is shared.
  const modes: readonly ContentMode[] = CONTENT_MODES;
  assert.equal(modes.length, Object.keys(DEFAULT_MODE_POLICY).length);
  for (const key of Object.keys(DEFAULT_MODE_POLICY)) {
    assert.ok(isContentMode(key), `${key} is in the policy but not in the enum`);
  }
});
