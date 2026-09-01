import "server-only";

// P1-R05 — the WordPress side of the sync, spoken only through dc/v1.
//
// The generic /wp/v2 routes are not an option and not a fallback. R07 closed
// them for this identity by removing `edit_posts` and `upload_files`, so a
// request there fails; more to the point, two write doors with different rules
// is exactly what G-52 exists to prevent.
//
// Nothing here retries on its own. Classification is this module's job; the
// worker decides what to do with it, because a retry policy buried inside an
// HTTP client is a retry policy nobody can see.

export interface WordpressConfig {
  baseUrl: string;
  user: string;
  /** Application Password. Never logged, never echoed, never serialised. */
  password: string;
  timeoutMs?: number;
}

export interface SyncBaseline {
  /** Opaque, version-prefixed. Stored verbatim; never parsed, never recomputed. */
  wpContentHash: string;
  /**
   * Nullable **by contract**. Null means WordPress cannot date the post, which
   * is not "unchanged" -- sending it as a baseline is refused server-side, and
   * that is the correct outcome.
   */
  postModifiedGmt: string | null;
}

export interface ProductProjection {
  id: number;
  slug: string;
  title: string;
  postStatus: string;
  postModifiedGmt: string | null;
  wpContentHash: string;
  facts: Record<string, unknown>;
}

/** P1-R06 — the read half of the §1B guard, exactly as R07 returns it. */
export interface ArticleSyncState {
  id: number;
  postType: string;
  postStatus: string;
  /** Nullable by contract. Null is "WordPress cannot date this", never "unchanged". */
  postModifiedGmt: string | null;
  wpContentHash: string;
  dcVerified: boolean;
}

export interface PatchResult {
  id: number;
  applied: string[];
  cleared: string[];
  unchanged: string[];
  postModifiedGmt: string | null;
  wpContentHash: string;
  idempotentReplay: boolean;
}

/**
 * Every failure mode the worker needs to tell apart.
 *
 * The split that matters is retryable vs not. Retrying a 400 only fails faster
 * (PROPOSED §9), and retrying a 412 is worse than useless -- it is a conflict
 * that needs a human, and hammering it would turn one stale baseline into a
 * loop that never resolves.
 */
import { classifyWordpressError, isRetryableKind, type WordpressErrorKind } from "./retry-policy";

export type { WordpressErrorKind } from "./retry-policy";

export class WordpressError extends Error {
  constructor(
    readonly kind: WordpressErrorKind,
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "WordpressError";
  }

  get retryable(): boolean {
    return isRetryableKind(this.kind);
  }
}


interface Envelope<T> {
  data: T | null;
  meta?: { request_id?: string; contract_version?: string; idempotent_replay?: boolean };
  error: { code: string; message: string; details?: unknown } | null;
}

export class WordpressClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: WordpressConfig) {
    if (!/^https:\/\//i.test(config.baseUrl)) {
      // The API refuses plaintext server-side too, but failing here means a
      // misconfiguration never gets as far as putting a credential on the wire.
      throw new Error("WORDPRESS_BASE_URL must be https");
    }
    this.base = config.baseUrl.replace(/\/+$/, "");
    this.auth = Buffer.from(`${config.user}:${config.password}`).toString("base64");
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      correlationId?: string;
      /** P4-R08 AC-06/AC-10 -- the signed-publish exception headers. Merged in last; see publishStatus(). */
      extraHeaders?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<{ data: T; replay: boolean; requestId?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      // Basic over TLS. This header is the credential; it is never logged, and
      // it is never included in an error message.
      Authorization: `Basic ${this.auth}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.correlationId) headers["X-Request-ID"] = options.correlationId;
    if (options.extraHeaders) Object.assign(headers, options.extraHeaders);

    let response: Response;
    try {
      response = await fetch(`${this.base}/wp-json/dc/v1${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new WordpressError(
        aborted ? "TIMEOUT" : "TRANSPORT",
        aborted ? "TIMEOUT" : "TRANSPORT",
        // Deliberately not `${err}` -- a transport error can carry the request
        // URL, and the URL is fine, but the habit of interpolating error
        // objects is how headers end up in logs.
        aborted ? `Request timed out after ${this.timeoutMs}ms` : "Transport failure contacting WordPress",
      );
    } finally {
      clearTimeout(timer);
    }

    let envelope: Envelope<T> | null = null;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      envelope = null;
    }

    if (!response.ok || envelope?.error) {
      const code = envelope?.error?.code ?? `HTTP_${response.status}`;
      const retryAfter = Number(response.headers.get("retry-after") ?? "") || undefined;
      throw new WordpressError(
        classifyWordpressError(response.status, code),
        code,
        envelope?.error?.message ?? `WordPress returned ${response.status}`,
        response.status,
        retryAfter,
      );
    }

