/**
 * P3-R07 — a preview link is a capability, not an identity.
 *
 * `AC-18` is the control the whole file rests on: refusal must be *reachable*.
 * A verifier that accepted everything would pass any test asserting that a valid
 * link works, so each negative case is paired with the positive one it differs
 * from by exactly one thing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  PREVIEW_AUDIT,
  PREVIEW_GRANTS,
  PREVIEW_HEADERS,
  PREVIEW_NEVER_GRANTS,
  PREVIEW_OUTCOMES,
  PREVIEW_ROBOTS_META,
  PREVIEW_TTL_CONFIG,
  PUBLIC_REFUSAL,
  TOKEN_PATTERN,
  buildPreviewToken,
  checkPreview,
  identityFromPreviewToken,
  parsePreviewToken,
  previewAuditRecordFor,
  publicResponseFor,
  resolveTtlMs,
  signaturesMatch,
  type PreviewLinkRecord,
  type PreviewScope,
  type Signer,
} from "./preview-policy";
import { buildAuditRecord } from "../audit/audit-policy";
import { authorisesPublish } from "./approval-policy";

const NOW = new Date("2026-08-22T12:00:00Z");
const HASH = "a".repeat(64);
const EXPIRES = new Date(NOW.getTime() + 15 * 60 * 1000);

const KEYS: Record<string, string> = { v1: "preview-key-one", v2: "preview-key-two" };

/** Production passes this same shape backed by the environment. */
const signer: Signer = (message, keyVersion) => {
  const k = KEYS[keyVersion];
  if (!k) return null;
  return createHmac("sha256", k).update(message).digest("hex");
};

const SCOPE: PreviewScope = {
  articleId: "art-1",
  revisionId: "rev-3",
  contentHash: HASH,
  expiresAt: EXPIRES,
};

const TOKEN = buildPreviewToken(SCOPE, "v1", signer)!;

function record(over: Partial<PreviewLinkRecord> = {}): PreviewLinkRecord {
  return {
    id: "lnk-1",
    articleId: "art-1",
    revisionId: "rev-3",
    contentHash: HASH,
    keyVersion: "v1",
    issuedAt: NOW,
    expiresAt: EXPIRES,
    revokedAt: null,
    ...over,
  };
}

function check(over: Partial<Parameters<typeof checkPreview>[0]> = {}, now = NOW) {
  return checkPreview(
    { token: TOKEN, record: record(), currentHash: HASH, sign: signer, ...over },
    now,
  );
}

describe("P3-R07 AC-01: the link is signed and verified server-side", () => {
  it("a correctly signed link is allowed", () => {
    assert.equal(check().outcome, "ALLOW");
  });

  it("an unsigned string is refused", () => {
    for (const t of ["", "art-1", "pv1.v1.abc", "not-a-token", null, 42, {}]) {
      assert.equal(check({ token: t }).outcome, "REFUSE_MALFORMED", String(t));
    }
  });

  it("a link re-signed with a WRONG key is refused", () => {
    const wrong = buildPreviewToken(SCOPE, "v2", signer)!;
    // Same scope, same shape, different key. The record says v1.
    //
    // This case FOUND A REAL GAP: the token verifies on its own terms, because
    // it was signed correctly with v2. Without comparing the record's key
    // version, anything holding ANY valid preview key could mint a link for any
    // record. It is reported as a scope mismatch rather than a bad signature,
    // because the signature is genuine -- it is the binding that is wrong.
    assert.equal(check({ token: wrong }).outcome, "REFUSE_SCOPE_MISMATCH");
  });

  it("and the SAME token is allowed once the record agrees on the key", () => {
    // The control for the case above: v2 is a valid key, so the refusal must be
    // about the binding and not about v2 being unusable.
    const wrong = buildPreviewToken(SCOPE, "v2", signer)!;
    assert.equal(check({ token: wrong, record: record({ keyVersion: "v2" }) }).outcome, "ALLOW");
  });

  it("an ALTERED payload is refused -- the signature covers the scope", () => {
    const parsed = parsePreviewToken(TOKEN)!;
    const other = buildPreviewToken({ ...SCOPE, revisionId: "rev-4" }, "v1", signer)!;
    const otherPayload = parsePreviewToken(other)!.payload;
    const forged = `pv1.v1.${otherPayload}.${parsed.signature}`;
    assert.equal(check({ token: forged }).outcome, "REFUSE_BAD_SIGNATURE");
  });

  it("a TRUNCATED link is refused", () => {
    assert.equal(check({ token: TOKEN.slice(0, TOKEN.length - 8) }).outcome, "REFUSE_MALFORMED");
  });

  it("an EXTENDED link is refused", () => {
    assert.equal(check({ token: TOKEN + "00" }).outcome, "REFUSE_MALFORMED");
  });

  it("the signature is checked BEFORE any record is consulted", () => {
    // A forged token with no record present must report the signature, not the
    // lookup: otherwise the endpoint tells a guesser which ids exist.
    const forged = TOKEN.slice(0, -1) + (TOKEN.endsWith("0") ? "1" : "0");
    assert.equal(check({ token: forged, record: null }).outcome, "REFUSE_BAD_SIGNATURE");
  });

  it("the token format is pinned", () => {
    assert.ok(TOKEN_PATTERN.test(TOKEN));
    assert.ok(TOKEN.startsWith("pv1."));
  });
});

