import type { LoaderFunctionArgs } from "react-router";
import { logger } from "../lib/logger.server";
import { authenticate } from "../shopify.server";
import { getStorefrontBadges, STOREFRONT_CACHE_SECONDS } from "../services/storefront-badge.server";

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

// Storefront: GET https://<shop>/apps/product-badge/badges?ids=<id>,<id>,...  (product grids, one call per page)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const started = Date.now();
  // Checks Shopify's signature over the whole query string (ids included); throws 400 before any DB work.
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  // `shop` is one of the signed parameters, so after the check above it is the tenant.
  const shopDomain = url.searchParams.get("shop");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const result = await getStorefrontBadges(shopDomain, url.searchParams.get("ids"), ip);

  if (result.kind === "invalid") return json({ badges: {} }, 400, { "Cache-Control": "no-store" });
  if (result.kind === "rate_limited") {
    logger.warn("storefront.badges_rate_limited", { shopDomain });
    return json({ badges: {} }, 429, { "Retry-After": String(result.retryAfterSec), "Cache-Control": "no-store" });
  }
  logger.info("storefront.badges", {
    shopId: result.shopId,
    requested: result.requested,
    found: Object.keys(result.badges).length,
    durationMs: Date.now() - started,
  });
  // Same answer for every shopper, so it is safe to cache publicly for a short time.
  return json({ badges: result.badges }, 200, { "Cache-Control": `public, max-age=${STOREFRONT_CACHE_SECONDS}` });
};
