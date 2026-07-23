import "server-only";

// AC01 — token bucket per (route, key) in-memory. V1 đủ cho single-instance.
// V1.1 nếu chạy multi-instance behind load balancer → move sang Redis.

interface Bucket {
  tokens: number;
  lastRefillAt: number; // ms epoch
}

interface Limiter {
  capacity: number; // max tokens
  refillPerSec: number; // tokens refilled per second
}

const buckets = new Map<string, Bucket>();

// Cleanup stale buckets mỗi 10 phút để tránh memory leak.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    // Nếu bucket đầy tokens và không update trong 30 phút → xoá
    if (now - bucket.lastRefillAt > 30 * 60 * 1000) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref?.();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs?: number;
}

export function checkRateLimit(key: string, limiter: Limiter): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limiter.capacity, lastRefillAt: now };
    buckets.set(key, bucket);
  }

  // Refill based on elapsed time
  const elapsedSec = (now - bucket.lastRefillAt) / 1000;
  if (elapsedSec > 0) {
    bucket.tokens = Math.min(limiter.capacity, bucket.tokens + elapsedSec * limiter.refillPerSec);
    bucket.lastRefillAt = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  const need = 1 - bucket.tokens;
  const retryAfterMs = Math.ceil((need / limiter.refillPerSec) * 1000);
  return { ok: false, remaining: 0, retryAfterMs };
}

// Preset limiters — bám PRD "rate limit login, destructive actions và webhook".
export const LIMITERS = {
  login: { capacity: 10, refillPerSec: 10 / 60 }, // 10/min
  destructive: { capacity: 30, refillPerSec: 30 / 60 }, // 30/min
  readOnly: { capacity: 300, refillPerSec: 300 / 60 }, // 300/min (5/s)
} as const;

// Helper key builder — {route}:{ip} an toàn cho reverse-proxy X-Forwarded-For.
export function makeKey(prefix: string, ip: string | null | undefined): string {
  return `${prefix}:${ip ?? "unknown"}`;
}
