import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideArticleSync,
  hashContractVersionOf,
  HASH_CONTRACT_VERSION,
  isDivergence,
  PERMITTING_STATES,
  type ArticleBaseline,
  type ArticleObservation,
} from "./article-guard-policy";

// P1-R06 AC-04 … AC-14.
//
// PROPOSED §7A: there is no silent overwrite path for WordPress prose. The
// property under test is not "the happy path works" — it is that everything
// which is not the happy path refuses.

const HASH_A = "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TIME_A = "2026-08-19T10:00:00+00:00";
const TIME_B = "2026-08-19T11:30:00+00:00";

function baseline(over: Partial<ArticleBaseline> = {}): ArticleBaseline {
  return {
    state: "BASELINE_SET",
    wpContentHash: HASH_A,
    wpPostModifiedGmt: TIME_A,
    wpPostStatus: "publish",
    hashContractVersion: "v1",
    ...over,
  };
}

function observed(over: Partial<ArticleObservation> = {}): ArticleObservation {
  return {
    wpContentHash: HASH_A,
    postModifiedGmt: TIME_A,
    postStatus: "publish",
    ...over,
  };
}

function refusalOf(b: ArticleBaseline | null, o: ArticleObservation) {
  const d = decideArticleSync(b, o);
  assert.equal(d.decision, "REFUSE", `expected REFUSE, got ${d.decision}`);
  return d.decision === "REFUSE" ? d.reason : "";
}

// ── AC-04 · the one path that is allowed ─────────────────────────────────

test("AC-04: hash and post_modified_gmt both unchanged -> ALLOW", () => {
  const d = decideArticleSync(baseline(), observed());
  assert.equal(d.decision, "ALLOW");
  if (d.decision === "ALLOW") {
    assert.equal(d.wpContentHash, HASH_A);
    assert.equal(d.postModifiedGmt, TIME_A);
  }
});

test("CONTROL: the fixtures agree, so every refusal below is caused by the one thing changed", () => {
  // Without this, a refusal could come from a fixture that never matched.
  assert.equal(decideArticleSync(baseline(), observed()).decision, "ALLOW");
});

// ── AC-06 · both checks required, not either ─────────────────────────────

test("AC-06: a changed hash alone refuses", () => {
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: HASH_B })), "CONTENT_CHANGED");
});

test("AC-06: a changed post_modified_gmt alone refuses", () => {
  assert.equal(refusalOf(baseline(), observed({ postModifiedGmt: TIME_B })), "MODIFIED_CHANGED");
});

test("AC-06: both changed refuses", () => {
  const r = refusalOf(baseline(), observed({ wpContentHash: HASH_B, postModifiedGmt: TIME_B }));
  assert.ok(r === "CONTENT_CHANGED" || r === "MODIFIED_CHANGED", `unexpected reason ${r}`);
});

// ── AC-07 · conflict ─────────────────────────────────────────────────────

test("AC-07: content edited in WordPress refuses with CONTENT_CHANGED", () => {
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: HASH_B })), "CONTENT_CHANGED");
});

// ── AC-08 · missing baseline ─────────────────────────────────────────────

test("AC-08: no baseline row refuses", () => {
  assert.equal(refusalOf(null, observed()), "NO_BASELINE");
  assert.equal(refusalOf(undefined as unknown as null, observed()), "NO_BASELINE");
});

test("AC-08: absence is not agreement even when WordPress looks pristine", () => {
  // The observation here is exactly what a matching baseline would hold. The
  // point is that "nothing recorded" must not be read as "nothing changed".
  assert.equal(refusalOf(null, observed()), "NO_BASELINE");
});

// ── AC-09 · unknown is never unchanged ───────────────────────────────────

test("AC-09: a null post_modified_gmt from WordPress refuses", () => {
  assert.equal(refusalOf(baseline(), observed({ postModifiedGmt: null })), "UNKNOWN_TIMESTAMP");
});

test("AC-09: a null timestamp refuses even when the hash matches", () => {
  // This is the case R07 found in production: drafts had an unusable GMT
  // column. A guard that compared only the hash would have said ALLOW.
  assert.equal(
    refusalOf(baseline(), observed({ wpContentHash: HASH_A, postModifiedGmt: null })),
    "UNKNOWN_TIMESTAMP",
  );
});

test("AC-09: a missing or blank hash refuses, from either side", () => {
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: null })), "UNKNOWN_HASH");
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: "" })), "UNKNOWN_HASH");
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: "   " })), "UNKNOWN_HASH");
  assert.equal(refusalOf(baseline({ wpContentHash: null }), observed()), "UNKNOWN_HASH");
});

test("AC-09: a baseline with no timestamp refuses", () => {
  assert.equal(refusalOf(baseline({ wpPostModifiedGmt: null }), observed()), "UNKNOWN_TIMESTAMP");
});

test("AC-09: two nulls are not a match", () => {
  // The trap: null === null is true in JavaScript. It must not mean agreement.
  assert.equal(
    refusalOf(baseline({ wpPostModifiedGmt: null }), observed({ postModifiedGmt: null })),
    "UNKNOWN_TIMESTAMP",
  );
  assert.equal(
    refusalOf(baseline({ wpContentHash: null }), observed({ wpContentHash: null })),
    "UNKNOWN_HASH",
  );
});

