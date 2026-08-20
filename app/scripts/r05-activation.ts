/**
 * P1-R05 production activation — map one real product and prove the sync is a
 * no-op before anything is written.
 *
 *   pnpm tsx scripts/r05-activation.ts <wpPostId> plan
 *   pnpm tsx scripts/r05-activation.ts <wpPostId> apply
 *
 * The app row is seeded **from WordPress's own current values**, so a correct
 * pipeline changes nothing at all. That is the whole design of this check: if
 * any managed field would move, the mapping is wrong, and the run aborts before
 * touching production rather than reporting the damage afterwards.
 *
 *   plan    snapshot WordPress, seed the app row and mapping (app-side only),
 *           then compute what the sync *would* send and diff it. Any predicted
 *           change is a hard stop.
 *   apply   run the sync, then assert applied=[] cleared=[] and that all 15
 *           fields read back byte-identical to the pre-sync snapshot.
 *
 * Rules inherited from R05/R06: every group carries a control; a failing
 * control voids the run; exit code 0 is never the evidence.
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { products, wordpressProductSync } from "../src/lib/db/schema/wordpress";
import { wordpressClientFromEnv, type WordpressClient } from "../src/lib/wordpress/client";
import { buildFacts, MANAGED_FIELD_KEYS } from "../src/lib/wordpress/field-map";
import { enqueueProductSync, runSyncJob } from "../src/lib/wordpress/sync-worker";
import { wordpressSyncJobs } from "../src/lib/db/schema/wordpress";
import { and } from "drizzle-orm";

let pass = 0;
let fail = 0;
let controlFailed = 0;

function ok(id: string, detail: string) {
  pass += 1;
  console.log(`PASS  ${id.padEnd(10)} ${detail}`);
}
function bad(id: string, detail: string, control = false) {
  fail += 1;
  if (control) controlFailed += 1;
  console.log(`FAIL  ${id.padEnd(10)} ${detail}`);
}
function assertEq(id: string, expected: unknown, actual: unknown, what: string, control = false) {
  if (String(expected) === String(actual)) ok(id, `${what} (=${actual})`);
  else bad(id, `${what} (expected=${expected} actual=${actual})`, control);
}

const wpPostId = Number(process.argv[2]);
const phase = String(process.argv[3] ?? "");

if (!Number.isInteger(wpPostId) || wpPostId <= 0 || !["plan", "apply"].includes(phase)) {
  console.error("usage: tsx scripts/r05-activation.ts <wpPostId> <plan|apply>");
  process.exit(2);
}

const BOOL_KEYS = new Set(["dc_free_plan", "dc_free_trial", "dc_has_coupon", "dc_active"]);

/**
 * What WordPress will have stored after receiving `value` for `key`.
 *
 * Mirrors dc_core_sanitize_bool(), which returns int 1|0 — so a boolean `true`
 * lands as the string "1", not "true" and not "". Sending `false` where
 * WordPress currently holds an empty string would write "0" over "", which is a
 * real change to a field that meant "unknown". That is the mistake this
 * function exists to make visible.
 */
function expectedStored(key: string, value: unknown): string {
  if (BOOL_KEYS.has(key)) return value === true ? "1" : "0";
  return String(value);
}

/** Read the 15 managed fields as WordPress currently holds them. */
async function snapshot(client: WordpressClient, tag: string): Promise<Record<string, string>> {
  const p = await client.getProduct(wpPostId, `r05-act-${tag}`);
  const out: Record<string, string> = {};
  for (const k of MANAGED_FIELD_KEYS) out[k] = String(p.facts[k] ?? "");
  return out;
}

/** Turn a WordPress value into the app column value that reproduces it exactly. */
function seedFrom(before: Record<string, string>) {
  const text = (k: string) => (before[k] === "" ? null : before[k]!);
  // "" means WordPress has nothing recorded. That is UNKNOWN, not false: seeding
  // `false` would send 0 and overwrite the empty value with "0".
  const bool = (k: string) => (before[k] === "" ? null : before[k] === "1");

  return {
    vendor: text("dc_vendor"),
    officialUrl: text("dc_official_url"),
    pricingModel: text("dc_pricing_model"),
    priceAmount: text("dc_price_amount"),
    priceCurrency: text("dc_price_currency"),
    pricePeriod: text("dc_price_period"),
    priceDisplay: text("dc_price_display"),
    freePlan: bool("dc_free_plan"),
    freeTrial: bool("dc_free_trial"),
    trialLength: text("dc_trial_length"),
    moneyback: text("dc_moneyback"),
    hasCoupon: bool("dc_has_coupon"),
    lastVerified: text("dc_last_verified"),
    lastPriceCheck: text("dc_last_price_check"),
    // NOT NULL in the schema, so an empty WordPress value has to become a
    // boolean. "" and "0" both mean not-active as far as WordPress is
    // concerned, and both round-trip to "0".
    active: before.dc_active === "1",
  };
}

