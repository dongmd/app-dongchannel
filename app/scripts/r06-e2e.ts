/**
 * P1-R06 end-to-end acceptance, run on the VPS against production WordPress.
 *
 *   pnpm tsx scripts/r06-e2e.ts <wpPostId> <phase>
 *
 * Three phases, because the requirement is about a **human** editing the
 * article and there is no way to fake that honestly from one host. WP-CLI lives
 * on the cPanel box; the guard lives here. So:
 *
 *   phase a   (VPS)     baseline, ALLOW, permit binding, the refusals that need
 *                       no WordPress-side change
 *   -- cPanel --        edit the post content by hand
 *   phase b   (VPS)     the requirement itself: the edit is detected, refused,
 *                       recorded as conflict context, and stays refused
 *   -- cPanel --        change the post status
 *   phase c   (VPS)     status divergence, then teardown
 *
 * Rules carried over from R07 and R05:
 *   - every group carries a CONTROL, and a failing control voids the run;
 *   - exit code 0 is never the evidence — every decision is read back from the
 *     database, not inferred from the return value;
 *   - an assertion prints what it compared, so a pass is legible as evidence.
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { wordpressArticleSync } from "../src/lib/db/schema/wordpress";
import { WordpressClient, wordpressClientFromEnv } from "../src/lib/wordpress/client";
import {
  consumeSyncPermit,
  establishArticleBaseline,
  getArticleBaseline,
  guardArticleUpdate,
  resolveArticleConflict,
} from "../src/lib/wordpress/article-guard";

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

/** Assert a call refuses, and say why it refused. */
async function assertRefused(
  id: string,
  expectedReason: string,
  run: () => Promise<{ decision: string; reason?: string; detail?: string }>,
  what: string,
) {
  const out = await run();
  if (out.decision !== "REFUSE") {
    bad(id, `${what} — expected REFUSE, got ${out.decision}`);
    return;
  }
  assertEq(id, expectedReason, out.reason, what);
}

/** Assert a synchronous call throws. A permit that silently fails is a write. */
function assertThrows(id: string, what: string, run: () => void) {
  try {
    run();
    bad(id, `${what} — expected a throw, none happened`);
  } catch (err) {
    ok(id, `${what} (${err instanceof Error ? err.message.slice(0, 60) : "threw"})`);
  }
}

const wpPostId = Number(process.argv[2]);
const phase = String(process.argv[3] ?? "");

if (!Number.isInteger(wpPostId) || wpPostId <= 0 || !["a", "b", "c"].includes(phase)) {
  console.error("usage: tsx scripts/r06-e2e.ts <wpPostId> <a|b|c>");
  process.exit(2);
}

const RUN = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);