describe("P3-R07 AC-02: scoped to one article and one revision", () => {
  it("the token carries both, and they are recovered exactly", () => {
    const p = parsePreviewToken(TOKEN)!;
    assert.equal(p.scope.articleId, "art-1");
    assert.equal(p.scope.revisionId, "rev-3");
  });

  it("a record for another revision refuses -- the link never follows the article", () => {
    assert.equal(check({ record: record({ revisionId: "rev-4" }) }).outcome, "REFUSE_SCOPE_MISMATCH");
  });

  it("a record for another article refuses", () => {
    assert.equal(check({ record: record({ articleId: "art-2" }) }).outcome, "REFUSE_SCOPE_MISMATCH");
  });

  it("a record with a different expiry refuses -- the deadline is signed too", () => {
    assert.equal(
      check({ record: record({ expiresAt: new Date(EXPIRES.getTime() + 1000) }) }).outcome,
      "REFUSE_SCOPE_MISMATCH",
    );
  });

  it("CONTROL: the matching record allows, so scope checks are not refusing everything", () => {
    assert.equal(check().outcome, "ALLOW");
  });
});

describe("P3-R07 AC-03: TTL is short, configurable, and capped", () => {
  it("the default is short", () => {
    assert.equal(resolveTtlMs().ms, PREVIEW_TTL_CONFIG.defaultMs);
    assert.ok(PREVIEW_TTL_CONFIG.defaultMs <= 15 * 60 * 1000);
  });

  it("a configured value is honoured", () => {
    assert.deepEqual(resolveTtlMs(5 * 60 * 1000), { ms: 5 * 60 * 1000, clamped: false });
  });

  it("a value above the maximum is CLAMPED, not accepted", () => {
    const r = resolveTtlMs(PREVIEW_TTL_CONFIG.maxMs * 10);
    assert.equal(r.ms, PREVIEW_TTL_CONFIG.maxMs);
    assert.equal(r.clamped, true);
  });

  it("a nonsensical value falls back to the default rather than to forever", () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = resolveTtlMs(v);
      assert.equal(r.ms, PREVIEW_TTL_CONFIG.defaultMs, String(v));
      assert.equal(r.clamped, true);
    }
  });

  it("the configuration is versioned, so raising it is a reviewed change", () => {
    assert.equal(typeof PREVIEW_TTL_CONFIG.version, "string");
    assert.ok(PREVIEW_TTL_CONFIG.maxMs > PREVIEW_TTL_CONFIG.defaultMs);
  });
});

describe("P3-R07 AC-04: expiry is asserted at the boundary", () => {
  it("one millisecond before expiry: allowed", () => {
    assert.equal(check({}, new Date(EXPIRES.getTime() - 1)).outcome, "ALLOW");
  });

  it("exactly at the expiry instant: expired", () => {
    assert.equal(check({}, new Date(EXPIRES.getTime())).outcome, "REFUSE_EXPIRED");
  });

  it("one millisecond after: expired", () => {
    assert.equal(check({}, new Date(EXPIRES.getTime() + 1)).outcome, "REFUSE_EXPIRED");
  });

  it("the decision is a pure function of (record, now)", () => {
    // Same inputs, same answer, twice, with no clock read in between.
    const a = check({}, new Date(EXPIRES.getTime() - 1000));
    const b = check({}, new Date(EXPIRES.getTime() - 1000));
    assert.deepEqual(a, b);
  });
});

