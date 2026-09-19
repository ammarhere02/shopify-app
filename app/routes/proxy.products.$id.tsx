import type { LoaderFunctionArgs } from "react-router";
import { logger } from "../lib/logger.server";
import { authenticate } from "../shopify.server";
import { getStorefrontBadge, STOREFRONT_CACHE_SECONDS } from "../services/storefront-badge.server";

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

// Storefront: GET https://<shop>/apps/product-badge/products/<numeric product id>
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const started = Date.now();
  // Checks Shopify's signature over the query string; throws 400 before any DB work if it is wrong.
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  // `shop` is one of the signed parameters, so after the check above it is the tenant.
  const shopDomain = url.searchParams.get("shop");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const result = await getStorefrontBadge(shopDomain, params.id, ip);

  if (result.kind === "rate_limited") {
    logger.warn("storefront.badge_rate_limited", { shopDomain });
    return json({ badge: null }, 429, { "Retry-After": String(result.retryAfterSec), "Cache-Control": "no-store" });
  }
  logger.info("storefront.badge", {
    shopId: result.shopId,
    productId: params.id,
    found: result.badge !== null,
    durationMs: Date.now() - started,
  });
  // Same answer for every shopper, so it is safe to cache publicly for a short time.
  return json({ badge: result.badge }, 200, { "Cache-Control": `public, max-age=${STOREFRONT_CACHE_SECONDS}` });
};
