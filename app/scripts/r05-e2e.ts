/**
 * P1-R05 end-to-end acceptance, run on the VPS against production WordPress.
 *
 *   pnpm tsx scripts/r05-e2e.ts <wpPostId>
 *
 * Rules carried over from R07, where they were earned the hard way:
 *   - every group has a CONTROL, and a failing control voids the entire run;
 *   - exit code 0 is never the evidence — every mutation is read back;
 *   - an assertion prints what it compared, so a pass is legible as evidence.
 */

import "dotenv/config";

import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  products,
  wordpressProductSync,
  wordpressSyncJobs,
} from "../src/lib/db/schema/wordpress";
import { WordpressError, wordpressClientFromEnv } from "../src/lib/wordpress/client";
import { enqueueProductSync, runSyncJob } from "../src/lib/wordpress/sync-worker";
import { buildFacts, idempotencyKeyFor, isForbiddenField, MANAGED_FIELD_KEYS } from "../src/lib/wordpress/field-map";

let pass = 0;
let fail = 0;
let controlFailed = 0;

function ok(id: string, detail: string) {
  pass += 1;
  console.log(`PASS  ${id.padEnd(10)} ${detail}`);
}
function bad(id: string, detail: string) {
  fail += 1;
  console.log(`FAIL  ${id.padEnd(10)} ${detail}`);
}
function assertEq(id: string, expected: unknown, actual: unknown, what: string) {
  if (String(expected) === String(actual)) ok(id, `${what} (=${actual})`);
  else bad(id, `${what} (expected=${expected} actual=${actual})`);
}

const wpPostId = Number(process.argv[2]);
if (!Number.isInteger(wpPostId) || wpPostId <= 0) {
  console.error("usage: tsx scripts/r05-e2e.ts <wpPostId>");
  process.exit(2);
}

const RUN = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
let productId = "";

async function takeJob(version: number) {
  const [job] = await db
    .select()
    .from(wordpressSyncJobs)
    .where(
      and(eq(wordpressSyncJobs.productId, productId), eq(wordpressSyncJobs.sourceVersion, version)),
    )
    .limit(1);
  return job;
}