describe("P3-R07 AC-05: revocable before expiry", () => {
  it("a revoked link is refused although it has not expired", () => {
    const d = check({ record: record({ revokedAt: new Date(NOW.getTime() - 1) }) });
    assert.equal(d.outcome, "REFUSE_REVOKED");
  });

  it("revocation is checked BEFORE expiry, so the audit says revoked", () => {
    // A link both revoked and expired is reported as revoked: that is the
    // decision somebody made, and the expiry is a coincidence.
    const d = check(
      { record: record({ revokedAt: new Date(NOW.getTime() - 1) }) },
      new Date(EXPIRES.getTime() + 5000),
    );
    assert.equal(d.outcome, "REFUSE_REVOKED");
  });

  it("a revoked link is refused EXACTLY as an expired one is, from outside", () => {
    const revoked = publicResponseFor(check({ record: record({ revokedAt: NOW }) }));
    const expired = publicResponseFor(check({}, new Date(EXPIRES.getTime() + 1)));
    assert.deepEqual(revoked, expired);
  });

  it("CONTROL: an un-revoked link still works", () => {
    assert.equal(check({ record: record({ revokedAt: null }) }).outcome, "ALLOW");
  });
});

describe("P3-R07 AC-06 / AC-07: it authorises a read and authenticates nothing", () => {
  it("the grant is exactly one read of one draft revision", () => {
    assert.deepEqual([...PREVIEW_GRANTS], ["READ_ONE_DRAFT_REVISION"]);
  });

  it("the things it never grants are enumerated, including publish", () => {
    for (const n of [
      "SESSION",
      "AUTH_COOKIE",
      "WORDPRESS_CAPABILITY",
      "ADMIN_CAPABILITY",
      "WP_ADMIN_ACCESS",
      "REST_API_ACCESS",
      "ANOTHER_POST",
      "ANOTHER_REVISION",
      "PUBLISH",
    ]) {
      assert.ok((PREVIEW_NEVER_GRANTS as readonly string[]).includes(n), n);
    }
  });

  it("a preview token on ANY non-preview route is fully anonymous", () => {
    for (const route of ["/admin", "/api/v1/tasks", "/tasks", "/api/telegram/webhook", "/"]) {
      assert.equal(identityFromPreviewToken(route, TOKEN), "anonymous", route);
    }
  });

  it("an ALLOW decision yields a read scope and nothing resembling a session", () => {
    const d = check();
    assert.deepEqual(Object.keys(d).sort(), ["articleId", "outcome", "reason", "revisionId"]);
    const s = JSON.stringify(d).toLowerCase();
    for (const forbidden of ["session", "cookie", "token", "capability", "admin"]) {
      assert.equal(s.includes(forbidden), false, `decision mentions ${forbidden}`);
    }
  });
});

describe("P3-R07 AC-08 / AC-09: the response cannot be indexed or shared", () => {
  it("carries noindex, nofollow as a header and as a meta tag", () => {
    assert.match(PREVIEW_HEADERS["X-Robots-Tag"]!, /noindex/);
    assert.match(PREVIEW_HEADERS["X-Robots-Tag"]!, /nofollow/);
    assert.match(PREVIEW_ROBOTS_META, /noindex, nofollow/);
  });

  it("carries private, no-store -- not merely no-cache", () => {
    // `no-cache` permits storing and revalidating. A shared cache holding a
    // preview would serve one owner's draft to whoever asked next.
    const cc = PREVIEW_HEADERS["Cache-Control"]!;
    assert.match(cc, /private/);
    assert.match(cc, /no-store/);
  });

  it("sends no referrer, so the token does not travel to whatever the draft links to", () => {
    assert.equal(PREVIEW_HEADERS["Referrer-Policy"], "no-referrer");
  });
});

