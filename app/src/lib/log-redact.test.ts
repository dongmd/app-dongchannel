import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact, scrub, REDACTED } from "./log-redact.ts";

// A DSN in the shape this app actually uses: postgres-js reads DATABASE_URL and
// quotes the connection target back when a connection fails.
const DSN = "postgres://ops_user:hunter2SuperSecret@127.0.0.1:5432/dongchannel_ops";

describe("patterns already covered before hardening", () => {
  test("still redacts Google, OpenAI, Bearer and Basic", () => {
    assert.ok(!scrub("GOCSPX-abcdefghijklmnopqrstuvwxyz").includes("abcdefghij"));
    assert.ok(!scrub("sk-abcdefghijklmnopqrstuvwxyz").includes("abcdefghij"));
    assert.match(scrub("Bearer eyJhbGciOiJIUzI1NiJ9"), /Bearer <REDACTED>/);
    assert.match(scrub("Basic dXNlcjpwYXNz"), /Basic <REDACTED>/);
  });
});

describe("gap 1 — connection strings", () => {
  test("removes the DSN password, keeps user and host", () => {
    const out = scrub(DSN);
    assert.ok(!out.includes("hunter2SuperSecret"), "DSN password leaked");
    assert.ok(out.includes("ops_user"), "username should survive");
    assert.ok(out.includes("127.0.0.1:5432"), "host should survive for debugging");
  });

  test("removes assigned secrets in any quoting style", () => {
    for (const input of [
      "PGPASSWORD=hunter2SuperSecret",
      "password: 'hunter2SuperSecret'",
      '{"token": "hunter2SuperSecret"}',
      "api_key=hunter2SuperSecret",
    ]) {
      assert.ok(!scrub(input).includes("hunter2SuperSecret"), `leaked: ${input}`);
    }
  });
});

describe("gap 2 — secret key names", () => {
  test("replaces the value of a credential-shaped field whole", () => {
    const out = redact({
      user_id: "u_123",
      password: "hunter2SuperSecret",
      DATABASE_URL: DSN,
      NEXTAUTH_SECRET: "whatever-this-is",
      nested: { client_secret: "GOCSPX-plain" },
    }) as Record<string, unknown>;

    assert.equal(out.user_id, "u_123", "non-secret fields must survive");
    assert.equal(out.password, REDACTED);
    assert.equal(out.DATABASE_URL, REDACTED);
    assert.equal(out.NEXTAUTH_SECRET, REDACTED);
    assert.deepEqual(out.nested, { client_secret: REDACTED });
  });

  test("scrubs a secret hidden under an innocent key name", () => {
    // What key-based redaction alone always misses.
    const out = redact({ detail: `could not connect to ${DSN}` }) as { detail: string };
    assert.ok(!out.detail.includes("hunter2SuperSecret"));
  });
});

describe("gap 3 — Errors", () => {
  test("an Error keeps its message instead of spreading to {}", () => {
    const out = redact(new Error("boom")) as { name: string; message: string };
    assert.equal(out.name, "Error");
    assert.equal(out.message, "boom");
  });

  test("scrubs both message and stack", () => {
    const out = redact(new Error(`connection to ${DSN} refused`)) as {
      message: string;
      stack: string;
    };
    assert.ok(!out.message.includes("hunter2SuperSecret"));
    assert.ok(!out.stack.includes("hunter2SuperSecret"));
  });
});

describe("gap 4 — circular structures", () => {
  test("a cycle logs as [Circular] instead of overflowing the stack", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    assert.equal(out.self, "[Circular]");
  });

  test("shared but acyclic references do not crash", () => {
    const shared = { v: 1 };
    const out = redact({ a: shared, b: shared }) as Record<string, unknown>;
    assert.deepEqual(out.a, { v: 1 });
  });
});

describe("does not damage ordinary data", () => {
  test("prose, numbers, arrays, null and Date pass through", () => {
    const when = new Date("2026-08-18T00:00:00.000Z");
    const out = redact({
      message: "published 2 pages in 1.4s",
      count: 2,
      list: [1, "two", null, true],
      when,
    }) as Record<string, unknown>;

    assert.equal(out.message, "published 2 pages in 1.4s");
    assert.equal(out.count, 2);
    assert.deepEqual(out.list, [1, "two", null, true]);
    assert.equal(out.when, when, "Date must not be walked into an object");
  });
});
