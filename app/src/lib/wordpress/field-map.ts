import type { ProductRow } from "@/lib/db/schema/wordpress";

// P1-R05 — the one place that knows how an app product becomes dc/v1 facts.
//
// The keys below are exactly the dc/v1 writable allowlist. That allowlist is
// itself derived server-side from dc_core_product_meta_schema(), so this file
// is a mirror of a mirror -- which is why it is one table, in one place, tested
// against the live contract rather than trusted.
//
// Anything absent here is absent on purpose:
//
//   dc_aff_* , dc_override_* , dc_deal_aff_url   payout destinations. The
//       integration must never hold dc_manage_affiliate, and the server refuses
//       these keys outright. Sending one is a 403 for the whole request.
//   dc_verified*                                 derived from evidence and QA.
//       Approval is not verification and no sync may assert it.
//   dc_rating                                    no published scoring rubric
//       exists yet (P5-R06).
//   dc_short_desc, dc_full_desc, dc_best_for,
//   dc_verdict, dc_pros, dc_cons                 editorial prose. WordPress
//       owns writing; the app owns researched facts (SOURCE_OF_TRUTH §2 rule 1).
//   post_status, post_title, post_content        publishing and prose. Not ours.

/** dc/v1 meta key → how to read it off an app product row. */
type FactReader = (p: ProductRow) => unknown;

const FIELD_MAP: Readonly<Record<string, FactReader>> = Object.freeze({
  dc_vendor: (p) => p.vendor,
  dc_official_url: (p) => p.officialUrl,
  dc_pricing_model: (p) => p.pricingModel,
  dc_price_amount: (p) => p.priceAmount,
  dc_price_currency: (p) => p.priceCurrency,
  dc_price_period: (p) => p.pricePeriod,
  dc_price_display: (p) => p.priceDisplay,
  dc_free_plan: (p) => p.freePlan,
  dc_free_trial: (p) => p.freeTrial,
  dc_trial_length: (p) => p.trialLength,
  dc_moneyback: (p) => p.moneyback,
  dc_has_coupon: (p) => p.hasCoupon,
  dc_last_verified: (p) => p.lastVerified,
  dc_last_price_check: (p) => p.lastPriceCheck,
  dc_active: (p) => p.active,
});

export const MANAGED_FIELD_KEYS: readonly string[] = Object.freeze(Object.keys(FIELD_MAP));

/** Keys the sync must never send, asserted here as well as refused server-side. */
export const FORBIDDEN_FIELD_PREFIXES = Object.freeze(["dc_aff_", "dc_override_", "dc_verified"]);
export const FORBIDDEN_FIELD_KEYS = Object.freeze(["dc_deal_aff_url", "dc_rating", "post_status", "post_title", "post_content"]);

export function isForbiddenField(key: string): boolean {
  return (
    FORBIDDEN_FIELD_KEYS.includes(key) ||
    FORBIDDEN_FIELD_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Build the sparse `facts` object for a PATCH.
 *
 * `undefined` and `null` are different answers and are treated as such:
 * `undefined` means the app has nothing to say, so the key is omitted and
 * WordPress leaves it alone; an explicit `null` means "clear this". Collapsing
 * the two would make "we never researched this" indistinguishable from "we
 * checked and there is none" — the UNKNOWN-is-not-false invariant, applied to
 * the wire.
 */
export function buildFacts(product: ProductRow): Record<string, unknown> {
  const facts: Record<string, unknown> = {};

  for (const [key, read] of Object.entries(FIELD_MAP)) {
    if (isForbiddenField(key)) {
      // Unreachable unless someone edits the map badly, which is exactly when
      // an assertion earns its place.
      throw new Error(`field-map contains a forbidden key: ${key}`);
    }

    const value = read(product);
    if (value === undefined) continue;

    // Booleans and dates travel in the shapes dc/v1 validates: booleans as
    // booleans, dates as YYYY-MM-DD strings, decimals as fixed-precision
    // strings. The server rejects rather than coerces (D-13), so guessing here
    // produces a 400 rather than a silent divergence.
    if (value instanceof Date) {
      facts[key] = value.toISOString().slice(0, 10);
      continue;
    }

    facts[key] = value;
  }

  return facts;
}

/**
 * Deterministic idempotency key.
 *
 * Derived from intent — product, version, destination — and never from the
 * attempt. A key regenerated per attempt, or after a process restart, turns
 * R07's duplicate protection into decoration.
 */
export function idempotencyKeyFor(productId: string, sourceVersion: number): string {
  return `r05:${productId}:v${sourceVersion}:wp-product-facts`;
}