describe("P3-R07 AC-10 / AC-11: a material edit invalidates the preview", () => {
  it("a changed content hash refuses", () => {
    assert.equal(check({ currentHash: "b".repeat(64) }).outcome, "REFUSE_CONTENT_CHANGED");
  });

  it("a hash that could not be computed refuses -- UNKNOWN is not unchanged", () => {
    assert.equal(check({ currentHash: null }).outcome, "REFUSE_CONTENT_CHANGED");
  });

  it("the hash is bound into the token, so an edited record cannot be re-pointed", () => {
    assert.equal(
      check({ record: record({ contentHash: "c".repeat(64) }) }).outcome,
      "REFUSE_SCOPE_MISMATCH",
    );
  });

  it("preview v3, edit, then approve: the preview refuses", () => {
    // The AC-11 sequence, as one case. The approval binds to the hash the owner
    // was shown; the preview refuses first, so the approval is never taken
    // against content nobody saw.
    assert.equal(check().outcome, "ALLOW");
    assert.equal(check({ currentHash: "d".repeat(64) }).outcome, "REFUSE_CONTENT_CHANGED");
  });
});

describe("P3-R07 AC-12: publish uses the approved revision and no other", () => {
  // The criterion's last sentence assigns an INDEPENDENT re-check to the P4
  // publish gate. That is defence in depth and a forward obligation on P4-R08,
  // not a second obligation on P3 -- the same reading P3-R05 AC-08 was closed
  // under. What P3 owes is that the approved revision is the only one a publish
  // can name, and that is enforced here and in migration 0032.
  const approval = {
    id: "app-1",
    articleId: "art-1",
    revisionId: "rev-3",
    approvedBy: 4242,
    approvedAt: NOW,
    payloadHash: "f".repeat(64),
    callbackNonce: "n1",
    expiresAt: new Date(NOW.getTime() + 3600_000),
    withdrawsId: null,
  };

  it("a publish naming a DIFFERENT revision than the approval is refused", () => {
    const v = authorisesPublish(
      { approval, revisionId: "rev-4", currentHash: "f".repeat(64) },
      NOW,
    );
    assert.notEqual(v.authorisation, "AUTHORISED");
  });

  it("a publish of a SUPERSEDED revision -- same id, changed bytes -- is refused", () => {
    const v = authorisesPublish(
      { approval, revisionId: "rev-3", currentHash: "0".repeat(64) },
      NOW,
    );
    assert.notEqual(v.authorisation, "AUTHORISED");
  });

  it("CONTROL: the approved revision with its approved bytes IS authorised", () => {
    const v = authorisesPublish(
      { approval, revisionId: "rev-3", currentHash: "f".repeat(64) },
      NOW,
    );
    assert.equal(v.authorisation, "AUTHORISED");
  });
});

describe("P3-R07 AC-13 / AC-14: keys", () => {
  it("the key version travels in the token", () => {
    assert.equal(parsePreviewToken(TOKEN)!.keyVersion, "v1");
  });

  it("rotation invalidates outstanding links, and says so distinctly", () => {
    const gone: Signer = (m, v) => (v === "v9" ? "0".repeat(64) : null);
    const d = check({ sign: gone });
    assert.equal(d.outcome, "REFUSE_KEY_UNAVAILABLE");
    // Not reported as a bad signature: that would send someone hunting for an
    // attacker after a routine rotation.
    assert.notEqual(d.outcome, "REFUSE_BAD_SIGNATURE");
  });

  it("no key material ever appears in a decision", () => {
    for (const d of [check(), check({ token: "pv1.v1.AAAA." + "f".repeat(64) })]) {
      const s = JSON.stringify(d);
      for (const k of Object.values(KEYS)) assert.equal(s.includes(k), false);
    }
  });

  it("the signer is injected, so this module never holds a key", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const src = await fs.readFile(
      url.fileURLToPath(new URL("./preview-policy.ts", import.meta.url)),
      "utf8",
    );
    assert.equal(/process\.env/.test(src), false, "the policy reads the environment");
    assert.equal(/createHmac|node:crypto/.test(src), false, "the policy imports crypto");
  });
});

