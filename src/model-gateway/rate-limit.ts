/**
 * Best-effort per-process rate limiter. This is an abuse guard for a single
 * runtime instance, not a distributed quota ledger; use an edge/platform limit
 * if the deployment scales horizontally.
 */
type Bucket = { startedAt: number; count: number };
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

export function checkGatewayRateLimit(key: string, now = Date.now(), maxRequests = MAX_REQUESTS_PER_WINDOW): {
  allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number;
} {
  if (buckets.size > 10_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.startedAt >= WINDOW_MS) buckets.delete(bucketKey);
    }
  }
  const requestLimit = Number.isFinite(maxRequests) ? Math.max(1, Math.min(1000, Math.floor(maxRequests))) : MAX_REQUESTS_PER_WINDOW;
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    buckets.set(key, bucket);
  }
  if (bucket.count >= requestLimit) {
    return {
      allowed: false, limit: requestLimit, remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + WINDOW_MS - now) / 1000))
    };
  }
  bucket.count += 1;
  return {
    allowed: true, limit: requestLimit,
    remaining: Math.max(0, requestLimit - bucket.count),
    retryAfterSeconds: 0
  };
}
