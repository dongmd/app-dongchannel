import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ALLOWLIST_SEED,
  PROVIDER_OUTCOMES,
  RADAR_ACTIONS,
  checkScope,
  classifyProviderResult,
  decideFetchRetry,
  emitSignal,
  isGenuineZero,
  isTrendStale,
  mayEmitSignal,
  tallyRun,
  totalRejected,
  trendTtlDays,
  type AllowlistEntry,
  type EmitVerdict,
} from "./trend-radar-policy";
import { isoWeekKey, observationKeyFor } from "./signal-policy";
import { claimTtlDays } from "./content-mode-policy";

// P2-R06 AC-01 … AC-09, plus the owner's additional invariants.
//
// The property under test is that a trend stays a trend: an observation with
// provenance, not a decision to write about something.

const T0 = new Date("2026-08-20T00:00:00.000Z");

function list(...terms: string[]): AllowlistEntry[] {
  return terms.map((term, i) => ({ id: `e${i}`, term, enabled: true }));
}

const OK = classifyProviderResult({ failed: false, rows: 12 });

// ─── AC-04 — an empty allowlist fails CLOSED ──────────────────────

test("AC-04: an empty allowlist rejects everything", () => {
  const v = checkScope("ai tools", []);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "EMPTY_ALLOWLIST");
});

test("AC-04: an allowlist of only DISABLED entries is an empty allowlist", () => {
  // A wiped table and a table of retired topics are the same fact to a radar,
  // and failing open on either would turn a misconfiguration into "publish
  // about anything".
  const disabled: AllowlistEntry[] = [{ id: "e0", term: "ai tools", enabled: false }];
  const v = checkScope("ai tools", disabled);
  assert.equal(v.ok === false && v.reason, "EMPTY_ALLOWLIST");
});

// ─── AC-02 — out of scope is REJECTED, with the term ──────────────

test("AC-02: an out-of-scope subject is rejected and names what failed", () => {
  const v = checkScope("crochet patterns", list("ai tools", "seo"));
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "OUT_OF_SCOPE");
  assert.equal(v.ok === false && v.subject, "crochet patterns");
});

test("AC-02: an in-scope subject names the entry it matched", () => {
  const v = checkScope("best AI  Tools for writing", list("ai tools", "seo"));
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.matchedTerm, "ai tools");
  assert.ok(v.ok === true && v.matchedEntryId.length > 0);
});

test("AC-02: whitespace and case do not decide scope", () => {
  assert.equal(checkScope("  SEO   audits ", list("seo")).ok, true);
});

test("AC-02: an empty subject is refused distinctly from out-of-scope", () => {
  const v = checkScope("   ", list("seo"));
  assert.equal(v.ok === false && v.reason, "NO_SUBJECT");
});

// ─── Provider outcomes: four things, not one ──────────────────────

test("provider error, no-data, unknown and genuine zero are distinguishable", () => {
  assert.equal(classifyProviderResult({ failed: true, error: "timeout" }).outcome, "PROVIDER_ERROR");
  assert.equal(classifyProviderResult({ failed: false, rows: 0 }).outcome, "NO_DATA");
  assert.equal(classifyProviderResult({ failed: false, rows: null }).outcome, "UNKNOWN");
  assert.equal(
    classifyProviderResult({ failed: false, rows: 5, valueMissing: true }).outcome,
    "UNKNOWN",
  );
  assert.equal(classifyProviderResult({ failed: false, rows: 5 }).outcome, "OK");

  // All four are different values, not synonyms for "nothing came back".
  assert.equal(new Set(["PROVIDER_ERROR", "NO_DATA", "UNKNOWN", "OK"]).size, 4);
});

test("a genuine zero is EVIDENCE, not absence", () => {
  // "Nobody searched for this" is a fact worth keeping. Treating it as an error
  // would discard real evidence.
  assert.equal(isGenuineZero(0), true);
  assert.equal(isGenuineZero(null), false);
  assert.equal(isGenuineZero(undefined), false);
});

test("only OK may become a signal — a provider error is never a trend", () => {
  assert.equal(mayEmitSignal("OK"), true);
  for (const bad of ["PROVIDER_ERROR", "NO_DATA", "UNKNOWN", "ZERO"] as const) {
    assert.equal(mayEmitSignal(bad), false, `${bad} must not become a signal`);
  }
});

test("a failed fetch cannot be emitted as an observation", () => {
  const v = emitSignal(
    { subject: "ai tools", sourceId: "src-1", capturedAt: T0 },
    list("ai tools"),
    classifyProviderResult({ failed: true, error: "502" }),
  );
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "PROVIDER_PROVIDER_ERROR");
});

// ─── AC-05 — provenance on every emitted signal ───────────────────

test("AC-05: an emitted signal carries source, capture time and the matched entry", () => {
  const v = emitSignal({ subject: "ai tools roundup", sourceId: "src-1", capturedAt: T0 }, list("ai tools"), OK);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.signal.sourceId, "src-1");
  assert.equal(v.signal.capturedAt.getTime(), T0.getTime());
  assert.ok(v.signal.matchedEntryId, "the allowlist entry is part of the provenance");
  assert.equal(v.signal.kind, "TREND");
});

