/**
 * `P4-R08 AC-07` — the real signer reads the environment, never a literal.
 *
 * Every value this file puts into `process.env` is a TEST key, set and
 * removed inside each test. The production key does not exist anywhere yet
 * (see the P4-R08 change plan) and nothing here creates, prints or persists
 * one.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PUBLISH_KEY_ENV } from "./publisher-policy";
import { PUBLISH_SIG_HEADER, signPublishRequest, type PublishSignatureInput } from "./publish-signature";
import { publishSignerFromEnv } from "./publish-signer";

const TEST_KEY = "test-key-do-not-use-in-production";
const INPUT: PublishSignatureInput = {
  wpPostId: 42,
  revisionId: "rev-test-abc",
  contentHash: "deadbeefcafe1234",
};
/** Same known-answer vector as `publish-signature.test.ts`. */
const KNOWN_ANSWER = "7e66e28fc083e708c0b115cfd503dbd94db5b98c15983d339af974bfbf1d7ae1";

const ORIGINAL = process.env[PUBLISH_KEY_ENV];

beforeEach(() => {
  delete process.env[PUBLISH_KEY_ENV];
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[PUBLISH_KEY_ENV];
  else process.env[PUBLISH_KEY_ENV] = ORIGINAL;
});

describe("publishSignerFromEnv", () => {
  it("signs with whatever key is in the environment at call time", () => {
    process.env[PUBLISH_KEY_ENV] = TEST_KEY;
    const result = signPublishRequest(INPUT, publishSignerFromEnv());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.headers[PUBLISH_SIG_HEADER], KNOWN_ANSWER);
    }
  });

  it("fails closed when the environment holds no key -- AC-07's non-negotiable", () => {
    // beforeEach already deleted it; asserted again so this case does not
    // depend on execution order.
    delete process.env[PUBLISH_KEY_ENV];
    const result = signPublishRequest(INPUT, publishSignerFromEnv());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "SIGNING_KEY_UNAVAILABLE");
    }
  });

  it("fails closed on an empty-string key too, not only an absent one", () => {
    process.env[PUBLISH_KEY_ENV] = "";
    const result = signPublishRequest(INPUT, publishSignerFromEnv());
    assert.equal(result.ok, false);
  });

  it("picks up a key that appears after the signer was built, without recreating it", () => {
    // `wordpressClientFromEnv`-style "reads at call time" -- a factory built
    // once and called many times must still see a key deployed after it was
    // constructed, since nothing here restarts the process to prove it.
    const signer = publishSignerFromEnv();
    assert.equal(signer("x"), null);
    process.env[PUBLISH_KEY_ENV] = TEST_KEY;
    assert.notEqual(signer("x"), null);
  });

  it("never hard-codes a secret: no key-shaped literal in this file", () => {
    const src = readFileSync(fileURLToPath(new URL("./publish-signer.ts", import.meta.url)), "utf8");
    assert.equal(
      /["'][A-Za-z0-9+/=_-]{32,}["']/.test(src),
      false,
      "a key-shaped literal is present in publish-signer.ts",
    );
    assert.match(src, /process\.env\[/, "the key is not read from the environment");
  });
});
