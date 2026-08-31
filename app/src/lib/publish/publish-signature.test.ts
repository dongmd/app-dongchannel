/**
 * `P4-R08 AC-06`/`AC-10` — the Repo B signer matches the WordPress contract.
 *
 * `dc_core_publish_signature_valid()` in
 * `dongchannel-dot-com/wp-content/plugins/dc-core/includes/publish-exception.php`
 * is not reachable from this test suite -- there is no PHP runtime here, and
 * no live call is made to production or to any secret. Two things stand in
 * for it instead:
 *
 *   1. A KNOWN-ANSWER VECTOR. The expected hex signature below was computed
 *      independently with `openssl dgst -sha256 -hmac` AND with Node's own
 *      `createHmac`, off this file, for the fixed test key/payload -- not
 *      derived from the code under test. Matching it proves this module
 *      implements HMAC-SHA256 correctly, the same standard algorithm
 *      `hash_hmac('sha256', ...)` implements, rather than merely agreeing
 *      with itself.
 *   2. LIVE PRODUCTION CROSS-CHECK, recorded in the P4-R08 change plan
 *      report rather than here: the same key/payload/tamper/missing-key
 *      matrix was run once against the REAL `dc_core_publish_signature_valid()`
 *      on production, in-process only (`putenv()` inside one `wp eval`
 *      invocation, never written to a file), using this exact TEST key --
 *      never the production key, which does not exist yet.
 *
 * Every key in this file is a literal marked TEST -- never use it as a real
 * signing key.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

import {
  PUBLISH_REV_HEADER,
  PUBLISH_SIG_HEADER,
  publishSignaturePayload,
  signPublishRequest,
  type PublishSignatureInput,
  type Signer,
} from "./publish-signature";

const TEST_KEY = "test-key-do-not-use-in-production";
const OTHER_TEST_KEY = "a-different-test-key-never-in-prod";

const INPUT: PublishSignatureInput = {
  wpPostId: 42,
  revisionId: "rev-test-abc",
  contentHash: "deadbeefcafe1234",
};

/**
 * Independently computed offline with:
 *   printf '%s' "42.rev-test-abc.deadbeefcafe1234" \
 *     | openssl dgst -sha256 -hmac "test-key-do-not-use-in-production"
 * and cross-checked with `node -e "require('crypto').createHmac(...)"`.
 * Both agreed on this exact value before it was pasted here.
 */
const KNOWN_ANSWER =
  "7e66e28fc083e708c0b115cfd503dbd94db5b98c15983d339af974bfbf1d7ae1";

function testSigner(key: string | null): Signer {
  return (message: string) => {
    if (!key) return null;
    // A from-scratch HMAC, not imported from the module under test -- see the
    // boundary test below for why the module itself may not do this.
    return createHmac("sha256", key).update(message).digest("hex");
  };
}

describe("publishSignaturePayload — the exact string WordPress hashes", () => {
  it("dot-joins post id, revision and content hash, in that order", () => {
    assert.equal(publishSignaturePayload(INPUT), "42.rev-test-abc.deadbeefcafe1234");
  });

  it("applies no encoding to any field", () => {
    // PHP does `$post_id . '.' . $rev . '.' . $content_hash` -- a bare
    // concatenation. Anything here that percent-encodes or base64s a field
    // would produce a payload WordPress never computes.
    const withDots: PublishSignatureInput = {
      wpPostId: 7,
      revisionId: "rev.with.dots",
      contentHash: "hash",
    };
    assert.equal(publishSignaturePayload(withDots), "7.rev.with.dots.hash");
  });
});

describe("signPublishRequest — the known-answer vector", () => {
  it("matches an independently computed HMAC-SHA256, not just its own algorithm", () => {
    const result = signPublishRequest(INPUT, testSigner(TEST_KEY));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.headers[PUBLISH_SIG_HEADER], KNOWN_ANSWER);
    }
  });

  it("sends the exact header names WordPress reads via $_SERVER", () => {
    const result = signPublishRequest(INPUT, testSigner(TEST_KEY));
    assert.equal(result.ok, true);
    assert.equal(PUBLISH_SIG_HEADER, "X-DC-Publish-Signature");
    assert.equal(PUBLISH_REV_HEADER, "X-DC-Publish-Revision");
    if (result.ok) {
      assert.equal(result.headers[PUBLISH_REV_HEADER], "rev-test-abc");
      assert.equal(Object.keys(result.headers).length, 2, "no extra header leaks in");
    }
  });
});

