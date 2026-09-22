import { createRateLimiter } from "../lib/rate-limit.server";

/**
 * Per-shop limit for admin-page intents that spend money (generate) or write to Shopify
 * (apply, restore, publish). The same numbers as the `generation` bucket of /api/v1, keyed by
 * shop id instead of API key. In memory, one process (same known limit as the API buckets).
 */
export const adminWriteLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

export const resetAdminLimitsForTests = () => adminWriteLimiter.reset();