// ── Phase A ───────────────────────────────────────────────────────
async function phaseA(client: WordpressClient) {
  // CONTROL — the credential and the namespace, before anything is concluded
  // from a refusal that might just be a broken connection.
  const health = await client.health(`r06-e2e-${RUN}`);
  assertEq("C-1", "dc-integration", health.login, "CONTROL authenticated identity", true);
  // health() throws outright if the identity ever holds dc_manage_affiliate, so
  // reaching this line is that assertion.
  //
  // Two different versions live nearby and must not be conflated: the API
  // contract is `1.0.0` (DC_V1_CONTRACT_VERSION), while the hash carries its
  // own `v1:` prefix. AC-10 compares the hash prefix; this control pins the API
  // one, so a server that moved on is caught here rather than showing up as a
  // mysterious conflict.
  assertEq("C-2", "1.0.0", health.contractVersion, "CONTROL dc/v1 API contract version", true);

  // Start from nothing, so the NO_BASELINE case below is real.
  await db.delete(wordpressArticleSync).where(eq(wordpressArticleSync.wpPostId, wpPostId));

  // ── AC-08 · missing baseline refuses ────────────────────────────
  // Run this *first*, while the article is genuinely untracked. WordPress is
  // pristine here, which is the point: absence of a record is not agreement.
  await assertRefused("AC-08", "NO_BASELINE", () => guardArticleUpdate(wpPostId, client, `r06-${RUN}-nb`),
    "an untracked article is refused");

  const noRow = await getArticleBaseline(wpPostId);
  assertEq("AC-08b", "null", String(noRow), "a refusal did not invent a baseline");

  // ── AC-01, AC-03 · a baseline comes from a live read ────────────
  const row = await establishArticleBaseline(wpPostId, client, `r06-${RUN}-base`);
  assertEq("AC-01", wpPostId, row.wpPostId, "baseline records the post id");
  assertEq("AC-01b", "BASELINE_SET", row.state, "baseline state");
  ok("AC-01c", `baseline hash recorded (${String(row.wpContentHash).slice(0, 12)}…)`);
  assertEq("AC-01d", true, typeof row.wpPostModifiedGmt === "string" && row.wpPostModifiedGmt.length > 0,
    "baseline records post_modified_gmt");
  assertEq("AC-01e", "v1", row.hashContractVersion, "baseline records the hash contract version");
  assertEq("AC-01f", true, row.wpLastSyncedAt instanceof Date, "baseline records when it was taken");

  // AC-03 — the stored values are the ones WordPress just returned, not
  // defaults and not values assembled from a second read.
  const live = await client.getArticleSyncState(wpPostId, `r06-${RUN}-cmp`);
  assertEq("AC-03", live.wpContentHash, row.wpContentHash, "stored hash is the one WordPress returned");
  assertEq("AC-03b", live.postModifiedGmt, row.wpPostModifiedGmt, "stored timestamp is the one WordPress returned");
  assertEq("AC-03c", live.postStatus, row.wpPostStatus, "stored status is the one WordPress returned");

  // ── AC-04 · the clean path ──────────────────────────────────────
  const allowed = await guardArticleUpdate(wpPostId, client, `r06-${RUN}-allow`);
  assertEq("AC-04", "ALLOW", allowed.decision, "CONTROL unchanged article is allowed", true);
  if (allowed.decision !== "ALLOW") {
    // Without this the whole phase proves nothing: every refusal below could be
    // a guard that refuses everything.
    return;
  }

  // ── AC-05, AC-17 · the permit is bound and single-use ───────────
  const target = { wpPostId, wpContentHash: allowed.wpContentHash, postModifiedGmt: allowed.postModifiedGmt };

  assertThrows("AC-05a", "a permit for another post is refused", () =>
    consumeSyncPermit(allowed.permit, { ...target, wpPostId: wpPostId + 1 }));

  assertThrows("AC-05b", "a permit against a different hash is refused", () =>
    consumeSyncPermit(allowed.permit, { ...target, wpContentHash: "v1:0000" }));

  assertThrows("AC-05c", "a permit against a different timestamp is refused", () =>
    consumeSyncPermit(allowed.permit, { ...target, postModifiedGmt: "2000-01-01T00:00:00+00:00" }));

  // The rejections above must not have consumed it — a permit spent by a failed
  // check would turn a caller's bug into a lockout.
  consumeSyncPermit(allowed.permit, target);
  ok("AC-05d", "the matching target spends the permit");

  assertThrows("AC-05e", "a spent permit cannot be reused", () =>
    consumeSyncPermit(allowed.permit, target));

  // ── AC-13 · a post that is not there ────────────────────────────
  await assertRefused("AC-13", "NOT_FOUND", () => guardArticleUpdate(99999999, client, `r06-${RUN}-404`),
    "a nonexistent post is refused");

  // ── AC-12 · unreachable is not unchanged ────────────────────────
  const broken = new WordpressClient({
    baseUrl: "https://127.0.0.1:9",
    user: "unused",
    password: "unused",
    timeoutMs: 3000,
  });
  await assertRefused("AC-12", "UPSTREAM_UNAVAILABLE", () => guardArticleUpdate(wpPostId, broken, `r06-${RUN}-down`),
    "an unreachable WordPress is refused");

  // And it did not corrupt the baseline on the way past.
  const after = await getArticleBaseline(wpPostId);
  assertEq("AC-12b", "BASELINE_SET", after?.state, "an upstream failure is not recorded as a conflict");

  console.log(`\nBASELINE HASH  ${after?.wpContentHash}`);
  console.log(`BASELINE TIME  ${after?.wpPostModifiedGmt}`);
  console.log("\n>>> Now edit the post by hand on cPanel, then run phase b.");
}