describe("signPublishRequest — the same four cases the owner asked to see proven", () => {
  it("1. same payload + same key -> a verifiable signature (the known-answer match above)", () => {
    const a = signPublishRequest(INPUT, testSigner(TEST_KEY));
    const b = signPublishRequest(INPUT, testSigner(TEST_KEY));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (a.ok && b.ok) {
      assert.equal(a.headers[PUBLISH_SIG_HEADER], b.headers[PUBLISH_SIG_HEADER]);
    }
  });

  it("2. wrong key -> a different signature (WordPress's hash_equals would refuse it)", () => {
    const right = signPublishRequest(INPUT, testSigner(TEST_KEY));
    const wrong = signPublishRequest(INPUT, testSigner(OTHER_TEST_KEY));
    assert.equal(right.ok, true);
    assert.equal(wrong.ok, true);
    if (right.ok && wrong.ok) {
      assert.notEqual(right.headers[PUBLISH_SIG_HEADER], wrong.headers[PUBLISH_SIG_HEADER]);
    }
  });

  it("3. payload changed after signing -> a different signature (a tampered content hash is caught)", () => {
    const original = signPublishRequest(INPUT, testSigner(TEST_KEY));
    const tampered = signPublishRequest(
      { ...INPUT, contentHash: "TAMPERED-hash-0000" },
      testSigner(TEST_KEY),
    );
    assert.equal(original.ok, true);
    assert.equal(tampered.ok, true);
    if (original.ok && tampered.ok) {
      assert.notEqual(original.headers[PUBLISH_SIG_HEADER], tampered.headers[PUBLISH_SIG_HEADER]);
    }
  });

  it("3b. the revision id is also covered -- changing it alone changes the signature", () => {
    const a = signPublishRequest(INPUT, testSigner(TEST_KEY));
    const b = signPublishRequest({ ...INPUT, revisionId: "rev-different" }, testSigner(TEST_KEY));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (a.ok && b.ok) {
      assert.notEqual(a.headers[PUBLISH_SIG_HEADER], b.headers[PUBLISH_SIG_HEADER]);
    }
  });

  it("3c. the post id is also covered -- one signature cannot be replayed onto another post", () => {
    const a = signPublishRequest(INPUT, testSigner(TEST_KEY));
    const b = signPublishRequest({ ...INPUT, wpPostId: 99 }, testSigner(TEST_KEY));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (a.ok && b.ok) {
      assert.notEqual(a.headers[PUBLISH_SIG_HEADER], b.headers[PUBLISH_SIG_HEADER]);
    }
  });

  it("4. missing key -> fails closed: no headers are ever produced", () => {
    const result = signPublishRequest(INPUT, testSigner(null));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "SIGNING_KEY_UNAVAILABLE");
    }
    // CONTROL for the control: the test double must actually be able to
    // produce `null`, or this case would pass no matter what
    // `signPublishRequest` does with it.
    assert.equal(testSigner(null)("x"), null, "the missing-key double does not return null");
  });

  it("5. signing has no side effect that could publish anything", () => {
    // This module makes no network call and touches no post -- asserted on
    // the source rather than by mocking fetch, so a future edit that added
    // one would fail here even before a test tried to catch it at runtime.
    const src = readFileSync(
      fileURLToPath(new URL("./publish-signature.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of [
      /\bfetch\(/,
      /WordpressClient/,
      /wp_insert_post|wp_update_post/,
      /\bdb\s*\./,
      /import\s+"server-only"/,
    ]) {
      assert.equal(forbidden.test(src), false, `publish-signature.ts matches ${forbidden}`);
    }
  });
});

/** A boundary named in prose is not a violation -- see agent-boundary.test.ts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("AC-07: the signer is injected, so the policy module never holds a key", () => {
  it("publish-signature.ts imports no crypto and reads no environment", async () => {
    const src = stripComments(
      readFileSync(fileURLToPath(new URL("./publish-signature.ts", import.meta.url)), "utf8"),
    );
    assert.equal(/process\.env/.test(src), false, "the policy reads the environment");
    assert.equal(/createHmac|node:crypto/.test(src), false, "the policy imports crypto");
  });

  it("no key-shaped literal lives in the policy module", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./publish-signature.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(
      /["'][A-Za-z0-9+/=_-]{32,}["']/.test(src),
      false,
      "a key-shaped literal is present",
    );
  });
});
