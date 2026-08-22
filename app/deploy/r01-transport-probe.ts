/**
 * P3-R01 AC-07 / AC-08 — exercise the REAL webhook route against a real
 * database.
 *
 *   DATABASE_URL=<scratch> npx tsx deploy/r01-transport-probe.ts
 *
 * `AC-08` says every denial is recorded to the audit log. A unit test can prove
 * the record is well formed; only running the route can prove the row lands —
 * and "the row lands" is the half that fails silently, because a swallowed
 * write leaves a working endpoint and an empty log.
 *
 * So this imports `route.ts` itself and calls `POST` with synthetic `Request`
 * objects, then reads `audit_events` back. Nothing is re-implemented: a probe
 * that rebuilt the handler would prove the probe correct.
 *
 * The environment is set before the import, because the route reads its
 * allowlist and secret at module load — which is itself worth exercising.
 */

process.env.TELEGRAM_OWNER_IDS = "4242";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (url.includes("dongchannel_ops")) {
  throw new Error("that is the production database -- use a scratch database");
}
if (!/scratch|test|tmp|_ci/.test(url)) {
  throw new Error("the scratch URL must be clearly named scratch/test/tmp");
}

const SECRET = "s".repeat(48);

type Row = { action: string; result: string };

async function main() {
  const out: Record<string, unknown> = {};

  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const { sql } = await import("drizzle-orm");

  const client = postgres(url!, { max: 1, prepare: false });
  const read = drizzle(client);

  const since = async (): Promise<Row[]> => {
    const r = await read.execute(
      sql`select action, result from audit_events order by created_at desc, id desc limit 5`,
    );
    return r as unknown as Row[];
  };

  const clear = async () => {
    // The audit log is append-only by trigger, so this cannot delete. The
    // probe therefore compares COUNTS before and after rather than emptying —
    // which is also closer to how the log behaves in life.
    const r = await read.execute(sql`select count(*)::int as n from audit_events`);
    return (r as unknown as { n: number }[])[0]!.n;
  };

  // Imported AFTER the env is set: the route reads both at module load.
  const routeUrl = new URL("../src/app/api/telegram/webhook/route.ts", import.meta.url);

  const post = (secret: string | undefined, body: unknown, method = "POST") =>
    new Request("https://app.dongchannel.com/api/telegram/webhook", {
      method,
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
      },
      body: JSON.stringify(body),
    });

  // ── 1. Unconfigured: every request refused, and recorded ──
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  const { POST } = (await import(routeUrl.href)) as {
    POST: (r: Request) => Promise<Response>;
  };

  let before = await clear();
  let res = await POST(post(SECRET, { message: { from: { id: 4242 }, text: "/status" } }));
  out.unconfiguredStatus = res.status;
  out.unconfiguredRows = (await since())[0];
  out.unconfiguredWrote = (await clear()) - before;

  // ── 2. Configured, wrong secret: refused, and recorded ──
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  before = await clear();
  res = await POST(post("w".repeat(48), { message: { from: { id: 4242 }, text: "/status" } }));
  out.badSecretStatus = res.status;
  out.badSecretRows = (await since())[0];
  out.badSecretWrote = (await clear()) - before;

  // ── 3. Correct secret, UNAUTHORISED actor ──
  // Two records expected: the transport accepted, the gateway denied. They are
  // separate events and this is where that separation is visible.
  before = await clear();
  res = await POST(post(SECRET, { message: { from: { id: 9999 }, text: "/status" } }));
  out.strangerStatus = res.status;
  out.strangerRows = (await since()).slice(0, 2);
  out.strangerWrote = (await clear()) - before;

  // ── 4. Correct secret, allowlisted actor ──
  before = await clear();
  res = await POST(post(SECRET, { message: { from: { id: 4242 }, text: "/status" } }));
  out.ownerStatus = res.status;
  out.ownerRows = (await since()).slice(0, 2);
  out.ownerWrote = (await clear()) - before;

  // ── 5. No side effects: nothing was approved or queued ──
  const approvals = await read.execute(sql`select count(*)::int as n from article_approvals`);
  const intents = await read.execute(sql`select count(*)::int as n from article_publish_intents`);
  out.approvals = (approvals as unknown as { n: number }[])[0]!.n;
  out.intents = (intents as unknown as { n: number }[])[0]!.n;

  console.log(JSON.stringify(out));
  await client.end({ timeout: 5 });
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