// ── Phase B — the requirement ─────────────────────────────────────
async function phaseB(client: WordpressClient) {
  const before = await getArticleBaseline(wpPostId);

  if (!before || before.state !== "BASELINE_SET") {
    bad("C-3", `CONTROL phase b needs a clean baseline, found ${before?.state ?? "no row"}`, true);
    return;
  }
  ok("C-3", `CONTROL baseline present and clean (${String(before.wpContentHash).slice(0, 12)}…)`);

  // CONTROL — WordPress really did change. If the hand edit did not land, the
  // refusal below would be meaningless.
  const live = await client.getArticleSyncState(wpPostId, `r06-${RUN}-b-live`);
  if (live.wpContentHash === before.wpContentHash) {
    bad("C-4", "CONTROL the hand edit did not change the content hash — nothing to detect", true);
    return;
  }
  ok("C-4", `CONTROL WordPress content moved (${String(before.wpContentHash).slice(0, 10)}… -> ${live.wpContentHash.slice(0, 10)}…)`);

  // ── AC-07 · the whole point of the requirement ──────────────────
  const refused = await guardArticleUpdate(wpPostId, client, `r06-${RUN}-conflict`);
  assertEq("AC-07", "REFUSE", refused.decision, "a hand edit is refused, not overwritten");
  assertEq("AC-07b", "CONTENT_CHANGED", refused.decision === "REFUSE" ? refused.reason : "",
    "the reason names the divergence");

  // ── AC-15 · conflict context, read back from the database ───────
  const conflicted = await getArticleBaseline(wpPostId);
  assertEq("AC-15", "CONFLICT", conflicted?.state, "the row moved to CONFLICT");
  assertEq("AC-15b", "CONTENT_CHANGED", conflicted?.conflictReason, "the reason is recorded");
  assertEq("AC-15c", before.wpContentHash, conflicted?.conflictBaselineHash, "the baseline hash is preserved");
  assertEq("AC-15d", live.wpContentHash, conflicted?.conflictObservedHash, "the observed hash is recorded");
  assertEq("AC-15e", before.wpPostModifiedGmt, conflicted?.conflictBaselineModifiedGmt,
    "the baseline timestamp is preserved");
  assertEq("AC-15f", true, conflicted?.conflictDetectedAt instanceof Date, "detection time is recorded");

  // The divergence is reconstructable without going back to WordPress, which
  // matters because by then it may have moved again.
  assertEq("AC-15g", true,
    conflicted?.conflictBaselineHash !== conflicted?.conflictObservedHash,
    "both sides of the divergence are on the row");

  // ── AC-14 · a conflict does not expire ──────────────────────────
  await assertRefused("AC-14", "EXISTING_CONFLICT", () => guardArticleUpdate(wpPostId, client, `r06-${RUN}-again`),
    "a second attempt is still refused");
  await assertRefused("AC-14b", "EXISTING_CONFLICT", () => guardArticleUpdate(wpPostId, client, `r06-${RUN}-again2`),
    "and a third");

  // ── AC-16 · resolving re-baselines from a fresh read ────────────
  const resolved = await resolveArticleConflict(wpPostId, client, `r06-${RUN}-resolve`);
  assertEq("AC-16", "BASELINE_SET", resolved.state, "resolving clears the conflict");
  assertEq("AC-16b", live.wpContentHash, resolved.wpContentHash, "the new baseline is the current WordPress state");
  assertEq("AC-16c", "null", String(resolved.conflictReason), "conflict context is cleared");
  assertEq("AC-16d", true, resolved.wpContentHash !== before.wpContentHash,
    "the new baseline is not the stale one");

  const allowedAgain = await guardArticleUpdate(wpPostId, client, `r06-${RUN}-post-resolve`);
  assertEq("AC-16e", "ALLOW", allowedAgain.decision, "after resolution the guard allows again");

  console.log("\n>>> Now change the post status on cPanel, then run phase c.");
}

// ── Phase C — status divergence, then teardown ────────────────────
async function phaseC(client: WordpressClient) {
  const before = await getArticleBaseline(wpPostId);

  if (!before || before.state !== "BASELINE_SET") {
    bad("C-5", `CONTROL phase c needs a clean baseline, found ${before?.state ?? "no row"}`, true);
  } else {
    ok("C-5", `CONTROL baseline clean, status ${before.wpPostStatus}`);

    const live = await client.getArticleSyncState(wpPostId, `r06-${RUN}-c-live`);
    if (live.postStatus === before.wpPostStatus) {
      bad("C-6", `CONTROL the status did not change (still ${live.postStatus}) — nothing to detect`, true);
    } else {
      ok("C-6", `CONTROL status moved ${before.wpPostStatus} -> ${live.postStatus}`);

      // AC-13 — a status the baseline did not observe is refused.
      await assertRefused("AC-13b", "STATUS_CHANGED", () => guardArticleUpdate(wpPostId, client, `r06-${RUN}-status`),
        "a status change is refused");

      const row = await getArticleBaseline(wpPostId);
      assertEq("AC-13c", "CONFLICT", row?.state, "a status divergence is recorded as conflict context");
      assertEq("AC-13d", "STATUS_CHANGED", row?.conflictReason, "the reason names the status change");
    }
  }

  console.log("\n=== TEARDOWN ===");
  await db.delete(wordpressArticleSync).where(eq(wordpressArticleSync.wpPostId, wpPostId));
  const left = await getArticleBaseline(wpPostId);
  console.log(`sync_row_removed=${left === null ? "YES" : "NO"}`);
  console.log(">>> Delete the WordPress fixture on cPanel.");
}

async function main() {
  const client = wordpressClientFromEnv();
  if (phase === "a") await phaseA(client);
  else if (phase === "b") await phaseB(client);
  else await phaseC(client);
}

main()
  .catch((err) => {
    console.log(`FAIL  RUNTIME    ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  })
  .finally(() => {
    console.log(`\n=== RESULT (phase ${phase}) ===`);
    console.log(`pass=${pass} fail=${fail} control_failed=${controlFailed}`);
    if (controlFailed > 0) console.log("VERDICT=VOID (a control failed; the other results prove nothing)");
    else if (fail === 0) console.log("VERDICT=PASS");
    else console.log("VERDICT=FAIL");
    process.exit(controlFailed > 0 || fail > 0 ? 1 : 0);
  });
