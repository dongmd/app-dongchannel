/**
 * P4-R09 AC-05 — the outbound alert path.
 *
 * The Ops Hub holds no bot token and sends nothing. It queues; a Hermes cron
 * job collects and delivers through the assistant's existing Telegram sender.
 * These tests cover the two decisions that path makes: which assistant carries
 * it, and who is allowed to collect.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildOwnerAlert, resolveFailure, resolveSuccess } from "../publish/idempotency-policy";
import {
  ALERT_REFUSALS,
  ASSISTANT_PROFILES,
  MIN_BODY_CHARS,
  isAssistantProfile,
  prepareAlert,
  renderForDelivery,
  routeToProfile,
  serviceTokenMatches,
} from "./outbound-policy";

const REAL_BODY = buildOwnerAlert({
  articleId: "art-1", revisionId: "rev-1",
  state: "FAILED_REQUIRES_ATTENTION",
  reason: "non-retryable failure — a person has to change something",
  attempts: 1,
});

// ─── Routing ───────────────────────────────────────────────────────

describe("the right assistant carries the message", () => {
  it("content and publishing route to the AFF assistant", () => {
    for (const e of ["article", "article_publish_intent", "affiliate_project", "content_opportunity"]) {
      assert.equal(routeToProfile(e), "aff", `${e} routed elsewhere`);
    }
  });

  it("video work routes to the YouTube assistant", () => {
    assert.equal(routeToProfile("video"), "yt");
    assert.equal(routeToProfile("youtube_niche"), "yt");
  });

  it("an unknown entity routes NOWHERE rather than to a default", () => {
    // Sending to whichever bot is first means the owner is answered by an
    // assistant that knows nothing about the work -- worse than a delayed alert.
    assert.equal(routeToProfile("something_new"), null);
    const v = prepareAlert("something_new", "x1", REAL_BODY);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "UNROUTABLE_ENTITY");
  });

  it("the profile slugs are HERMES' own, not ours", () => {
    // /opt/hermes-data/profiles/ holds exactly these two. A third would queue
    // alerts no collector ever asks for.
    assert.deepEqual([...ASSISTANT_PROFILES], ["aff", "yt"]);
    assert.equal(isAssistantProfile("aff"), true);
    assert.equal(isAssistantProfile("affiliate"), false);
    assert.equal(isAssistantProfile("youtube"), false);
  });
});

// ─── What may be queued ────────────────────────────────────────────

describe("an alert must be actionable and must carry no secret", () => {
  it("accepts what buildOwnerAlert produces", () => {
    const v = prepareAlert("article", "art-1", REAL_BODY);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.alert.profile, "aff");
  });

  it("refuses a body too thin to act on", () => {
    // AC-05 requires the alert to say WHY. "Publish failed" satisfies nothing.
    const v = prepareAlert("article", "art-1", "Publish failed");
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "BODY_TOO_THIN");
    assert.ok(REAL_BODY.length >= MIN_BODY_CHARS);
  });

  it("refuses a body carrying a credential, and does not echo it", () => {
    // The body goes over Telegram, where it is readable in a chat log forever.
    for (const secret of [
      "sk-ant-0123456789abcdefghij",
      "ghp_01234567890123456789abc",
      "postgres://user:pw@host/db",
      "1234567890:AA" + "x".repeat(33),
    ]) {
      const v = prepareAlert("article", "art-1", `${REAL_BODY} ${secret}`);
      assert.equal(v.ok, false, `accepted a body containing ${secret.slice(0, 8)}…`);
      assert.equal(v.ok === false && v.reason, "BODY_CARRIES_A_SECRET");
      // The refusal names the pattern, never the match.
      assert.equal(v.ok === false && v.detail, null);
    }
  });

  it("refuses an alert with no entity to point at", () => {
    assert.equal(prepareAlert("", "art-1", REAL_BODY).ok, false);
    assert.equal(prepareAlert("article", "  ", REAL_BODY).ok, false);
  });

  it("every refusal reason is reachable and none is ad-hoc", () => {
    const seen = new Set<string>();
    for (const [t, i, b] of [
      ["", "x", REAL_BODY],
      ["nope", "x", REAL_BODY],
      ["article", "x", "short"],
      ["article", "x", `${REAL_BODY} sk-ant-0123456789abcdefghij`],
    ] as const) {
      const v = prepareAlert(t, i, b);
      if (!v.ok) {
        assert.ok((ALERT_REFUSALS as readonly string[]).includes(v.reason), `${v.reason} is ad-hoc`);
        seen.add(v.reason);
      }
    }
    assert.ok(seen.size >= 4, `only ${seen.size} refusal reasons reachable`);
  });
});

// ─── The service boundary ──────────────────────────────────────────

describe("only the collector may drain the queue", () => {
  it("accepts the configured token", () => {
    assert.equal(serviceTokenMatches("s3cret-token-value", "s3cret-token-value").ok, true);
  });

  it("FAILS CLOSED when no token is configured", () => {
    // An endpoint that opened because its token was missing would be a public
    // queue of production failures.
    for (const expected of [undefined, null, ""]) {
      const a = serviceTokenMatches("anything", expected);
      assert.equal(a.ok, false, `opened with expected=${JSON.stringify(expected)}`);
      assert.equal(a.ok === false && a.reason, "NOT_CONFIGURED");
    }
  });

  it("refuses a missing, wrong or differently-sized token", () => {
    assert.equal(serviceTokenMatches(null, "abc").ok, false);
    assert.equal(serviceTokenMatches("abd", "abc").ok, false);
    assert.equal(serviceTokenMatches("ab", "abc").ok, false);
    assert.equal(serviceTokenMatches("abcd", "abc").ok, false);
  });

  it("the comparison is constant-time, asserted on the SOURCE", () => {
    // A behavioural test cannot kill this one. `presented === expected` returns
    // the same VERDICT for every input; only the TIMING differs, and measuring
    // timing in a unit test is how flaky suites are born.
    //
    // Mutation confirmed it: replacing the XOR loop with `===` killed no test.
    // So the property is checked where it actually lives -- in the shape of the
    // code -- the same way agent-boundary.test.ts checks its boundaries.
    const src = readFileSync(
      fileURLToPath(new URL("./outbound-policy.ts", import.meta.url)), "utf8");
    const fn = src.slice(src.indexOf("export function serviceTokenMatches"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    assert.match(body, /\^/, "no XOR: the comparison is not constant-time");
    assert.match(body, /diff \|=/, "the differences are not accumulated");
    assert.equal(
      /presented === expected|expected === presented/.test(body), false,
      "a direct === on the secrets returns as soon as two bytes differ",
    );
    assert.match(body, /presented\.length !== expected\.length/,
      "length is not compared before the scan");
  });

  it("compares correctly — near and far misses both refused", () => {
    // A `===` returns as soon as two bytes differ, and how long that takes
    // measures how much of the prefix was right.
    const expected = "x".repeat(64);
    const nearMiss = "x".repeat(63) + "y";
    const farMiss = "y" + "x".repeat(63);
    assert.equal(serviceTokenMatches(nearMiss, expected).ok, false);
    assert.equal(serviceTokenMatches(farMiss, expected).ok, false);
    assert.equal(serviceTokenMatches(expected, expected).ok, true);
  });
});

// ─── What the owner actually receives ──────────────────────────────

describe("delivery rendering", () => {
  it("joins several alerts readably", () => {
    const out = renderForDelivery([{ body: "first alert body" }, { body: "second alert body" }]);
    assert.match(out, /first alert body/);
    assert.match(out, /second alert body/);
    assert.match(out, /———/);
  });

  it("carries ONLY the body — no ids, no timestamps, no row shape", () => {
    // The collector prints this verbatim into a Telegram message. Anything
    // here becomes chat content.
    const out = renderForDelivery([{ body: "the body" }]);
    assert.equal(out, "the body");
  });

  it("an empty queue renders to nothing, so nothing is sent", () => {
    // Hermes skips whitespace-only content, so a quiet minute is silent rather
    // than a stream of "no alerts" messages.
    assert.equal(renderForDelivery([]), "");
  });
});

// ─── The alertable decision comes from P4-R09, not from here ───────

describe("only terminal failures reach the queue", () => {
  it("a retryable failure is not alertable", () => {
    // Alerting on every transient error teaches the owner to ignore the
    // channel that also carries the real ones.
    const v = prepareAlert("article", "a1", REAL_BODY);
    assert.equal(v.ok, true); // the body is fine...
    assert.equal(resolveFailure(true, false).alertOwner, false); // ...but this is what gates it
  });

  it("a terminal failure and an exhausted budget both alert", () => {
    assert.equal(resolveFailure(false, false).alertOwner, true);
    assert.equal(resolveFailure(true, true).alertOwner, true);
  });

  it("a success never alerts", () => {
    assert.equal(resolveSuccess().alertOwner, false);
  });
});