async function doPlan(client: WordpressClient) {
  const health = await client.health("r05-act-health");
  assertEq("C-1", "dc-integration", health.login, "CONTROL authenticated identity", true);
  assertEq("C-2", true, health.writesEnabled, "CONTROL writes enabled", true);

  const wp = await client.getProduct(wpPostId, "r05-act-read");
  ok("C-3", `CONTROL target is ${wp.slug} "${wp.title}" (${wp.postStatus})`);

  const before = await snapshot(client, "before");
  console.log("\n--- WordPress now ---");
  for (const k of MANAGED_FIELD_KEYS) console.log(`  ${k.padEnd(22)} ${JSON.stringify(before[k])}`);

  // The app row is new data; it modifies no business record in WordPress.
  const seed = seedFrom(before);
  const [row] = await db
    .insert(products)
    .values({ slug: wp.slug, name: wp.title, sourceVersion: 1, ...seed })
    .onConflictDoUpdate({ target: products.slug, set: { ...seed, name: wp.title, updatedAt: new Date() } })
    .returning();

  if (!row) {
    bad("C-4", "CONTROL could not seed the app product row", true);
    return;
  }
  ok("C-4", `CONTROL app row seeded from WordPress (${row.id.slice(0, 8)}…)`);

  await db
    .insert(wordpressProductSync)
    .values({ productId: row.id, wpPostId, status: "PENDING" })
    .onConflictDoNothing({ target: wordpressProductSync.wpPostId });
  ok("C-5", `CONTROL mapping recorded product=${row.id.slice(0, 8)}… wp=${wpPostId}`);

  // ---- The gate. What would the sync send, and would any of it move?
  const facts = buildFacts(row);
  const changes: string[] = [];

  console.log("\n--- what the sync would send ---");
  for (const k of MANAGED_FIELD_KEYS) {
    const has = Object.prototype.hasOwnProperty.call(facts, k);
    const v = facts[k];

    if (!has) {
      console.log(`  ${k.padEnd(22)} (omitted — WordPress keeps ${JSON.stringify(before[k])})`);
      continue;
    }

    if (v === null) {
      // null clears. That only changes anything if WordPress holds a value.
      if (before[k] !== "") changes.push(`${k}: ${JSON.stringify(before[k])} -> (cleared)`);
      else console.log(`  ${k.padEnd(22)} null -> already empty, no change`);
      continue;
    }

    const would = expectedStored(k, v);
    if (would !== before[k]) changes.push(`${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(would)}`);
    else console.log(`  ${k.padEnd(22)} ${JSON.stringify(would)} -> identical`);
  }

  console.log("");
  if (changes.length > 0) {
    for (const c of changes) console.log(`  WOULD CHANGE  ${c}`);
    bad("AC-A1", `${changes.length} managed field(s) would change — the mapping is wrong, refusing to sync`, true);
    return;
  }

  ok("AC-A1", "CONTROL the sync would change nothing: every managed field round-trips identically");
  console.log("\n>>> plan gate PASSED. Safe to run: apply");
}

async function doApply(client: WordpressClient) {
  const [row] = await db
    .select()
    .from(products)
    .innerJoin(wordpressProductSync, eq(wordpressProductSync.productId, products.id))
    .where(eq(wordpressProductSync.wpPostId, wpPostId))
    .limit(1);

  if (!row) {
    bad("C-1", "CONTROL no mapped product — run the plan phase first", true);
    return;
  }
  const product = row.products;
  ok("C-1", `CONTROL mapped product ${product.slug} (${product.id.slice(0, 8)}…)`);

  const before = await snapshot(client, "pre");

  await enqueueProductSync(product.id, product.sourceVersion);
  const [job] = await db
    .select()
    .from(wordpressSyncJobs)
    .where(and(eq(wordpressSyncJobs.productId, product.id), eq(wordpressSyncJobs.sourceVersion, product.sourceVersion)))
    .limit(1);

  if (!job) {
    bad("C-2", "CONTROL the job was not enqueued", true);
    return;
  }

  const result = await runSyncJob(job, client);
  assertEq("AC-A2", "applied", result.result, "CONTROL the controlled sync ran", true);

  // ---- The proof: the sync touched nothing.
  const after = await snapshot(client, "post");
  let moved = 0;
  for (const k of MANAGED_FIELD_KEYS) {
    if (before[k] !== after[k]) {
      bad(`AC-A3:${k}`, `${k} moved ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`, true);
      moved += 1;
    }
  }
  if (moved === 0) ok("AC-A3", `all ${MANAGED_FIELD_KEYS.length} managed fields identical after the sync`);

  // The worker reports what it applied. Both lists must be empty.
  assertEq("AC-A4", "", result.detail, "the sync applied no field");

  const [state] = await db
    .select()
    .from(wordpressProductSync)
    .where(eq(wordpressProductSync.wpPostId, wpPostId))
    .limit(1);
  assertEq("AC-A5", "SYNCED", state?.status, "sync state recorded");
  assertEq("AC-A6", product.sourceVersion, state?.syncedSourceVersion, "synced version recorded");
  ok("AC-A7", `baseline stored: hash=${String(state?.wpContentHash).slice(0, 14)}… modified=${state?.wpPostModifiedGmt}`);
}

async function main() {
  const client = wordpressClientFromEnv();
  if (phase === "plan") await doPlan(client);
  else await doApply(client);
}

main()
  .catch((err) => {
    console.log(`FAIL  RUNTIME    ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  })
  .finally(() => {
    console.log(`\n=== RESULT (${phase}) ===`);
    console.log(`pass=${pass} fail=${fail} control_failed=${controlFailed}`);
    if (controlFailed > 0) console.log("VERDICT=VOID (a control failed; the other results prove nothing)");
    else if (fail === 0) console.log("VERDICT=PASS");
    else console.log("VERDICT=FAIL");
    process.exit(controlFailed > 0 || fail > 0 ? 1 : 0);
  });
