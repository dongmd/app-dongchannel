/**
 * `P4-R08 AC-10` end-to-end, run ON THE VPS against production WordPress.
 *
 *   pnpm tsx --conditions=react-server scripts/r08-ac10-e2e.ts <wpPostId>
 *
 * One self-contained run: it creates its own rows, exercises the worker, and
 * tears down in a `finally`. An earlier version split this across three
 * invocations and the state between them was itself the bug — a crashed run
 * left the intent CANCELLED, so the next phase found nothing to claim and
 * reported a failure that was really a leftover.
 *
 * ## What this can and cannot prove, and why
 *
 * AC-10's control ends "...and a fully-eligible intent **publishes**". That
 * final step is **irreversible from this side**: `dc/v1` registers no
 * unpublish and no delete route, and `dc_integration` holds `edit_posts:
 * false` / `publish_posts: false` (checked live, `/dc/v1/health`), so nothing
 * in Repo B can put a published post back to draft. Reverting needs WP-CLI
 * through an owner-authenticated cPanel session.
 *
 * `edit_posts: false` also means Repo B **cannot create a synthetic canary**,
 * so "publish a throwaway instead of real content" is not available either.
 * Every candidate post is real editorial work.
 *
 * So this script proves everything up to and including WordPress **evaluating
 * our request**, and deliberately stops short of a successful publish:
 *
 *   setup     real rows: verification PASS, a real approval, a real intent
 *   run       the REAL worker claims it, reads WordPress live, assembles
 *             state, runs the three gates, signs, and makes a REAL HTTP
 *             request to the live route
 *   teardown  removes what it can; WITHDRAWS the approval, which is immutable
 *
 * The worker runs with a DELIBERATELY WRONG signing key. That is not a
 * weaker test dressed up — it is the only way to exercise the whole path
 * including the network round trip and WordPress's own signature evaluation
 * without changing a post. It proves: the claim, the live read, the hash
 * bridge, all three gates passing, signing, transport, WordPress's verdict,
 * the classification of that verdict, and the persistence of it. The single
 * step it does not prove is WordPress answering 200 — which is exactly the
 * step that cannot be undone.
 *
 * It doubles as the fail-closed evidence the requirement wants: an invalid
 * signature must refuse, and the post must still be `draft` afterwards.
 *
 * Rules carried from r05/r06-e2e:
 *   - every group carries a CONTROL, and a failing control VOIDS the run;
 *   - exit code 0 is never the evidence -- every claim is read back;
 *   - an assertion prints what it compared, so a pass is legible as evidence.
 */

import "dotenv/config";

import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { articleApprovals, articleVerification } from "../src/lib/db/schema/approval";
import { articlePublishRecords } from "../src/lib/db/schema/publish";
import { articlePublishIntents } from "../src/lib/db/schema/two-step";
import { wordpressClientFromEnv } from "../src/lib/wordpress/client";
import { rawSha256FromWpHash } from "../src/lib/wordpress/article-guard-policy";
import { publishIdempotencyKey, DEFAULT_DESTINATION } from "../src/lib/publish/idempotency-policy";
import { runPublishOnce } from "../src/lib/publish/publish-worker";
import { publishWorkerDeps } from "../src/lib/publish/publish-wiring";

let pass = 0;
let fail = 0;
let controlFailed = 0;

function ok(id: string, detail: string) {
  pass += 1;
  console.log(`PASS  ${id.padEnd(14)} ${detail}`);
}
function no(id: string, detail: string, control = false) {
  fail += 1;
  if (control) controlFailed += 1;
  console.log(`FAIL  ${id.padEnd(14)} ${detail}`);
}
function eq_(id: string, actual: unknown, expected: unknown, control = false) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(id, `${a} == ${e}`);
  else no(id, `expected ${e}, got ${a}`, control);
}

/**
 * A FRESH revision per run, and that is forced by the schema rather than
 * chosen for convenience:
 *
 *   - `article_approvals` is IMMUTABLE (migration 0029 refuses UPDATE, DELETE
 *     and TRUNCATE) because consent is a historical fact. A run therefore
 *     cannot delete its own approval and reuse the identifier.
 *   - `article_approvals_article_revision_uq` allows one LIVE approval per
 *     (article, revision), so a second run on the same revision could not
 *     create one anyway.
 *
 * Teardown withdraws instead of deleting — a withdrawal is a NEW ROW pointing
 * at what it retracts, which is the mechanism `P3-R04 AC-08` specifies.
 */