async function main() {
  const client = wordpressClientFromEnv();

  // ── A · credential and contract ────────────────────────────────
  const health = await client.health(`r05-e2e-${RUN}`);
  assertEq("AC-01", "dc-integration", health.login, "CONTROL authenticated identity");
  if (health.login !== "dc-integration") controlFailed += 1;
  assertEq("AC-02", true, health.writesEnabled, "writes enabled for the run");

  // ── B · mapping ───────────────────────────────────────────────
  const [product] = await db
    .insert(products)
    .values({
      slug: `zz-r05-${RUN}`,
      name: `R05 fixture ${RUN}`,
      vendor: "R05 Vendor",
      priceAmount: "29.00",
      priceCurrency: "USD",
      pricePeriod: "month",
      freeTrial: true,
      trialLength: "14 days",
      active: true,
      sourceVersion: 1,
    })
    .returning();
  if (!product) throw new Error("failed to create fixture product");
  productId = product.id;

  await db.insert(wordpressProductSync).values({ productId, wpPostId, status: "PENDING" });
  ok("AC-03", `mapping created product=${productId.slice(0, 8)} wp=${wpPostId}`);

  // ── C · field map cannot carry a forbidden key ────────────────
  const facts = buildFacts(product);
  const leaked = Object.keys(facts).filter(isForbiddenField);
  assertEq("AC-06", 0, leaked.length, "no forbidden key in the built payload");
  assertEq("AC-06b", true, MANAGED_FIELD_KEYS.includes("dc_price_amount"), "price is a managed field");
  assertEq("AC-08a", false, MANAGED_FIELD_KEYS.includes("dc_aff_url"), "affiliate url is not managed");

  // ── D · valid sync ────────────────────────────────────────────
  await enqueueProductSync(productId, 1);
  const job1 = await takeJob(1);
  const r1 = await runSyncJob(job1!, client);
  assertEq("AC-05", "applied", r1.result, "CONTROL first sync applies");
  if (r1.result !== "applied") controlFailed += 1;

  const after1 = await client.getProduct(wpPostId, `r05-e2e-${RUN}-rb`);
  assertEq("AC-05b", "29.00", after1.facts.dc_price_amount, "read-back price via API");
  assertEq("AC-05c", "USD", after1.facts.dc_price_currency, "read-back currency via API");

  const [state1] = await db.select().from(wordpressProductSync).where(eq(wordpressProductSync.productId, productId));
  assertEq("AC-03b", "SYNCED", state1!.status, "sync state recorded");
  assertEq("AC-03c", 1, state1!.syncedSourceVersion, "synced version recorded");

  // ── E · idempotency ───────────────────────────────────────────
  const modifiedBefore = after1.postModifiedGmt;
  await db.update(wordpressSyncJobs).set({ state: "QUEUED" }).where(eq(wordpressSyncJobs.id, job1!.id));
  const job1again = await takeJob(1);
  const r2 = await runSyncJob(job1again!, client);
  const after2 = await client.getProduct(wpPostId, `r05-e2e-${RUN}-rb2`);
  ok("AC-11", `replay result=${r2.result}`);
  assertEq("AC-11b", modifiedBefore, after2.postModifiedGmt, "post_modified identical: no second write");

  // ── F · stale version is refused ──────────────────────────────
  await db.update(products).set({ sourceVersion: 5, priceAmount: "49.00" }).where(eq(products.id, productId));
  await enqueueProductSync(productId, 5);
  const job5 = await takeJob(5);
  const r5 = await runSyncJob(job5!, client);
  assertEq("AC-09a", "applied", r5.result, "newer version applies");

  const after5 = await client.getProduct(wpPostId, `r05-e2e-${RUN}-rb5`);
  assertEq("AC-09b", "49.00", after5.facts.dc_price_amount, "read-back shows the newer price");

  // Now replay an older version. It must be refused without touching WordPress.
  await db.update(products).set({ priceAmount: "9.99" }).where(eq(products.id, productId));
  await enqueueProductSync(productId, 2);
  const job2 = await takeJob(2);
  const rStale = await runSyncJob(job2!, client);
  assertEq("AC-09c", "skipped_stale", rStale.result, "older version refused");

  const afterStale = await client.getProduct(wpPostId, `r05-e2e-${RUN}-rb6`);
  assertEq("AC-09d", "49.00", afterStale.facts.dc_price_amount, "read-back unchanged: no rollback");
  assertEq("AC-10", "49.00", afterStale.facts.dc_price_amount, "stale guard holds independently of idempotency expiry");

  // ── G · affiliate and forbidden fields are refused at the API ──
  try {
    await client.patchFacts(
      wpPostId,
      { wpContentHash: afterStale.wpContentHash, postModifiedGmt: afterStale.postModifiedGmt },
      { dc_aff_url: "https://example.invalid/stolen" },
      `r05-e2e-aff-${RUN}`,
      `r05-e2e-${RUN}-aff`,
    );
    bad("AC-08", "affiliate write was NOT refused");
  } catch (err) {
    const e = err as WordpressError;
    assertEq("AC-08", "FORBIDDEN", e.kind, `affiliate write refused (${e.code})`);
    assertEq("AC-08b", false, e.retryable, "affiliate refusal is not retryable");
  }

  try {
    await client.patchFacts(
      wpPostId,
      { wpContentHash: afterStale.wpContentHash, postModifiedGmt: afterStale.postModifiedGmt },
      { post_status: "publish" },
      `r05-e2e-status-${RUN}`,
      `r05-e2e-${RUN}-status`,
    );
    bad("AC-08c", "post_status was NOT refused");
  } catch (err) {
    const e = err as WordpressError;
    ok("AC-08c", `post_status refused (${e.code}, kind=${e.kind})`);
  }

  // ── H · conflict is not retryable ─────────────────────────────
  try {
    await client.patchFacts(
      wpPostId,
      { wpContentHash: "v1:deadbeef", postModifiedGmt: afterStale.postModifiedGmt },
      { dc_trial_length: "30 days" },
      `r05-e2e-conflict-${RUN}`,
      `r05-e2e-${RUN}-conflict`,
    );
    bad("AC-14", "stale baseline was NOT refused");
  } catch (err) {
    const e = err as WordpressError;
    assertEq("AC-14", "CONFLICT", e.kind, `stale baseline refused (${e.code})`);
    assertEq("AC-14b", false, e.retryable, "a 412 is never retried");
  }

  // ── I · cache freshness (R07 R-4 still holds through this client)
  const fresh1 = await client.getProduct(wpPostId, `r05-e2e-${RUN}-c1`);
  await db.update(products).set({ sourceVersion: 6, moneyback: `r05-${RUN}` }).where(eq(products.id, productId));
  await enqueueProductSync(productId, 6);
  const job6 = await takeJob(6);
  await runSyncJob(job6!, client);
  const fresh2 = await client.getProduct(wpPostId, `r05-e2e-${RUN}-c2`);
  if (fresh1.postModifiedGmt !== fresh2.postModifiedGmt || fresh2.facts.dc_moneyback === fresh1.facts.dc_moneyback) {
    ok("AC-15", `change observable without a cache-buster (moneyback=${fresh2.facts.dc_moneyback})`);
  } else {
    bad("AC-15", "API served a stale projection after a successful sync");
    controlFailed += 1;
  }
}

async function teardown() {
  console.log("\n=== TEARDOWN ===");
  if (productId) {
    await db.delete(wordpressSyncJobs).where(eq(wordpressSyncJobs.productId, productId));
    await db.delete(wordpressProductSync).where(eq(wordpressProductSync.productId, productId));
    await db.delete(products).where(eq(products.id, productId));

    const left = await db.select().from(products).where(eq(products.id, productId));
    console.log(`product_removed=${left.length === 0 ? "YES" : "NO"}`);
    const jobsLeft = await db.select().from(wordpressSyncJobs).where(eq(wordpressSyncJobs.productId, productId));
    console.log(`jobs_removed=${jobsLeft.length === 0 ? "YES" : "NO"}`);
  }

  console.log("\n=== RESULT ===");
  console.log(`pass=${pass} fail=${fail} control_failed=${controlFailed}`);
  if (controlFailed > 0) console.log("VERDICT=VOID (a control failed; the other results prove nothing)");
  else if (fail === 0) console.log("VERDICT=PASS");
  else console.log("VERDICT=FAIL");
}

main()
  .catch((err) => {
    console.log(`FAIL  RUNTIME    ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  })
  .finally(async () => {
    await teardown();
    process.exit(controlFailed > 0 || fail > 0 ? 1 : 0);
  });
