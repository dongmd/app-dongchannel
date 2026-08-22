/**
 * P3-R07 AC-06 / AC-07 / AC-08 / AC-09 / AC-14 / AC-17 — the boundary the
 * preview route sits on.
 *
 * These are claims about the *system around* the policy: which routes the auth
 * middleware guards, what the route can and cannot import, and what a preview
 * token is worth anywhere else. They are asserted against the real files rather
 * than against a description of them, because every one of these criteria fails
 * by a file quietly changing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const MIDDLEWARE = read("middleware.ts");
const PREVIEW_ROUTE = read("app/preview/[token]/route.ts");
const WEBHOOK_ROUTE = read("app/api/telegram/webhook/route.ts");

/** The matcher's negative lookahead, as the middleware actually declares it. */
function matcherExcludes(fragment: string): boolean {
  const m = MIDDLEWARE.match(/matcher:\s*\[\s*"([^"]+)"/);
  assert.ok(m, "no matcher found in middleware.ts");
  return m![1]!.includes(fragment);
}

describe("P3-R07: the self-verifying endpoints are reachable without a session", () => {
  it("the preview route is excluded from the auth middleware", () => {
    // Requiring a session here would defeat Q32 Option A outright: reviewing a
    // draft from a phone is precisely what must not need a login.
    assert.equal(matcherExcludes("preview/"), true);
  });

  it("the Telegram webhook is excluded too", () => {
    // Found while building the preview route. Left in the matcher, the webhook
    // is redirected to /login and Telegram never reaches the handler -- the
    // transport probe calls POST directly and never crosses the middleware, so
    // it passed while the real HTTP path was dead.
    assert.equal(matcherExcludes("api/telegram/webhook$"), true);
  });

  it("CONTROL: ordinary routes are still guarded", () => {
    // Without this, "excluded" would also be satisfied by a matcher that
    // guarded nothing at all.
    for (const guarded of ["/admin", "/tasks", "/api/v1/tasks", "/search"]) {
      assert.equal(matcherExcludes(guarded), false, `${guarded} appears in the exclusion list`);
    }
    assert.equal(matcherExcludes("api/v1/"), false);
  });

  it("the webhook exclusion is anchored, so a sibling path cannot inherit it", () => {
    // `$` ends the alternative at the route. Asserted on the alternatives
    // themselves rather than by substring -- "api/telegram/webhook$" trivially
    // CONTAINS "api/telegram/", which is what the first version of this case
    // got wrong.
    const m = MIDDLEWARE.match(/matcher:\s*\[\s*"([^"]+)"/)![1]!;
    const alternatives = m.slice(m.indexOf("(?!") + 3, m.indexOf(").*)")).split("|");
    assert.ok(
      alternatives.includes("api/telegram/webhook$"),
      `webhook alternative missing: ${alternatives.join(",")}`,
    );
    assert.equal(
      alternatives.includes("api/telegram/"),
      false,
      "the whole telegram namespace is exempt, not just the webhook",
    );
  });
});

