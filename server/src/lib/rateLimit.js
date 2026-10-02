import { redis } from '../redis.js';

/**
 * Sliding-window-counter limiter: weights the previous fixed window by how much of it
 * still overlaps the sliding window, which avoids the 2x burst at fixed-window edges.
 */
export async function rateLimit(key, limit, windowMs = 60_000) {
  const now = Date.now();
  const win = Math.floor(now / windowMs);
  const cur = `rl:${key}:${win}`;
  const prev = `rl:${key}:${win - 1}`;
  const [[, count], [, prevCount]] = await redis
    .multi()
    .incr(cur)
    .pexpire(cur, windowMs * 2)
    .get(prev)
    .exec()
    .then((r) => [r[0], r[2]]);
  const weight = 1 - (now % windowMs) / windowMs;
  const used = count + Math.floor(Number(prevCount || 0) * weight);
  const allowed = used <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - used),
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000)),
  };
}