test("AC-05: a signal with no source is refused", () => {
  const v = emitSignal({ subject: "ai tools", sourceId: "  ", capturedAt: T0 }, list("ai tools"), OK);
  assert.equal(v.ok === false && v.reason, "NO_PROVENANCE");
});

test("AC-05: an unparseable capture time is refused", () => {
  const v = emitSignal(
    { subject: "ai tools", sourceId: "s", capturedAt: new Date("nope") },
    list("ai tools"),
    OK,
  );
  assert.equal(v.ok === false && v.reason, "INVALID_CAPTURE_TIME");
});

// ─── Dedup / idempotency: no duplicates from scheduled runs ───────

test("the same trend twice yields the same canonical key", () => {
  const a = emitSignal({ subject: "AI  Tools", sourceId: "s", capturedAt: T0 }, list("ai tools"), OK);
  const b = emitSignal({ subject: "ai tools", sourceId: "s", capturedAt: new Date(T0.getTime() + 9e6) }, list("ai tools"), OK);
  assert.ok(a.ok && b.ok);
  assert.equal(a.ok && a.signal.canonicalKey, b.ok && b.signal.canonicalKey);
});

test("the dedup key is P2-R02's, not a second scheme", () => {
  // A radar that keyed its own way would duplicate every signal another source
  // had already produced.
  const v = emitSignal({ subject: "seo audits", sourceId: "s", capturedAt: T0 }, list("seo"), OK);
  assert.equal(
    v.ok && v.signal.canonicalKey,
    observationKeyFor("TREND", "seo audits", isoWeekKey(T0)),
  );
});

test("a trend re-emerging in a later window is a NEW signal, not a duplicate", () => {
  // The defect this fixed: keying on the subject alone meant a December sighting
  // was deduplicated against an August one and never entered the queue again --
  // a scheduled radar going quiet after its first pass and looking healthy.
  const august = emitSignal({ subject: "ai tools", sourceId: "s", capturedAt: T0 }, list("ai tools"), OK);
  const december = emitSignal(
    { subject: "ai tools", sourceId: "s", capturedAt: new Date("2026-12-10T00:00:00Z") },
    list("ai tools"),
    OK,
  );
  assert.ok(august.ok && december.ok);
  assert.notEqual(august.ok && august.signal.canonicalKey, december.ok && december.signal.canonicalKey);
});

test("a retry cannot produce a second signal: same window, same key", () => {
  // A retry happens minutes later, inside the same observation window, so the
  // key is unchanged and the emission deduplicates.
  const first = emitSignal({ subject: "hosting deals", sourceId: "s", capturedAt: T0 }, list("hosting"), OK);
  const afterRetry = emitSignal(
    { subject: "hosting deals", sourceId: "s", capturedAt: new Date(T0.getTime() + 60_000) },
    list("hosting"),
    OK,
  );
  assert.equal(first.ok && first.signal.canonicalKey, afterRetry.ok && afterRetry.signal.canonicalKey);
});

test("an explicit window overrides the default, so a run controls its own bucket", () => {
  const a = emitSignal({ subject: "saas", sourceId: "s", capturedAt: T0, windowKey: "run-1" }, list("saas"), OK);
  const b = emitSignal({ subject: "saas", sourceId: "s", capturedAt: T0, windowKey: "run-2" }, list("saas"), OK);
  assert.notEqual(a.ok && a.signal.canonicalKey, b.ok && b.signal.canonicalKey);
});

// ─── AC-03 — rejections are countable ─────────────────────────────

test("AC-03: rejecting everything and rejecting nothing are distinguishable", () => {
  const mk = (subject: string): { verdict: EmitVerdict; outcome: "OK" } => ({
    verdict: emitSignal({ subject, sourceId: "s", capturedAt: T0 }, list("ai tools"), OK),
    outcome: "OK",
  });

  const allRejected = tallyRun([mk("crochet"), mk("gardening"), mk("baking")]);
  const noneRejected = tallyRun([mk("ai tools a"), mk("ai tools b")]);

  assert.equal(allRejected.emitted, 0);
  assert.equal(totalRejected(allRejected), 3);
  assert.equal(noneRejected.emitted, 2);
  assert.equal(totalRejected(noneRejected), 0);

  // Both leave an empty-ish queue; only the tally says which is healthy.
  assert.notDeepEqual(allRejected.rejected, noneRejected.rejected);
});

test("AC-03: the tally records provider outcomes too, so a dead connector shows", () => {
  const t = tallyRun([
    { verdict: emitSignal({ subject: "ai tools", sourceId: "s", capturedAt: T0 }, list("ai tools"), OK), outcome: "OK" },
    { verdict: { ok: false, reason: "PROVIDER_PROVIDER_ERROR", subject: "x" }, outcome: "PROVIDER_ERROR" },
    { verdict: { ok: false, reason: "PROVIDER_NO_DATA", subject: "y" }, outcome: "NO_DATA" },
  ]);
  assert.equal(t.providerOutcomes.PROVIDER_ERROR, 1);
  assert.equal(t.providerOutcomes.NO_DATA, 1);
  assert.equal(t.emitted, 1);
});