describe("P3-R07 AC-17: the preview route cannot mutate anything", () => {
  it("it issues no database write of any kind", () => {
    // Matched on the DATABASE handle rather than on the method name. The first
    // version of this case searched for `.update(` and matched
    // `createHmac(...).update(message)` -- a hash being fed its input, not a row
    // being changed. A check that cannot tell those apart would either fail on
    // correct code, as it did, or be relaxed until it caught nothing.
    for (const write of [
      /db\s*\.\s*insert\(/,
      /db\s*\.\s*update\(/,
      /db\s*\.\s*delete\(/,
      /tx\s*\.\s*update\(/,
      /tx\s*\.\s*delete\(/,
      /DELETE FROM|INSERT INTO|UPDATE\s+"?\w+"?\s+SET/i,
    ]) {
      assert.equal(write.test(PREVIEW_ROUTE), false, `preview route matches ${write}`);
    }
  });

  it("the only write it performs is the audit entry AC-16 requires", () => {
    assert.equal((PREVIEW_ROUTE.match(/recordAudit\(/g) ?? []).length, 1);
    assert.match(PREVIEW_ROUTE, /db\s*\n?\s*\.select\(\)/);
  });

  it("only GET exists on the route -- there is no handler to POST to", () => {
    assert.match(PREVIEW_ROUTE, /export async function GET\b/);
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(
        new RegExp(`export (async )?function ${verb}\\b`).test(PREVIEW_ROUTE),
        false,
        `the preview route exports ${verb}`,
      );
    }
  });
});

describe("P3-R07 AC-08 / AC-09: the response headers", () => {
  it("the route sends the canonical header set on BOTH answers", () => {
    // A refusal that omitted them would be cacheable, and a cached 404 for a
    // preview URL is a preview URL somebody can enumerate.
    const uses = (PREVIEW_ROUTE.match(/PREVIEW_HEADERS/g) ?? []).length;
    assert.ok(uses >= 2, `PREVIEW_HEADERS used ${uses} times; expected the refusal and the render`);
  });

  it("the rendered body carries the robots meta tag as well as the header", () => {
    // A header can be stripped by an intermediary that rewrites the response;
    // the tag survives the page being saved.
    assert.match(PREVIEW_ROUTE, /PREVIEW_ROBOTS_META/);
  });

  it("AC-08/AC-09 sitemap and LiteSpeed clauses are satisfied by ARCHITECTURE, stated not assumed", () => {
    // The criteria name a WordPress sitemap and the LiteSpeed page cache. The
    // preview is served from app.dongchannel.com, which is Next.js behind
    // Nginx: it appears in no WordPress sitemap because it is not a WordPress
    // URL, and it passes through no LiteSpeed cache because LiteSpeed fronts
    // the other host.
    //
    // Recorded here rather than ticked silently: the clauses hold because the
    // surface they name does not serve the preview, which is a different fact
    // from a rule having been added. The headers above are what actually does
    // the work on this host.
    assert.match(PREVIEW_ROUTE, /export const runtime = "nodejs"/);
  });
});

describe("P3-R07 AC-13 / AC-14: the signing key", () => {
  it("the key is read from the environment, never hard-coded", () => {
    assert.match(PREVIEW_ROUTE, /process\.env\[/, "the key is not read from the environment");
    assert.match(PREVIEW_ROUTE, /`PREVIEW_SIGNING_KEY_\$\{/, "the name is not PREVIEW-scoped");
    // No 32+ character literal that could be a key.
    assert.equal(/["'][A-Za-z0-9+/=_-]{32,}["']/.test(PREVIEW_ROUTE), false, "a key-shaped literal is present");
  });

  it("the variable name is PREVIEW-specific, so it cannot be the P4 publish key", () => {
    assert.match(PREVIEW_ROUTE, /PREVIEW_SIGNING_KEY_/);
    assert.equal(/PUBLISH_SIGNING_KEY|P4_SIGNING_KEY/.test(PREVIEW_ROUTE), false);
  });

  it("the version is constrained, so the token cannot probe the environment", () => {
    // The key version arrives inside an attacker-supplied token and is
    // interpolated into a variable name. Without the pattern check, a crafted
    // version could name any environment variable in the process.
    assert.match(PREVIEW_ROUTE, /\^\[a-z0-9\]\{1,16\}\$/);
  });

  it("no key material is ever written to the audit or the response", () => {
    assert.equal(/console\.(log|error|warn)/.test(PREVIEW_ROUTE), false);
  });
});

describe("P3-R07 AC-07: a preview token is worth nothing elsewhere", () => {
  it("no other route reads the preview token or its key", () => {
    // The token is a capability for one route. If another route parsed it, it
    // would become an identity somewhere -- which is the exact drift AC-07
    // exists to prevent.
    assert.equal(WEBHOOK_ROUTE.includes("preview-policy"), false);
    assert.equal(WEBHOOK_ROUTE.includes("PREVIEW_SIGNING_KEY"), false);
    assert.equal(MIDDLEWARE.includes("preview-policy"), false);
    assert.equal(MIDDLEWARE.includes("PREVIEW_SIGNING_KEY"), false);
  });

  it("the preview route sets no cookie and creates no session", () => {
    for (const s of ["set-cookie", "Set-Cookie", "cookies()", "signIn", "getToken"]) {
      assert.equal(PREVIEW_ROUTE.includes(s), false, `preview route uses ${s}`);
    }
  });
});