const REVISION = `ac10-e2e-${Date.now().toString(36)}`;
const OWNER_TG = 1;

async function readState(wpPostId: number) {
  const client = wordpressClientFromEnv();
  return client.getArticleSyncState(wpPostId);
}

/**
 * Remove exactly what this run created — and WITHDRAW what it cannot remove.
 *
 * The approval is immutable by design, so the honest cleanup is `P3-R04 AC-08`'s
 * own mechanism: a withdrawal row pointing at it. Deleting was attempted first
 * and the database refused, which is the constraint working.
 */
async function teardown(articleId: string, approvalId: string | null) {
  const key = publishIdempotencyKey(articleId, REVISION, DEFAULT_DESTINATION);
  await db.delete(articlePublishRecords).where(eq(articlePublishRecords.idempotencyKey, key));
  await db
    .delete(articlePublishIntents)
    .where(and(eq(articlePublishIntents.articleId, articleId), eq(articlePublishIntents.revisionId, REVISION)));

  if (approvalId) {
    await db.insert(articleApprovals).values({
      articleId,
      revisionId: REVISION,
      approvedBy: OWNER_TG,
      payloadHash: "0".repeat(64),
      callbackNonce: `act_${"f".repeat(32)}`,
      expiresAt: new Date(Date.now() + 3600_000),
      withdrawsId: approvalId,
    });
  }

  // The verification row is the MUTABLE half of the split and is this run's to
  // remove. Only for the canary's own article.
  await db.delete(articleVerification).where(eq(articleVerification.articleId, articleId));
}