    if (envelope?.data == null) {
      throw new WordpressError("UNKNOWN", "EMPTY_ENVELOPE", "WordPress returned an empty data envelope", response.status);
    }

    return {
      data: envelope.data,
      replay: envelope.meta?.idempotent_replay === true,
      requestId: envelope.meta?.request_id,
    };
  }

  /**
   * Contract handshake. The capability assertion is checked, not trusted: if
   * WordPress ever reports that this identity holds `dc_manage_affiliate`, the
   * standing non-negotiable has been broken somewhere and the sync must not run.
   */
  async health(correlationId?: string): Promise<{ contractVersion: string; writesEnabled: boolean; login: string }> {
    const { data } = await this.request<{
      contract_version: string;
      namespace_enabled: boolean;
      writes_enabled: boolean;
      identity: { login: string; roles: string[] };
      capabilities: Record<string, boolean>;
    }>("GET", "/health", { correlationId });

    if (data.capabilities?.dc_manage_affiliate === true) {
      throw new WordpressError(
        "FORBIDDEN",
        "AFFILIATE_CAPABILITY_PRESENT",
        "The integration identity holds dc_manage_affiliate; refusing to sync.",
      );
    }

    return {
      contractVersion: data.contract_version,
      writesEnabled: data.writes_enabled === true,
      login: data.identity?.login ?? "",
    };
  }

  async getProduct(wpPostId: number, correlationId?: string): Promise<ProductProjection> {
    const { data } = await this.request<{
      id: number;
      slug: string;
      title: string;
      post_status: string;
      post_modified_gmt: string | null;
      wp_content_hash: string;
      facts: Record<string, unknown>;
    }>("GET", `/products/${wpPostId}`, { correlationId });

    return {
      id: data.id,
      slug: data.slug,
      title: data.title,
      postStatus: data.post_status,
      postModifiedGmt: data.post_modified_gmt,
      wpContentHash: data.wp_content_hash,
      facts: data.facts ?? {},
    };
  }

  /**
   * The one write path. Sparse: a key absent means "leave it alone", an
   * explicit null means "clear it".
   */
  async patchFacts(
    wpPostId: number,
    baseline: SyncBaseline,
    facts: Record<string, unknown>,
    idempotencyKey: string,
    correlationId?: string,
  ): Promise<PatchResult> {
    const { data, replay } = await this.request<{
      id: number;
      applied: string[];
      cleared: string[];
      unchanged: string[];
      post_modified_gmt: string | null;
      wp_content_hash: string;
    }>("PATCH", `/products/${wpPostId}/facts`, {
      idempotencyKey,
      correlationId,
      body: {
        baseline: {
          post_modified_gmt: baseline.postModifiedGmt,
          wp_content_hash: baseline.wpContentHash,
        },
        facts,
      },
    });

    return {
      id: data.id,
      applied: data.applied ?? [],
      cleared: data.cleared ?? [],
      unchanged: data.unchanged ?? [],
      postModifiedGmt: data.post_modified_gmt,
      wpContentHash: data.wp_content_hash,
      idempotentReplay: replay,
    };
  }

  /**
   * P1-R06 — read the comparison input for one article.
   *
   * Returns what WordPress says right now. It makes no judgement: deciding
   * whether that agrees with a baseline is the guard's job, and keeping the two
   * apart is what lets the guard be tested without a network.
   */
  async getArticleSyncState(wpPostId: number, correlationId?: string): Promise<ArticleSyncState> {
    const { data } = await this.request<{
      id: number;
      post_type: string;
      post_status: string;
      post_modified_gmt: string | null;
      wp_content_hash: string;
      dc_verified: boolean;
    }>("GET", `/articles/${wpPostId}/sync-state`, { correlationId });

    return {
      id: data.id,
      postType: data.post_type,
      postStatus: data.post_status,
      postModifiedGmt: data.post_modified_gmt,
      wpContentHash: data.wp_content_hash,
      dcVerified: data.dc_verified === true,
    };
  }

  /**
   * `P4-R08 AC-06`/`AC-10` -- the one door through which this identity can
   * ever reach `post_status = 'publish'`. `signatureHeaders` carries
   * `X-DC-Publish-Signature` / `X-DC-Publish-Revision`
   * (`publish-signature.ts`'s `signPublishRequest`); this method adds no
   * signing logic of its own, matching the split `preview-policy.ts` /
   * `publish-signer.ts` already draw between policy and crypto.
   *
   * No body is sent. `dc_v1_handle_publish_status()` accepts one only to echo
   * a `revision_id` for its own audit trail -- the authorisation decision is
   * carried entirely by the headers, read via `$_SERVER` before any body is
   * parsed. Sending one would add a JSON content-type requirement for no
   * contract benefit.
   *
   * Returns whatever WordPress answered, `post_status` included, WITHOUT
   * asserting it equals `'publish'`. WordPress's own guard already refuses a
   * mismatch with `PUBLISH_NOT_APPLIED` (403) before a 200 can carry
   * anything else -- but `publish-executor.ts` re-verifies the body per M-04
   * rather than trusting a call that merely did not throw, and that check
   * belongs in exactly one place. Duplicating it here would be the "two
   * classifiers that can disagree" defect `P4-R07 AC-06` names, applied to
   * this contract instead of QA.
   */
  async publishStatus(
    wpPostId: number,
    signatureHeaders: Readonly<Record<string, string>>,
    correlationId?: string,
  ): Promise<{ id: number; postStatus: string; postModifiedGmt: string | null; wpContentHash: string }> {
    const { data } = await this.request<{
      id: number;
      post_status: string;
      post_modified_gmt: string | null;
      wp_content_hash: string;
    }>("PATCH", `/articles/${wpPostId}/publish-status`, {
      correlationId,
      extraHeaders: signatureHeaders,
    });

    return {
      id: data.id,
      postStatus: data.post_status,
      postModifiedGmt: data.post_modified_gmt,
      wpContentHash: data.wp_content_hash,
    };
  }
}

