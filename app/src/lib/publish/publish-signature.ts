/**
 * `P4-R08 AC-06`/`AC-10` — the Repo B half of the signed-approval exception.
 *
 * WordPress's `dc_core_publish_signature_valid()`
 * (`wp-content/plugins/dc-core/includes/publish-exception.php`) is the
 * CONTRACT this module must match exactly. It is not derived here — it was
 * shipped first, deployed to production 2026-08-31, and this module conforms
 * to what it already checks:
 *
 *   payload    `$post_id . '.' . $rev . '.' . $content_hash`  — three fields,
 *              dot-joined, in that order, with NO encoding of the parts.
 *   algorithm  `hash_hmac( 'sha256', $payload, $key )` — HMAC-SHA256, lowercase
 *              hex output (PHP's default, `raw_output = false`).
 *   headers    `X-DC-Publish-Signature` and `X-DC-Publish-Revision`, read by
 *              PHP as `$_SERVER['HTTP_X_DC_PUBLISH_SIGNATURE']` /
 *              `['HTTP_X_DC_PUBLISH_REVISION']` — the standard CGI header
 *              transform, so the outgoing names below are exact, not a guess.
 *   fails      An absent key, an absent header, or a mismatch all verify
 *   closed     `false` on the WordPress side (see that file). This module
 *              mirrors the same discipline on the way out: no key means no
 *              signature is produced, ever — never a signature over an empty
 *              or placeholder key.
 *
 * `wp-content/plugins/dc-core/tools/test-publish-exception.py` asserts the
 * PHP side's payload format and algorithm as literal source strings. Nothing
 * here may drift from it without that check and this one both changing.
 *
 * ## Pure, like `publisher-policy.ts` and `preview-policy.ts`
 *
 * No `node:crypto` import, no network, no `server-only`. The real HMAC
 * implementation is injected as a `Signer`, exactly as `preview-policy.ts`
 * does for the `P3-R07` preview link — a policy module that can compute its
 * own cryptography is a policy module a test cannot exercise without a real
 * key, and it is a policy module the boundary test below cannot hold to
 * "no crypto in here" by construction rather than by promise.
 *
 * This module does not call WordPress. The HTTP client that will one day POST
 * a publish with these headers does not exist yet — `wordpress/client.ts`
 * exposes no article-publish route, and `wp-content/plugins/dc-core`'s dc/v1
 * namespace registers exactly four routes, none of which can change a post's
 * status. Building that executor is `P4-R08 AC-10`'s remaining work and is
 * deliberately out of scope here, matching `publish-runner.ts`'s own note:
 * "Deliberately not a publisher."
 */

// ─── The wire contract ──────────────────────────────────────────────

/**
 * Exact outgoing header names. WordPress reads them via `$_SERVER`'s
 * `HTTP_` + uppercase-with-underscores transform of these, so the names here
 * are not a style choice -- changing either string breaks the exception on
 * the WordPress side without a single test on this side failing.
 */
export const PUBLISH_SIG_HEADER = "X-DC-Publish-Signature" as const;
export const PUBLISH_REV_HEADER = "X-DC-Publish-Revision" as const;

export interface PublishSignatureInput {
  /** The WordPress post id the write targets. */
  readonly wpPostId: number;
  readonly revisionId: string;
  /** The hash of the content being written -- `publisher-policy.ts`'s `contentHash`. */
  readonly contentHash: string;
}

/**
 * An HMAC-SHA256 over a string, hex encoded, or `null` when no key is
 * available. Injected so this file never imports `node:crypto` -- see the
 * module note.
 */
export type Signer = (message: string) => string | null;

/**
 * The exact string WordPress hashes. `String(wpPostId)` matches PHP's
 * post-id-to-string coercion in string concatenation; no other formatting
 * (no leading zeros, no locale separators) is applied on either side.
 */
export function publishSignaturePayload(input: PublishSignatureInput): string {
  return `${input.wpPostId}.${input.revisionId}.${input.contentHash}`;
}

export type PublishSignResult =
  | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: "SIGNING_KEY_UNAVAILABLE" };

/**
 * `AC-07`. Sign one publish request.
 *
 * Fails closed: if `sign` returns `null` (the key is not configured), this
 * returns a refusal rather than a signature computed over an empty key or a
 * placeholder -- there is no code path here that can produce a header pair
 * without a real key having signed the real payload.
 */
export function signPublishRequest(
  input: PublishSignatureInput,
  sign: Signer,
): PublishSignResult {
  const payload = publishSignaturePayload(input);
  const signature = sign(payload);

  if (!signature) {
    return { ok: false, reason: "SIGNING_KEY_UNAVAILABLE" };
  }

  return {
    ok: true,
    headers: {
      [PUBLISH_SIG_HEADER]: signature,
      [PUBLISH_REV_HEADER]: input.revisionId,
    },
  };
}
