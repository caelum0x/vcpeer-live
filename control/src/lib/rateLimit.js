'use strict';

/**
 * Minimal in-memory fixed-window rate limiter. No new dependency - this
 * control app already deliberately avoids a database (see lib/store.js),
 * and request-rate bookkeeping is the one place a plain mutable Map is
 * the right tool: it's ephemeral counters, not business data, and a
 * process restart harmlessly resets it (worst case one extra burst right
 * after a deploy).
 *
 * `check(key)` is the only mutation point and is intentionally isolated
 * here so callers (routes) stay pure/testable against an injected clock.
 */
function createRateLimiter({ windowMs, max }) {
  if (!(windowMs > 0)) throw new Error('windowMs must be a positive number');
  if (!(max > 0)) throw new Error('max must be a positive number');

  const hits = new Map(); // key -> { count, resetAt }

  return {
    /** Returns { limited, retryAfterMs } for `key` at time `now`. */
    check(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || now >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { limited: false, retryAfterMs: 0 };
      }
      if (entry.count >= max) {
        return { limited: true, retryAfterMs: entry.resetAt - now };
      }
      hits.set(key, { ...entry, count: entry.count + 1 });
      return { limited: false, retryAfterMs: 0 };
    },
  };
}

module.exports = { createRateLimiter };
