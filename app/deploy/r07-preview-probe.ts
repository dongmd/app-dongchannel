/**
 * P3-R07 AC-16 / AC-17 — exercise the REAL preview route against a real
 * database.
 *
 *   DATABASE_URL=<scratch> npx tsx deploy/r07-preview-probe.ts
 *
 * `AC-16` says every use and refusal is audited; `AC-17` says the route mutates
 * nothing. Both are claims about what happens when the handler runs, and both
 * fail silently — a swallowed audit write leaves a working preview and an empty
 * log, and an accidental write leaves a preview that works and a row nobody
 * expected.
 *
 * So this imports `route.ts` itself, calls `GET`, and reads the database back.
 */

process.env.PREVIEW_SIGNING_KEY_V1 = "probe-preview-key-v1";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (url.includes("dongchannel_ops")) throw new Error("that is production -- use a scratch database");
if (!/scratch|test|tmp|_ci/.test(url)) throw new Error("the scratch URL must be clearly named");

async function main() {
  const out: Record<string, unknown> = {};

  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const { sql } = await import("drizzle-orm");
  const { buildPreviewToken } = await import("../src/lib/telegram/preview-policy");
  const { createHmac } = await import("node:crypto");

  const client = postgres(url!, { max: 1, prepare: false });
  const dbx = drizzle(client);

  const signer = (message: string, keyVersion: string) => {
    const k = process.env[`PREVIEW_SIGNING_KEY_${keyVersion.toUpperCase()}`];
    return k ? createHmac("sha256", k).update(message).digest("hex") : null;
  };

  const HASH = "a".repeat(64);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await dbx.execute(sql`
    INSERT INTO article_preview_links (article_id, revision_id, content_hash, key_version, expires_at)
    VALUES ('art-probe','rev-1',${HASH},'v1',${expiresAt.toISOString()}::timestamptz)
    ON CONFLICT DO NOTHING
  `);

  const token = buildPreviewToken(
    { articleId: "art-probe", revisionId: "rev-1", contentHash: HASH, expiresAt },
    "v1",
    signer,
  )!;

  const { GET } = (await import(
    new URL("../src/app/preview/[token]/route.ts", import.meta.url).href
  )) as { GET: (r: Request, c: { params: Promise<{ token: string }> }) => Promise<Response> };

  const count = async (t: string) => {
    const r = await dbx.execute(sql.raw(`select count(*)::int as n from ${t}`));
    return (r as unknown as { n: number }[])[0]!.n;
  };
  const lastAudit = async () => {
    const r = await dbx.execute(
      sql`select action, result, entity_type from audit_events order by created_at desc, id desc limit 1`,
    );
    return (r as unknown as Record<string, unknown>[])[0];
  };

  const call = (tok: string) =>
    GET(new Request(`https://app.dongchannel.com/preview/${tok}`), {
      params: Promise.resolve({ token: tok }),
    });

  // ── A valid link ──
  const beforeAudit = await count("audit_events");
  const beforeLinks = await count("article_preview_links");
  const beforeApprovals = await count("article_approvals");

  let res = await call(token);
  out.validStatus = res.status;
  out.validCacheControl = res.headers.get("cache-control");
  out.validRobots = res.headers.get("x-robots-tag");
  out.validReferrer = res.headers.get("referrer-policy");
  out.validBodyHasMeta = (await res.text()).includes('name="robots"');
  out.validAudit = await lastAudit();

  // ── A forged link ──
  const forged = token.slice(0, -2) + (token.endsWith("00") ? "11" : "00");
  res = await call(forged);
  out.forgedStatus = res.status;
  out.forgedBody = await res.text();
  out.forgedCacheControl = res.headers.get("cache-control");
  out.forgedAudit = await lastAudit();

  // ── A revoked link ──
  await dbx.execute(sql`UPDATE article_preview_links SET revoked_at = now() WHERE article_id = 'art-probe'`);
  res = await call(token);
  out.revokedStatus = res.status;
  out.revokedBody = await res.text();
  out.revokedAudit = await lastAudit();

  // ── AC-17: nothing was mutated except the audit entries AC-16 requires ──
  out.auditWritten = (await count("audit_events")) - beforeAudit;
  out.linksUnchanged = (await count("article_preview_links")) === beforeLinks;
  out.approvalsUnchanged = (await count("article_approvals")) === beforeApprovals;
  out.intents = await count("article_publish_intents");
  out.pending = await count("telegram_pending_actions");

  // The probe COMMITS its link, because the route has to read a committed row --
  // it cannot see one inside a transaction it is not part of. So the probe
  // removes what it created, and the harness then asserts the table is empty,
  // which also proves this cleanup ran.
  //
  // The audit rows are deliberately NOT removed: audit_events is append-only by
  // trigger and could not be, which is the point of it.
  await dbx.execute(sql`DELETE FROM article_preview_links WHERE article_id = 'art-probe'`);
  out.cleanedUp = (await count("article_preview_links")) === beforeLinks;

  console.log(JSON.stringify(out));
  await client.end({ timeout: 5 });
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