// ── AC-10 · version mismatch ─────────────────────────────────────────────

test("AC-10: a hash with no version prefix refuses", () => {
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: "deadbeef" })), "CONTRACT_MISMATCH");
});

test("AC-10: a hash from a future contract refuses", () => {
  const future = "v2:aaaa";
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: future })), "CONTRACT_MISMATCH");
});

test("AC-10: a baseline taken under a different contract refuses", () => {
  assert.equal(refusalOf(baseline({ hashContractVersion: "v0" }), observed()), "CONTRACT_MISMATCH");
});

test("AC-10: a version-shaped string with nothing after the colon is not a hash", () => {
  assert.equal(hashContractVersionOf("v1:"), null);
  assert.equal(refusalOf(baseline(), observed({ wpContentHash: "v1:" })), "CONTRACT_MISMATCH");
});

test("AC-10: hashContractVersionOf reads the prefix and nothing else", () => {
  assert.equal(hashContractVersionOf(HASH_A), "v1");
  assert.equal(hashContractVersionOf(null), null);
  assert.equal(hashContractVersionOf(":abc"), null);
  assert.equal(hashContractVersionOf("nocolon"), null);
  assert.equal(HASH_CONTRACT_VERSION, "v1");
});

// ── AC-11 · unexpected state, by construction ────────────────────────────

test("AC-11: only BASELINE_SET permits a write", () => {
  assert.deepEqual([...PERMITTING_STATES], ["BASELINE_SET"]);
});

test("AC-11: a state nobody enumerated refuses", () => {
  for (const state of ["", "PENDING", "SYNCED", "RESOLVED", "OK", "ALLOW", "baseline_set"]) {
    assert.equal(
      refusalOf(baseline({ state }), observed()),
      "UNEXPECTED_STATE",
      `state ${JSON.stringify(state)} must not permit a write`,
    );
  }
});

test("AC-11: a state added to the enum later refuses until it is allowlisted", () => {
  // The property, stated directly: adding a value to wp_article_sync_state does
  // not make it a write path.
  assert.equal(refusalOf(baseline({ state: "SOME_FUTURE_STATE" }), observed()), "UNEXPECTED_STATE");
});

test("AC-11: a missing post status where the baseline had one refuses", () => {
  assert.equal(refusalOf(baseline(), observed({ postStatus: null })), "UNEXPECTED_STATE");
});

// ── AC-13 · status changed ───────────────────────────────────────────────

test("AC-13: a post that changed status refuses even with an identical hash", () => {
  assert.equal(refusalOf(baseline(), observed({ postStatus: "draft" })), "STATUS_CHANGED");
});

// ── AC-14 · a conflict does not expire ───────────────────────────────────

test("AC-14: a recorded conflict refuses even once WordPress matches again", () => {
  // The owner edited, then undid the edit. The hash agrees again, but the
  // conflict has not been resolved, so the guard stays shut.
  assert.equal(refusalOf(baseline({ state: "CONFLICT" }), observed()), "EXISTING_CONFLICT");
});

// ── The shape of the decision itself ─────────────────────────────────────

test("no combination of the enumerated inputs produces ALLOW except the clean one", () => {
  // A small exhaustive sweep. 2 states x 3 hashes x 3 timestamps x 3 statuses,
  // and exactly one cell may be ALLOW.
  const states = ["BASELINE_SET", "CONFLICT"];
  const hashes = [HASH_A, HASH_B, null];
  const times = [TIME_A, TIME_B, null];
  const statuses = ["publish", "draft", null];

  let allowed = 0;

  for (const state of states) {
    for (const h of hashes) {
      for (const t of times) {
        for (const st of statuses) {
          const d = decideArticleSync(
            baseline({ state }),
            { wpContentHash: h, postModifiedGmt: t, postStatus: st },
          );
          if (d.decision === "ALLOW") {
            allowed += 1;
            assert.equal(state, "BASELINE_SET");
            assert.equal(h, HASH_A);
            assert.equal(t, TIME_A);
            assert.equal(st, "publish");
          }
        }
      }
    }
  }

  assert.equal(allowed, 1, `expected exactly one ALLOW across the sweep, got ${allowed}`);
});

test("divergence is distinguished from the other refusals", () => {
  // Only these three describe WordPress having moved, and only these are worth
  // recording as conflict context.
  for (const r of ["CONTENT_CHANGED", "MODIFIED_CHANGED", "STATUS_CHANGED"] as const) {
    assert.equal(isDivergence(r), true);
  }
  for (const r of ["NO_BASELINE", "UNKNOWN_HASH", "UNKNOWN_TIMESTAMP", "CONTRACT_MISMATCH",
                   "UPSTREAM_UNAVAILABLE", "NOT_FOUND", "UNEXPECTED_STATE", "EXISTING_CONFLICT"] as const) {
    assert.equal(isDivergence(r), false);
  }
});
