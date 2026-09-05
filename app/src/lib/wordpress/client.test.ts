/**
 * `P4-R08 AC-10` -- the WIRE FORMAT, and the first test in this repo that runs
 * the real `WordpressClient` at all.
 *
 * ## Why this file did not exist before, and what changed
 *
 * `client.ts` opens with `import "server-only"`, which throws outside a server
 * bundling context, so a plain `node:test` run could never import it. That is
 * why a code review found `publishStatus()` and `wordpressPublishCall()`
 * "hoàn toàn chưa có test" -- the wire format was guaranteed only by reading
 * the source.
 *
 * The `server-only` package resolves to an EMPTY module under the
 * `react-server` export condition, so `tsx --test --conditions=react-server`
 * (now in `package.json`) makes this file importable without weakening
 * anything: the boundary tests that matter -- `publish-executor.test.ts`'s and
 * `agent-boundary.test.ts`'s -- assert on SOURCE TEXT, not on import failure,
 * so they are unaffected. All 1121 pre-existing tests were re-run under the
 * flag before it was added.
 *
 * ## No network
 *
 * `globalThis.fetch` is stubbed, and restored after every case. That replaces
 * the socket and NOTHING else: the URL construction, the Basic-auth header,
 * the `extraHeaders` merge, the envelope parsing, the `WordpressError`
 * construction and `TD-21`'s classification are all the real code paths. No
 * request leaves this machine, and no post -- real or synthetic -- is touched.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { WordpressClient, WordpressError, wordpressPublishCall } from "./client";
import { executePublish, type PublishExecutorDeps } from "@/lib/publish/publish-executor";
import { PUBLISH_REV_HEADER, PUBLISH_SIG_HEADER } from "@/lib/publish/publish-signature";
import type { ApprovalState, ArticleState, PublishIntent } from "@/lib/publish/publisher-policy";
import type { AuditEntry } from "@/lib/publish/publish-runner";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const client = new WordpressClient({
  baseUrl: "https://wp.invalid/",   // trailing slash on purpose -- it must be stripped
  user: "dc_integration",
  password: "TEST-ONLY-never-a-real-application-password",
});

interface Captured { url: string; init: RequestInit }

/** Capture the outgoing request and answer with a canned envelope. */
function captureFetch(status: number, envelope: unknown): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(envelope), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls };
}

const OK_ENVELOPE = {
  data: { id: 42, post_status: "publish", post_modified_gmt: "2026-09-05 10:00:00", wp_content_hash: "v1:abc" },
  meta: { request_id: "req-1" },
  error: null,
};

const SIG_HEADERS = { [PUBLISH_SIG_HEADER]: "deadbeef", [PUBLISH_REV_HEADER]: "rev-1" };

// ─── The wire format ────────────────────────────────────────────────

describe("publishStatus -- what actually goes on the wire", () => {
  it("PATCHes the exact dc/v1 publish-status path, trailing slash stripped", async () => {
    const cap = captureFetch(200, OK_ENVELOPE);
    await client.publishStatus(42, SIG_HEADERS);

    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0]!.url, "https://wp.invalid/wp-json/dc/v1/articles/42/publish-status");
    assert.equal(cap.calls[0]!.init.method, "PATCH");
  });

  it("the signature headers travel VERBATIM -- WordPress reads these via $_SERVER", async () => {
    const cap = captureFetch(200, OK_ENVELOPE);
    await client.publishStatus(42, SIG_HEADERS);

    const h = cap.calls[0]!.init.headers as Record<string, string>;
    assert.equal(h[PUBLISH_SIG_HEADER], "deadbeef");
    assert.equal(h[PUBLISH_REV_HEADER], "rev-1");
  });

  it("sends NO body -- the authorisation decision is carried entirely by headers", async () => {
    // dc_v1_handle_publish_status() parses a body only to echo a revision_id.
    // Sending one would add a JSON content-type requirement for nothing.
    const cap = captureFetch(200, OK_ENVELOPE);
    await client.publishStatus(42, SIG_HEADERS);

    assert.equal(cap.calls[0]!.init.body, undefined);
    const h = cap.calls[0]!.init.headers as Record<string, string>;
    assert.equal(h["Content-Type"], undefined, "a content-type implies a body this route does not need");
  });

  it("still authenticates as the integration identity, and parses the envelope", async () => {
    const cap = captureFetch(200, OK_ENVELOPE);
    const r = await client.publishStatus(42, SIG_HEADERS);

    const h = cap.calls[0]!.init.headers as Record<string, string>;
    assert.match(h["Authorization"]!, /^Basic /, "the signed exception does not replace authentication");
    assert.equal(r.postStatus, "publish");
    assert.equal(r.id, 42);
  });

  it("a signature refusal surfaces as a classified WordpressError, not a silent success", async () => {
    captureFetch(403, { data: null, error: { code: "PUBLISH_SIGNATURE_INVALID", message: "Missing or invalid publish signature." } });

    await assert.rejects(
      () => client.publishStatus(42, SIG_HEADERS),
      (err: unknown) => {
        assert.ok(err instanceof WordpressError);
        assert.equal(err.code, "PUBLISH_SIGNATURE_INVALID");
        assert.equal(err.kind, "FORBIDDEN");
        assert.equal(err.retryable, false, "a bad signature must never be retried");
        return true;
      },
    );
  });
});

// ─── The flattening the code review found broken ───────────────────

