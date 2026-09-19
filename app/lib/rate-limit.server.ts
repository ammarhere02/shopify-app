/**
 * Fixed-window in-memory rate limiter. One process only: counters reset on restart and are
 * not shared between instances (documented limit; a multi-instance deploy needs Redis/MySQL).
 */
export type RateLimiter = ReturnType<typeof createRateLimiter>;

export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxEntries?: number;
}) {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const current = (key: string) => {
    const entry = windows.get(key);
    if (entry && entry.resetAt > now()) return entry;
    windows.delete(key);
    return undefined;
  };
  const retryAfterSec = (resetAt: number) => Math.max(1, Math.ceil((resetAt - now()) / 1000));

  return {
    /** Count one event. `allowed` is false once the window already holds `limit` events. */
    hit(key: string): { allowed: boolean; retryAfterSec: number } {
      let entry = current(key);
      if (!entry) {
        // Bound memory: keys can be attacker-chosen (IPs), so drop expired windows when large.
        if (windows.size >= maxEntries) {
          for (const [k, v] of windows) if (v.resetAt <= now()) windows.delete(k);
          if (windows.size >= maxEntries) windows.clear();
        }
        entry = { count: 0, resetAt: now() + opts.windowMs };
        windows.set(key, entry);
      }
      if (entry.count >= opts.limit) return { allowed: false, retryAfterSec: retryAfterSec(entry.resetAt) };
      entry.count++;
      return { allowed: true, retryAfterSec: 0 };
    },
    /** Check without counting (used before auth to see if an IP is already blocked). */
    blocked(key: string): { blocked: boolean; retryAfterSec: number } {
      const entry = current(key);
      if (entry && entry.count >= opts.limit) return { blocked: true, retryAfterSec: retryAfterSec(entry.resetAt) };
      return { blocked: false, retryAfterSec: 0 };
    },
    reset: () => windows.clear(),
  };
}
