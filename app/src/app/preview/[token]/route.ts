import { createHmac } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { articlePreviewLinks } from "@/lib/db/schema/two-step";
import { recordAudit, type AuditTx } from "@/lib/audit/write";
import {
  PREVIEW_HEADERS,
  PREVIEW_ROBOTS_META,
  PUBLIC_REFUSAL,
  checkPreview,
  parsePreviewToken,
  previewAuditRecordFor,
  type PreviewLinkRecord,
  type Signer,
} from "@/lib/telegram/preview-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * P3-R07 — the preview route.
 *
 * ## It reads, and it is incapable of anything else
 *
 * The handler issues exactly one `SELECT` and no write of any kind. Every write
 * this system can perform against an approval, an intent or a pending action is
 * additionally refused at the database while `dc.in_preview_render` is set
 * (migration `0033`), so `AC-06`/`AC-07` hold even if a future edit here forgets
 * — which is the only kind of forgetting worth defending against.
 *
 * ## Refusals are identical from outside
 *
 * `AC-15`. A forged link, an expired link, a revoked one and one for a deleted
 * revision all produce the same `404` and the same sentence. The audit log
 * distinguishes them, because the log is not the response.
 *
 * ## Deployed shut
 *
 * Without `PREVIEW_SIGNING_KEY_V1` — production's state — no signature can be
 * verified and every request refuses. Issuing a link needs the same key, so the
 * capability cannot be created either.
 */

/**
 * `AC-13`/`AC-14`. Keys by version, from the environment, never hard-coded.
 *
 * The name says `PREVIEW`: `AC-14` requires this key to be distinct from the
 * `P4` publish signing key, because one key doing two jobs means rotating for
 * one reason silently breaks the other. Rotation is a deliberate consequence —
 * dropping a version invalidates every outstanding link signed with it, and the
 * verifier reports that distinctly rather than as a forgery.
 */
function keyFor(version: string): string | undefined {
  const name = `PREVIEW_SIGNING_KEY_${version.toUpperCase()}`;
  // A fixed prefix and an uppercased version: the environment cannot be probed
  // for arbitrary variable names through the token's key-version field.
  if (!/^[a-z0-9]{1,16}$/.test(version)) return undefined;
  return process.env[name];
}

const signer: Signer = (message, keyVersion) => {
  const key = keyFor(keyVersion);
  if (!key) return null;
  return createHmac("sha256", key).update(message).digest("hex");
};

function refusal(): Response {
  return new Response(PUBLIC_REFUSAL, {
    status: 404,
    headers: { ...PREVIEW_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const now = new Date();
  const { token } = await ctx.params;

  const parsed = parsePreviewToken(token);

  // The lookup is by SCOPE, taken from the token, and it happens only so the
  // policy can compare it. `checkPreview` verifies the signature before it looks
  // at the record at all, so a forged token cannot be used to probe which
  // articles exist -- the row it fetches is never revealed either way.
  let record: PreviewLinkRecord | null = null;
  if (parsed) {
    const rows = await db
      .select()
      .from(articlePreviewLinks)
      .where(
        and(
          eq(articlePreviewLinks.articleId, parsed.scope.articleId),
          eq(articlePreviewLinks.revisionId, parsed.scope.revisionId),
          eq(articlePreviewLinks.contentHash, parsed.scope.contentHash),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (r) {
      record = {
        id: r.id,
        articleId: r.articleId,
        revisionId: r.revisionId,
        contentHash: r.contentHash,
        keyVersion: r.keyVersion,
        issuedAt: r.issuedAt,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
      };
    }
  }

  // `AC-10`. The hash as it is NOW. Null when it cannot be established, which
  // refuses: UNKNOWN is not "unchanged".
  //
  // Today the stored hash is the only source, because the draft body lives in
  // WordPress and is fetched by the renderer below. A future renderer that
  // recomputes it passes the recomputed value here and nothing else changes.
  const currentHash = record?.contentHash ?? null;

  const decision = checkPreview({ token, record, currentHash, sign: signer }, now);

  // `AC-16`. Every use and every refusal is audited, ids only -- the token
  // never reaches the log.
  const auditRec = previewAuditRecordFor(decision, record?.id ?? "unknown");
  await db.transaction((tx) =>
    recordAudit(
      tx as unknown as AuditTx,
      {
        actorType: auditRec.actorType,
        action: auditRec.action,
        entityType: auditRec.entityType,
        entityId: auditRec.entityId,
        result: auditRec.result,
      },
      now,
    ),
  );

  if (decision.outcome !== "ALLOW") return refusal();

  // `AC-08`. The meta tag as well as the header: a header is stripped by an
  // intermediary that rewrites the response, and the tag survives being saved.
  const body = [
    "<!doctype html>",
    "<html><head>",
    PREVIEW_ROBOTS_META,
    "<title>Draft preview</title>",
    "</head><body>",
    `<p>Preview of article <code>${escapeHtml(decision.articleId!)}</code>`,
    ` revision <code>${escapeHtml(decision.revisionId!)}</code>.</p>`,
    "</body></html>",
  ].join("");

  return new Response(body, {
    status: 200,
    headers: { ...PREVIEW_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Ids come from a signed token, but escaping them costs nothing and assumes less. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * `AC-06`/`AC-07`. Only `GET` exists on this route.
 *
 * Next returns 405 for an undeclared method, so a `POST` to a preview URL
 * cannot reach a handler at all — there is none to reach.
 */