/**
 * `P4-R08 AC-10` -- adapts `WordpressClient.publishStatus` to
 * `publish-executor.ts`'s injected `WordpressPublishCall` shape.
 *
 * The executor stays free of `WordpressError`, `fetch` and `server-only` --
 * see that module's own boundary test -- so this is the one place a thrown
 * `WordpressError` becomes the plain `{ status, code, kind }` the executor's
 * classifier-reuse (`resolvePublishFailure`, `TD-21`) already knows how to
 * read. An error this client did not throw as `WordpressError` (a bug, not a
 * WordPress refusal) is deliberately NOT swallowed here -- it propagates, so
 * a defect in this file fails loudly instead of being filed as a WordPress
 * error it never was.
 *
 * `kind` is carried through rather than dropped. `TRANSPORT`/`TIMEOUT`
 * (`request()`'s catch block, above) are thrown with no real HTTP status --
 * the request never reached WordPress -- so `classifyWordpressError(status,
 * code)` cannot reconstruct them from `(0, "TRANSPORT")` and would answer
 * `UNKNOWN`, which is not retryable. `article-guard.ts` and `sync-worker.ts`
 * both read `err.kind` directly for the identical reason; this adapter now
 * does the same rather than re-deriving a worse answer from strictly less
 * information.
 *
 * Untested at THIS layer, deliberately, like every other method on
 * `WordpressClient` -- importing this file drags in `server-only`, which
 * throws outside a server bundling context and makes a plain `node:test` run
 * of this module impossible (confirmed while writing this function: a
 * `client.test.ts` was attempted and removed for exactly this reason). The
 * flattening this function does is instead proven at `publish-executor.
 * test.ts`'s "REGRESSION: a TRANSPORT/TIMEOUT failure" case, one layer up,
 * against a fake shaped like this function's own return type.
 */
export function wordpressPublishCall(
  client: WordpressClient,
): (
  wpPostId: number,
  headers: Readonly<Record<string, string>>,
) => Promise<
  | { readonly ok: true; readonly postStatus: string; readonly postModifiedGmt: string | null }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly kind: WordpressErrorKind }
> {
  return async (wpPostId, headers) => {
    try {
      const result = await client.publishStatus(wpPostId, headers);
      return { ok: true, postStatus: result.postStatus, postModifiedGmt: result.postModifiedGmt };
    } catch (err) {
      if (err instanceof WordpressError) {
        return { ok: false, status: err.httpStatus ?? 0, code: err.code, kind: err.kind };
      }
      throw err;
    }
  };
}

/**
 * Build a client from the environment.
 *
 * Reads at call time rather than at module load: a missing variable should fail
 * the job that needed it, with a name, not the whole process at import.
 */
export function wordpressClientFromEnv(): WordpressClient {
  const baseUrl = process.env.WORDPRESS_BASE_URL;
  const user = process.env.WORDPRESS_INTEGRATION_USER;
  const password = process.env.WORDPRESS_APPLICATION_PASSWORD;

  const missing = [
    !baseUrl && "WORDPRESS_BASE_URL",
    !user && "WORDPRESS_INTEGRATION_USER",
    !password && "WORDPRESS_APPLICATION_PASSWORD",
  ].filter(Boolean);

  if (missing.length > 0) {
    // Names only. Never the values, and never a partial value as a hint.
    throw new Error(`WordPress sync is not configured: missing ${missing.join(", ")}`);
  }

  return new WordpressClient({ baseUrl: baseUrl!, user: user!, password: password! });
}
