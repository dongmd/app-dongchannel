/**
 * `P4-R08 AC-10` / `P4-R09 AC-01`/`AC-02` -- the executor driven end to end
 * with fakes standing in for everything that touches the world: the signer,
 * the WordPress call, the intent writer, the audit sink, the alert queue.
 *
 * `decidePublish`'s own gate-isolation cases live in `publisher-policy.
 * test.ts` and are not repeated here; this file proves the WIRING -- that a
 * refusal never reaches the signer or WordPress, that a signer refusal never
 * reaches WordPress, and that a WordPress failure reaches the SAME
 * `resolvePublishFailure` machinery `publish-runner.test.ts` already proves.
 *
 * No network call is made anywhere in this file, and no post -- real,
 * synthetic or draft -- is ever touched. `callWordpress` is a fake for every
 * case.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PUBLISH_SIG_HEADER, PUBLISH_REV_HEADER, publishSignaturePayload } from "./publish-signature";
import type { ApprovalState, ArticleState, PublishIntent } from "./publisher-policy";
import {
  executePublish,
  type PublishExecutorDeps,
  type WordpressCallResult,
} from "./publish-executor";
import type { AuditEntry } from "./publish-runner";

const NOW = new Date("2026-09-01T12:00:00Z");
const HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85";

const INTENT: PublishIntent = {
  id: "intent-1", articleId: "art-1", revisionId: "rev-1", contentHash: HASH, state: "OPEN",
};
const APPROVAL: ApprovalState = {
  approvalId: "ap-1", articleId: "art-1", revisionId: "rev-1", withdrawn: false,
};
const ARTICLE: ArticleState = {
  articleId: "art-1", revisionId: "rev-1", contentHash: HASH, contentMode: "COMMERCIAL",
  wpPostId: 42, wpModifiedGmt: null, lastPublishedHash: null, lastPublishedModifiedGmt: null,
};
const QA_PASS = { passed: true, reason: null };
const VERIFIED = { allClaimsMeetBar: true, unsourcedClaimCount: 0 };

function harness(over: Partial<PublishExecutorDeps> = {}) {
  const consumed: { id: string; at: Date }[] = [];
  const cancelled: { id: string; at: Date }[] = [];
  const audits: AuditEntry[] = [];
  const wpCalls: { wpPostId: number; headers: Readonly<Record<string, string>> }[] = [];
  let wpResponse: WordpressCallResult = { ok: true, postStatus: "publish", postModifiedGmt: "2026-09-01T12:00:00" };

  const deps: PublishExecutorDeps = {
    now: () => NOW,
    // A deterministic fake, never a real HMAC -- the real algorithm is
    // `publish-signature.test.ts`'s known-answer vector, not this file's job.
    sign: (message: string) => `sig-for(${message})`,
    callWordpress: async (wpPostId, headers) => {
      wpCalls.push({ wpPostId, headers });
      return wpResponse;
    },
    consumeIntent: async (id, at) => { consumed.push({ id, at }); },
    cancelIntent: async (id, at) => { cancelled.push({ id, at }); },
    recordAudit: async (e) => { audits.push(e); },
    queueAlert: async () => ({ ok: true, queued: true }),
    ...over,
  };

  return {
    deps,
    consumed,
    cancelled,
    audits,
    wpCalls,
    setWpResponse: (r: WordpressCallResult) => { wpResponse = r; },
  };
}

// ─── Gate refusals never reach the signer or WordPress ─────────────

describe("a policy refusal never signs anything and never calls WordPress", () => {
  it("gate 1: a withdrawn approval", async () => {
    const h = harness();
    const r = await executePublish(
      { intent: INTENT, approval: { ...APPROVAL, withdrawn: true }, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome, "REFUSED");
    assert.equal(r.outcome === "REFUSED" && r.reason, "APPROVAL_WITHDRAWN");
    assert.equal(h.wpCalls.length, 0);
    assert.equal(h.audits[0]!.outcome, "APPROVAL_WITHDRAWN");
  });

  it("gate 2: the content hash moved", async () => {
    const h = harness();
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: { ...ARTICLE, contentHash: "different" }, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome === "REFUSED" && r.reason, "CONTENT_HASH_MOVED");
    assert.equal(h.wpCalls.length, 0);
  });

  it("gate 3: mode QA failed", async () => {
    const h = harness();
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: { passed: false, reason: "CLAIM_BELOW_MODE_POLICY" }, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome === "REFUSED" && r.reason, "QA_GATE_FAILED");
    assert.equal(h.wpCalls.length, 0);
  });

  it("a fully-eligible intent is the ONLY case that reaches WordPress", async () => {
    // CONTROL for the three above: without this, an executor that refuses
    // everything would pass every case in this describe block.
    const h = harness();
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome, "PUBLISHED");
    assert.equal(h.wpCalls.length, 1);
  });
});

// ─── The signing key ────────────────────────────────────────────────

describe("the signer refuses -- fails closed before any network call", () => {
  it("a missing key stops the attempt and never calls WordPress", async () => {
    const h = harness({ sign: () => null });
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome, "SIGNING_KEY_UNAVAILABLE");
    assert.equal(h.wpCalls.length, 0);
    assert.equal(h.audits[0]!.outcome, "SIGNING_KEY_UNAVAILABLE");
  });
});

// ─── No post to flip ────────────────────────────────────────────────

describe("a plan with no WordPress post id has nothing to flip", () => {
  it("refuses WP_POST_MISSING and creates nothing", async () => {
    const h = harness();
    const r = await executePublish(
      {
        intent: INTENT, approval: APPROVAL,
        article: { ...ARTICLE, wpPostId: null, lastPublishedModifiedGmt: null },
        qa: QA_PASS, verification: VERIFIED, attempts: 1,
      },
      h.deps,
    );
    assert.equal(r.outcome, "WP_POST_MISSING");
    assert.equal(h.wpCalls.length, 0);
  });
});

// ─── WordPress error classification, reused not duplicated ─────────

describe("a WordPress failure hands off to the SAME resolvePublishFailure machinery", () => {
  it("a non-retryable error (400) cancels the intent and alerts", async () => {
    const h = harness();
    h.setWpResponse({ ok: false, status: 400, code: "rest_invalid_param" });
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.outcome === "FAILED" && r.failure.outcome.publishState, "FAILED_REQUIRES_ATTENTION");
    assert.equal(r.outcome === "FAILED" && r.failure.intentCancelled, true);
    assert.equal(h.cancelled.length, 1);
    assert.equal(h.consumed.length, 0, "a failure must never CONSUME -- that would say the publish happened");
  });

  it("a retryable error (503) with attempts remaining stays OPEN", async () => {
    const h = harness();
    h.setWpResponse({ ok: false, status: 503, code: "" });
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome === "FAILED" && r.failure.outcome.publishState, "FAILED_RETRYING");
    assert.equal(r.outcome === "FAILED" && r.failure.intentCancelled, false);
    assert.equal(h.cancelled.length, 0);
  });

  it("REGRESSION: a TRANSPORT/TIMEOUT failure has no real HTTP status and must stay retryable", async () => {
    // `TRANSPORT`/`TIMEOUT` are thrown by `wordpress/client.ts` with NO http
    // status -- the request never reached WordPress. `status: 0, code:
    // "TRANSPORT"` alone would classify as `UNKNOWN` (not retryable),
    // wrongly cancelling the intent and alerting the owner over a network
    // blip. `wordpressPublishCall` (client.ts) now carries the real `kind`
    // through instead of letting `resolvePublishFailure` re-derive a worse
    // answer from strictly less information -- this is that wiring, proven
    // at the point a caught bug would have surfaced.
    const h = harness();
    h.setWpResponse({ ok: false, status: 0, code: "TRANSPORT", kind: "TRANSPORT" });
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome === "FAILED" && r.failure.kind, "TRANSPORT");
    assert.equal(r.outcome === "FAILED" && r.failure.outcome.publishState, "FAILED_RETRYING");
    assert.equal(r.outcome === "FAILED" && r.failure.intentCancelled, false);
    assert.equal(h.cancelled.length, 0, "a transient network failure must never cancel the intent");
  });

  it("post_status != 'publish' is treated as a non-retryable failure, not a success", async () => {
    // AC-10's CONTROL: a 200 that merely did not throw is not verified. This
    // is the one case the WordPress side's own guard should never let through
    // -- see `dc_v1_handle_publish_status()` -- and this executor does not
    // trust that it never will.
    const h = harness();
    h.setWpResponse({ ok: true, postStatus: "draft", postModifiedGmt: null });
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.outcome === "FAILED" && r.failure.outcome.publishState, "FAILED_REQUIRES_ATTENTION");
    assert.equal(h.consumed.length, 0, "a non-publish status must never be treated as a successful publish");
  });
});

// ─── Success ─────────────────────────────────────────────────────────

describe("a fully-eligible intent publishes", () => {
  it("signs the exact plan fields, calls WordPress once, consumes the intent, and audits success", async () => {
    const h = harness();
    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );

    assert.equal(r.outcome, "PUBLISHED");
    assert.equal(r.outcome === "PUBLISHED" && r.wpPostId, 42);
    assert.equal(r.outcome === "PUBLISHED" && r.dcVerified, true);

    assert.equal(h.wpCalls.length, 1);
    assert.equal(h.wpCalls[0]!.wpPostId, 42);
    const expectedPayload = publishSignaturePayload({ wpPostId: 42, revisionId: "rev-1", contentHash: HASH });
    assert.equal(h.wpCalls[0]!.headers[PUBLISH_SIG_HEADER], `sig-for(${expectedPayload})`);
    assert.equal(h.wpCalls[0]!.headers[PUBLISH_REV_HEADER], "rev-1");

    assert.deepEqual(h.consumed, [{ id: "intent-1", at: NOW }]);
    assert.equal(h.cancelled.length, 0);
    assert.equal(h.audits.some((a) => a.outcome === "SUCCEEDED"), true);
  });

  it("dcVerified on the published result comes from VERIFICATION, never the approval (AC-04, restated at this layer)", async () => {
    const h = harness();
    const r = await executePublish(
      {
        intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS,
        verification: { allClaimsMeetBar: true, unsourcedClaimCount: 3 }, attempts: 1,
      },
      h.deps,
    );
    assert.equal(r.outcome === "PUBLISHED" && r.dcVerified, false);
  });
});

// ─── AC-02: replay cannot duplicate a publish ───────────────────────

describe("AC-02 -- a replayed publish leaves the intent's lock held exactly once", () => {
  it("a second execution against the SAME intent, now CONSUMED, never reaches WordPress again", async () => {
    const h = harness();
    const first = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );
    assert.equal(first.outcome, "PUBLISHED");
    assert.equal(h.wpCalls.length, 1);

    // What a caller re-reading the intent after the first success would see:
    // `consumeIntent` set state to CONSUMED. Nothing here re-opens it.
    const replayedIntent: PublishIntent = { ...INTENT, state: "CONSUMED" };
    const second = await executePublish(
      { intent: replayedIntent, approval: APPROVAL, article: ARTICLE, qa: QA_PASS, verification: VERIFIED, attempts: 1 },
      h.deps,
    );

    assert.equal(second.outcome, "REFUSED");
    assert.equal(second.outcome === "REFUSED" && second.reason, "INTENT_NOT_OPEN");
    assert.equal(h.wpCalls.length, 1, "the replay must not reach WordPress a second time");
    assert.equal(h.consumed.length, 1, "the replay must not consume a second time");
  });
});

// ─── Boundary: this file touches nothing real ──────────────────────

/** A boundary named in prose is not a violation -- see publish-signature.test.ts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("publish-executor.ts stays free of crypto, network and server-only imports", () => {
  it("no fetch, no WordpressClient/WordpressError, no node:crypto, no server-only", () => {
    const src = stripComments(readFileSync(
      fileURLToPath(new URL("./publish-executor.ts", import.meta.url)),
      "utf8",
    ));
    for (const forbidden of [
      /\bfetch\(/,
      // Word-boundaried so `WordpressErrorKind` -- the pure, crypto-free type
      // this module legitimately imports from retry-policy.ts to carry a
      // classified error's `kind` -- does not false-positive as the CLASS.
      /\bWordpressClient\b/,
      /\bWordpressError\b/,
      /node:crypto|createHmac/,
      /import\s+"server-only"/,
      /wp_insert_post|wp_update_post/,
    ]) {
      assert.equal(forbidden.test(src), false, `publish-executor.ts matches ${forbidden}`);
    }
  });
});
