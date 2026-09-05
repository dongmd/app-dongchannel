/**
 * `P4-R08 AC-10` — the worker that turns an approved intent into a real
 * publish, driven end to end with fakes for the five things that touch the
 * world: the claim, the WordPress read, the WordPress write, the record store
 * and the clock.
 *
 * The REAL `executePublish`, the REAL `decidePublish` and the REAL
 * `rawSha256FromWpHash` run in every case below. What is faked is I/O, never a
 * decision — so a gate that stopped working would fail here.
 *
 * No network call, and no post is touched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rawSha256FromWpHash } from "@/lib/wordpress/article-guard-policy";
import { publishIdempotencyKey } from "./idempotency-policy";
import { articleWpPostId, runPublishOnce, type IntentRow, type PublishWorkerDeps } from "./publish-worker";
import type { AuditEntry } from "./publish-runner";

const NOW = new Date("2026-09-05T12:00:00Z");
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const DEST = "wordpress:dongchannel.com";

const INTENT: IntentRow = {
  id: "intent-1",
  approvalId: "ap-1",
  articleId: "8191",
  revisionId: "rev-1",
  payloadHash: HASH,
  destination: DEST,
  state: "OPEN",
};

interface Harness {
  deps: PublishWorkerDeps;
  wpCalls: number[];
  audits: AuditEntry[];
  consumed: string[];
  cancelled: string[];
  success: { key: string; wpPostId: number; publishedHash: string }[];
  failure: { key: string; state: string; kind: string }[];
}

function harness(over: Partial<PublishWorkerDeps> = {}, intent: IntentRow | null = INTENT): Harness {
  const wpCalls: number[] = [];
  const audits: AuditEntry[] = [];
  const consumed: string[] = [];
  const cancelled: string[] = [];
  const success: { key: string; wpPostId: number; publishedHash: string }[] = [];
  const failure: { key: string; state: string; kind: string }[] = [];
  let claimed = false;

  const deps: PublishWorkerDeps = {
    now: () => NOW,
    sign: (m) => `sig(${m})`,
    callWordpress: async (wpPostId) => {
      wpCalls.push(wpPostId);
      return { ok: true, postStatus: "publish", postModifiedGmt: "2026-09-05 12:00:00" };
    },
    claimIntent: async () => {
      if (claimed || !intent) return null;
      claimed = true;
      return intent;
    },
    loadApproval: async (articleId, revisionId) => ({
      approvalId: "ap-1", articleId, revisionId, withdrawn: false,
    }),
    observeArticle: async (wpPostId) => ({
      id: wpPostId,
      postStatus: "draft",
      postModifiedGmt: "2026-09-04 09:00:00",
      // The READ contract's form: 'v1:' + the same sha256 the signature uses.
      wpContentHash: `v1:${HASH}`,
    }),
    loadPublishRecord: async () => null,
    beginAttempt: async () => 1,
    recordSuccess: async (key, o) => { success.push({ key, wpPostId: o.wpPostId, publishedHash: o.publishedHash }); },
    recordFailure: async (key, o) => { failure.push({ key, state: o.state, kind: o.kind }); },
    loadQaVerdict: async () => ({ passed: true, reason: null }),
    loadVerification: async () => ({ allClaimsMeetBar: true, unsourcedClaimCount: 0 }),
    consumeIntent: async (id) => { consumed.push(id); },
    cancelIntent: async (id) => { cancelled.push(id); },
    recordAudit: async (e) => { audits.push(e); },
    queueAlert: async () => ({ ok: true, queued: true }),
    ...over,
  };

  return { deps, wpCalls, audits, consumed, cancelled, success, failure };
}

// ─── Article identity ──────────────────────────────────────────────

describe("articleWpPostId -- an article IS a WordPress post", () => {
  it("reads a positive integer id", () => {
    assert.equal(articleWpPostId("8191"), 8191);
    assert.equal(articleWpPostId("1"), 1);
  });

  it("refuses anything that would coerce into a broken request path", () => {
    // Number("abc") is NaN and Number("") is 0 -- both would reach the wire as
    // /articles/NaN/publish-status or /articles/0/publish-status.
    for (const bad of ["", "abc", "0", "-5", "1.5", " 12", "12 ", "0012", "1e3"]) {
      assert.equal(articleWpPostId(bad), null, `${JSON.stringify(bad)} was accepted`);
    }
  });
});

// ─── The two hashes ────────────────────────────────────────────────

describe("rawSha256FromWpHash -- the read hash and the signature hash", () => {
  it("strips the v1 prefix that dc_v1_content_hash adds", () => {
    assert.equal(rawSha256FromWpHash(`v1:${HASH}`), HASH);
  });

  it("fails closed on an unknown contract version, rather than signing a guess", () => {
    assert.equal(rawSha256FromWpHash(`v2:${HASH}`), null);
    assert.equal(rawSha256FromWpHash(HASH), null, "an unprefixed value is not a v1 read hash");
    assert.equal(rawSha256FromWpHash(null), null);
    assert.equal(rawSha256FromWpHash("v1:"), null);
  });

  it("refuses a v1 hash carrying something that is not a sha256 digest", () => {
    assert.equal(rawSha256FromWpHash("v1:nothex"), null);
    assert.equal(rawSha256FromWpHash(`v1:${"A".repeat(64)}`), null, "uppercase is not the PHP output form");
  });
});

// ─── Nothing to do ─────────────────────────────────────────────────

describe("an unclaimed queue is not an error", () => {
  it("reports IDLE and touches nothing", async () => {
    const h = harness({}, null);
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome, "IDLE");
    assert.equal(h.wpCalls.length, 0);
    assert.equal(h.audits.length, 0);
  });
});

// ─── Refusals that never reach WordPress ───────────────────────────

describe("the worker fails closed before the wire", () => {
  it("an article_id that is not a post id cancels the intent and never calls WordPress", async () => {
    const h = harness({}, { ...INTENT, articleId: "not-a-post" });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome, "UNREADABLE_ARTICLE_ID");
    assert.equal(h.wpCalls.length, 0);
    assert.deepEqual(h.cancelled, ["intent-1"]);
  });

  it("an article WordPress does not have cancels the intent", async () => {
    const h = harness({ observeArticle: async () => null });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome, "ARTICLE_NOT_FOUND");
    assert.equal(h.wpCalls.length, 0);
    assert.deepEqual(h.cancelled, ["intent-1"]);
  });

  it("an unreadable hash contract refuses but does NOT cancel -- consent survives a fault", async () => {
    // Cancelling here would discard the owner's approval over a contract
    // problem a fixed build would resolve.
    const h = harness({
      observeArticle: async (id) => ({ id, postStatus: "draft", postModifiedGmt: "x", wpContentHash: `v9:${HASH}` }),
    });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome, "HASH_CONTRACT_UNREADABLE");
    assert.equal(h.wpCalls.length, 0);
    assert.deepEqual(h.cancelled, [], "an unreadable hash must not burn the approval");
    assert.deepEqual(h.consumed, []);
  });
});

// ─── The gates still run, on LIVE state ────────────────────────────

describe("the gates are fed the article's CURRENT state, not the intent's copy", () => {
  it("content that moved since approval is refused -- the live hash is what gate 2 compares", async () => {
    // The intent still carries the approved hash; WordPress now reports a
    // different one. If the worker passed the intent's own hash through as the
    // article state, this would publish the wrong bytes and pass.
    const h = harness({
      observeArticle: async (id) => ({
        id, postStatus: "draft", postModifiedGmt: "x", wpContentHash: `v1:${OTHER_HASH}`,
      }),
    });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome, "EXECUTED");
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome, "REFUSED");
    assert.equal(
      r.outcome === "EXECUTED" && r.result.outcome === "REFUSED" && r.result.reason,
      "CONTENT_HASH_MOVED",
    );
    assert.equal(h.wpCalls.length, 0);
    assert.equal(h.failure[0]!.state, "FAILED_REQUIRES_ATTENTION");
  });

  it("a withdrawn approval is refused", async () => {
    const h = harness({ loadApproval: async () => null });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome === "REFUSED" && r.result.reason, "APPROVAL_MISSING");
    assert.equal(h.wpCalls.length, 0);
  });

  it("a QA record that does not say PASS is refused", async () => {
    const h = harness({ loadQaVerdict: async () => ({ passed: false, reason: "NO_QA_RECORD" }) });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome === "REFUSED" && r.result.reason, "QA_GATE_FAILED");
    assert.equal(h.wpCalls.length, 0);
  });
});

// ─── AC-02: the replay short-circuit ───────────────────────────────

describe("AC-02 -- a replay of an identical publish never writes twice", () => {
  it("an already-SUCCEEDED key with the same hash short-circuits before signing", async () => {
    const h = harness({
      loadPublishRecord: async () => ({
        wpPostId: 8191, publishedHash: HASH, wpModifiedGmt: "2026-09-05 12:00:00",
        attempts: 1, state: "SUCCEEDED",
      }),
    });
    const r = await runPublishOnce(h.deps);

    assert.equal(r.outcome, "ALREADY_PUBLISHED");
    assert.equal(h.wpCalls.length, 0, "a replay must not reach WordPress a second time");
    // The intent is still resolved -- it asked for a state the world is in.
    assert.deepEqual(h.consumed, ["intent-1"]);
    assert.equal(h.audits.some((a) => a.action === "PUBLISH_REPLAY_NOOP"), true);
  });

  it("CONTROL: a SUCCEEDED key whose content CHANGED is not short-circuited", async () => {
    // Without this, the case above would pass on a worker that skips every
    // publish for which any record exists.
    const h = harness({
      loadPublishRecord: async () => ({
        wpPostId: 8191, publishedHash: OTHER_HASH, wpModifiedGmt: "2026-09-05 12:00:00",
        attempts: 1, state: "SUCCEEDED",
      }),
    });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome, "EXECUTED");
  });

  it("the idempotency key is built by the one function, over the three components", async () => {
    const h = harness();
    await runPublishOnce(h.deps);
    assert.equal(h.success[0]!.key, publishIdempotencyKey("8191", "rev-1", DEST));
  });
});

// ─── The whole path ────────────────────────────────────────────────

describe("a fully-eligible intent publishes and the outcome is stored", () => {
  it("claims, signs the live hash, calls WordPress once, consumes, and records the post id", async () => {
    const h = harness();
    const r = await runPublishOnce(h.deps);

    assert.equal(r.outcome, "EXECUTED");
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome, "PUBLISHED");

    assert.deepEqual(h.wpCalls, [8191], "exactly one publish request, for the right post");
    assert.deepEqual(h.consumed, ["intent-1"], "AC-05: success consumes the intent");
    assert.deepEqual(h.cancelled, []);

    // AC-01: the resulting WordPress post id is STORED.
    assert.equal(h.success.length, 1);
    assert.equal(h.success[0]!.wpPostId, 8191);
    assert.equal(h.success[0]!.publishedHash, HASH);
  });

  it("AC-04: an unverified article still publishes, but unverified", async () => {
    const h = harness({
      loadVerification: async () => ({ allClaimsMeetBar: true, unsourcedClaimCount: 3 }),
    });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome, "PUBLISHED");
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome === "PUBLISHED" && r.result.dcVerified, false);
  });

  it("a WordPress answer that is not 'publish' is recorded as a failure, not a success", async () => {
    const h = harness({
      callWordpress: async () => ({ ok: true, postStatus: "draft", postModifiedGmt: null }),
    });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome, "FAILED");
    assert.equal(h.success.length, 0, "a non-publish status must never be stored as a publish");
    assert.equal(h.failure[0]!.state, "FAILED_REQUIRES_ATTENTION");
  });

  it("a transient network failure stays retryable and does not consume the intent", async () => {
    const h = harness({
      callWordpress: async () => ({ ok: false, status: 0, code: "TRANSPORT", kind: "TRANSPORT" }),
    });
    const r = await runPublishOnce(h.deps);
    assert.equal(r.outcome === "EXECUTED" && r.result.outcome, "FAILED");
    assert.equal(h.failure[0]!.state, "FAILED_RETRYING");
    assert.deepEqual(h.consumed, []);
    assert.deepEqual(h.cancelled, []);
  });
});