describe("P3-R07 AC-15: refusals are indistinguishable from outside", () => {
  const cases: Record<string, () => ReturnType<typeof check>> = {
    truncated: () => check({ token: TOKEN.slice(0, -8) }),
    extended: () => check({ token: TOKEN + "00" }),
    wrongKey: () => check({ token: buildPreviewToken(SCOPE, "v2", signer)! }),
    deletedRevision: () => check({ record: null }),
    revoked: () => check({ record: record({ revokedAt: NOW }) }),
    expired: () => check({}, new Date(EXPIRES.getTime() + 1)),
    edited: () => check({ currentHash: "e".repeat(64) }),
  };

  it("every refusal produces the SAME public response", () => {
    const responses = Object.values(cases).map((f) => JSON.stringify(publicResponseFor(f())));
    assert.equal(new Set(responses).size, 1, `responses differ: ${new Set(responses).size}`);
    assert.equal(JSON.parse(responses[0]!).status, 404);
    assert.equal(JSON.parse(responses[0]!).body, PUBLIC_REFUSAL);
  });

  it("but the audit distinguishes them, because the log is not the response", () => {
    const outcomes = Object.values(cases).map((f) => f().outcome);
    assert.ok(new Set(outcomes).size >= 5, `only ${new Set(outcomes).size} distinct outcomes`);
  });

  it("CONTROL: the allowed case produces a DIFFERENT public response", () => {
    // Without this, "all refusals look alike" would also hold if everything,
    // including success, returned 404.
    assert.notEqual(JSON.stringify(publicResponseFor(check())), JSON.stringify(publicResponseFor(cases.revoked!())));
  });

  it("each named negative case is covered", () => {
    assert.equal(Object.keys(cases).length, 7);
  });
});

describe("P3-R07 AC-16: audit stores ids, never the token", () => {
  it("a use and a refusal are different actions", () => {
    assert.equal(previewAuditRecordFor(check(), "lnk-1").action, PREVIEW_AUDIT.use);
    assert.equal(previewAuditRecordFor(check({ record: null }), "lnk-1").action, PREVIEW_AUDIT.refuse);
  });

  it("the record carries the link id and never the token", () => {
    const r = previewAuditRecordFor(check(), "lnk-1");
    assert.equal(r.entityId, "lnk-1");
    assert.equal(JSON.stringify(r).includes(TOKEN), false);
    assert.equal(JSON.stringify(r).includes(parsePreviewToken(TOKEN)!.signature), false);
  });

  it("every preview action is accepted by P3-R06's canonical writer", () => {
    for (const action of Object.values(PREVIEW_AUDIT)) {
      const built = buildAuditRecord(
        { actorType: "system", action, result: "OK", entityType: "preview_link", entityId: "lnk-1" },
        NOW,
      );
      assert.equal(built.ok, true, `${action}: ${JSON.stringify(built)}`);
    }
  });
});

describe("P3-R07 AC-18: CONTROL -- refusal is reachable", () => {
  it("a forged, an expired and a revoked link each fail", () => {
    assert.notEqual(check({ token: TOKEN.slice(0, -2) + "ff" }).outcome, "ALLOW");
    assert.notEqual(check({}, new Date(EXPIRES.getTime() + 1)).outcome, "ALLOW");
    assert.notEqual(check({ record: record({ revokedAt: NOW }) }).outcome, "ALLOW");
  });

  it("and the valid link is allowed, so the verifier is not simply refusing", () => {
    assert.equal(check().outcome, "ALLOW");
  });

  it("a verifier that accepted any token would fail these cases", () => {
    // Written out: if signaturesMatch returned true unconditionally, the forged
    // case above would ALLOW. Asserted here on the comparator directly.
    assert.equal(signaturesMatch("a".repeat(64), "b".repeat(64)), false);
    assert.equal(signaturesMatch("a".repeat(64), "a".repeat(64)), true);
  });

  it("the outcome vocabulary is closed and has exactly one success", () => {
    assert.equal(new Set(PREVIEW_OUTCOMES).size, PREVIEW_OUTCOMES.length);
    assert.equal(PREVIEW_OUTCOMES.filter((o) => o === "ALLOW").length, 1);
  });
});