async function main() {
  const wpPostId = Number(process.argv[2]);

  if (!Number.isSafeInteger(wpPostId) || wpPostId <= 0) {
    console.error("usage: tsx scripts/r08-ac10-e2e.ts <wpPostId>");
    process.exit(2);
  }

  const articleId = String(wpPostId);
  console.log(`\n=== P4-R08 AC-10 E2E · post ${wpPostId} · revision ${REVISION} ===\n`);

  // ── Every phase begins by reading WordPress. The article's real state is the
  //    premise of the whole run, and asserting it here means a surprise shows
  //    up as a failed CONTROL rather than as a confusing later result.
  const before = await readState(wpPostId);
  console.log(`   WordPress: status=${before.postStatus} type=${before.postType} hash=${before.wpContentHash.slice(0, 16)}…`);

  const liveHash = rawSha256FromWpHash(before.wpContentHash);
  if (!liveHash) {
    no("CONTROL-hash", `wp_content_hash is not a readable v1 hash: ${before.wpContentHash}`, true);
    return finish();
  }
  ok("CONTROL-hash", `v1 read hash bridges to a 64-hex signature hash (${liveHash.slice(0, 12)}…)`);

  eq_("CONTROL-draft", before.postStatus, "draft", true);
  if (controlFailed) return finish();

  let approvalId: string | null = null;
  try {
    // QA must PASS for gate 3, and verification is what AC-04 reads. Both are
    // written here EXPLICITLY rather than defaulted, because a missing row
    // means "not verified" and would refuse -- which is the correct default and
    // the reason it has to be set deliberately for a publish to be eligible.
    await db
      .insert(articleVerification)
      .values({
        articleId,
        evidenceLevel: "E2",
        qaResult: "PASS",
        claimsChecked: 1,
        unsupportedClaims: 0,
        conflictingClaims: 0,
        lastVerifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: articleVerification.articleId,
        set: { evidenceLevel: "E2", qaResult: "PASS", unsupportedClaims: 0, conflictingClaims: 0 },
      });

    // The approval binds to the LIVE hash. `article_approvals_hash_shape`
    // CHECKs 64 lowercase hex, which is exactly the signature form -- the
    // database itself refuses a 'v1:'-prefixed value, which is how we know the
    // raw form is the canonical one for this chain.
    const [approval] = await db
      .insert(articleApprovals)
      .values({
        articleId,
        revisionId: REVISION,
        approvedBy: OWNER_TG,
        payloadHash: liveHash,
        callbackNonce: `act_${"0".repeat(32)}`,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning({ id: articleApprovals.id });

    approvalId = approval!.id;
    ok("approval", `article_approvals row ${approval!.id}`);

    // The intent. The 0032 trigger PROVES it matches its approval -- article,
    // revision and hash -- and refuses a withdrawal as authority. A row landing
    // here is therefore evidence the consent chain is intact, not just that an
    // INSERT ran.
    const [intent] = await db
      .insert(articlePublishIntents)
      .values({
        approvalId: approval!.id,
        articleId,
        revisionId: REVISION,
        payloadHash: liveHash,
        destination: DEFAULT_DESTINATION,
      })
      .returning({ id: articlePublishIntents.id, state: articlePublishIntents.state });

    ok("intent", `article_publish_intents row ${intent!.id} state=${intent!.state}`);
    eq_("intent-open", intent!.state, "OPEN");

    await runPhase(articleId, wpPostId, before);
  } finally {
    await teardown(articleId, approvalId);
    ok("teardown", "intent + record + verification removed; approval WITHDRAWN (immutable by design)");
  }

  return finish();
}

async function runPhase(
  articleId: string,
  wpPostId: number,
  before: Awaited<ReturnType<typeof readState>>,
) {
  //
  // The REAL worker, the REAL wiring, the REAL production database and the
  // REAL WordPress route. Only the signing key is substituted -- see the module
  // note: a correct signature here would publish a real article irreversibly.
  const realKey = process.env.DC_PUBLISH_SIGNING_KEY_V1;
  eq_("CONTROL-key", typeof realKey === "string" && realKey.length > 0, true, true);
  if (controlFailed) return finish();

  process.env.DC_PUBLISH_SIGNING_KEY_V1 = "E2E-DELIBERATELY-WRONG-KEY-never-the-production-one";

  const deps = publishWorkerDeps();
  const result = await runPublishOnce(deps);

  process.env.DC_PUBLISH_SIGNING_KEY_V1 = realKey;

  console.log(`   worker outcome: ${JSON.stringify(result).slice(0, 300)}`);

  // The whole chain ran: an intent was claimed at all.
  eq_("claimed", result.outcome, "EXECUTED");

  if (result.outcome === "EXECUTED") {
    // The three gates PASSED -- this is the part that matters for AC-10. A
    // refusal here would mean the gates stopped it before the wire, and the
    // network evidence below would be vacuous.
    eq_("gates-passed", result.result.outcome, "FAILED");

    if (result.result.outcome === "FAILED") {
      // WordPress ANSWERED. 403 FORBIDDEN is its signature verdict, reached
      // over a real HTTPS request from this host to the live route.
      eq_("wp-answered", result.result.failure.kind, "FORBIDDEN");
      eq_("not-retryable", result.result.failure.outcome.publishState, "FAILED_REQUIRES_ATTENTION");
      eq_("intent-resolved", result.result.failure.intentCancelled, true);
    }
  }

  // Read back, never trusted from the return value -- M-04.
  const after = await readState(wpPostId);
  eq_("fail-closed", after.postStatus, "draft");
  eq_("content-untouched", after.wpContentHash, before.wpContentHash);

  const key = publishIdempotencyKey(articleId, REVISION, DEFAULT_DESTINATION);
  const rec = await db
    .select({
      state: articlePublishRecords.state,
      attempts: articlePublishRecords.attempts,
      wpPostId: articlePublishRecords.wpPostId,
      kind: articlePublishRecords.lastErrorKind,
    })
    .from(articlePublishRecords)
    .where(eq(articlePublishRecords.idempotencyKey, key));

  if (!rec[0]) {
    no("record", "no article_publish_records row was written");
  } else {
    ok("record", `state=${rec[0].state} attempts=${rec[0].attempts} kind=${rec[0].kind}`);
    eq_("record-state", rec[0].state, "FAILED_REQUIRES_ATTENTION");
    eq_("attempts", rec[0].attempts, 1);
    // AC-01's negative half: nothing published means no post id is claimed.
    eq_("no-post-id", rec[0].wpPostId, null);
  }

  const intents = await db
    .select({ state: articlePublishIntents.state, resolvedAt: articlePublishIntents.resolvedAt })
    .from(articlePublishIntents)
    .where(and(eq(articlePublishIntents.articleId, articleId), eq(articlePublishIntents.revisionId, REVISION)));

  eq_("intent-cancelled", intents[0]?.state, "CANCELLED");
  eq_("resolved-at-set", intents[0]?.resolvedAt !== null, true);
}

function finish() {
  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (controlFailed > 0) {
    console.log("  VERDICT=VOID -- a control failed, so nothing here is evidence");
    process.exit(1);
  }
  console.log(fail === 0 ? "  VERDICT=PASS" : "  VERDICT=FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