test("AC-03: a deduplicated signal is counted apart from an emitted one", () => {
  const v = emitSignal({ subject: "ai tools", sourceId: "s", capturedAt: T0 }, list("ai tools"), OK);
  const t = tallyRun([{ verdict: v, outcome: "OK", duplicate: true }]);
  assert.equal(t.emitted, 0, "a duplicate is not a new signal");
  assert.equal(t.deduplicated, 1);
});

// ─── Freshness reuses the existing policy ─────────────────────────

test("no new staleness constant: the TTL comes from the P2-R05 claim policy", () => {
  assert.equal(trendTtlDays(), claimTtlDays("availability"));

  const src = readFileSync(join(process.cwd(), "src/lib/content/trend-radar-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // The shape a new hard-coded duration would take.
  assert.equal(
    /\b\d{2,}\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(src.replace("trendTtlDays() * 24 * 60 * 60 * 1000", "")),
    false,
    "the radar must not introduce its own stale duration",
  );
});

test("an unknown capture time is stale, not fresh", () => {
  assert.equal(isTrendStale(null, T0), true);
  assert.equal(isTrendStale(new Date("nope"), T0), true);
  assert.equal(isTrendStale(T0, T0), false);
});

// ─── AC-06 / AC-07 — what the radar may do, and retries ───────────

test("AC-06: the action vocabulary cannot express creating an opportunity", () => {
  for (const banned of ["CREATE_OPPORTUNITY", "CREATE_PROJECT", "WRITE_CONTENT", "PUBLISH", "SCORE"]) {
    assert.equal(
      (RADAR_ACTIONS as readonly string[]).includes(banned),
      false,
      `${banned} must not be expressible`,
    );
  }
  assert.deepEqual([...RADAR_ACTIONS].sort(), [
    "EMIT_SIGNAL",
    "NONE",
    "RECORD_REJECTION",
    "SKIP_DUPLICATE",
  ]);
});

test("AC-06: the module reaches no opportunity, project, publisher or scorer", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/content/trend-radar-policy.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
  assert.ok(specs.length > 0, "parsed no imports -- the guard would be vacuous");

  const bad = specs.filter((s) => /opportunity-content|opportunity-scoring|wordpress\/client|publish|\/aff\b/i.test(s));
  assert.deepEqual(bad, [], `the radar must not reach: ${bad.join(", ")}`);

  // And it must not compute a score of its own -- P2-R03 owns that (AC: the
  // radar must not bypass the scoring engine).
  assert.equal(/scoreOpportunity|overallScore|opportunityScore/.test(src), false);
});

test("AC-07: retries reuse the P1-R05 state machine rather than a second one", () => {
  const d = decideFetchRetry({ retryable: true, attemptsMade: 1, now: T0 });
  assert.equal(d.action, "RETRY");
  const stop = decideFetchRetry({ retryable: false, attemptsMade: 1, now: T0 });
  assert.equal(stop.action, "FAIL_PERMANENT");

  const src = readFileSync(join(process.cwd(), "src/lib/content/trend-radar-policy.ts"), "utf8");
  assert.ok(src.includes("decideRetry"), "AC-07: reuse, not a second policy");
});

// ─── The seed list ────────────────────────────────────────────────

test("the seed list is the one PROPOSED §3 names", () => {
  for (const t of ["ai tools", "saas", "seo", "affiliate", "hosting"]) {
    assert.ok(ALLOWLIST_SEED.includes(t), `${t} missing from the seed`);
  }
  assert.ok(ALLOWLIST_SEED.length >= 10);
});

// ─── AC-09 CONTROL ────────────────────────────────────────────────

test("AC-09 CONTROL: in-scope accepted and out-of-scope rejected in the SAME run", () => {
  // The control the AC asks for: a suite that only ever rejected would look
  // identical to a radar that rejects everything.
  const allow = list("ai tools");
  const results = [
    { verdict: emitSignal({ subject: "ai tools weekly", sourceId: "s", capturedAt: T0 }, allow, OK), outcome: "OK" as const },
    { verdict: emitSignal({ subject: "sourdough", sourceId: "s", capturedAt: T0 }, allow, OK), outcome: "OK" as const },
  ];
  const t = tallyRun(results);
  assert.equal(t.emitted, 1, "the in-scope one must be accepted");
  assert.equal(totalRejected(t), 1, "the out-of-scope one must be rejected");
});

test("CONTROL: every provider outcome is reachable from the classifier", () => {
  const reachable = new Set([
    classifyProviderResult({ failed: true }).outcome,
    classifyProviderResult({ failed: false, rows: 0 }).outcome,
    classifyProviderResult({ failed: false, rows: null }).outcome,
    classifyProviderResult({ failed: false, rows: 3 }).outcome,
  ]);
  assert.equal(reachable.size, 4);
  for (const o of reachable) assert.ok((PROVIDER_OUTCOMES as readonly string[]).includes(o));
});