describe("wordpressPublishCall -- the real kind survives the flattening", () => {
  it("REGRESSION: a network failure is TRANSPORT and stays RETRYABLE", async () => {
    // The bug: this used to return only {status, code}. TRANSPORT has no HTTP
    // status, so classifyWordpressError(0, "TRANSPORT") answered UNKNOWN --
    // not retryable -- and a network blip cancelled the publish intent.
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

    const r = await wordpressPublishCall(client)(42, SIG_HEADERS);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "TRANSPORT");
      assert.equal(r.status, 0, "TRANSPORT genuinely has no HTTP status to report");
    }
  });

  it("REGRESSION: an aborted request is TIMEOUT and stays RETRYABLE", async () => {
    globalThis.fetch = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;

    const r = await wordpressPublishCall(client)(42, SIG_HEADERS);
    assert.equal(r.ok === false && r.kind, "TIMEOUT");
  });

  it("a 5xx is SERVER, a 403 is FORBIDDEN -- the classifier is not answering one way", async () => {
    captureFetch(503, { data: null, error: { code: "SERVICE_UNAVAILABLE", message: "down" } });
    const five = await wordpressPublishCall(client)(42, SIG_HEADERS);
    assert.equal(five.ok === false && five.kind, "SERVER");

    captureFetch(403, { data: null, error: { code: "PUBLISH_SIGNATURE_INVALID", message: "nope" } });
    const four = await wordpressPublishCall(client)(42, SIG_HEADERS);
    assert.equal(four.ok === false && four.kind, "FORBIDDEN");
  });
});

// ─── The whole chain, real client included ─────────────────────────

const INTENT: PublishIntent = {
  id: "intent-1", articleId: "art-1", revisionId: "rev-1", contentHash: "hash-1", state: "OPEN",
};
const APPROVAL: ApprovalState = {
  approvalId: "ap-1", articleId: "art-1", revisionId: "rev-1", withdrawn: false,
};
const ARTICLE: ArticleState = {
  articleId: "art-1", revisionId: "rev-1", contentHash: "hash-1", contentMode: "COMMERCIAL",
  wpPostId: 42, wpModifiedGmt: null, lastPublishedHash: null, lastPublishedModifiedGmt: null,
};

function chainDeps(over: Partial<PublishExecutorDeps> = {}) {
  const consumed: string[] = [];
  const cancelled: string[] = [];
  const audits: AuditEntry[] = [];
  const deps: PublishExecutorDeps = {
    now: () => new Date("2026-09-05T12:00:00Z"),
    sign: (m) => `sig(${m})`,
    // THE REAL ADAPTER over THE REAL CLIENT -- only the socket is stubbed.
    callWordpress: wordpressPublishCall(client),
    consumeIntent: async (id) => { consumed.push(id); },
    cancelIntent: async (id) => { cancelled.push(id); },
    recordAudit: async (e) => { audits.push(e); },
    queueAlert: async () => ({ ok: true, queued: true }),
    ...over,
  };
  return { deps, consumed, cancelled, audits };
}

describe("executePublish through the REAL client -- end to end but for the socket", () => {
  it("an eligible intent signs, PATCHes, and consumes the intent", async () => {
    const cap = captureFetch(200, OK_ENVELOPE);
    const h = chainDeps();

    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: { passed: true, reason: null },
        verification: { allClaimsMeetBar: true, unsourcedClaimCount: 0 }, attempts: 1 },
      h.deps,
    );

    assert.equal(r.outcome, "PUBLISHED");
    assert.equal(cap.calls.length, 1, "exactly one request reached the wire");
    assert.equal(cap.calls[0]!.url, "https://wp.invalid/wp-json/dc/v1/articles/42/publish-status");

    // The signature that actually travelled was computed over the real payload.
    const sent = (cap.calls[0]!.init.headers as Record<string, string>)[PUBLISH_SIG_HEADER];
    assert.equal(sent, "sig(42.rev-1.hash-1)");
    assert.deepEqual(h.consumed, ["intent-1"]);
  });

  it("REGRESSION, full chain: a network blip retries and does NOT cancel the intent", async () => {
    // This is the bug the code review caught, proven at the level it would
    // actually have bitten: a real client, a real adapter, a real classifier.
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const h = chainDeps();

    const r = await executePublish(
      { intent: INTENT, approval: APPROVAL, article: ARTICLE, qa: { passed: true, reason: null },
        verification: { allClaimsMeetBar: true, unsourcedClaimCount: 0 }, attempts: 1 },
      h.deps,
    );

    assert.equal(r.outcome, "FAILED");
    assert.equal(r.outcome === "FAILED" && r.failure.kind, "TRANSPORT");
    assert.equal(r.outcome === "FAILED" && r.failure.outcome.publishState, "FAILED_RETRYING");
    assert.deepEqual(h.cancelled, [], "a transient network failure must not burn the intent");
    assert.deepEqual(h.consumed, [], "and must certainly not claim the publish happened");
  });

  it("a refused gate never reaches the wire at all", async () => {
    const cap = captureFetch(200, OK_ENVELOPE);
    const h = chainDeps();

    const r = await executePublish(
      { intent: INTENT, approval: { ...APPROVAL, withdrawn: true }, article: ARTICLE,
        qa: { passed: true, reason: null },
        verification: { allClaimsMeetBar: true, unsourcedClaimCount: 0 }, attempts: 1 },
      h.deps,
    );

    assert.equal(r.outcome, "REFUSED");
    assert.equal(cap.calls.length, 0, "a withdrawn approval must not produce a request");
  });
});
