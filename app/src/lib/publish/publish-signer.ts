import { createHmac } from "node:crypto";

import { PUBLISH_KEY_ENV } from "./publisher-policy";
import type { Signer } from "./publish-signature";

/**
 * `AC-07`. The real signer, built from the environment.
 *
 * Kept in its own tiny file, apart from `publish-signature.ts`, for the same
 * reason `preview/[token]/route.ts` keeps `createHmac` out of
 * `preview-policy.ts`: the policy stays crypto-free and this is the one place
 * that is not.
 *
 * Reads `process.env` on every call rather than once at import time, so a
 * process that had no key at startup still works the moment one is deployed
 * without needing this module reloaded — mirroring `wordpressClientFromEnv`'s
 * "reads at call time" discipline in `wordpress/client.ts`.
 *
 * Never throws. A missing key produces a `Signer` that returns `null`, which
 * `signPublishRequest` turns into `SIGNING_KEY_UNAVAILABLE` — fail-closed, the
 * same shape `dc_core_publish_signature_valid()` fails closed on the
 * WordPress side.
 */
export function publishSignerFromEnv(): Signer {
  return (message: string): string | null => {
    const key = process.env[PUBLISH_KEY_ENV];
    if (!key) return null;
    return createHmac("sha256", key).update(message).digest("hex");
  };
}
