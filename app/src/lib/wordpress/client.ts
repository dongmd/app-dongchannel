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
export type WordpressErrorKind =
  | "TRANSPORT"        // retryable: connection reset, DNS, TLS
  | "TIMEOUT"          // retryable
  | "SERVER"           // retryable: 5xx
  | "RATE_LIMITED"     // retryable, honour Retry-After
  | "IN_FLIGHT"        // retryable: 409 REQUEST_IN_FLIGHT, another worker owns it
  | "CONFLICT"         // NOT retryable: 412 precondition -- WordPress changed
  | "KEY_REUSED"       // NOT retryable: 409 IDEMPOTENCY_KEY_REUSED, a client bug
  | "VALIDATION"       // NOT retryable: 400
  | "FORBIDDEN"        // NOT retryable: 403 -- includes affiliate/verification refusals
  | "UNAUTHENTICATED"  // NOT retryable: 401 -- credential problem, not a blip
  | "NOT_FOUND"        // NOT retryable: 404
  | "DISABLED"         // retryable: 503, the namespace kill switch is off
  | "UNKNOWN";

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
    switch (this.kind) {
      case "TRANSPORT":
      case "TIMEOUT":
      case "SERVER":
      case "RATE_LIMITED":
      case "IN_FLIGHT":
      case "DISABLED":
        return true;
      default:
        return false;
    }
  }
}

const RETRYABLE_CODES = new Set(["REQUEST_IN_FLIGHT", "RATE_LIMITED", "NAMESPACE_DISABLED", "WRITES_DISABLED"]);

function classify(status: number, code: string): WordpressErrorKind {
  if (code === "REQUEST_IN_FLIGHT") return "IN_FLIGHT";
  if (code === "IDEMPOTENCY_KEY_REUSED") return "KEY_REUSED";
  if (code === "NAMESPACE_DISABLED" || code === "WRITES_DISABLED") return "DISABLED";

  switch (status) {
    case 400:
    case 415:
      return "VALIDATION";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return RETRYABLE_CODES.has(code) ? "IN_FLIGHT" : "KEY_REUSED";
    case 412:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "SERVER" : "UNKNOWN";
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
    options: { body?: unknown; idempotencyKey?: string; correlationId?: string } = {},
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
        classify(response.status, code),
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
